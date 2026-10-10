// Codex rollout adapter; see docs/harnesses/codex.md for the local schema notes.
// Paginated histories persist completed display items; legacy histories need protocol
// calls/results instead. Never guess a pane's identity from cwd or newest-file order:
// shared app-server daemons can own several unrelated sessions in the same folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { namedSessions, titleMatches } from './codex-sessions.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 4000, MAX_LINE = 16 * 1024 * 1024, TAIL_BYTES = 24 * 1024 * 1024;
const fileCache = new Map();
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
const names = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const real = (f) => { try { return fs.realpathSync(f); } catch { return null; } };

// Only a bounded first record is needed for discovery, even for multi-GB histories.
function header(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024), parts = [];
    for (let nread = 0; nread < 4 * 1024 * 1024;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      nread += n;
      const end = buf.subarray(0, n).indexOf(10);
      parts.push(Buffer.from(buf.subarray(0, end < 0 ? n : end)));
      if (end >= 0) {
        const e = json(Buffer.concat(parts).toString('utf8'));
        return e?.type === 'session_meta' ? e.payload : null;
      }
    }
  } catch { /* new, missing, or unreadable rollout */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

function fdTargets(pid, procRoot) {
  return names(`${procRoot}/${pid}/fd`).flatMap((n) => {
    try { return [fs.readlinkSync(`${procRoot}/${pid}/fd/${n}`)]; } catch { return []; }
  });
}
function children(pid, procRoot) {
  return read(`${procRoot}/${pid}/task/${pid}/children`).trim().split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}
const isCodex = (p) => p?.name === 'codex' || (Array.isArray(p?.argv) && p.argv.some((s) => typeof s === 'string' && /(?:^|\/)codex(?:\.js)?$/.test(s)));
const isSubagent = (m) => m?.parent_thread_id || (m?.source && typeof m.source === 'object' && m.source.subagent);

// Options inject process discovery for tests. binding is trusted pane lifecycle data,
// not request query parameters. A supplied pid protects manually configured mappings
// against a pane being reused by another process.
export function locate(info, options = {}) {
  info = info?.result || info;
  const procs = (info?.process_info?.foreground_processes || []).filter((p) => Number.isInteger(p.pid) && isCodex(p));
  if (!procs.length) return null;
  const procRoot = options.procRoot || '/proc';
  const readFd = options.readFd || ((pid) => fdTargets(pid, procRoot));
  const readChildren = options.readChildren || ((pid) => children(pid, procRoot));
  const proc = procs[0];
  const envHome = read(`${procRoot}/${proc.pid}/environ`).split('\0').find((s) => s.startsWith('CODEX_HOME='))?.slice(11);
  const home = real(options.home || envHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  if (!home) return null;
  const roots = ['sessions', 'archived_sessions'].map((s) => path.join(home, s));
  const validFile = (f) => {
    const resolved = typeof f === 'string' ? real(f) : null;
    return resolved && resolved.endsWith('.jsonl') && roots.some((r) => resolved.startsWith(r + path.sep)) ? resolved : null;
  };
  const findSession = (sessionId) => {
    const cacheKey = `${home}:${sessionId}`, cached = fileCache.get(cacheKey);
    if (cached && validFile(cached) && header(cached)?.id === sessionId) return cached;
    const queue = [...roots];
    while (queue.length) {
      const dir = queue.shift();
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) queue.push(f); // do not follow symlink directories
        else if (e.isFile() && e.name.endsWith(`-${sessionId}.jsonl`)) {
          const file = validFile(f);
          if (file && header(file)?.id === sessionId) { boundedSet(fileCache, cacheKey, file); return file; }
        }
      }
    }
    return null;
  };
  const configured = json(process.env.OFFICE_CODEX_SESSIONS || '{}')?.[info?.process_info?.pane_id];
  // Manual mappings must name the foreground process so pane reuse fails closed.
  if (configured && !Number.isInteger(configured.pid)) return null;
  const binding = options.binding || info?.binding || configured;
  if (binding) {
    if (binding.pid !== undefined && !procs.some((p) => p.pid === binding.pid)) return null;
    const sessionId = binding.sessionId || binding.agent_session_id;
    if (!UUID.test(sessionId || '')) return null;
    const requested = binding.file || binding.agent_session_path;
    const file = requested ? validFile(requested) : findSession(sessionId);
    const meta = file && header(file);
    if (!meta || meta.id !== sessionId) return null;
    return { sessionId, file, pid: binding.pid || proc.pid, cwd: meta.cwd || proc.cwd || null, name: null, method: 'pane-binding', exact: true };
  }
  const candidates = new Map(), pending = procs.map((p) => p.pid), seen = new Set();
  while (pending.length && seen.size < 64) {
    const pid = pending.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const target of readFd(pid) || []) {
      let file = validFile(target);
      // An owning lock FD is also usable when the rollout FD is opened lazily.
      const lock = typeof target === 'string' && path.dirname(target) === path.join(home, 'thread-writer-locks')
        ? /^([0-9a-f-]+)\.lock$/i.exec(path.basename(target))?.[1] : null;
      if (!file && lock && UUID.test(lock)) file = findSession(lock);
      if (!file) continue;
      const meta = header(file);
      if (!UUID.test(meta?.id || '') || isSubagent(meta)) continue;
      candidates.set(meta.id, { sessionId: meta.id, file, pid: proc.pid, cwd: meta.cwd || proc.cwd || null, name: null, method: 'owned-rollout', exact: true });
    }
    pending.push(...(readChildren(pid) || []).filter((n) => Number.isInteger(n) && n > 0));
  }
  if (candidates.size) return candidates.size === 1 ? candidates.values().next().value : null;
  // Shared-daemon TUIs have no owned rollout FD. Their live OSC title reflects
  // the selected named thread. Require a unique match; cwd/mtime alone is never
  // enough. Recompute every locate, so /new, /resume and PID reuse cannot keep
  // a cached binding to a previous title. This is evidence, not a PID registry.
  const pane = options.pane || info.pane;
  const title = pane?.terminal_title_stripped || pane?.terminal_title;
  if (!title || !proc.cwd) return null;
  const matches = (options.namedSessions || namedSessions)(home, proc.cwd)
    .filter((s) => s.cwd === proc.cwd && titleMatches(title, s.name, proc.cwd));
  if (matches.length !== 1) return null;
  const match = matches[0], file = validFile(match.file), meta = file && header(file);
  if (!UUID.test(match.sessionId || '') || meta?.id !== match.sessionId || meta.cwd !== proc.cwd || isSubagent(meta)) return null;
  return { ...match, file, pid: proc.pid, method: 'terminal-title', exact: false };
}

// Keep only display fields. Redaction is defense in depth, not a general secret detector.
const secretKey = (k) => /token|secret|password|api.?key|credential|authorization|encrypted_content|image_url|audio_url/i.test(k);
const sensitivePath = (s) => /(?:^|[/\s])(?:auth\.json|credentials(?:\.json)?|\.env(?:\.[\w.-]+)?|id_rsa|id_ed25519)(?:$|[\s"';|&()<>])/i.test(s || '');
function redact(s) {
  return String(s ?? '')
    .replace(/data:(?:image|audio)\/[^\s"']+/gi, '[media omitted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key omitted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[credential omitted]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [credential omitted]')
    .replace(/((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)["']?)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[credential omitted]')
    .replace(/([?&](?:token|key|sig|signature|X-Amz-Signature)=)[^&\s"']+/gi, '$1[credential omitted]');
}
const clip = (s, n = 6000) => { s = redact(s); return s.length > n ? `${s.slice(0, n)}\n… [clipped]` : s; };
const array = (v) => Array.isArray(v) ? v : [];
function textOf(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((b) => b && ['text', 'Text', 'input_text', 'output_text', 'summary_text'].includes(b.type) && typeof b.text === 'string' ? b.text : '').filter(Boolean).join('\n');
  if (v && typeof v === 'object') return textOf(v.content ?? v.text ?? v.output ?? v.stdout ?? '');
  return '';
}
function slim(v, depth = 0) {
  if (typeof v === 'string') return clip(v, 4000);
  if (v == null || typeof v !== 'object') return v;
  if (depth >= 3) return '[details omitted]';
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => slim(x, depth + 1));
  return Object.fromEntries(Object.entries(v).filter(([k]) => !secretKey(k)).slice(0, 12).map(([k, x]) => [k, slim(x, depth + 1)]));
}
const command = (v) => Array.isArray(v) ? (v.length === 3 && /^-l?c$/.test(v[1]) ? v[2] : v.join(' ')) : typeof v === 'string' ? v : '';
const failed = (p) => ['failed', 'declined', 'cancelled'].includes(p.status) || p.success === false || p.isError === true || p.is_error === true || !!p.error || (Number.isInteger(p.exit_code) && p.exit_code !== 0);
function outputResult(output) {
  const parsed = typeof output === 'string' ? json(output) : output;
  const raw = textOf(output) || textOf(parsed);
  const exit = /^(?:Process exited with code|Exit code:)\s*(-?\d+)/mi.exec(raw);
  return { text: clip(raw), error: failed(parsed || {}) || failed(parsed?.metadata || {}) || !!(exit && Number(exit[1]) !== 0) };
}
function user(content) {
  let text = textOf(content);
  text = text.replace(/<(environment_context|permissions instructions|system-reminder)>[\s\S]*?<\/\1>\s*/g, '')
    .replace(/^# AGENTS\.md instructions[^\n]*\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/i, '').trim();
  const images = array(content).filter((b) => b && ['image', 'local_image', 'input_image'].includes(b.type)).length;
  return text || images ? { kind: 'user', text: clip(text, 12000), images } : null;
}

function patchHunks(diff) {
  const hunks = []; let h, budget = 600;
  for (const line of String(diff || '').split('\n')) {
    if (budget <= 0) break;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) { h = { oldStart: +m[1], newStart: +m[2], lines: [] }; hunks.push(h); }
    else if (h && /^[ +\-]/.test(line)) { h.lines.push(clip(line, 400)); budget--; }
  }
  return hunks;
}
function pathKey(file, cwd) { return typeof file === 'string' && cwd && !path.isAbsolute(file) ? path.resolve(cwd, file) : file; }
function patchFiles(input, cwd) {
  const files = [];
  if (typeof input !== 'string') return files;
  for (const m of input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) files.push(pathKey(m[1].trim(), cwd));
  return [...new Set(files)];
}
function changesOps(p, id, ts, ctx) {
  const out = [], changes = p.changes && typeof p.changes === 'object' ? p.changes : {};
  for (const [file, change] of Object.entries(changes).slice(0, 100)) {
    if (!change || typeof change !== 'object' || !['update', 'add', 'delete'].includes(change.type)) continue;
    const filePath = pathKey(file, ctx.cwd), hidden = sensitivePath(filePath);
    const patch = hidden ? undefined : change.type === 'update' ? patchHunks(change.unified_diff)
      : [{ oldStart: 1, newStart: 1, lines: String(change.content || '').split('\n').slice(0, 600).map((l) => (change.type === 'delete' ? '-' : '+') + clip(l, 400)) }];
    const res = { text: hidden ? '[sensitive-file content omitted]' : clip(p.stderr || p.stdout || ''), error: failed(p) };
    if (patch?.length) res.patch = patch;
    out.push({ id: `${id}:${filePath}`, ts, kind: 'tool', name: 'Edit', input: { file_path: clip(filePath, 1000), ...(change.move_path ? { move_path: clip(change.move_path, 1000) } : {}) } });
    if (p.status !== 'in_progress') out.push({ id: `${id}:${filePath}`, result: true, res, priority: 3 });
  }
  return out;
}
function initContext(ctx) {
  ctx.calls ||= new Map(); ctx.occurrences ||= new Map(); ctx.seenCalls ||= new Map(); ctx.outputs ||= new Map();
  return ctx;
}
function boundedSet(map, key, value) { map.set(key, value); if (map.size > MAX_ITEMS) map.delete(map.keys().next().value); }

// Stateful context suppresses mirrors and pairs legacy tool results. Offsets supplied by
// Transcript give ID-less records a stable identity across chunk sizes and tail reads.
export function normalize(entry, context = {}) {
  if (!entry || typeof entry !== 'object') return [];
  const ctx = initContext(context), p = entry.payload;
  if (!p || typeof p !== 'object') return [];
  if (entry.type === 'session_meta') {
    ctx.sessionId = p.id || p.session_id || ctx.sessionId;
    ctx.mode = p.history_mode || ctx.mode;
    ctx.cwd = p.cwd || ctx.cwd;
    return [];
  }
  if (entry.type === 'turn_context') { ctx.model = p.model || ctx.model; ctx.cwd = p.cwd || ctx.cwd; ctx.turnId = p.turn_id || ctx.turnId; return []; }
  const fallback = `record:${entry.ordinal ?? ctx.offset ?? crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 20)}`;
  const prefix = ctx.sessionId ? `${ctx.sessionId}:` : '';
  const key = (s) => `${prefix}${s}`;
  const ts = Date.parse(entry.timestamp) || undefined;
  const notice = (text, tone = 'info', id = fallback) => [{ id: key(id), ts, kind: 'notice', text: clip(text, 1500), tone }];

  if (entry.type === 'compacted') return ctx.mode === 'paginated' ? [] : notice('Conversation compacted to free up context');
  if (entry.type === 'event_msg') {
    if (p.type === 'task_started') { ctx.turnId = p.turn_id; return []; }
    if (p.type === 'turn_aborted') return notice(`Turn aborted: ${p.reason || 'interrupted'}`, 'warn');
    if (p.type === 'thread_rolled_back') return notice('Conversation rolled back; earlier items may have been withdrawn', 'warn');
    if (['error', 'warning', 'stream_error'].includes(p.type)) return notice(textOf(p.message) || textOf(p.error) || 'Codex reported an error', 'warn');
    if (p.type === 'item_completed') {
      const i = p.item;
      if (!i || typeof i !== 'object') return [];
      // No explicit mode: completed core display messages identify a paginated log.
      // Legacy also persists a few display-only kinds, which must not switch modes.
      if (!ctx.mode && ['UserMessage', 'AgentMessage', 'CommandExecution', 'FileChange'].includes(i.type)) ctx.mode = 'paginated';
      if (ctx.mode !== 'paginated' && !['Plan', 'SubAgentActivity', 'FunctionCallOutput'].includes(i.type)) return [];
      const id = key(i.id || fallback);
      const tool = (name, input, res) => [{ id, ts, kind: 'tool', name: clip(name, 150), input: slim(input) }, ...(res ? [{ id, result: true, res, priority: 3 }] : [])];
      switch (i.type) {
        case 'UserMessage': { const u = user(i.content); return u ? [{ id, ts, ...u }] : []; }
        case 'AgentMessage': { const text = textOf(i.content); return text.trim() ? [{ id, ts, kind: 'assistant', text: clip(text, 30000), model: ctx.model }] : []; }
        case 'Reasoning': { const text = array(i.summary_text).filter((s) => typeof s === 'string').join('\n'); return text.trim() ? [{ id, ts, kind: 'thinking', text: clip(text, 4000) }] : []; }
        case 'CommandExecution': {
          const cmd = command(i.command), res = { text: sensitivePath(cmd) ? '[sensitive-file command output omitted]' : clip(i.aggregated_output ?? i.formatted_output ?? i.stdout ?? i.stderr ?? ''), error: failed(i) };
          return tool('Bash', { command: cmd, workdir: i.cwd }, i.status === 'in_progress' ? null : res);
        }
        case 'FileChange': return changesOps(i, id, ts, ctx);
        case 'ContextCompaction': return notice('Conversation compacted to free up context', 'info', i.id || fallback);
        case 'SubAgentActivity': return notice(`Subagent ${i.kind || 'activity'}: ${i.agent_path || i.agent_thread_id || ''}`, 'task', i.id || fallback);
        case 'CollabAgentToolCall': return tool('Agent', { description: i.tool, prompt: i.prompt }, i.status === 'in_progress' ? null : { text: clip(i.status || 'Completed'), error: failed(i) });
        case 'ImageView': return tool('Read', { file_path: i.path }, { text: 'Viewed image', error: false });
        case 'Plan': { const text = textOf(i.text ?? i.content); return text ? [{ id, ts, kind: 'assistant', text: clip(text, 12000) }] : []; }
        case 'McpToolCall': case 'DynamicToolCall': return tool(i.tool || i.name || i.type, { server: i.server, arguments: i.arguments }, i.status === 'in_progress' ? null : { ...outputResult(i.result ?? i.output), error: failed(i) || failed(i.result || {}) });
        case 'FunctionCallOutput': return tool(i.name || 'tool', {}, outputResult(i.output));
        case 'WebSearch': return tool('WebSearch', { query: i.query || i.action?.query || i.action?.queries?.join('\n') }, { text: clip(i.status || 'Completed'), error: failed(i) });
        case 'Extension':
          if (i.kind === 'web.search') return tool('WebSearch', { query: i.query || i.action?.query }, { text: clip(array(i.results).map((r) => `${r?.title || ''} ${r?.url || ''}`).join('\n')), error: failed(i) });
          if (i.kind === 'clock.sleep') return tool('Wait', { duration_ms: i.duration_ms }, { text: 'Finished waiting', error: false });
          return [];
        case 'ImageGeneration': return tool('ImageGeneration', {}, { text: clip(i.status || 'Image generated'), error: failed(i) });
        default: return [];
      }
    }
    if (ctx.mode === 'paginated') return [];
    const call = ctx.calls.get(p.call_id), callId = call?.id || key(`call:${p.call_id}:1`);
    if (p.type === 'patch_apply_end') {
      const ops = changesOps(p, callId, ts, ctx);
      if (!ops.length) return (call?.ids || [callId]).map((id) => ({ id, result: true, priority: 3, res: { text: clip(p.stderr || p.stdout || ''), error: failed(p) } }));
      return ops;
    }
    if (p.type === 'exec_command_end' && p.call_id) return [{ id: callId, result: true, priority: 3, res: { text: call?.sensitive ? '[sensitive-file command output omitted]' : clip(p.aggregated_output ?? p.stdout ?? p.stderr ?? ''), error: failed(p) } }];
    if (p.type === 'web_search_end' && (p.call_id || p.id)) {
      ctx.searchResults ||= new Map();
      const resultKey = p.call_id || p.id;
      const id = ctx.searchResults.get(resultKey) || ctx.searches?.get(JSON.stringify(p.action || {}))?.shift() || key(resultKey);
      boundedSet(ctx.searchResults, resultKey, id);
      return [{ id, result: true, priority: 3, res: { text: clip(textOf(p.results) || array(p.results).map((r) => `${r?.title || ''} ${r?.url || ''}`).join('\n')), error: failed(p) } }];
    }
    if (p.type === 'context_compacted') return []; // top-level compacted is canonical in legacy mode
    return [];
  }
  if (entry.type !== 'response_item' || ctx.mode === 'paginated') return [];
  const id = key(p.id || fallback);
  if (p.type === 'message') {
    if (p.role === 'user') { const u = user(p.content); return u ? [{ id, ts, ...u }] : []; }
    const text = textOf(p.content);
    return p.role === 'assistant' && text.trim() ? [{ id, ts, kind: 'assistant', text: clip(text, 30000), model: ctx.model }] : [];
  }
  if (p.type === 'reasoning') {
    const text = textOf(p.summary);
    return text.trim() ? [{ id, ts, kind: 'thinking', text: clip(text, 4000) }] : [];
  }
  if (p.type === 'web_search_call') {
    ctx.searches ||= new Map();
    const actionKey = JSON.stringify(p.action || {}), searchId = key(p.call_id || p.id || fallback);
    const queue = ctx.searches.get(actionKey) || [];
    if (!queue.includes(searchId)) queue.push(searchId);
    boundedSet(ctx.searches, actionKey, queue.slice(-40));
    return [{ id: searchId, ts, kind: 'tool', name: 'WebSearch', input: { query: clip(p.action?.query || array(p.action?.queries).join('\n'), 1000) } }];
  }
  if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) {
    const callKey = p.call_id || p.id || fallback, signature = `${callKey}:${p.id || fallback}`;
    let callId = ctx.seenCalls.get(signature);
    if (!callId) {
      const n = (ctx.occurrences.get(callKey) || 0) + 1;
      boundedSet(ctx.occurrences, callKey, n); callId = key(`call:${callKey}:${n}`);
      boundedSet(ctx.seenCalls, signature, callId);
    }
    const input = json(p.arguments) || (typeof p.arguments === 'object' ? p.arguments : {}) || {};
    const cmd = command(input.cmd ?? input.command ?? p.action?.command), rawName = p.name || 'shell';
    let name = rawName, fields = slim(input);
    if (['exec_command', 'shell', 'shell_command'].includes(rawName) || p.type === 'local_shell_call') { name = 'Bash'; fields = { command: clip(cmd, 4000), workdir: clip(input.workdir || '', 1000) }; }
    else if (rawName === 'update_plan') { name = 'TodoWrite'; fields = { todos: array(input.plan).slice(0, 40).map((s) => ({ content: clip(s?.step, 200), status: s?.status })) }; }
    else if (p.type === 'custom_tool_call') fields = { input: clip(p.input, 4000) };
    const filePaths = rawName === 'apply_patch' ? patchFiles(p.input || input.patch || input.input, ctx.cwd) : [];
    const ids = filePaths.length ? filePaths.map((f) => `${callId}:${f}`) : [callId];
    const sensitive = sensitivePath(cmd) || filePaths.some(sensitivePath);
    boundedSet(ctx.calls, callKey, { id: callId, ids, sensitive });
    const ops = filePaths.length ? filePaths.map((f, n) => ({ id: ids[n], ts, kind: 'tool', name: 'Edit', input: { file_path: clip(f, 1000) } }))
      : [{ id: callId, ts, kind: 'tool', name: clip(name, 150), input: fields }];
    const early = ctx.outputs.get(callKey);
    if (early) {
      ctx.outputs.delete(callKey);
      for (const id of ids) ops.push({ id, result: true, priority: 1, res: sensitive ? { ...early, text: '[sensitive-file command output omitted]' } : early });
    }
    return ops;
  }
  if (['function_call_output', 'custom_tool_call_output'].includes(p.type) && p.call_id) {
    const call = ctx.calls.get(p.call_id), res = outputResult(p.output);
    if (!call) boundedSet(ctx.outputs, p.call_id, res);
    if (call?.sensitive) res.text = '[sensitive-file command output omitted]';
    return (call?.ids || [key(`call:${p.call_id}:1`)]).map((id) => ({ id, result: true, res, priority: 1 }));
  }
  return [];
}

export class Transcript {
  constructor(file, options = {}) {
    this.file = file;
    this.chunk = Math.max(1, Math.min(options.chunk || 1024 * 1024, 4 * 1024 * 1024));
    this.tailBytes = options.tailBytes ?? TAIL_BYTES;
    this.maxLine = options.maxLine ?? MAX_LINE;
    this.items = []; this.byId = new Map(); this.orphans = new Map(); this.ranks = new Map();
    this.ver = 0; this.generation = 0; this.title = options.name || null; this.size = 0;
    this.offset = 0; this.lineStart = 0; this.carry = ''; this.discard = false;
    this.decoder = new StringDecoder('utf8'); this.identity = null; this.context = {};
    this.seq = 0;
  }
  #reset() {
    this.items = []; this.byId.clear(); this.orphans.clear(); this.ranks.clear();
    this.offset = 0; this.lineStart = 0; this.carry = ''; this.discard = false;
    this.decoder = new StringDecoder('utf8'); this.context = {}; this.seq = 0;
    this.generation++; this.ver++;
  }
  #upsert(op) {
    if (!op?.id) return;
    if (op.result === true) {
      const priority = op.priority || 1;
      if ((this.ranks.get(op.id) || 0) > priority) return;
      const prev = this.byId.get(op.id);
      if (prev) {
        if (JSON.stringify(prev.result) !== JSON.stringify(op.res)) { prev.result = op.res; prev.v = ++this.ver; }
        this.ranks.set(op.id, priority);
      } else {
        const old = this.orphans.get(op.id);
        if (!old || old.priority <= priority) boundedSet(this.orphans, op.id, { res: op.res, priority });
      }
      return;
    }
    const prev = this.byId.get(op.id);
    if (prev) {
      if (Object.entries(op).some(([k, v]) => JSON.stringify(prev[k]) !== JSON.stringify(v))) { Object.assign(prev, op); prev.v = ++this.ver; }
      return;
    }
    const item = { ...op, seq: this.seq++, v: ++this.ver }, orphan = this.orphans.get(op.id);
    if (orphan) { item.result = orphan.res; this.ranks.set(op.id, orphan.priority); this.orphans.delete(op.id); }
    this.items.push(item); this.byId.set(item.id, item);
    if (this.items.length > MAX_ITEMS) {
      const removed = this.items.shift(); this.byId.delete(removed.id); this.ranks.delete(removed.id);
    }
  }
  #line(line, offset) {
    const entry = json(line);
    if (!entry) return;
    this.context.offset = offset;
    try {
      const oldMode = this.context.mode, ops = normalize(entry, this.context);
      if (!oldMode && this.context.mode === 'paginated' && this.items.length) {
        // A header from an older/foreign producer may omit history_mode. Once a
        // core display item establishes it, remove speculative protocol mirrors.
        this.items = []; this.byId.clear(); this.orphans.clear(); this.ranks.clear();
        this.seq = 0; this.generation++; this.ver++;
      }
      for (const op of ops) this.#upsert(op);
    } catch { /* an unsupported nested payload must not stall subsequent lines */ }
  }
  refresh() {
    let fd;
    const before = this.ver;
    try {
      fd = fs.openSync(this.file, 'r');
      const st = fs.fstatSync(fd), identity = `${st.dev}:${st.ino}`;
      if ((this.identity !== null && this.identity !== identity) || st.size < this.offset) this.#reset();
      this.identity = identity; this.size = st.size;
      if (this.offset === 0) {
        const meta = header(this.file);
        if (meta) normalize({ type: 'session_meta', payload: meta }, this.context);
        if (st.size > this.tailBytes) {
          this.offset = st.size - this.tailBytes; this.lineStart = this.offset;
          this.discard = true; // remain in discard mode until the first newline, even across chunks
        }
      }
      const buf = Buffer.alloc(this.chunk);
      while (this.offset < st.size) {
        const start = this.offset;
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - start), start);
        if (!n) break;
        for (let a = 0; a < n;) {
          const end = buf.subarray(0, n).indexOf(10, a), b = end < 0 ? n : end;
          if (!this.discard) {
            if (start + b - this.lineStart > this.maxLine) { this.discard = true; this.carry = ''; }
            else this.carry += this.decoder.write(buf.subarray(a, b));
          }
          if (b < n) {
            if (!this.discard) this.#line(this.carry + this.decoder.end(), this.lineStart);
            this.carry = ''; this.discard = false; this.decoder = new StringDecoder('utf8');
            this.lineStart = start + b + 1;
          }
          a = b < n ? b + 1 : n;
        }
        this.offset += n;
      }
    } catch { /* missing/replaced file: locating and the next refresh retry */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    return this.ver !== before;
  }
  delta(since = 0, limit = Infinity) {
    const changed = since === 0 ? this.items : this.items.filter((i) => i.v > since);
    return limit < changed.length ? changed.slice(-limit) : changed;
  }
  before(seq, limit = 100) {
    const idx = this.items.findIndex((i) => i.seq >= seq), end = idx < 0 ? this.items.length : idx;
    return this.items.slice(Math.max(0, end - limit), end);
  }
}

export const id = 'codex';
