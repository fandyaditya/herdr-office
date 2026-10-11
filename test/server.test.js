import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Boots the real server against the mock herdr and exercises auth + API end to end.
const PORT = 4791, TOKEN = 'test-token-123';
let proc;
const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'office-up-'));
const url = (p) => `http://127.0.0.1:${PORT}${p}`;
const auth = { authorization: `Bearer ${TOKEN}` };

test.before(async () => {
  proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', OFFICE_TOKEN: TOKEN, OFFICE_UPLOAD_DIR: UPLOADS, OFFICE_MOCK: '1', OFFICE_MOCK_STATIC: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(url('/healthz'))).ok) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('server did not start');
});
test.after(() => { proc?.kill(); fs.rmSync(UPLOADS, { recursive: true, force: true }); });

test('everything but /healthz and /login requires auth', async () => {
  assert.equal((await fetch(url('/api/state'))).status, 401);
  const page = await fetch(url('/'), { redirect: 'manual' });
  assert.equal(page.status, 303); assert.equal(page.headers.get('location'), '/login');
  assert.equal((await fetch(url('/js/main.js'), { redirect: 'manual' })).status, 303);
  assert.equal((await fetch(url('/healthz'))).status, 200);
});

test('login form sets a session cookie that unlocks the app', async () => {
  const bad = await fetch(url('/login'), { method: 'POST', body: 'token=wrong', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.equal(bad.status, 401);
  const ok = await fetch(url('/login'), { method: 'POST', body: `token=${TOKEN}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  const page = await fetch(url('/'), { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Herdr Office/);
});

test('state API returns the building model; security headers present', async () => {
  const r = await fetch(url('/api/state'), { headers: auth });
  assert.equal(r.status, 200);
  const { model, summary } = await r.json();
  assert.ok(model.workspaces.length >= 3);
  assert.ok(summary.idle >= 0);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('demo mode: every agent pane serves the sample conversation, plain shells have no chat', async () => {
  const { model } = await (await fetch(url('/api/state'), { headers: auth })).json();
  const panes = model.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes));
  const agent = panes.find((p) => p.kind === 'codex');
  const r = await (await fetch(url(`/api/pane/${agent.id}/chat`), { headers: auth })).json();
  assert.equal(r.supported, true);
  assert.equal(r.session.name, 'Fix flaky checkout test');
  assert.ok(r.items.some((i) => i.kind === 'user') && r.items.some((i) => i.kind === 'tool' && i.result));
  const shell = panes.find((p) => !p.kind);
  assert.deepEqual(await (await fetch(url(`/api/pane/${shell.id}/chat`), { headers: auth })).json(), { pane: shell.id, supported: false, items: [] });
});

test('pane read/send validate input and reject cross-origin posts', async () => {
  const { model } = await (await fetch(url('/api/state'), { headers: auth })).json();
  const id = model.workspaces[0].tabs[0].panes[0].id;
  const read = await (await fetch(url(`/api/pane/${id}/read?lines=20`), { headers: auth })).json();
  assert.ok(typeof read.text === 'string');
  const post = (path, body, extra = {}) => fetch(url(path), { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  assert.equal((await post(`/api/pane/${id}/text`, { text: 'hello', enter: true })).status, 200);
  assert.equal((await post(`/api/pane/${id}/text`, { text: '' })).status, 400);
  assert.equal((await post(`/api/pane/${id}/text`, { text: 'x'.repeat(9000) })).status, 400);
  assert.equal((await post(`/api/pane/${id}/keys`, { keys: ['enter'] })).status, 200);
  assert.equal((await post(`/api/pane/${id}/keys`, { keys: ['rm -rf /'] })).status, 400);
  assert.equal((await post(`/api/pane/${id}/text`, { text: 'evil' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(url('/api/pane/not-a-pane/read'), { headers: auth })).status, 400);
  const after = await (await fetch(url(`/api/pane/${id}/read`), { headers: auth })).json();
  assert.match(after.text, /> hello/);
});

test('static files cannot escape the public directory', async () => {
  for (const p of ['/../server/index.js', '/..%2fserver/index.js', '/%2e%2e/.env']) {
    const r = await fetch(url(p), { headers: auth });
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
  }
});

test('SSE stream delivers the initial state', async () => {
  const ctl = new AbortController();
  const r = await fetch(url('/api/events'), { headers: auth, signal: ctl.signal });
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  const reader = r.body.getReader();
  let text = '';
  while (!text.includes('event: state')) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
  ctl.abort();
  assert.match(text, /event: state/);
});

test('opening a chat never reports "no chat" before the chat itself (the panel must not flash the terminal tab)', async () => {
  const { model } = await (await fetch(url('/api/state'), { headers: auth })).json();
  const agent = model.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes)).find((p) => p.kind === 'claude');
  const ctl = new AbortController();
  const r = await fetch(url('/api/events'), { headers: auth, signal: ctl.signal });
  const reader = r.body.getReader();
  let text = '';
  const pump = async (until) => { while (!until()) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } };
  await pump(() => /event: hello/.test(text));
  const cid = JSON.parse(/event: hello\ndata: (.*)\n/.exec(text)[1]).cid;
  const w = await fetch(url('/api/watch'), { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ cid, pane: agent.id, chat: true }) });
  assert.equal(w.status, 200);
  await pump(() => /event: chat\n/.test(text) || /event: chatnone/.test(text));
  ctl.abort();
  assert.ok(/event: chat\n/.test(text), 'got the conversation');
  assert.ok(!/event: chatnone/.test(text), 'and no premature "no chat" notice');
});

test('image upload stores real images only and returns a private file path', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const up = (body, headers = {}) => fetch(url('/api/pane/w1:p1/image'), { method: 'POST', body, headers: { ...auth, origin: `http://127.0.0.1:${PORT}`, ...headers } });
  assert.equal((await fetch(url('/api/pane/w1:p1/image'), { method: 'POST', body: png })).status, 401);
  const ok = await up(png, { 'content-type': 'image/png' });
  assert.equal(ok.status, 200);
  const { path: file } = await ok.json();
  assert.equal(path.dirname(file), UPLOADS); assert.match(file, /\.png$/);
  assert.deepEqual(fs.readFileSync(file), png);
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'file is private to the owner');
  const name = path.basename(file);
  const back = await fetch(url(`/api/upload/${name}`), { headers: auth });
  assert.equal(back.status, 200); assert.equal(back.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), png);
  assert.equal((await fetch(url(`/api/upload/${name}`))).status, 401);
  assert.equal((await fetch(url('/api/upload/..%2F..%2Fetc%2Fpasswd'), { headers: auth })).status, 404);
  assert.equal((await up(Buffer.from('<svg onload=alert(1)>'), { 'content-type': 'image/png' })).status, 415, 'type comes from the bytes');
  assert.equal((await up(Buffer.alloc(11 * 1024 * 1024, 1), { 'content-type': 'image/png' })).status, 413);
});
