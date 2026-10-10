import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, loadEnv } from './env.js';
import { HerdrClient } from './herdr.js';
import { MockHerdr, demoAdapter } from './mock.js';
import { buildModel, diffEvents, summarize } from './model.js';
import { makeAuth } from './auth.js';
import { loginPage } from './login.js';
import { splitPanes } from './layout.js';
import { SubagentTracker } from './harness/claude.js';
import { storeImage, readUpload, UPLOAD_MAX } from './upload.js';
import { adapterFor as realAdapterFor } from './harness/index.js';

loadEnv();
const PORT = Number(process.env.PORT || 4747);
const HOSTS = (process.env.HOST || '127.0.0.1').split(',').map((s) => s.trim()).filter(Boolean);
const POLL_MS = Number(process.env.OFFICE_POLL_MS || 1000);
const PUBLIC = path.join(ROOT, 'public');
const auth = makeAuth(process.env.OFFICE_TOKEN || '');
if (!auth.enabled) {
  // The office can type into your terminals: do not run it open by accident.
  if (process.env.OFFICE_MOCK !== '1' && process.env.OFFICE_ALLOW_OPEN !== '1') {
    console.error('[office] OFFICE_TOKEN is empty. Run `npm start` (it creates one in .env), or set one by hand (see .env.example), or OFFICE_ALLOW_OPEN=1 to run without a login (loopback only!).');
    process.exit(1);
  }
  if (process.env.OFFICE_MOCK !== '1') console.warn('[office] running WITHOUT a login. Keep it on loopback.');
}

const MOCK = process.env.OFFICE_MOCK === '1';
const herdr = MOCK ? new MockHerdr() : new HerdrClient();
const adapterFor = (kind) => (MOCK ? (kind ? demoAdapter : null) : realAdapterFor(kind));
let model = null;
let modelJson = '';
let lastError = null;
// Keep native lifecycle identity out of the browser model; adapters receive it privately.
let sessionBindings = new Map();
let paneMetadata = new Map();
const activity = []; // newest last
const clients = new Set();
const PANE_ID = /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/;
const KEY = /^[A-Za-z0-9+_-]{1,24}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

const SECURITY = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, code, body, headers = {}) {
  const isObj = body && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'content-type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store', ...SECURITY, ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

// Sub-agents ("interns" in the office): herdr knows nothing about them, but the agent's own session log does.
const helperLoc = new Map();   // pane id -> { loc, at }
const subTrackers = new Map(); // session file -> { t, used }
async function addHelpers(m) {
  const now = Date.now();
  for (const w of m.workspaces) for (const t of w.tabs) for (const p of t.panes) {
    if (p.kind !== 'claude') continue;
    let run = [];
    if (MOCK) run = herdr.helpersFor?.(p.id) || [];
    else {
      try {
        let h = helperLoc.get(p.id);
        if (!h || now - h.at > 10_000) { h = { loc: await locateChat(realAdapterFor('claude'), p.id).catch(() => null), at: now }; helperLoc.set(p.id, h); }
        if (h.loc?.file) {
          let e = subTrackers.get(h.loc.file);
          if (!e) subTrackers.set(h.loc.file, (e = { t: new SubagentTracker(h.loc.file), used: now }));
          e.used = now; e.t.refresh(); run = e.t.running;
        }
      } catch { run = []; }
    }
    if (run.length) p.helpers = run;
  }
  for (const [f, e] of subTrackers) if (now - e.used > 60_000) subTrackers.delete(f);
}

let failStreak = 0;
async function refresh() {
  try {
    const snap = await herdr.snapshot();
    paneMetadata = new Map((snap.panes || []).map((p) => [p.pane_id, p]));
    sessionBindings = new Map([...(snap.panes || []), ...(snap.agents || [])]
      .filter((p) => p.agent_session_id)
      .map((p) => [p.pane_id, { agent_session_id: p.agent_session_id, agent_session_path: p.agent_session_path }]));
    const next = buildModel(snap);
    await addHelpers(next);
    failStreak = 0;
    const recovered = lastError !== null;
    lastError = null;
    const json = JSON.stringify(next);
    if (json === modelJson && !recovered) return;
    const events = json === modelJson ? [] : diffEvents(model, next).map((e) => ({ ...e, ts: Date.now() }));
    model = next; modelJson = json;
    if (events.length) { activity.push(...events); activity.splice(0, Math.max(0, activity.length - 200)); }
    broadcast('state', model); // also clears a client's "building is dark" state after an outage
    for (const e of events) broadcast('activity', e);
  } catch (e) {
    // One failed snapshot is a blip, not an outage: only report after a few in a row.
    const msg = e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'herdr is not running' : e.message;
    if (++failStreak >= 3 && msg !== lastError) { lastError = msg; broadcast('error', { message: msg }); }
  }
}

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

let timer = null;
function ensurePolling() {
  if (timer || clients.size === 0) return;
  refresh();
  timer = setInterval(() => {
    if (clients.size === 0) { clearInterval(timer); timer = null; return; }
    refresh();
  }, POLL_MS);
}

// Pane content is pushed over the same SSE stream: a browser registers the pane it has open
// (POST /api/watch), one shared poller per watched pane reads it and sends `pane` events on change.
const PANE_MS = Number(process.env.OFFICE_PANE_MS || 700);
const watchers = new Map(); // paneId -> { timer, busy, last, fails }
function paneFrame(id, w) { return `event: pane\ndata: ${JSON.stringify({ pane: id, text: w.last.text, side: w.last.side, revision: w.last.revision })}\n\n`; }
async function pollPane(id, w) {
  if (w.busy) return;
  w.busy = true;
  try {
    const r = await herdr.readPane(id, 'visible', 90, true);
    const raw = (r.text || '').replace(/\s+$/, '').slice(-200_000);
    w.fails = 0;
    if (!w.last || w.last.raw !== raw) {
      const { main: text, side } = splitPanes(raw); // chat and diff side panel are separate views
      w.last = { raw, text, side, revision: r.revision };
      const frame = paneFrame(id, w);
      for (const c of clients) if (c.watching === id) c.write(frame);
    }
  } catch (e) {
    if (++w.fails === 5) for (const c of clients) if (c.watching === id) c.write(`event: paneerror\ndata: ${JSON.stringify({ pane: id, error: 'unreadable right now' })}\n\n`);
  } finally { w.busy = false; }
}
// Chat view: for panes running a known harness, tail the agent's own session log and push
// normalised chat items over the same SSE stream. One shared watcher per pane, deltas only.
const CHAT_MS = Number(process.env.OFFICE_CHAT_MS || 500);
const CHAT_FIRST = 150;
const transcripts = new Map(); // file -> { tr, used }
const chatWatchers = new Map(); // paneId -> { timer, busy, adapter, loc, locAt, tr, sentVer, none }
const paneKind = (id) => model?.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes)).find((p) => p.id === id)?.kind || null;
async function locateChat(adapter, id) {
  const info = await herdr.processInfo(id);
  return adapter.locate({ ...info, binding: sessionBindings.get(id), pane: paneMetadata.get(id) });
}

async function chatLocate(id, w) {
  if (w.loc && Date.now() - w.locAt < 2500) return w.loc;
  let loc = null;
  try { loc = await locateChat(w.adapter, id); } catch { loc = null; }
  w.locAt = Date.now();
  return (w.loc = loc);
}
function chatTranscript(adapter, loc) {
  let e = transcripts.get(loc.file);
  if (!e) transcripts.set(loc.file, (e = { tr: new adapter.Transcript(loc.file, loc), used: Date.now() }));
  e.used = Date.now();
  return e.tr;
}
const chatMeta = (loc, tr) => ({ id: loc.sessionId, title: tr.title, name: loc.name });
const chatFrame = (id, loc, tr, items, reset) => `event: chat\ndata: ${JSON.stringify({ pane: id, session: chatMeta(loc, tr), reset, items, total: tr.items.length, more: reset && tr.items.length > items.length })}\n\n`;
const chatNone = (id, reason) => `event: chatnone\ndata: ${JSON.stringify({ pane: id, reason })}\n\n`;

async function pollChat(id, w) {
  if (w.busy) return;
  w.busy = true;
  try {
    const loc = await chatLocate(id, w);
    const viewers = [...clients].filter((c) => c.chat === id);
    if (!loc) {
      if (w.none !== 'no-session') { w.none = 'no-session'; w.tr = null; for (const c of viewers) c.write(chatNone(id, 'no-session')); }
      return;
    }
    w.none = null;
    const tr = chatTranscript(w.adapter, loc);
    if (w.tr !== tr) { // first time, or the pane switched session (/clear, /resume): everyone starts over
      w.tr = tr; tr.refresh(); w.sentVer = tr.ver; w.generation = tr.generation;
      for (const c of viewers) c.write(chatFrame(id, loc, tr, tr.delta(0, CHAT_FIRST), true));
      return;
    }
    if (tr.refresh() || tr.ver !== w.sentVer) {
      const reset = tr.generation !== w.generation;
      const items = tr.delta(reset ? 0 : w.sentVer, reset ? CHAT_FIRST : Infinity);
      w.sentVer = tr.ver;
      w.generation = tr.generation;
      if (items.length || reset) { const f = chatFrame(id, loc, tr, items, reset); for (const c of viewers) c.write(f); }
    }
  } catch (e) { /* next tick retries */ } finally { w.busy = false; }
}
function syncChat() {
  const want = new Set([...clients].map((c) => c.chat).filter(Boolean));
  for (const [id, w] of chatWatchers) if (!want.has(id)) { clearInterval(w.timer); chatWatchers.delete(id); }
  for (const id of want) if (!chatWatchers.has(id)) {
    const adapter = adapterFor(paneKind(id));
    if (!adapter) { for (const c of clients) if (c.chat === id) c.write(chatNone(id, 'unsupported')); continue; }
    const w = { timer: null, busy: false, adapter, loc: null, locAt: 0, tr: null, sentVer: 0, none: null };
    w.timer = setInterval(() => pollChat(id, w), CHAT_MS);
    chatWatchers.set(id, w);
    pollChat(id, w);
  }
  for (const [file, e] of transcripts) if (Date.now() - e.used > 120_000 && ![...chatWatchers.values()].some((w) => w.tr === e.tr)) transcripts.delete(file);
}
// A client that just asked for the chat gets the current history right away, from the shared cache.
function sendChatSnapshot(c) {
  const w = chatWatchers.get(c.chat);
  if (!w) return;
  if (!w.loc) return c.write(chatNone(c.chat, w.none || 'no-session')); // the first poll reports it
  if (w.tr) c.write(chatFrame(c.chat, w.loc, w.tr, w.tr.delta(0, CHAT_FIRST), true));
}

function syncWatchers() {
  const want = new Set([...clients].map((c) => c.watching).filter(Boolean));
  for (const [id, w] of watchers) if (!want.has(id)) { clearInterval(w.timer); watchers.delete(id); }
  for (const id of want) if (!watchers.has(id)) {
    const w = { timer: null, busy: false, last: null, fails: 0 };
    w.timer = setInterval(() => pollPane(id, w), PANE_MS);
    watchers.set(id, w);
    pollPane(id, w);
  }
}


async function saveImage(req, res) {
  console.log(`[office] image upload from ${req.headers['cf-connecting-ip'] || req.socket.remoteAddress}: ${req.headers['content-type'] || 'no type'}, ${req.headers['content-length'] || '?'} bytes`);
  let body;
  try {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > UPLOAD_MAX) return send(res, 413, { error: 'image too large (max 10 MB)' }); chunks.push(c); }
    body = Buffer.concat(chunks);
  } catch { return send(res, 400, { error: 'upload failed' }); }
  const file = storeImage(body);
  if (!file) return send(res, 415, { error: 'only png, jpeg, gif or webp images' });
  console.log(`[office] image saved: ${body.length} bytes (${path.basename(file)})`);
  return send(res, 200, { ok: true, path: file, bytes: body.length });
}

async function readBody(req, limit = 16 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const clientIp = (req) => req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '?';
const isSecure = (req) => req.headers['x-forwarded-proto'] === 'https';

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch { return false; }
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream', etag, ...SECURITY,
      'cache-control': ext === '.png' || ext === '.webp' ? 'public, max-age=3600, must-revalidate' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...SECURITY,
    });
    res.cid = crypto.randomBytes(9).toString('base64url'); res.watching = null; res.chat = null;
    res.write(`retry: 2000\n\nevent: hello\ndata: ${JSON.stringify({ cid: res.cid })}\n\n`);
    if (model) res.write(`event: state\ndata: ${modelJson}\n\n`);
    res.write(`event: backlog\ndata: ${JSON.stringify(activity.slice(-60))}\n\n`);
    if (lastError) res.write(`event: error\ndata: ${JSON.stringify({ message: lastError })}\n\n`);
    clients.add(res);
    ensurePolling();
    const ka = setInterval(() => res.write('event: ping\ndata: 1\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); syncWatchers(); syncChat(); });
    return;
  }
  if (p === '/api/watch' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin' });
    const b = JSON.parse((await readBody(req)) || '{}');
    const c = [...clients].find((x) => x.cid === b.cid);
    if (!c) return send(res, 410, { error: 'stream gone, reconnect' });
    if (b.pane != null && !PANE_ID.test(String(b.pane))) return send(res, 400, { error: 'bad pane id' });
    c.watching = b.pane || null;
    c.chat = b.pane && b.chat ? b.pane : null;
    syncWatchers(); syncChat();
    if (c.chat) sendChatSnapshot(c);
    const w = c.watching && watchers.get(c.watching);
    if (w?.last) c.write(paneFrame(c.watching, w)); // instant first paint from the shared cache
    return send(res, 200, { ok: true });
  }
  if (p === '/api/state' && req.method === 'GET') {
    if (!model) await refresh();
    return send(res, model ? 200 : 503, model ? { model, summary: summarize(model) } : { error: lastError || 'no snapshot' });
  }
  if (p === '/api/mock/set' && herdr.force && req.method === 'POST') {
    const b = JSON.parse((await readBody(req)) || '{}');
    for (const [id, st] of Object.entries(b)) herdr.force(id, st?.status ?? st, st?.helpers);
    return send(res, 200, { ok: true });
  }
  const up = /^\/api\/upload\/([^/]+)$/.exec(p);
  if (up && req.method === 'GET') {
    const img = readUpload(decodeURIComponent(up[1]));
    if (!img) return send(res, 404, { error: 'not found' });
    return send(res, 200, img.data, { 'content-type': img.type, 'cache-control': 'private, max-age=3600', 'content-disposition': 'inline' });
  }
  let m = /^\/api\/pane\/([^/]+)\/(read|chat|text|keys|focus|image)$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!PANE_ID.test(id)) return send(res, 400, { error: 'bad pane id' });
    if (m[2] === 'chat' && req.method === 'GET') {
      const adapter = adapterFor(paneKind(id));
      if (!adapter) return send(res, 200, { pane: id, supported: false, items: [] });
      const w = chatWatchers.get(id);
      const loc = w ? await chatLocate(id, w) : await locateChat(adapter, id);
      if (!loc) return send(res, 200, { pane: id, supported: true, session: null, items: [] });
      const tr = chatTranscript(adapter, loc); tr.refresh();
      const q = url.searchParams, limit = Math.min(500, Math.max(1, Number(q.get('limit')) || CHAT_FIRST));
      const items = q.has('before') ? tr.before(Number(q.get('before')), limit) : tr.delta(Number(q.get('since')) || 0, limit);
      return send(res, 200, { pane: id, supported: true, session: chatMeta(loc, tr), items, ver: tr.ver, total: tr.items.length, more: items.length && items[0].seq > 0 });
    }
    if (m[2] === 'read' && req.method === 'GET') {
      const lines = Math.min(200, Math.max(5, Number(url.searchParams.get('lines')) || 60));
      const source = url.searchParams.get('source') === 'recent' ? 'recent' : 'visible';
      const r = await herdr.readPane(id, source, lines, url.searchParams.get('ansi') === '1');
      const raw = (r.text || '').replace(/\s+$/, '').slice(-200_000);
      if (url.searchParams.get('split') === '0') return send(res, 200, { pane: id, text: raw, revision: r.revision });
      const { main, side } = splitPanes(raw);
      return send(res, 200, { pane: id, text: main, side, revision: r.revision });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin' });
    if (m[2] === 'image') return saveImage(req, res);
    const body = JSON.parse((await readBody(req)) || '{}');
    if (m[2] === 'text') {
      const text = String(body.text ?? '');
      if (!text || text.length > 8000) return send(res, 400, { error: 'text required (max 8000 chars)' });
      await herdr.sendText(id, text);
      // Agent TUIs treat text that arrives together with Enter as a paste and swallow the newline, so the
      // submit key goes in as its own keypress a beat later.
      if (body.enter) { await new Promise((r) => setTimeout(r, 150)); await herdr.sendKeys(id, ['enter']); }
      return send(res, 200, { ok: true });
    }
    if (m[2] === 'keys') {
      const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
      if (!keys.length || keys.length > 8 || !keys.every((k) => KEY.test(k))) return send(res, 400, { error: 'bad keys' });
      await herdr.sendKeys(id, keys);
      return send(res, 200, { ok: true });
    }
    if (m[2] === 'focus') { await herdr.focusPane(id); return send(res, 200, { ok: true }); }
  }
  return send(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, herdr: !lastError, clients: clients.size });

    if (url.pathname === '/login') {
      if (req.method === 'POST') {
        const ct = req.headers['content-type'] || '';
        const raw = await readBody(req, 2048);
        const token = ct.includes('json') ? JSON.parse(raw || '{}').token : new URLSearchParams(raw).get('token');
        const r = auth.tryLogin(clientIp(req), token);
        if (r.ok) return send(res, 303, '', { location: '/', 'set-cookie': auth.cookie(isSecure(req)) });
        return send(res, r.limited ? 429 : 401, loginPage(r.limited ? 'Too many tries. Wait a few minutes.' : 'Wrong token.'), { 'content-type': 'text/html; charset=utf-8' });
      }
      return send(res, 200, loginPage(), { 'content-type': 'text/html; charset=utf-8' });
    }
    if (url.pathname === '/logout') return send(res, 303, '', { location: '/login', 'set-cookie': auth.clearCookie() });
    if (url.pathname === '/favicon.svg') return serveStatic(req, res, '/favicon.svg');

    if (!auth.isAuthed(req)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'unauthorized' });
      return send(res, 303, '', { location: '/login' });
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    // Our own 4xx stay as they are; anything that failed talking to herdr is a temporary 503 (JSON), never a
    // destroyed response, so the proxy in front does not turn it into an opaque 502.
    const code = e.status || (e instanceof SyntaxError ? 400 : 503);
    if (!res.headersSent) send(res, code, { error: code === 503 ? 'herdr unavailable, retry' : e.message, retry: code === 503 }, code === 503 ? { 'retry-after': '1' } : {});
    else res.end();
  }
});

process.on('unhandledRejection', (e) => console.warn('[office] unhandled rejection:', e?.message || e));
process.on('uncaughtException', (e) => console.warn('[office] uncaught exception:', e?.message || e));

for (const host of HOSTS) {
  const s = host === HOSTS[0] ? server : http.createServer(server.listeners('request')[0]);
  s.on('error', (e) => { if (s !== server) console.warn(`[office] cannot bind ${host}:${PORT}: ${e.code}`); else throw e; });
  s.listen(PORT, host, () => console.log(`[office] listening on http://${host}:${PORT}`));
}
