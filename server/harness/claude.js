// Claude Code adapter for the chat view.
//
//  pane --(herdr pane.process_info)--> claude pid --(~/.claude/sessions/<pid>.json)--> sessionId
//       --(~/.claude/projects/<project>/<sessionId>.jsonl)--> append-only event log, one JSON object per line.
//
// The log is not a stable public format (see the notes in README), so the parser is defensive: unknown entry
// types are skipped, every field is optional, and a bad line never stops the rest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MAX_TEXT = 6000;       // per tool result / long string kept in an item
const MAX_ITEMS = 4000;      // per session kept in memory
const TAIL_BYTES = 24 * 1024 * 1024; // very long sessions: only read the end of the file

// ---------------------------------------------------------------- locating

const fileCache = new Map(); // sessionId -> transcript path
function transcriptPath(sessionId) {
  if (!SESSION_ID.test(sessionId)) return null;
  const hit = fileCache.get(sessionId);
  if (hit && fs.existsSync(hit)) return hit;
  const root = path.join(CONFIG, 'projects');
  try {
    for (const dir of fs.readdirSync(root)) {
      const p = path.join(root, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) { fileCache.set(sessionId, p); return p; }
    }
  } catch { /* no projects dir */ }
  return null;
}

// Where Claude Code will write the log: ~/.claude/projects/<cwd with every non-alphanumeric turned into "-">/<id>.jsonl
function expectedPath(reg) {
  if (!SESSION_ID.test(reg.sessionId) || typeof reg.cwd !== 'string') return null;
  return path.join(CONFIG, 'projects', reg.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${reg.sessionId}.jsonl`);
}

// -> { sessionId, file, pid, cwd } | null          `info` is the result of herdr's pane.process_info
export function locate(info) {
  const procs = info?.process_info?.foreground_processes || [];
  for (const proc of procs) {
    if (!Number.isInteger(proc.pid)) continue;
    let reg;
    try { reg = JSON.parse(fs.readFileSync(path.join(CONFIG, 'sessions', `${proc.pid}.json`), 'utf8')); } catch { continue; }
    if (reg.pid !== proc.pid || typeof reg.sessionId !== 'string') continue;
    // A session that has not said anything yet has no log file; it is created on the first message.
    const file = transcriptPath(reg.sessionId) || expectedPath(reg);
    if (file) return { sessionId: reg.sessionId, file, pid: proc.pid, cwd: reg.cwd || proc.cwd || null, name: reg.name || null };
  }
  return null;
}

// ---------------------------------------------------------------- normalising

const clip = (s, n = MAX_TEXT) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
};

// Keep only what the UI renders; never ship whole 100 KB inputs.
function slimInput(name, input = {}) {
  const pick = (...keys) => Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, typeof input[k] === 'string' ? clip(input[k], 4000) : input[k]]));
  switch (name) {
    case 'Bash': return pick('command', 'description', 'run_in_background');
    case 'Read': return pick('file_path', 'offset', 'limit');
    case 'Edit': return pick('file_path', 'old_string', 'new_string', 'replace_all');
    case 'Write': return pick('file_path', 'content');
    case 'Grep': return pick('pattern', 'path', 'glob', 'output_mode');
    case 'Glob': return pick('pattern', 'path');
    case 'TodoWrite': return { todos: Array.isArray(input.todos) ? input.todos.slice(0, 40).map((t) => ({ content: clip(t.content, 200), status: t.status })) : [] };
    case 'Task': case 'Agent': return pick('description', 'subagent_type', 'prompt');
    case 'WebFetch': return pick('url', 'prompt');
    case 'WebSearch': return pick('query');
    default: {
      const out = {};
      for (const [k, v] of Object.entries(input).slice(0, 8)) out[k] = typeof v === 'string' ? clip(v, 500) : typeof v === 'object' ? clip(JSON.stringify(v), 500) : v;
      return out;
    }
  }
}

function slimPatch(p) {
  if (!Array.isArray(p)) return undefined;
  let budget = 600; // lines
  const hunks = [];
  for (const h of p) {
    if (!Array.isArray(h?.lines) || budget <= 0) break;
    const lines = h.lines.slice(0, budget).map((l) => clip(String(l), 400));
    budget -= lines.length;
    hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines });
  }
  return hunks.length ? hunks : undefined;
}

function userText(entry) {
  const raw = textOf(entry.message?.content).trim();
  if (!raw) return null;
  if (raw.startsWith('<local-command-caveat>')) return null;
  const cmd = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(raw);
  if (cmd) { const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim(); return { kind: 'command', text: args ? `${cmd[1]} ${args}` : cmd[1] }; }
  const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(raw);
  if (out) return out[1].trim() ? { kind: 'notice', text: clip(out[1].trim(), 1500), tone: 'output' } : null;
  if (raw.startsWith('<task-notification')) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(raw)?.[1]?.trim();
    const interim = INTERIM.test(raw);
    return { kind: 'notice', text: summary ? (interim ? summary.replace(/ finished$/, ' paused, waiting on its own background work') : summary) : 'A background task reported back', tone: 'task' };
  }
  if (/^<system-reminder>[\s\S]*<\/system-reminder>$/.test(raw)) return null;
  if (raw.startsWith('[Request interrupted')) return { kind: 'notice', text: raw.replace(/^\[|\]$/g, ''), tone: 'warn' };
  const images = Array.isArray(entry.message?.content) ? entry.message.content.filter((b) => b?.type === 'image').length : 0;
  return { kind: 'user', text: clip(raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim(), 12000), images };
}

// One log entry -> list of { id, ...fields } upserts (and tool-result patches keyed by the tool call id).
export function normalize(entry) {
  if (!entry || typeof entry !== 'object' || entry.isSidechain) return [];
  const ts = entry.timestamp ? Date.parse(entry.timestamp) || undefined : undefined;
  const ops = [];

  if (entry.type === 'user') {
    if (entry.isMeta || entry.isCompactSummary) return [];
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue;
        const res = { text: clip(textOf(b.content)), error: !!b.is_error };
        const tur = entry.toolUseResult;
        if (tur && typeof tur === 'object') {
          const patch = slimPatch(tur.structuredPatch);
          if (patch) res.patch = patch;
          if (tur.stdout !== undefined && !res.text) res.text = clip(String(tur.stdout));
        }
        ops.push({ result: true, id: b.tool_use_id, res });
      }
      if (ops.length && !content.some((b) => b?.type === 'text')) return ops;
    }
    const u = userText(entry);
    if (u) ops.push({ id: entry.uuid, ts, ...u });
    return ops;
  }

  if (entry.type === 'assistant') {
    const msg = entry.message || {};
    const synthetic = msg.model === '<synthetic>' || entry.isApiErrorMessage;
    for (const [i, b] of (Array.isArray(msg.content) ? msg.content : []).entries()) {
      const id = `${entry.uuid}:${i}`;
      if (b?.type === 'text' && b.text?.trim()) ops.push(synthetic
        ? { id, ts, kind: 'notice', text: clip(b.text), tone: 'warn' }
        : { id, ts, kind: 'assistant', text: clip(b.text, 30000), model: msg.model });
      else if (b?.type === 'thinking') ops.push({ id, ts, kind: 'thinking', ms: entry.thinkingDurationMs, text: clip(b.thinking || '', 4000) });
      else if (b?.type === 'tool_use') ops.push({ id: b.id, ts, kind: 'tool', name: b.name, input: slimInput(b.name, b.input) });
    }
    return ops;
  }

  // A message typed while the agent was busy and handed to it mid-turn is logged only as this attachment.
  if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
    const a = entry.attachment;
    const u = userText({ message: { content: String(a.prompt || '') } });
    if (!u) return [];
    if (u.kind === 'user' && !(a.origin?.kind === 'human' || a.humanTurn)) return [];
    return [{ id: `qc:${a.delivery_id || entry.uuid}`, ts: Date.parse(a.timestamp || entry.timestamp) || ts, fromQueue: true, ...u }];
  }

  if (entry.type === 'system') {
    if (entry.subtype === 'compact_boundary') return [{ id: entry.uuid, ts, kind: 'notice', text: 'Conversation compacted to free up context', tone: 'info' }];
    return [];
  }
  return [];
}

// ---------------------------------------------------------------- tailing one session

export class Transcript {
  constructor(file, { chunk = 4 * 1024 * 1024 } = {}) {
    this.file = file;
    this.chunk = chunk;
    this.decoder = new StringDecoder('utf8'); // a multi-byte character can straddle two reads
    this.offset = 0;
    this.carry = '';
    this.items = [];          // ordered
    this.byId = new Map();
    this.ver = 0;             // bumped on every change; items carry the version they last changed at
    this.title = null;
    this.size = 0;
    this.orphans = new Map();
    this.pending = []; // ids of messages typed while the agent was busy and not yet delivered, oldest first
  }

  #upsert(op) {
    if (op.result) {
      const t = this.byId.get(op.id);
      if (t) { t.result = op.res; t.v = ++this.ver; }
      else this.orphans.set(op.id, op.res); // result seen before its call (after a tail-only read)
      return;
    }
    const prev = this.byId.get(op.id);
    if (prev) { Object.assign(prev, op); prev.v = ++this.ver; return; }
    if (op.kind === 'user' && !op.queued) { // the delivered copy of a message already shown as queued: update that bubble in place
      const i = this.pending.findIndex((id) => this.byId.get(id)?.text.trim() === op.text.trim());
      if (i >= 0) {
        const q = this.byId.get(this.pending[i]); this.pending.splice(i, 1);
        q.queued = false; if (op.images) q.images = op.images; q.v = ++this.ver; return;
      }
    }
    const item = { ...op, seq: this.items.length ? this.items.at(-1).seq + 1 : 0, v: ++this.ver };
    const orphan = this.orphans.get(op.id);
    if (orphan) { item.result = orphan; this.orphans.delete(op.id); }
    this.items.push(item); this.byId.set(item.id, item);
    if (this.items.length > MAX_ITEMS) { const d = this.items.splice(0, this.items.length - MAX_ITEMS); for (const x of d) this.byId.delete(x.id); }
  }
  #line(line) {
    if (!line) return;
    let e; try { e = JSON.parse(line); } catch { return; } // a half-written or foreign line
    if (e.type === 'ai-title' && e.aiTitle) { this.title = e.aiTitle; return; }
    if (e.type === 'queue-operation') { // the user typed while the agent was busy: show it right away, marked as queued
      if (e.operation === 'enqueue' && typeof e.content === 'string') {
        const u = userText({ message: { content: e.content } });
        if (u?.kind === 'user' && !/^\/[\w:-]+(\s|$)/.test(u.text)) { // slash commands run locally and are logged as commands
          const id = `q:${e.timestamp || ''}:${this.items.length}`;
          this.#upsert({ id, ts: Date.parse(e.timestamp) || undefined, kind: 'user', text: u.text, images: 0, queued: true });
          this.pending.push(id);
          if (this.pending.length > 20) this.pending.shift();
        }
      }
      return;
    }
    for (const op of normalize(e)) this.#upsert(op);
  }

  // Read whatever was appended since the last call. -> true when something changed.
  refresh() {
    let st;
    try { st = fs.statSync(this.file); } catch { return false; }
    if (st.size < this.offset) { this.offset = 0; this.carry = ''; this.decoder = new StringDecoder('utf8'); this.items = []; this.byId.clear(); this.orphans.clear(); this.pending = []; this.ver++; }
    if (st.size === this.offset) return false;
    const before = this.ver;
    const fd = fs.openSync(this.file, 'r');
    try {
      let pos = this.offset;
      let skipFirst = false;
      if (pos === 0 && st.size > TAIL_BYTES) { pos = st.size - TAIL_BYTES; skipFirst = true; }
      const CHUNK = this.chunk;
      const buf = Buffer.alloc(CHUNK);
      while (pos < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        this.carry += this.decoder.write(buf.subarray(0, n));
        const lines = this.carry.split('\n');
        this.carry = lines.pop();                // last piece may be half-written; keep for next time
        if (skipFirst) { lines.shift(); skipFirst = false; }
        for (const l of lines) this.#line(l);
      }
      this.offset = pos;
    } finally { fs.closeSync(fd); }
    return this.ver !== before;
  }

  // Items changed after `since` (a version), newest `limit` of them when there are many.
  delta(since = 0, limit = Infinity) {
    const changed = since === 0 ? this.items : this.items.filter((i) => i.v > since);
    return limit < changed.length ? changed.slice(-limit) : changed;
  }
  // Older history for "load earlier".
  before(seq, limit = 100) {
    const idx = this.items.findIndex((i) => i.seq >= seq);
    const end = idx < 0 ? this.items.length : idx;
    return this.items.slice(Math.max(0, end - limit), end);
  }
}

// ---------------------------------------------------------------- running sub-agents

// A sub-agent is an Agent/Task tool call. A foreground one is finished by its tool result. A background one
// answers at once with "Async agent launched" and is finished by a <task-notification> that names the call.
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const INTERIM = /This agent has not reported yet/; // vs. "This agent's report was delivered" on the final one
const STALE_MS = 6 * 3600 * 1000; // a launch with no end after this long is a crashed session, not work in progress

export class SubagentTracker {
  constructor(file, { tail = 1.5 * 1024 * 1024 } = {}) {
    this.file = file; this.tail = tail;
    this.decoder = new StringDecoder('utf8');
    this.offset = 0; this.carry = '';
    this.agents = new Map(); // tool call id -> { id, label, type, bg, since, done }
    this.byTask = new Map(); // background agent id (the notification's <task-id>) -> tool call id
  }
  #line(line) {
    // cheap pre-filter: most lines are neither a launch, a result, nor a notification
    if (!(line.includes('"Agent"') || line.includes('"Task"') || line.includes('tool_result') || line.includes('<task-notification'))) return;
    let e; try { e = JSON.parse(line); } catch { return; }
    if (e.isSidechain) return;
    const ts = Date.parse(e.timestamp) || Date.now();
    const content = e.message?.content;
    if (Array.isArray(content)) for (const b of content) {
      if (b?.type === 'tool_use' && AGENT_TOOLS.has(b.name)) {
        const i = b.input || {};
        this.agents.set(b.id, { id: b.id, label: clip(String(i.description || i.subagent_type || 'sub-agent'), 80), type: i.subagent_type ? String(i.subagent_type).slice(0, 40) : null, bg: !!i.run_in_background, since: ts, done: false });
      } else if (b?.type === 'tool_result') {
        const a = this.agents.get(b.tool_use_id);
        if (a) {
          const text = textOf(b.content).trim();
          if (/^Async agent launched/i.test(text)) { a.bg = true; const m = /agentId:\s*(\w+)/.exec(text); if (m) this.byTask.set(m[1], a.id); } else a.done = true;
        }
      }
    }
    // An agent that stops while its own background work still runs sends an interim notification and reports again later.
    if (line.includes('<task-notification') && !INTERIM.test(line)) {
      // the final report names the agent's <task-id> only; interim ones also carry the <tool-use-id>
      for (const m of line.matchAll(/<tool-use-id>([^<\s]+)<\/tool-use-id>/g)) { const a = this.agents.get(m[1]); if (a) a.done = true; }
      for (const m of line.matchAll(/<task-id>([^<\s]+)<\/task-id>/g)) { const a = this.agents.get(this.byTask.get(m[1])); if (a) a.done = true; }
    }
  }
  refresh() {
    let st; try { st = fs.statSync(this.file); } catch { return false; }
    if (st.size < this.offset) { this.offset = 0; this.carry = ''; this.agents.clear(); this.byTask.clear(); this.decoder = new StringDecoder('utf8'); }
    if (st.size === this.offset) return false;
    let pos = this.offset, skipFirst = false;
    if (pos === 0 && st.size > this.tail) { pos = st.size - this.tail; skipFirst = true; }
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(1024 * 1024);
      while (pos < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        this.carry += this.decoder.write(buf.subarray(0, n));
        const lines = this.carry.split('\n'); this.carry = lines.pop();
        if (skipFirst) { lines.shift(); skipFirst = false; }
        for (const l of lines) this.#line(l);
      }
      this.offset = pos;
    } finally { fs.closeSync(fd); }
    for (const [k, a] of this.agents) if (a.done || Date.now() - a.since > STALE_MS) { if (!a.done) a.done = true; if (this.agents.size > 64) this.agents.delete(k); }
    return true;
  }
  get running() { return [...this.agents.values()].filter((a) => !a.done).slice(-8).map(({ id, label, type, bg, since }) => ({ id, label, type, bg, since })); }
}

export const id = 'claude';
