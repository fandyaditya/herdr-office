import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locate, normalize, Transcript } from '../server/harness/codex.js';
import { adapterFor } from '../server/harness/index.js';

const SID = '01a12479-0507-78d1-998b-ede8610c3513';
const OTHER = '01a11eac-d077-71f2-b887-4ff13a863f3d';
const event = (type, payload, extra = {}) => ({ timestamp: '2026-10-10T06:21:13Z', type, payload, ...extra });
const meta = (mode = 'paginated', extra = {}) => event('session_meta', { id: SID, history_mode: mode, cwd: '/project', ...extra });
const item = (type, id, fields = {}) => event('event_msg', { type: 'item_completed', thread_id: SID, turn_id: 'turn1', item: { type, id, ...fields } });
const msg = (id, text) => item('AgentMessage', id, { content: [{ type: 'Text', text }] });
const protocol = (type, fields = {}) => event('response_item', { type, ...fields });
const call = (id = 'call1', command = 'ls', extra = {}) => protocol('function_call', { name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd: command }), ...extra });
const result = (id = 'call1', output = 'ok') => protocol('function_call_output', { call_id: id, output });
const write = (file, entries) => fs.writeFileSync(file, entries.map(JSON.stringify).join('\n') + '\n');
const append = (file, ...entries) => fs.appendFileSync(file, entries.map(JSON.stringify).join('\n') + '\n');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-chat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function transcript(t, entries, options) {
  const file = path.join(temp(t), 'rollout.jsonl'); write(file, entries);
  const tr = new Transcript(file, options); tr.refresh(); return tr;
}

test('Codex is registered; paginated display items suppress protocol mirrors and system noise', (t) => {
  assert.equal(adapterFor('codex').Transcript, Transcript);
  const tr = transcript(t, [meta(),
    protocol('message', { role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] }),
    protocol('message', { role: 'user', content: [{ type: 'input_text', text: 'hello' }] }),
    item('UserMessage', 'u', { content: [{ type: 'text', text: 'hello' }, { type: 'image', image_url: 'data:image/png;base64,hidden' }, { type: 'local_image', path: '/x.png' }] }),
    protocol('message', { id: 'a', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] }),
    item('AgentMessage', 'a', { content: [{ type: 'Text', text: 'reply' }, { type: 'Text', text: 'second block' }] }),
    protocol('custom_tool_call', { name: 'functions.exec', call_id: 'wrapper', input: 'orchestration code' }),
    event('world_state', { full: true, state: { private: 'hidden' } }),
    event('event_msg', { type: 'task_complete', last_agent_message: 'reply' }),
  ]);
  assert.deepEqual(tr.items.map((i) => i.kind), ['user', 'assistant']);
  assert.equal(tr.items[0].images, 2);
  assert.equal(tr.items[1].text, 'reply\nsecond block');
  assert.equal(tr.items[0].id, `${SID}:u`);
  assert.doesNotMatch(JSON.stringify(tr.items), /data:image|instructions|orchestration|hidden/);
});

test('completed tools have statuses and per-file real diffs, including lines beginning --- or +++', (t) => {
  const tr = transcript(t, [meta(), item('CommandExecution', 'shell', { command: ['bash', '-lc', 'false'], status: 'failed', exit_code: 1, aggregated_output: 'failed test' }),
    item('FileChange', 'patch', { status: 'completed', changes: {
      '/project/a': { type: 'update', unified_diff: '@@ -2,2 +2,2 @@\n---literal\n+++literal\n context\n' },
      '/project/b': { type: 'add', content: 'new\nfile' },
      '/project/c': { type: 'delete', content: 'old' },
    } }),
  ]);
  assert.equal(tr.items.length, 4);
  assert.equal(tr.items[0].name, 'Bash'); assert.equal(tr.items[0].input.command, 'false');
  assert.equal(tr.items[0].result.error, true);
  assert.deepEqual(tr.items[1].result.patch, [{ oldStart: 2, newStart: 2, lines: ['---literal', '+++literal', ' context'] }]);
  assert.deepEqual(tr.items[2].result.patch[0].lines, ['+new', '+file']);
  assert.deepEqual(tr.items[3].result.patch[0].lines, ['-old']);
  assert.equal(new Set(tr.items.map((i) => i.id)).size, 4);
});

test('display tool completion updates the same sequence and version without duplicating replayed records', (t) => {
  const pending = item('CommandExecution', 'exec1', { command: ['ls'], status: 'in_progress' });
  const tr = transcript(t, [meta(), pending]);
  const v = tr.ver;
  assert.equal(tr.items[0].result, undefined);
  const completed = item('CommandExecution', 'exec1', { command: ['ls'], status: 'completed', exit_code: 0, aggregated_output: 'a.txt' });
  append(tr.file, completed); assert.equal(tr.refresh(), true);
  assert.equal(tr.items.length, 1); assert.equal(tr.items[0].seq, 0);
  assert.equal(tr.delta(v)[0].result.text, 'a.txt');
  append(tr.file, completed); assert.equal(tr.refresh(), false);
  assert.equal(tr.before(1).length, 1);
});

test('reasoning exposes only summary text; compaction, interrupt and subagent notices stay separate', (t) => {
  const tr = transcript(t, [meta(), item('Reasoning', 'r', { summary_text: ['Checking the tests'], raw_content: ['PRIVATE REASONING'] }),
    protocol('reasoning', { encrypted_content: 'opaque', summary: [{ type: 'summary_text', text: 'duplicate' }] }),
    event('compacted', { message: 'PRIVATE SUMMARY', replacement_history: [msg('bad', 'duplicate')] }),
    item('ContextCompaction', 'compact'), item('SubAgentActivity', 'child', { kind: 'started', agent_path: '/root/test' }),
    event('event_msg', { type: 'turn_aborted', reason: 'interrupted' }),
  ]);
  assert.deepEqual(tr.items.map((i) => i.kind), ['thinking', 'notice', 'notice', 'notice']);
  assert.equal(tr.items[0].ms, undefined);
  assert.doesNotMatch(JSON.stringify(tr.items), /PRIVATE|opaque|duplicate/);
});

test('legacy delayed and orphan results pair; repeated call IDs remain distinct; richer results beat mirrors', (t) => {
  const tr = transcript(t, [meta('legacy'), result('orphan', [{ type: 'input_text', text: 'arrived first' }]), call('orphan'),
    call('repeat', 'first'), result('repeat', 'one'), call('repeat', 'second'),
    event('event_msg', { type: 'exec_command_end', call_id: 'repeat', exit_code: 2, aggregated_output: 'rich failure' }), result('repeat', 'mirror'),
  ]);
  assert.equal(tr.items.length, 3);
  assert.equal(tr.items[0].result.text, 'arrived first');
  assert.equal(tr.items[1].result.text, 'one'); assert.equal(tr.items[1].input.command, 'first');
  assert.equal(tr.items[2].result.text, 'rich failure'); assert.equal(tr.items[2].result.error, true);
  assert.notEqual(tr.items[1].id, tr.items[2].id);
  const v = tr.ver;
  append(tr.file, call('late')); tr.refresh();
  append(tr.file, result('late', 'Process exited with code 3\nOutput:\nno')); tr.refresh();
  assert.equal(tr.delta(v).length, 1); assert.equal(tr.items.at(-1).result.error, true);
});

test('legacy apply_patch pending cards acquire structured diffs without extra tool cards', (t) => {
  const tr = transcript(t, [meta('legacy'), protocol('custom_tool_call', { name: 'apply_patch', call_id: 'patch', input: '*** Begin Patch\n*** Update File: a.js\n@@\n-old\n+new\n*** End Patch' })]);
  assert.equal(tr.items.length, 1); assert.equal(tr.items[0].input.file_path, '/project/a.js');
  const v = tr.ver;
  append(tr.file, result('patch', 'ok'), event('event_msg', { type: 'patch_apply_end', call_id: 'patch', success: true, changes: { '/project/a.js': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new' } } }));
  tr.refresh();
  assert.equal(tr.items.length, 1); assert.equal(tr.delta(v).length, 1);
  assert.deepEqual(tr.items[0].result.patch[0].lines, ['-old', '+new']);
});

test('an orphan result also attaches to a later multi-file patch call', (t) => {
  const tr = transcript(t, [meta('legacy'), result('patch', 'done'),
    protocol('custom_tool_call', { name: 'apply_patch', call_id: 'patch', input: '*** Begin Patch\n*** Add File: a\n+new\n*** Add File: b\n+new\n*** End Patch' }),
  ]);
  assert.equal(tr.items.length, 2);
  assert.ok(tr.items.every((i) => i.result?.text === 'done'));
});

test('legacy filters scaffolding while retaining user text following environment blocks', (t) => {
  const tr = transcript(t, [meta('legacy'), protocol('message', { role: 'user', content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>\nPlease fix this.' }] }),
    protocol('message', { role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /project\n<INSTRUCTIONS>hidden</INSTRUCTIONS>' }] }),
    event('event_msg', { type: 'user_message', message: 'duplicate' }),
  ]);
  assert.equal(tr.items.length, 1); assert.equal(tr.items[0].text, 'Please fix this.');
});

test('UTF-8 survives tiny chunks and a half-written record waits for its newline', (t) => {
  const tr = transcript(t, [meta(), msg('first', 'héllo 🐑 日本語')], { chunk: 1 });
  assert.equal(tr.items[0].text, 'héllo 🐑 日本語');
  const b = Buffer.from(JSON.stringify(msg('next', '🐑')) + '\n'), split = b.indexOf(Buffer.from('🐑')) + 2;
  fs.appendFileSync(tr.file, b.subarray(0, split)); assert.equal(tr.refresh(), false);
  fs.appendFileSync(tr.file, b.subarray(split)); assert.equal(tr.refresh(), true);
  assert.equal(tr.items[1].text, '🐑'); assert.equal(tr.refresh(), false);
});

test('tail bootstrap reads mode from header and discards the initial partial record across chunks', (t) => {
  const tail = JSON.stringify(msg('keep', 'tail reply')) + '\n';
  const tr = transcript(t, [meta(), msg('large', 'x'.repeat(2000)), msg('keep', 'tail reply')], { chunk: 7, tailBytes: Buffer.byteLength(tail) + 300 });
  assert.deepEqual(tr.items.map((i) => i.text), ['tail reply']);
  const full = transcript(t, [meta(), msg('large', 'x'.repeat(2000)), msg('keep', 'tail reply')]);
  assert.equal(tr.items[0].id, full.items.at(-1).id);
});

test('oversized and malformed lines are skipped and subsequent IDs use absolute byte offsets', (t) => {
  const file = path.join(temp(t), 'rollout.jsonl');
  const good = event('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] });
  fs.writeFileSync(file, JSON.stringify(meta('legacy')) + '\n' + 'x'.repeat(1000) + '\n{bad}\n' + JSON.stringify(good) + '\n');
  const a = new Transcript(file, { chunk: 3, maxLine: 500 }); a.refresh();
  const b = new Transcript(file, { chunk: 83, maxLine: 500 }); b.refresh();
  assert.equal(a.items.length, 1); assert.equal(a.items[0].text, 'ok');
  assert.equal(a.items[0].id, b.items[0].id); assert.equal(a.carry, '');
});

test('inode replacement and truncation clear stale history and increment the reset generation', (t) => {
  const tr = transcript(t, [meta(), msg('a', 'old')]);
  const next = `${tr.file}.next`; write(next, [meta(), msg('b', 'new')]); fs.renameSync(next, tr.file);
  assert.equal(tr.refresh(), true); assert.equal(tr.generation, 1);
  assert.deepEqual(tr.items.map((i) => i.text), ['new']);
  fs.truncateSync(tr.file); assert.equal(tr.refresh(), true); assert.equal(tr.generation, 2); assert.equal(tr.items.length, 0);
  append(tr.file, meta(), msg('c', 'again')); tr.refresh(); assert.equal(tr.items[0].text, 'again');
});

test('display allowlists redact credentials and suppress sensitive-file command output and patches', (t) => {
  const fake = 'sk-' + 'a'.repeat(28);
  const tr = transcript(t, [meta(), msg('a', `Bearer fake-bearer-value api_key="fake-key-value" ${fake}`),
    item('CommandExecution', 'read', { command: ['cat', '/home/demo/.codex/auth.json'], status: 'completed', aggregated_output: 'sensitive body' }),
    item('FileChange', 'secret', { status: 'completed', changes: { '/project/.env': { type: 'add', content: 'sensitive body' } } }),
    item('McpToolCall', 'mcp', { tool: 'read', arguments: { access_token: 'fake-access-value', nested: { password: 'fake-password' }, query: 'safe' }, status: 'completed', result: { content: [{ type: 'text', text: 'done' }] } }),
  ]);
  const out = JSON.stringify(tr.items);
  assert.doesNotMatch(out, /fake-bearer-value|fake-key-value|fake-access-value|fake-password|sensitive body|sk-aaaa/);
  assert.match(out, /credential omitted/); assert.match(out, /safe/);
  assert.equal(tr.items[2].result.patch, undefined);
});

test('unknown and malformed schema fields do not abort later records', (t) => {
  const tr = transcript(t, [meta(), null, event('event_msg', { type: 'item_completed', item: { type: 'FutureKind' } }),
    item('UserMessage', 'empty', { content: [null, 1, {}] }),
    item('WebSearch', 'malformed', { action: { queries: 5 } }), msg('ok', 'still works')]);
  assert.deepEqual(tr.items.map((i) => i.text), ['still works']);
  assert.deepEqual(normalize({ type: 'response_item', payload: null }), []);
});

test('a missing history_mode is inferred from core display items and clears protocol mirrors', (t) => {
  const tr = transcript(t, [meta(undefined, { history_mode: undefined }),
    protocol('message', { role: 'user', content: [{ type: 'input_text', text: 'hello' }] }),
    item('UserMessage', 'u', { content: [{ type: 'text', text: 'hello' }] }),
    protocol('message', { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }), msg('a', 'answer'),
  ]);
  assert.deepEqual(tr.items.map((i) => i.text), ['hello', 'answer']);
  assert.equal(tr.generation, 1);
});

test('legacy hosted search pairs its result by action when the call has no call_id', (t) => {
  const action = { type: 'search', query: 'Codex documentation' };
  const tr = transcript(t, [meta('legacy'), protocol('web_search_call', { id: 'search', action }),
    event('event_msg', { type: 'web_search_end', call_id: 'call_search', action, results: [{ title: 'Docs', url: 'https://example.com/docs' }] }),
  ]);
  assert.equal(tr.items.length, 1); assert.equal(tr.items[0].name, 'WebSearch');
  assert.match(tr.items[0].result.text, /https:\/\/example.com\/docs/);
});

test('repeated hosted search actions have separate results and duplicate completions keep their target', (t) => {
  const action = { type: 'search', query: 'same query' };
  const end = (id, title) => event('event_msg', { type: 'web_search_end', call_id: id, action, results: [{ title }] });
  const tr = transcript(t, [meta('legacy'), protocol('web_search_call', { id: 'first', action }),
    protocol('web_search_call', { id: 'second', action }), end('result1', 'one'), end('result1', 'one'), end('result2', 'two'),
  ]);
  assert.deepEqual(tr.items.map((i) => i.result.text.trim()), ['one', 'two']);
});

function locating(t) {
  const home = temp(t), root = path.join(home, 'sessions', '2026', '10', '10');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `rollout-2026-10-10T06-21-13-${SID}.jsonl`); write(file, [meta()]);
  const info = { process_info: { pane_id: 'wA:p7', foreground_processes: [{ pid: 123456789, name: 'codex', argv: ['codex'], cwd: '/project' }] } };
  const options = { home, readFd: () => [], readChildren: () => [] };
  return { home, root, file, info, options };
}
test('locator validates an owned rollout FD or explicit binding and never guesses by cwd', (t) => {
  const { file, info, options } = locating(t);
  assert.equal(locate(info, options), null);
  assert.equal(locate({ result: info }, { ...options, readFd: () => [file] }).sessionId, SID);
  assert.equal(locate(info, { ...options, binding: { sessionId: SID } }).file, file);
  assert.equal(locate(info, { ...options, binding: { sessionId: SID, file, pid: 99 } }), null);
  assert.equal(locate(info, { ...options, binding: { sessionId: '../auth' } }), null);
  const otherProc = { process_info: { foreground_processes: [{ pid: 123456789, name: 'cursor', argv: ['cursor-agent'] }] } };
  assert.equal(locate(otherProc, { ...options, readFd: () => [file] }), null);
});

test('locator handles dedicated descendants and lock FDs, rejecting multiple root sessions', (t) => {
  const { home, root, file, info, options } = locating(t);
  const another = path.join(root, `rollout-2026-10-10T06-21-14-${OTHER}.jsonl`);
  write(another, [meta('paginated', { id: OTHER })]);
  const descendant = { ...options, readChildren: (pid) => pid === 123456789 ? [55] : [], readFd: (pid) => pid === 55 ? [file] : [] };
  assert.equal(locate(info, descendant).sessionId, SID);
  assert.equal(locate(info, { ...options, readFd: () => [file, another] }), null);
  write(another, [meta('paginated', { id: OTHER, source: { subagent: { thread_spawn: {} } } })]);
  assert.equal(locate(info, { ...options, readFd: () => [file, another] }).sessionId, SID);
  assert.equal(locate(info, { ...options, readFd: () => [path.join(home, 'thread-writer-locks', `${SID}.lock`)] }).file, file);
});

test('locator rejects paths outside Codex home, escaping symlinks and mismatched headers', (t) => {
  const { root, file, info, options } = locating(t);
  const outside = path.join(temp(t), `rollout-${OTHER}.jsonl`); write(outside, [meta()]);
  const linked = path.join(root, `rollout-escaped-${OTHER}.jsonl`); fs.symlinkSync(outside, linked);
  assert.equal(locate(info, { ...options, readFd: () => [outside, linked] }), null);
  assert.equal(locate(info, { ...options, binding: { sessionId: OTHER, file } }), null);
});

test('manual session bindings require a matching foreground PID', (t) => {
  const { file, info, options } = locating(t), old = process.env.OFFICE_CODEX_SESSIONS;
  t.after(() => { if (old === undefined) delete process.env.OFFICE_CODEX_SESSIONS; else process.env.OFFICE_CODEX_SESSIONS = old; });
  const configure = (binding) => { process.env.OFFICE_CODEX_SESSIONS = JSON.stringify({ 'wA:p7': binding }); };
  configure({ sessionId: SID }); assert.equal(locate(info, options), null);
  configure({ pid: 99, sessionId: SID }); assert.equal(locate(info, options), null);
  configure({ pid: 123456789, sessionId: SID }); assert.equal(locate(info, options).file, file);
});
