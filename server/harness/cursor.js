// Cursor CLI (cursor-agent) adapter for the chat view.
//
//  pane --(herdr pane.process_info)--> cursor-agent pid --(/proc/<pid>/fd)--> store.db
//       --(~/.cursor/chats/<md5(cwd)>/<sessionId>/store.db)--> native resume store (tool results)
//       --(~/.cursor/projects/<cwd-with-slashes-as-dashes>/agent-transcripts/<id>/<id>.jsonl)
//            --> append-only timeline (user / assistant text / tool_use). No tool ids or results.
//
// Same contract as claude.js: locate(info) and Transcript with refresh/delta/before.
// The log is undocumented; unknown entries and bad lines are skipped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';

const require = createRequire(import.meta.url);
const CONFIG = process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), '.cursor');
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const STORE_FD = /(?:^|[/\\])(?:\.cursor[/\\])?chats[/\\]([0-9a-f]{32})[/\\]([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})[/\\]store\.db(?:-wal|-shm)?$/i;
const MAX_TEXT = 6000;
const MAX_ITEMS = 4000;
const TAIL_BYTES = 24 * 1024 * 1024;
const SKIP_RESULT = new Set(['GetDynamicTools', 'GetMcpTools']);
const NAME_MAP = { Shell: 'Bash', StrReplace: 'Edit', ReadFile: 'Read', ApplyPatch: 'Edit', Await: 'AwaitShell' };

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node < 22.5: timeline still works, results stay pending */ }

const clip = (s, n = MAX_TEXT) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
const secretKey = (k) => /token|secret|password|apikey|api_key|credential|auth|blobencryption|signature/i.test(String(k || ''));

export function encodeProjectDir(cwd) {
  return String(cwd || '').replace(/^[/\\]+/, '').replace(/[/\\]/g, '-');
}

export function sessionFromFdTargets(targets) {
  for (const tgt of targets || []) {
    const m = STORE_FD.exec(String(tgt).replace(/-wal$|-shm$/, ''));
    if (!m || !SESSION_ID.test(m[2])) continue;
    const store = String(tgt).replace(/-wal$|-shm$/, '');
    return { hash: m[1], sessionId: m[2], store };
  }
  return null;
}

function fdTargets(pid) {
  const dir = `/proc/${pid}/fd`;
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(fs.readlinkSync(path.join(dir, n))); } catch { /* gone */ }
  }
  return out;
}

function isCursorProc(proc) {
  const cmd = `${proc?.cmdline || ''} ${(proc?.argv || []).join(' ')}`;
  return /cursor-agent/.test(cmd);
}

function readMeta(store) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(path.dirname(store), 'meta.json'), 'utf8'));
    return { title: j.title || null, cwd: j.cwd || null };
  } catch { return { title: null, cwd: null }; }
}

function expectedJsonl(sessionId, cwd, home = CONFIG) {
  if (!SESSION_ID.test(sessionId) || !cwd) return null;
  const nested = path.join(home, 'projects', encodeProjectDir(cwd), 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
  const flat = path.join(home, 'projects', encodeProjectDir(cwd), 'agent-transcripts', `${sessionId}.jsonl`);
  if (fs.existsSync(nested)) return nested;
  if (fs.existsSync(flat)) return flat;
  return nested; // created on the first message
}

// -> { sessionId, file, store, pid, cwd, name } | null     `info` is pane.process_info
export function locate(info, { home = CONFIG, readFd = fdTargets } = {}) {
  const procs = info?.process_info?.foreground_processes || [];
  for (const proc of procs) {
    if (!Number.isInteger(proc.pid) || !isCursorProc(proc)) continue;
    const hit = sessionFromFdTargets(readFd(proc.pid));
    if (!hit) continue;
    const meta = readMeta(hit.store);
    const cwd = proc.cwd || meta.cwd || null;
    const file = expectedJsonl(hit.sessionId, cwd, home);
    if (!file) continue;
    return { sessionId: hit.sessionId, file, store: hit.store, pid: proc.pid, cwd, name: meta.title || null };
  }
  return null;
}

function mapName(name) { return NAME_MAP[name] || name; }

function mappedInput(name, input = {}) {
  const i = { ...input };
  if (i.path != null && i.file_path == null) i.file_path = i.path;
  if (i.contents != null && i.content == null) i.content = i.contents;
  if (i.glob_pattern != null && i.pattern == null) i.pattern = i.glob_pattern;
  if (name === 'Glob' && i.target_directory != null && i.path == null) i.path = i.target_directory;
  if (i.search_term != null && i.query == null) i.query = i.search_term;
  return i;
}

function slimInput(name, input = {}) {
  const pick = (...keys) => Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, typeof input[k] === 'string' ? clip(input[k], 4000) : input[k]]));
  switch (name) {
    case 'Bash': case 'Shell': return pick('command', 'description', 'working_directory', 'block_until_ms', 'run_in_background');
    case 'Read': return pick('file_path', 'offset', 'limit');
    case 'Edit': return pick('file_path', 'old_string', 'new_string', 'replace_all');
    case 'Write': return pick('file_path', 'content');
    case 'Grep': return pick('pattern', 'path', 'glob', 'output_mode');
    case 'Glob': return pick('pattern', 'path');
    case 'TodoWrite': return { todos: Array.isArray(input.todos) ? input.todos.slice(0, 40).map((t) => ({ content: clip(t.content, 200), status: t.status })) : [] };
    case 'Task': case 'Agent': return pick('description', 'subagent_type', 'prompt', 'resume', 'run_in_background');
    case 'WebFetch': return pick('url', 'prompt');
    case 'WebSearch': return pick('query', 'explanation');
    case 'CallDynamicTool': return { namespace: input.namespace, toolName: input.toolName, arguments: typeof input.arguments === 'string' ? clip(input.arguments, 800) : clip(JSON.stringify(input.arguments || {}), 800) };
    default: {
      const out = {};
      for (const [k, v] of Object.entries(input).slice(0, 8)) {
        if (secretKey(k)) continue;
        out[k] = typeof v === 'string' ? clip(v, 500) : typeof v === 'object' ? clip(JSON.stringify(v), 500) : v;
      }
      return out;
    }
  }
}

function parseUserTs(stamp) {
  if (!stamp) return undefined;
  const t = Date.parse(String(stamp).replace(/\s*\(UTC.*\)\s*$/i, ' UTC'));
  return Number.isFinite(t) ? t : undefined;
}

function userFromText(raw) {
  const text = String(raw || '');
  if (!text.trim()) return null;
  if (/^<user_info>[\s\S]*<\/user_info>\s*$/.test(text.trim())) return null;
  const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(text);
  let body = query ? query[1] : text
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, '')
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gi, '')
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, '')
    .replace(/<image_files>[\s\S]*?<\/image_files>/gi, '');
  body = body.trim();
  if (!body) return null;
  const imgBlock = [...text.matchAll(/<image_files>([\s\S]*?)<\/image_files>/gi)].map((m) => m[1]).join('\n');
  const images = (imgBlock.match(/\.(?:png|jpe?g|gif|webp|svg)\b/gi) || []).length;
  const stamp = /<timestamp>\s*([^<]+?)\s*<\/timestamp>/i.exec(text)?.[1];
  return { kind: 'user', text: clip(body, 12000), images, ts: parseUserTs(stamp) };
}

function resultText(res) {
  if (res == null) return '';
  if (typeof res === 'string') return res;
  if (typeof res === 'object') {
    for (const k of ['output', 'text', 'content', 'stdout']) if (typeof res[k] === 'string') return res[k];
    try { return JSON.stringify(res); } catch { return String(res); }
  }
  return String(res);
}

function isToolError(text) {
  if (!text) return false;
  const m = /^Exit code:\s*(-?\d+)/m.exec(text);
  if (m && m[1] !== '0') return true;
  return /^(Error|Traceback|Command failed)\b/m.test(text);
}

function matchKey(name, input) {
  try { return `${name}\n${JSON.stringify(input || {})}`; } catch { return `${name}\n`; }
}

function contentBlocks(entry) {
  const c = entry?.message?.content ?? entry?.content;
  if (Array.isArray(c)) return c;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return [];
}

// One JSONL object -> upserts. Tool match metadata is on the op as _raw/_key (stripped before send).
export function normalize(entry, lineNo = 0) {
  if (!entry || typeof entry !== 'object') return [];
  if (entry.type === 'turn_ended') {
    if (entry.status === 'success' || !entry.status) return [];
    return [{ id: `turn_ended:${lineNo}`, kind: 'notice', text: entry.error ? `${entry.status}: ${entry.error}` : `Turn ${entry.status}`, tone: 'warn' }];
  }
  const role = entry.role;
  const blocks = contentBlocks(entry);
  if (role === 'user') {
    const text = blocks.map((b) => (b?.type === 'text' ? b.text : '')).join('\n');
    const u = userFromText(text);
    return u ? [{ id: `user:${lineNo}`, ...u }] : [];
  }
  if (role !== 'assistant') return [];
  const ops = [];
  for (const [i, b] of blocks.entries()) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') {
      const t = String(b.text || '').replace(/\[REDACTED\]/g, '').trim();
      if (t) ops.push({ id: `asst:${lineNo}:${i}`, kind: 'assistant', text: clip(t, 30000) });
    } else if (b.type === 'thinking' && String(b.thinking || '').trim()) {
      ops.push({ id: `think:${lineNo}:${i}`, kind: 'thinking', text: clip(b.thinking, 4000) });
    } else if (b.type === 'tool_use' && b.name) {
      const raw = b.name;
      const name = mapName(raw);
      const input = mappedInput(raw, b.input || {});
      ops.push({ id: `tool:${lineNo}:${i}`, kind: 'tool', name, input: slimInput(name, input), _raw: raw, _key: matchKey(raw, b.input || {}) });
    }
  }
  return ops;
}

function openStore(store) {
  if (!DatabaseSync || !store) return null;
  try { return new DatabaseSync(`file:${store}?mode=ro`, { readOnly: true, timeout: 1500 }); } catch {
    try { return new DatabaseSync(store, { readOnly: true, timeout: 1500 }); } catch { return null; }
  }
}

function blobToString(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  return Buffer.from(data).toString('utf8');
}

export class Transcript {
  constructor(file, loc = {}) {
    this.file = file;
    this.store = loc.store || null;
    this.chunk = loc.chunk || 4 * 1024 * 1024;
    this.decoder = new StringDecoder('utf8');
    this.offset = 0;
    this.carry = '';
    this.items = [];
    this.byId = new Map();
    this.ver = 0;
    this.title = loc.name || null;
    this.lineNo = 0;
    this.toolKeys = new Map();   // item id -> { raw, key }
    this.results = [];           // unmatched store results
    this.seenRes = new Set();
    this.callKeys = new Map();   // store toolCallId -> { raw, key }
    this.blobRowid = 0;
    this.storeSize = 0;
    this.compactMtime = 0;
  }

  #upsert(op) {
    if (!op?.id) return;
    if (op._raw) { this.toolKeys.set(op.id, { raw: op._raw, key: op._key }); delete op._raw; delete op._key; }
    const prev = this.byId.get(op.id);
    if (prev) { Object.assign(prev, op); prev.v = ++this.ver; return; }
    const item = { ...op, seq: this.items.length ? this.items.at(-1).seq + 1 : 0, v: ++this.ver };
    this.items.push(item); this.byId.set(item.id, item);
    if (this.items.length > MAX_ITEMS) {
      const d = this.items.splice(0, this.items.length - MAX_ITEMS);
      for (const x of d) { this.byId.delete(x.id); this.toolKeys.delete(x.id); }
    }
  }
  #line(line) {
    if (!line) return;
    let e; try { e = JSON.parse(line); } catch { return; }
    this.lineNo += 1;
    for (const op of normalize(e, this.lineNo)) this.#upsert(op);
  }

  #tailJsonl() {
    if (!this.file) return false;
    let st;
    try { st = fs.statSync(this.file); } catch { return false; }
    if (st.size < this.offset) {
      this.offset = 0; this.carry = ''; this.decoder = new StringDecoder('utf8');
      this.items = []; this.byId.clear(); this.toolKeys.clear(); this.lineNo = 0; this.ver++;
      this.blobRowid = 0; this.seenRes.clear(); this.callKeys.clear(); this.results = [];
    }
    if (st.size === this.offset) return false;
    const before = this.ver;
    const fd = fs.openSync(this.file, 'r');
    try {
      let pos = this.offset;
      let skipFirst = false;
      if (pos === 0 && st.size > TAIL_BYTES) { pos = st.size - TAIL_BYTES; skipFirst = true; }
      const buf = Buffer.alloc(this.chunk);
      while (pos < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(this.chunk, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        this.carry += this.decoder.write(buf.subarray(0, n));
        const lines = this.carry.split('\n');
        this.carry = lines.pop();
        if (skipFirst) { lines.shift(); skipFirst = false; }
        for (const l of lines) this.#line(l);
      }
      this.offset = pos;
    } finally { fs.closeSync(fd); }
    return this.ver !== before;
  }

  #ingestBlob(obj) {
    if (!obj || typeof obj !== 'object') return;
    const role = obj.role;
    const content = obj.content;
    if (role === 'assistant' && Array.isArray(content)) {
      for (const p of content) {
        if (p?.type !== 'tool-call' || !p.toolCallId) continue;
        const raw = p.toolName || '';
        const args = (p.args && typeof p.args === 'object') ? p.args : {};
        this.callKeys.set(p.toolCallId, { raw, key: matchKey(raw, args) });
      }
    }
    if (role === 'tool' && Array.isArray(content)) {
      for (const p of content) {
        if (p?.type !== 'tool-result') continue;
        const id = p.toolCallId || p.toolName || '';
        if (this.seenRes.has(id)) continue;
        this.seenRes.add(id);
        const raw = p.toolName || '';
        const meta = this.callKeys.get(p.toolCallId) || { raw, key: matchKey(raw, {}) };
        if (SKIP_RESULT.has(raw)) {
          this.results.push({ raw, key: meta.key, text: '(schema omitted)', error: false });
          continue;
        }
        const text = clip(resultText(p.result));
        this.results.push({ raw, key: meta.key, text, error: isToolError(text) });
      }
    }
  }

  #attachQueued() {
    let n = 0;
    for (const item of this.items) {
      if (item.kind !== 'tool' || item.result) continue;
      const meta = this.toolKeys.get(item.id);
      if (!meta) continue;
      let idx = this.results.findIndex((r) => r.key === meta.key);
      if (idx < 0) idx = this.results.findIndex((r) => r.raw === meta.raw);
      if (idx < 0) continue;
      const r = this.results.splice(idx, 1)[0];
      item.result = { text: r.text, error: !!r.error };
      item.v = ++this.ver;
      n++;
    }
    return n > 0;
  }

  #attachStore() {
    if (!this.store) return false;
    let st;
    try { st = fs.statSync(this.store); } catch { st = null; }
    try {
      const wal = fs.statSync(`${this.store}-wal`);
      if (!st || wal.mtimeMs > st.mtimeMs) st = { size: (st?.size || 0) + wal.size };
    } catch { /* no wal */ }
    if (st && st.size < this.storeSize) { this.blobRowid = 0; this.seenRes.clear(); this.callKeys.clear(); this.results = []; }
    if (st) this.storeSize = st.size;

    const db = openStore(this.store);
    if (!db) return this.#attachQueued();
    const before = this.ver;
    try {
      const rows = db.prepare(`SELECT rowid, data FROM blobs WHERE rowid > ? AND hex(substr(data, 1, 1)) = '7B'`).all(this.blobRowid);
      for (const row of rows) {
        this.blobRowid = Math.max(this.blobRowid, Number(row.rowid) || 0);
        let obj;
        try { obj = JSON.parse(blobToString(row.data)); } catch { continue; }
        this.#ingestBlob(obj);
      }
    } catch { /* locked / schema change: try again next tick */ } finally {
      try { db.close(); } catch { /* */ }
    }
    this.#attachQueued();
    if (!this.title) {
      const meta = readMeta(this.store);
      if (meta.title) this.title = meta.title;
    }
    return this.ver !== before;
  }

  #compaction() {
    if (!this.file) return false;
    const idx = path.join(path.dirname(this.file), 'compaction', 'INDEX.md');
    let mtime = 0;
    try { mtime = fs.statSync(idx).mtimeMs; } catch { return false; }
    if (!this.compactMtime) { this.compactMtime = mtime; return false; }
    if (mtime <= this.compactMtime) return false;
    this.compactMtime = mtime;
    this.#upsert({ id: `compact:${mtime}`, kind: 'notice', text: 'Conversation compacted to free up context', tone: 'info' });
    return true;
  }

  refresh() {
    const a = this.#tailJsonl();
    const b = this.#attachStore();
    const c = this.#compaction();
    return a || b || c;
  }
  delta(since = 0, limit = Infinity) {
    const changed = since === 0 ? this.items : this.items.filter((i) => i.v > since);
    return limit < changed.length ? changed.slice(-limit) : changed;
  }
  before(seq, limit = 100) {
    const idx = this.items.findIndex((i) => i.seq >= seq);
    const end = idx < 0 ? this.items.length : idx;
    return this.items.slice(Math.max(0, end - limit), end);
  }
}

export const id = 'cursor';
