import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transcript, normalize } from '../server/harness/claude.js';

const line = (o) => JSON.stringify({ sessionId: 's', isSidechain: false, ...o });
const user = (uuid, content, extra = {}) => line({ type: 'user', uuid, timestamp: '2026-10-10T01:00:00Z', message: { role: 'user', content }, ...extra });
const asst = (uuid, mid, block, extra = {}) => line({ type: 'assistant', uuid, timestamp: '2026-10-10T01:00:01Z', message: { id: mid, model: 'claude-x', role: 'assistant', content: [block] }, ...extra });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-')), 's.jsonl');

test('one assistant message split across lines becomes ordered items; results attach to their tool call', () => {
  const f = tmp();
  fs.writeFileSync(f, [
    user('u1', 'hello there'),
    asst('a1', 'm1', { type: 'thinking', thinking: '' }, { thinkingDurationMs: 2300 }),
    asst('a2', 'm1', { type: 'text', text: 'Let me look.' }),
    asst('a3', 'm1', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', description: 'List files' } }),
    user('u2', [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt\nb.txt', is_error: false }], { toolUseResult: { stdout: 'a.txt\nb.txt' } }),
    asst('a4', 'm2', { type: 'text', text: 'Two files.' }),
  ].join('\n') + '\n');
  const t = new Transcript(f); assert.ok(t.refresh());
  assert.deepEqual(t.items.map((i) => i.kind), ['user', 'thinking', 'assistant', 'tool', 'assistant']);
  const tool = t.items.find((i) => i.kind === 'tool');
  assert.equal(tool.name, 'Bash');
  assert.equal(tool.result.text, 'a.txt\nb.txt');
  assert.equal(t.items[1].ms, 2300);
});

test('noise is dropped: meta lines, sidechains, reminders, compact summaries; commands and notices are kept', () => {
  const out = [
    normalize(JSON.parse(user('m', 'caveat', { isMeta: true }))),
    normalize(JSON.parse(user('s', 'sub', { isSidechain: true }))),
    normalize(JSON.parse(user('r', '<system-reminder>be nice</system-reminder>'))),
    normalize(JSON.parse(user('c', 'summary of the past', { isCompactSummary: true }))),
    normalize(JSON.parse(user('l', '<local-command-caveat>x</local-command-caveat>'))),
  ];
  assert.deepEqual(out.flat(), []);
  assert.deepEqual(normalize(JSON.parse(user('k', '<command-name>/restart</command-name>\n<command-args></command-args>')))[0].text, '/restart');
  const task = normalize(JSON.parse(user('n', '<task-notification><summary>Build finished</summary></task-notification>')))[0];
  assert.equal(task.kind, 'notice'); assert.equal(task.text, 'Build finished');
  const compact = normalize(JSON.parse(line({ type: 'system', subtype: 'compact_boundary', uuid: 'cb' })))[0];
  assert.equal(compact.kind, 'notice');
});

test('tailing: only new lines are read, half-written lines wait, and edits carry their structured patch', () => {
  const f = tmp();
  fs.writeFileSync(f, user('u1', 'first') + '\n');
  const t = new Transcript(f); t.refresh();
  const v1 = t.ver;
  const second = asst('a1', 'm1', { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/x.js', old_string: 'a', new_string: 'b' } });
  fs.appendFileSync(f, second.slice(0, 40)); // half a line
  assert.equal(t.refresh(), false);
  fs.appendFileSync(f, second.slice(40) + '\n');
  assert.ok(t.refresh());
  fs.appendFileSync(f, user('u2', [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }], { toolUseResult: { structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }] } }) + '\n');
  assert.ok(t.refresh());
  assert.equal(t.items.length, 2);
  assert.deepEqual(t.items[1].result.patch[0].lines, ['-a', '+b']);
  const changed = t.delta(v1);
  assert.equal(changed.length, 1);          // only the edit call changed since v1 (the first user item did not)
  assert.equal(t.refresh(), false);
});

test('a result that arrives before its call (tail-only read) is attached when the call shows up', () => {
  const f = tmp();
  fs.writeFileSync(f, [user('u2', [{ type: 'tool_result', tool_use_id: 'z', content: 'late' }]), asst('a', 'm', { type: 'tool_use', id: 'z', name: 'Read', input: { file_path: '/y' } })].join('\n') + '\n');
  const t = new Transcript(f); t.refresh();
  assert.equal(t.items[0].result.text, 'late');
});

test('multi-byte characters survive being split across read chunks', () => {
  const f = tmp();
  const text = 'héllo wörld 🎉 日本語 '.repeat(40);
  fs.writeFileSync(f, user('u1', text) + '\n');
  const t = new Transcript(f, { chunk: 7 }); // tiny reads cut characters in half
  t.refresh();
  assert.equal(t.items[0].text, text.trim());
});

const qop = (operation, content, ts) => line({ type: 'queue-operation', operation, timestamp: ts, ...(content === undefined ? {} : { content }) });
const queued = (prompt, ts, extra = {}) => line({ type: 'attachment', uuid: 'a-' + prompt.length, timestamp: ts, attachment: { type: 'queued_command', prompt, delivery_id: 'd-' + prompt.length, origin: { kind: 'human' }, humanTurn: true, timestamp: ts, ...extra } });

test('a message typed while the agent is busy shows at once as queued, then becomes the delivered message in place', () => {
  const f = tmp();
  fs.writeFileSync(f, [user('u1', 'start'), asst('a1', 'm1', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 9' } })].join('\n') + '\n');
  const t = new Transcript(f); t.refresh();
  fs.appendFileSync(f, qop('enqueue', 'also fix the footer', '2026-10-10T01:00:05Z') + '\n');
  t.refresh();
  const q = t.items.find((i) => i.text === 'also fix the footer');
  assert.ok(q && q.queued === true && q.kind === 'user', 'visible while still queued');
  fs.appendFileSync(f, [qop('remove', 'also fix the footer', '2026-10-10T01:00:09Z'), queued('also fix the footer', '2026-10-10T01:00:05Z')].join('\n') + '\n');
  t.refresh();
  const same = t.items.filter((i) => i.text === 'also fix the footer');
  assert.equal(same.length, 1, 'no duplicate once delivered');
  assert.equal(same[0].queued, false);
  assert.equal(same[0].seq, q.seq, 'it keeps its place in the conversation');
});

test('a queued message that starts the next turn is merged with its normal user line; notifications and commands never show as queued', () => {
  const f = tmp();
  fs.writeFileSync(f, [
    user('u1', 'start'),
    qop('enqueue', 'and then deploy', '2026-10-10T01:00:05Z'),
    qop('enqueue', '<task-notification>\n<summary>Build done</summary>\n</task-notification>', '2026-10-10T01:00:06Z'),
    qop('enqueue', '/usage', '2026-10-10T01:00:07Z'),
  ].join('\n') + '\n');
  const t = new Transcript(f); t.refresh();
  assert.deepEqual(t.items.filter((i) => i.queued).map((i) => i.text), ['and then deploy']);
  fs.appendFileSync(f, [qop('dequeue', undefined, '2026-10-10T01:00:10Z'), user('u2', 'and then deploy')].join('\n') + '\n');
  t.refresh();
  assert.equal(t.items.filter((i) => i.text === 'and then deploy').length, 1);
  assert.equal(t.items.find((i) => i.text === 'and then deploy').queued, false);
});

test('two identical queued messages are delivered one by one', () => {
  const f = tmp();
  fs.writeFileSync(f, [user('u1', 'go'), qop('enqueue', 'again', '2026-10-10T01:00:05Z'), qop('enqueue', 'again', '2026-10-10T01:00:06Z')].join('\n') + '\n');
  const t = new Transcript(f); t.refresh();
  assert.equal(t.items.filter((i) => i.queued).length, 2);
  fs.appendFileSync(f, user('u2', 'again') + '\n'); t.refresh();
  assert.equal(t.items.filter((i) => i.queued).length, 1);
});

test('a mid-turn background-task notification is shown as a notice', () => {
  const ops = normalize(JSON.parse(queued('<task-notification>\n<summary>Monitor expired</summary>\n</task-notification>', '2026-10-10T01:00:05Z', { origin: { kind: 'task-notification' }, humanTurn: false })));
  assert.equal(ops.length, 1); assert.equal(ops[0].kind, 'notice'); assert.equal(ops[0].text, 'Monitor expired');
});

import { SubagentTracker } from '../server/harness/claude.js';
const launch = (id, input) => asst('a-' + id, 'm-' + id, { type: 'tool_use', id, name: 'Agent', input }, { timestamp: new Date().toISOString() });
const result = (id, text) => user('r-' + id, [{ type: 'tool_result', tool_use_id: id, content: text }]);

test('sub-agent tracker: foreground agents run until their result, background ones until their notification', () => {
  const f = tmp();
  fs.writeFileSync(f, [
    user('u1', 'go'),
    launch('fg1', { description: 'Triage crash reports', subagent_type: 'general-purpose', prompt: 'x' }),
    launch('fg2', { description: 'Check the docs', prompt: 'x' }),
    launch('bg1', { description: 'Slow build', run_in_background: true, prompt: 'x' }),
    result('bg1', 'Async agent launched successfully.\nagentId: abc'),
  ].join('\n') + '\n');
  const tr = new SubagentTracker(f); tr.refresh();
  assert.deepEqual(tr.running.map((a) => a.label), ['Triage crash reports', 'Check the docs', 'Slow build']);
  fs.appendFileSync(f, result('fg1', 'done') + '\n'); tr.refresh();
  assert.deepEqual(tr.running.map((a) => a.label), ['Check the docs', 'Slow build'], 'a result ends a foreground agent');
  fs.appendFileSync(f, qop('enqueue', '<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>bg1</tool-use-id>\n<status>completed</status>\n</task-notification>', '2026-10-10T01:05:00Z') + '\n'); tr.refresh();
  assert.deepEqual(tr.running.map((a) => a.label), ['Check the docs'], 'a notification ends a background agent');
  assert.equal(tr.running[0].bg, false);
});

test('sub-agent tracker: sidechain lines and unrelated tool calls are ignored; a reset clears it', () => {
  const f = tmp();
  fs.writeFileSync(f, [asst('a1', 'm1', { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }), line({ type: 'assistant', isSidechain: true, uuid: 'x', message: { content: [{ type: 'tool_use', id: 'sc', name: 'Agent', input: { description: 'nested' } }] } })].join('\n') + '\n');
  const tr = new SubagentTracker(f); tr.refresh();
  assert.equal(tr.running.length, 0);
  fs.writeFileSync(f, launch('n1', { description: 'fresh' }) + '\n'); tr.refresh();
  assert.deepEqual(tr.running.map((a) => a.label), ['fresh']);
  fs.writeFileSync(f, user('u9', 'new session') + '\n'); tr.refresh();
  assert.equal(tr.running.length, 0, 'file replaced (e.g. /clear) -> start over');
});

test('sub-agent tracker: a launch that never ended and is many hours old is not "running"', () => {
  const f = tmp();
  fs.writeFileSync(f, asst('a1', 'm1', { type: 'tool_use', id: 'old', name: 'Agent', input: { description: 'ancient' } }, { timestamp: '2020-01-01T00:00:00Z' }) + '\n');
  const tr = new SubagentTracker(f); tr.refresh();
  assert.equal(tr.running.length, 0);
});

test('sub-agent tracker: an interim notification (the agent still has background work) does not end the agent; the final one does', () => {
  const f = tmp();
  fs.writeFileSync(f, [user('u1', 'go'), launch('ag1', { description: 'Slow job', run_in_background: true }), result('ag1', 'Async agent launched successfully.\nagentId: abc123 (internal ID)')].join('\n') + '\n');
  const tr = new SubagentTracker(f); tr.refresh();
  const note = (extra, result = 'This agent has not reported yet: it is waiting on its own background work and will deliver its report through SubagentHandback when that finishes.') => qop('enqueue', `<task-notification>\n<tool-use-id>ag1</tool-use-id>\n<status>completed</status>\n<summary>Agent "Slow job" finished</summary>\n<note>${extra}</note>\n<result>${result}</result>\n</task-notification>`, '2026-10-10T01:05:00Z');
  fs.appendFileSync(f, note('This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.') + '\n'); tr.refresh();
  assert.deepEqual(tr.running.map((a) => a.label), ['Slow job'], 'interim: still running');
  // the final report names the <task-id> (the agentId from the launch result) and has no <tool-use-id>
  fs.appendFileSync(f, qop('enqueue', '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n<summary>Agent "Slow job" finished</summary>\n<note>This agent stopped with background work of its own still running (stale wording).</note>\n<result>This agent\'s report was delivered to you as a message from "x".</result>\n</task-notification>', '2026-10-10T01:06:00Z') + '\n'); tr.refresh();
  assert.equal(tr.running.length, 0, 'final: done');
  const [n] = normalize(JSON.parse(user('u2', '<task-notification>\n<summary>Agent "Slow job" finished</summary>\n<note>This agent stopped with background work of its own still running.</note>\n<result>This agent has not reported yet.</result>\n</task-notification>')));
  assert.match(n.text, /paused, waiting on its own background work/);
});
