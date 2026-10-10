import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';

for (const automatic of [false, true]) test(`${automatic ? 'Automatically located' : 'Bound'} Codex history reaches HTTP and SSE; appends and replacement work`, { timeout: 15000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-server-'));
  const sessionId = '01a12479-0507-78d1-998b-ede8610c3513';
  const root = path.join(home, 'sessions', '2026', '10', '10'); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `rollout-2026-10-10T06-21-13-${sessionId}.jsonl`);
  const header = { type: 'session_meta', payload: { id: sessionId, history_mode: 'paginated', cwd: '/project' } };
  const message = (id, text) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id, content: [{ type: 'Text', text }] } } });
  const records = (...entries) => entries.map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(file, records(header, message('first', 'Initial answer')));
  const snapshot = {
    version: 'test', workspaces: [{ workspace_id: 'w1', label: 'Test', number: 1 }],
    tabs: [{ workspace_id: 'w1', tab_id: 'w1:t1', number: 1 }],
    panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'codex', agent_status: 'idle', terminal_title_stripped: 'My thread | project' }],
    agents: [{ pane_id: 'w1:p1', agent: 'codex', ...(automatic ? {} : { agent_session_id: sessionId, agent_session_path: file }) }], layouts: [],
  };
  if (automatic) execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('create table threads (id text,rollout_path text,cwd text,name text)')
c.execute('insert into threads values (?,?,?,?)',(sys.argv[2],sys.argv[3],'/project','My thread'))
c.commit()`, path.join(home, 'state_5.sqlite'), sessionId, file]);
  const socket = path.join(home, 'herdr.sock'), connections = new Set();
  const herdr = net.createServer((client) => {
    connections.add(client); client.on('close', () => connections.delete(client));
    // The office closes each RPC connection and may reset one during teardown.
    client.on('error', () => client.destroy());
    let carry = ''; client.setEncoding('utf8');
    client.on('data', (data) => {
      carry += data;
      let n;
      while ((n = carry.indexOf('\n')) >= 0) {
        const request = JSON.parse(carry.slice(0, n)); carry = carry.slice(n + 1);
        let result;
        if (request.method === 'session.snapshot') result = { snapshot };
        else if (request.method === 'pane.process_info') result = { process_info: { pane_id: 'w1:p1', foreground_processes: [{ pid: 123456789, name: 'codex', argv: ['codex'], cwd: '/project' }] } };
        else if (request.method === 'pane.read') result = { read: { text: 'Codex terminal', revision: 1 } };
        else result = {};
        client.write(JSON.stringify({ id: request.id, result }) + '\n');
      }
    });
  });
  const ctl = new AbortController();
  let child;
  t.after(async () => {
    ctl.abort();
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    for (const c of connections) c.destroy();
    if (herdr.listening) await new Promise((resolve) => herdr.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  herdr.listen(socket); await once(herdr, 'listening');
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  child = spawn(process.execPath, ['server/index.js'], { stdio: 'ignore', env: { ...process.env,
    HOST: '127.0.0.1', PORT: String(port), HERDR_SOCKET_PATH: socket, CODEX_HOME: home,
    OFFICE_TOKEN: 'codex-integration-test', OFFICE_MOCK: '0', OFFICE_CODEX_SESSIONS: '{}', OFFICE_CHAT_MS: '30', OFFICE_POLL_MS: '50',
  } });
  const url = (s) => `http://127.0.0.1:${port}${s}`, auth = { authorization: 'Bearer codex-integration-test' };
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(url('/healthz'))).ok) break; } catch { /* startup */ }
    await new Promise((r) => setTimeout(r, 30));
  }
  const state = await (await fetch(url('/api/state'), { headers: auth })).json();
  assert.equal(state.model.workspaces[0].tabs[0].panes[0].kind, 'codex');
  assert.doesNotMatch(JSON.stringify(state), /agent_session_path|agent_session_id/);
  const history = await (await fetch(url('/api/pane/w1:p1/chat'), { headers: auth })).json();
  assert.equal(history.supported, true); assert.equal(history.session.id, sessionId);
  assert.deepEqual(history.items.map((i) => i.text), ['Initial answer']);

  const stream = await fetch(url('/api/events'), { headers: auth, signal: ctl.signal });
  const reader = stream.body.getReader(), decoder = new TextDecoder();
  let carry = '';
  async function next(kind, predicate = () => true) {
    for (;;) {
      let end;
      while ((end = carry.indexOf('\n\n')) >= 0) {
        const frame = carry.slice(0, end); carry = carry.slice(end + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1], body = /^data: (.+)$/m.exec(frame)?.[1];
        if (event === kind && body) { const data = JSON.parse(body); if (predicate(data)) return data; }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE closed before expected event');
      carry += decoder.decode(value, { stream: true });
    }
  }
  const hello = await next('hello');
  const watch = await fetch(url('/api/watch'), { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ cid: hello.cid, pane: 'w1:p1', chat: true }) });
  assert.equal(watch.status, 200);
  assert.equal((await next('chat', (e) => e.reset)).items[0].text, 'Initial answer');
  fs.appendFileSync(file, records(message('second', 'New reply')));
  const delta = await next('chat', (e) => !e.reset);
  assert.deepEqual(delta.items.map((i) => i.text), ['New reply']);
  fs.writeFileSync(`${file}.next`, records(header, message('replacement', 'Replaced history')));
  fs.renameSync(`${file}.next`, file);
  const reset = await next('chat', (e) => e.reset && e.items.some((i) => i.text === 'Replaced history'));
  assert.equal(reset.items.length, 1);
  fs.truncateSync(file);
  assert.equal((await next('chat', (e) => e.reset && e.items.length === 0)).total, 0);
  if (automatic) {
    // Resume another named thread in the same directory, with no binding update.
    const other = '01a11eac-d077-71f2-b887-4ff13a863f3d';
    const otherFile = path.join(root, `rollout-${other}.jsonl`);
    fs.writeFileSync(otherFile, records({ ...header, payload: { ...header.payload, id: other } }, message('resumed', 'Resumed thread')));
    execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('insert into threads values (?,?,?,?)',(sys.argv[2],sys.argv[3],'/project','Resumed'))
c.commit()`, path.join(home, 'state_5.sqlite'), other, otherFile]);
    snapshot.panes[0].terminal_title_stripped = 'Resumed | project';
    const switched = await next('chat', (e) => e.reset && e.session.id === other);
    assert.equal(switched.items[0].text, 'Resumed thread');
    snapshot.panes[0].terminal_title_stripped = 'Codex | project';
    assert.equal((await next('chatnone')).reason, 'no-session');
  }
});
