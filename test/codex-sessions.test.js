import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { namedSessions, titleMatches } from '../server/harness/codex-sessions.js';
import { locate } from '../server/harness/codex.js';

const A = '01a12479-0507-78d1-998b-ede8610c3513';
const B = '01a11eac-d077-71f2-b887-4ff13a863f3d';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-names-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'sessions'); fs.mkdirSync(root);
  const rows = [A, B].map((sessionId, i) => {
    const file = path.join(root, `rollout-${sessionId}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/project' } }) + '\n');
    return { sessionId, file, cwd: '/project', name: i ? 'Other thread' : 'Fix login' };
  });
  execFileSync('python3', ['-c', `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1])
c.execute('create table threads (id text,rollout_path text,cwd text,name text)')
c.executemany('insert into threads values (?,?,?,?)',[(r['sessionId'],r['file'],r['cwd'],r['name']) for r in json.loads(sys.argv[2])])
c.commit()`, path.join(home, 'state_5.sqlite'), JSON.stringify(rows)]);
  const info = { process_info: { pane_id: 'w1:p1', foreground_processes: [{ pid: 987654321, name: 'codex', cwd: '/project' }] },
    pane: { terminal_title_stripped: 'Fix login | project' } };
  const options = { home, readFd: () => [], readChildren: () => [] };
  return { home, rows, info, options };
}

test('shared daemon resolves named threads in the same cwd without manual bindings; switches and new threads revalidate', (t) => {
  const { info, options } = fixture(t);
  const first = locate(info, options);
  assert.equal(first.sessionId, A); assert.equal(first.method, 'terminal-title'); assert.equal(first.exact, false);
  info.pane.terminal_title_stripped = 'Other thread | project';
  assert.equal(locate(info, options).sessionId, B);
  info.pane.terminal_title_stripped = 'Codex | project';
  assert.equal(locate(info, options), null);
  info.pane.terminal_title_stripped = 'Fix login | project';
  info.process_info.foreground_processes[0].name = 'bash';
  assert.equal(locate(info, options), null);
});

test('duplicate names, wrong cwd, subagents and mismatched headers fail closed', (t) => {
  const { rows, info, options } = fixture(t);
  const lookup = (records) => locate(info, { ...options, namedSessions: () => records });
  assert.equal(lookup([rows[0], { ...rows[1], name: rows[0].name }]), null);
  assert.equal(lookup([{ ...rows[0], cwd: '/elsewhere' }]), null);
  assert.equal(lookup([{ ...rows[0], file: rows[1].file }]), null);
  fs.writeFileSync(rows[0].file, JSON.stringify({ type: 'session_meta', payload: { id: A, cwd: '/project', parent_thread_id: B } }) + '\n');
  assert.equal(lookup([rows[0]]), null);
});

test('SQLite lookup is read-only, cwd-scoped and uses newest schema; unsupported schemas fail closed', (t) => {
  const { home } = fixture(t), file = path.join(home, 'state_5.sqlite');
  const before = fs.statSync(file).mtimeMs;
  assert.equal(namedSessions(home, '/project').length, 2);
  assert.deepEqual(namedSessions(home, '/unknown'), []);
  assert.equal(fs.statSync(file).mtimeMs, before);
  fs.writeFileSync(path.join(home, 'state_6.sqlite'), 'unsupported database');
  assert.deepEqual(namedSessions(home, '/another'), []);
});

test('terminal matching handles spinners and sanitization but refuses truncated or generic titles', () => {
  assert.equal(titleMatches('⠏ Fix login | project', 'Fix login', '/project'), true);
  assert.equal(titleMatches('Fix login | project', 'Fix\u202elogin', '/project'), false);
  assert.equal(titleMatches('A | B | project', 'A | B', '/project'), true);
  assert.equal(titleMatches('Codex | project', '', '/project'), false);
  assert.equal(titleMatches('a'.repeat(240), 'a'.repeat(250), '/project'), false);
});
