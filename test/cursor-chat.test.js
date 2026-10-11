import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Transcript, normalize, locate, sessionFromFdTargets, encodeProjectDir } from '../server/harness/cursor.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cur-'));
const line = (o) => JSON.stringify(o);
const userQuery = (text, extra = '') => line({
  role: 'user',
  message: { content: [{ type: 'text', text: `<timestamp>Saturday, Oct 10, 2026, 6:21 AM (UTC)</timestamp>\n${extra}<user_query>\n${text}\n</user_query>` }] },
});
const asst = (blocks) => line({ role: 'assistant', message: { content: blocks } });

test('user_query is unwrapped, user_info is dropped, images are counted', () => {
  const u = normalize(JSON.parse(userQuery('Fix the drawer', '<image_files>\n1. /tmp/a.png\n2. /tmp/b.jpg\n</image_files>\n')))[0];
  assert.equal(u.kind, 'user');
  assert.equal(u.text, 'Fix the drawer');
  assert.equal(u.images, 2);
  assert.ok(u.ts);
  assert.deepEqual(normalize({ role: 'user', message: { content: '<user_info>\nOS Version: linux\n</user_info>' } }), []);
});

test('one user turn split across assistant lines; Shell/StrReplace map to Bash/Edit', () => {
  const f = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(f, [
    userQuery('hello'),
    asst([{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', name: 'Shell', input: { command: 'ls', description: 'List' } }]),
    asst([{ type: 'tool_use', name: 'StrReplace', input: { path: '/x.js', old_string: 'a', new_string: 'b' } }]),
    asst([{ type: 'text', text: 'Done.' }]),
  ].join('\n') + '\n');
  const t = new Transcript(f);
  assert.ok(t.refresh());
  assert.deepEqual(t.items.map((i) => i.kind), ['user', 'assistant', 'tool', 'tool', 'assistant']);
  assert.equal(t.items[2].name, 'Bash');
  assert.equal(t.items[2].input.command, 'ls');
  assert.equal(t.items[3].name, 'Edit');
  assert.equal(t.items[3].input.file_path, '/x.js');
  assert.equal(t.items[3].input.old_string, 'a');
});

test('noise is dropped: [REDACTED], successful turn_ended; aborted is a notice', () => {
  assert.deepEqual(normalize({ role: 'assistant', message: { content: [{ type: 'text', text: '[REDACTED]' }] } }), []);
  assert.deepEqual(normalize({ type: 'turn_ended', status: 'success' }), []);
  const n = normalize({ type: 'turn_ended', status: 'error', error: 'stopped' }, 9);
  assert.equal(n[0].kind, 'notice');
  assert.match(n[0].text, /stopped/);
});

test('tailing: only new lines are read and half-written lines wait', () => {
  const f = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(f, userQuery('first') + '\n');
  const t = new Transcript(f, { chunk: 8 });
  t.refresh();
  const v1 = t.ver;
  const second = asst([{ type: 'text', text: 'more' }]);
  fs.appendFileSync(f, second.slice(0, 20));
  assert.equal(t.refresh(), false);
  fs.appendFileSync(f, second.slice(20) + '\n');
  assert.ok(t.refresh());
  assert.equal(t.items.length, 2);
  assert.equal(t.delta(v1).length, 1);
  assert.equal(t.refresh(), false);
});

test('Write contents is mapped to content so the UI can synth a diff', () => {
  const [op] = normalize({
    role: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Write', input: { path: '/a.js', contents: 'hi' } }] },
  }, 1);
  assert.equal(op.name, 'Write');
  assert.equal(op.input.file_path, '/a.js');
  assert.equal(op.input.content, 'hi');
});

test('store.db tool-result attaches to the matching JSONL tool call', () => {
  const dir = tmp();
  const jsonl = path.join(dir, 's.jsonl');
  const store = path.join(dir, 'store.db');
  fs.writeFileSync(jsonl, [
    userQuery('run it'),
    asst([{ type: 'tool_use', name: 'Shell', input: { command: 'ls', description: 'List' } }]),
  ].join('\n') + '\n');
  const db = new DatabaseSync(store);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
  const call = {
    role: 'assistant', content: [{
      type: 'tool-call', toolCallId: 'c1', toolName: 'Shell', args: { command: 'ls', description: 'List' },
    }],
  };
  const res = {
    role: 'tool', content: [{
      type: 'tool-result', toolCallId: 'c1', toolName: 'Shell', result: 'Exit code: 0\n\nCommand output:\na.txt\n',
    }],
  };
  db.prepare('INSERT INTO blobs VALUES (?, ?)').run('1', Buffer.from(JSON.stringify(call)));
  db.prepare('INSERT INTO blobs VALUES (?, ?)').run('2', Buffer.from(JSON.stringify(res)));
  db.close();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ title: 'Research Task', cwd: '/tmp' }));
  const t = new Transcript(jsonl, { store });
  t.refresh();
  assert.equal(t.title, 'Research Task');
  const tool = t.items.find((i) => i.kind === 'tool');
  assert.equal(tool.name, 'Bash');
  assert.match(tool.result.text, /a\.txt/);
  assert.equal(tool.result.error, false);
});

test('a failed shell result is marked error; late results attach on the next refresh', () => {
  const dir = tmp();
  const jsonl = path.join(dir, 's.jsonl');
  const store = path.join(dir, 'store.db');
  fs.writeFileSync(jsonl, asst([{ type: 'tool_use', name: 'Shell', input: { command: 'false' } }]) + '\n');
  const db = new DatabaseSync(store);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  db.close();
  const t = new Transcript(jsonl, { store });
  t.refresh();
  assert.equal(t.items[0].result, undefined);
  const db2 = new DatabaseSync(store);
  db2.prepare('INSERT INTO blobs VALUES (?, ?)').run('r', Buffer.from(JSON.stringify({
    role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x', toolName: 'Shell', result: 'Exit code: 1\n\nCommand output:\nnope\n' }],
  })));
  db2.close();
  assert.ok(t.refresh());
  assert.equal(t.items[0].result.error, true);
  assert.match(t.items[0].result.text, /nope/);
});

test('locate reads the store.db path from open fds and does not use cwd+newest', () => {
  const home = tmp();
  const cwd = '/home/demo/projects/herdr-office';
  const hash = crypto.createHash('md5').update(cwd).digest('hex');
  const id = 'e7f0f20d-1017-42a4-9a05-d201e0944d81';
  const storeDir = path.join(home, 'chats', hash, id);
  fs.mkdirSync(storeDir, { recursive: true });
  const store = path.join(storeDir, 'store.db');
  fs.writeFileSync(store, '');
  fs.writeFileSync(path.join(storeDir, 'meta.json'), JSON.stringify({ title: 'Research Task', cwd }));
  const jsonlDir = path.join(home, 'projects', encodeProjectDir(cwd), 'agent-transcripts', id);
  fs.mkdirSync(jsonlDir, { recursive: true });
  const jsonl = path.join(jsonlDir, `${id}.jsonl`);
  fs.writeFileSync(jsonl, userQuery('hi') + '\n');
  const info = {
    process_info: {
      foreground_processes: [
        { pid: 11, cmdline: '/bin/cursor-agent --force', cwd, argv: ['/bin/cursor-agent'] },
      ],
    },
  };
  const loc = locate(info, { home, readFd: () => [`${store}-wal`, store] });
  assert.equal(loc.sessionId, id);
  assert.equal(loc.file, jsonl);
  assert.equal(loc.store, store);
  assert.equal(loc.name, 'Research Task');
  assert.equal(locate(info, { home, readFd: () => [] }), null);
});

test('sessionFromFdTargets ignores unrelated files and strips -wal', () => {
  const id = '2438b480-e191-45f6-bc38-22968dbb667a';
  const store = `/home/demo/.cursor/chats/02d70a05d484ac797dcb6d126d88da70/${id}/store.db`;
  assert.equal(sessionFromFdTargets(['/dev/null', `${store}-wal`]).sessionId, id);
  assert.equal(sessionFromFdTargets(['/home/demo/.cursor/ai-tracking/ai-code-tracking.db']), null);
});

// Cursor writes a user turn as a bare <timestamp> line and fills in <user_query> by rewriting that line a moment later;
// it also rewrites the whole file now and then. Reading only appended bytes lost those messages (no bubble, just replies).
const bare = () => line({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Sunday, Oct 11, 2026, 11:00 AM (UTC)</timestamp>' }] } });
const kinds = (t) => t.items.map((i) => `${i.kind}${i.text ? ':' + i.text.slice(0, 12) : ''}`);

test('a user turn whose text is filled in by rewriting the last line shows up, before the reply', () => {
  const f = path.join(tmp(), 'inplace.jsonl');
  fs.writeFileSync(f, [asst([{ type: 'text', text: 'Earlier answer.' }]), bare()].join('\n') + '\n');
  const t = new Transcript(f);
  t.refresh();
  assert.deepEqual(kinds(t), ['assistant:Earlier answ']);          // the bare line has nothing to show yet
  fs.writeFileSync(f, [asst([{ type: 'text', text: 'Earlier answer.' }]), userQuery('How small can it get?')].join('\n') + '\n');
  assert.ok(t.refresh());
  assert.deepEqual(kinds(t), ['assistant:Earlier answ', 'user:How small ca']);
  fs.appendFileSync(f, asst([{ type: 'text', text: 'Pretty small.' }]) + '\n');
  t.refresh();
  assert.deepEqual(kinds(t), ['assistant:Earlier answ', 'user:How small ca', 'assistant:Pretty small']);
});

test('a text that arrives after the reply began is put in order (everything is rebuilt once, viewers reset)', () => {
  const f = path.join(tmp(), 'late.jsonl');
  fs.writeFileSync(f, [asst([{ type: 'text', text: 'one' }]), bare(), asst([{ type: 'text', text: 'two' }])].join('\n') + '\n');
  const t = new Transcript(f);
  t.refresh();
  const gen = t.generation;
  fs.writeFileSync(f, [asst([{ type: 'text', text: 'one' }]), userQuery('late question'), asst([{ type: 'text', text: 'two' }])].join('\n') + '\n');
  assert.ok(t.refresh());
  assert.deepEqual(kinds(t), ['assistant:one', 'user:late questio', 'assistant:two']);
  assert.ok(t.generation > gen, 'viewers are told to start over');
  assert.deepEqual(t.items.map((i) => i.seq), [0, 1, 2]);
});

test('a rewritten file (larger, different start) is read from scratch instead of from the old offset', () => {
  const f = path.join(tmp(), 'rewrite.jsonl');
  fs.writeFileSync(f, [userQuery('first'), asst([{ type: 'text', text: 'reply one' }])].join('\n') + '\n');
  const t = new Transcript(f);
  t.refresh();
  fs.writeFileSync(f, [userQuery('first, now much longer than before'), asst([{ type: 'text', text: 'reply one, also longer' }]), userQuery('second'), asst([{ type: 'text', text: 'reply two' }])].join('\n') + '\n');
  assert.ok(t.refresh());
  assert.deepEqual(kinds(t), ['user:first, now m', 'assistant:reply one, a', 'user:second', 'assistant:reply two']);
});

test('re-reading the tail is quiet when nothing changed (no version churn for viewers)', () => {
  const f = path.join(tmp(), 'quiet.jsonl');
  fs.writeFileSync(f, [userQuery('q'), asst([{ type: 'text', text: 'a' }])].join('\n') + '\n');
  const t = new Transcript(f);
  t.refresh();
  const ver = t.ver;
  const later = new Date(Date.now() + 5000); fs.utimesSync(f, later, later); // touched, same content
  assert.equal(t.refresh(), false);
  assert.equal(t.ver, ver);
  fs.appendFileSync(f, asst([{ type: 'text', text: 'b' }]) + '\n');
  assert.ok(t.refresh());
  assert.equal(t.items.length, 3);
});
