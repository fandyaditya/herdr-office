import { Renderer } from './render.js';
import { planFloor, floorSignature } from './floorplan.js';
import { FloorSim } from './sim.js';
import { kindColor, STATUS_COLOR, makeLook, personFrame, T } from './art.js';
import { ansiToHtml } from './ansi.js';
import { ChatView, dialogOpen } from './chat.js';
import { loadAssets, cast, castFrame, castIndexFor } from './assets.js';
import { installEggs } from './eggs.js';
import { installNewFloor } from './newfloor.js';

const $ = (id) => document.getElementById(id);
// The floor follows the viewer's local time (night look, agents asleep). `?hour=23` previews another hour.
const hourParam = () => { const v = new URLSearchParams(location.search).get('hour'); return v !== null && v !== '' && Number.isFinite(+v) ? ((+v % 24) + 24) % 24 : undefined; };
const hourNow = () => { if (S.hour !== undefined) return S.hour; const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
const S = {
  hour: hourParam(),
  model: null, floors: new Map(), cur: null, selected: null, hover: null,
  follow: localStorage.getItem('ho.follow') === '1', sound: localStorage.getItem('ho.sound') === '1',
  panes: new Map(), panePath: new Map(), error: null, lastFocusWs: null, activity: [],
};
const renderer = new Renderer($('office'));
window.__office = { S, renderer, select }; // handy for debugging in devtools

const STATUS_ORDER = ['working', 'blocked', 'done', 'idle', 'unknown', 'shell'];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const shortPath = (p) => (p || '').replace(/^\/home\/[^/]+/, '~');

// ------------------------------------------------------------------ data
let es = null, cid = null, esBackoff = 1000, esWatchdog = 0, darkTimer = 0;
const conn = $('conn');
const setConn = (cls, text) => { conn.className = `conn ${cls}`; conn.querySelector('span').textContent = text; };

// The browser reconnects an EventSource by itself, but gives up for good if the proxy answers with an error
// page (readyState CLOSED). So: reconnect by hand with backoff, and use a watchdog for streams that go quiet.
function connect() {
  clearTimeout(esWatchdog);
  if (es) { es.onerror = es.onopen = null; es.close(); }
  cid = null;
  es = new EventSource('/api/events');
  const bump = () => { clearTimeout(esWatchdog); esWatchdog = setTimeout(() => connect(), 40000); };
  es.onopen = () => { esBackoff = 1000; bump(); setConn('ok', S.error ? S.error : 'live'); };
  es.onerror = async () => {
    setConn('bad', 'reconnecting…');
    if (es.readyState === EventSource.CLOSED) { clearTimeout(esWatchdog); setTimeout(connect, esBackoff); esBackoff = Math.min(esBackoff * 2, 15000); }
    try { const r = await fetch('/api/state'); if (r.status === 401) location.href = '/login'; } catch { /* offline */ }
  };
  es.addEventListener('hello', (e) => { bump(); cid = JSON.parse(e.data).cid; if (drawer.paneId) watchPane(drawer.paneId); });
  es.addEventListener('ping', bump);
  es.addEventListener('state', (e) => { bump(); clearTimeout(darkTimer); S.error = null; setConn('ok', 'live'); onModel(JSON.parse(e.data)); });
  es.addEventListener('backlog', (e) => { bump(); S.activity = JSON.parse(e.data); renderActivity(); });
  es.addEventListener('activity', (e) => { bump(); onActivity(JSON.parse(e.data)); });
  es.addEventListener('pane', (e) => { bump(); onPaneFrame(JSON.parse(e.data)); });
  es.addEventListener('chat', (e) => { bump(); onChatFrame(JSON.parse(e.data)); });
  es.addEventListener('chatnone', (e) => { bump(); onChatNone(JSON.parse(e.data)); });
  es.addEventListener('paneerror', (e) => { const j = JSON.parse(e.data); if (j.pane === drawer.paneId) $('d-termstat').textContent = j.error; });
  es.addEventListener('error', (e) => {
    if (!e.data) return; // a transport error, handled by onerror
    // The server only reports an outage after several failed snapshots; still wait a moment before going dark.
    const message = JSON.parse(e.data).message;
    clearTimeout(darkTimer);
    darkTimer = setTimeout(() => { S.error = message; setConn('bad', message); renderEmpty(); }, 3000);
  });
}

function onModel(model) {
  S.model = model;
  S.panes = new Map(); S.panePath = new Map();
  for (const w of model.workspaces) for (const t of w.tabs) for (const p of t.panes) {
    S.panes.set(p.id, p); S.panePath.set(p.id, { ws: w, tab: t });
  }
  if (!S.cur || !model.workspaces.some((w) => w.id === S.cur)) {
    const hashWs = (location.hash.slice(1).split(':')[0]) || '';
    S.cur = model.workspaces.find((w) => w.id === hashWs)?.id || model.focused.workspace || model.workspaces[0]?.id || null;
    if (S.cur) { prepareFloor(S.cur, false); }
    const hp = location.hash.slice(1);
    if (!S.selected && S.panes.has(hp)) select(hp, true);
  }
  if (S.follow && model.focused.workspace && model.focused.workspace !== S.lastFocusWs) {
    S.lastFocusWs = model.focused.workspace;
    if (model.focused.workspace !== S.cur) goFloor(model.focused.workspace);
  } else if (!S.follow) S.lastFocusWs = model.focused.workspace;
  if (S.cur) prepareFloor(S.cur, true);
  if (S.selected && !S.panes.has(S.selected)) closeDrawer();
  renderFloors(); renderCounters(); renderEmpty(); refreshDrawerHead();
  if (drawer.paneId && chatView && drawer.chat !== 'none') setChatStatus(S.panes.get(drawer.paneId)?.status, stripAnsi(drawer.main));
}

function prepareFloor(wsId, keepCam) {
  const ws = S.model.workspaces.find((w) => w.id === wsId);
  if (!ws) return null;
  let f = S.floors.get(wsId);
  const sig = floorSignature(ws);
  if (!f || f.plan.sig !== sig) {
    const plan = planFloor(ws);
    f = { plan, sim: new FloorSim(plan, ws, hourNow()) };
    S.floors.set(wsId, f);
    if (wsId === S.cur) renderer.setFloor(plan, f.sim, keepCam && !!renderer.plan);
  } else {
    f.sim.sync(ws);
    if (wsId === S.cur && renderer.sim !== f.sim) renderer.setFloor(f.plan, f.sim);
  }
  return f;
}

function goFloor(wsId, { fit = true, keepDrawer = false } = {}) {
  if (!S.model?.workspaces.some((w) => w.id === wsId)) return;
  // The open chat belongs to a pane on the old floor: close it rather than leave it showing another floor's agent.
  if (S.selected && S.panePath.get(S.selected)?.ws.id !== wsId && !keepDrawer) closeDrawer();
  S.cur = wsId;
  const f = prepareFloor(wsId, false);
  if (f) renderer.setFloor(f.plan, f.sim, !fit);
  history.replaceState(null, '', `#${S.selected && S.panePath.get(S.selected)?.ws.id === wsId ? S.selected : wsId}`);
  renderFloors(); renderEmpty();
  $('floors').classList.remove('open');
}

// ------------------------------------------------------------------ side panels
function renderCounters() {
  const c = {};
  for (const p of S.panes.values()) c[p.status] = (c[p.status] || 0) + 1;
  const parts = ['working', 'blocked', 'done', 'idle'].filter((k) => c[k] || k === 'working' || k === 'blocked')
    .map((k) => `<span class="pill ${k} ${c[k] ? 'on' : ''}" title="${k}"><i style="background:${STATUS_COLOR[k]}"></i>${c[k] || 0} ${k}</span>`);
  $('counters').innerHTML = parts.join('');
  const blocked = c.blocked || 0;
  document.title = blocked ? `(${blocked}) Herdr Office` : 'Herdr Office';
}

function renderFloors() {
  if (!S.model) return;
  const list = $('floor-list');
  const wss = [...S.model.workspaces].sort((a, b) => b.number - a.number); // top floor first
  list.innerHTML = wss.map((w) => {
    const panes = w.tabs.flatMap((t) => t.panes);
    const blocked = panes.filter((p) => p.status === 'blocked').length;
    const dots = panes.map((p) => `<i style="background:${STATUS_COLOR[p.status]}" title="${esc(p.name || p.kindLabel || 'shell')} · ${p.status}"></i>`).join('');
    const rooms = w.tabs.length;
    return `<button class="floor ${w.id === S.cur ? 'active' : ''} ${w.id === S.model.focused.workspace ? 'herdr-focus' : ''}" data-ws="${w.id}">
      <span class="num">F${w.number}</span>
      <span class="meta"><div class="name">${esc(w.label)}${blocked ? `<span class="alert">!${blocked}</span>` : ''}</div>
      <div class="sub">${dots}</div><div class="tag">${rooms} room${rooms === 1 ? '' : 's'} · ${panes.length} desk${panes.length === 1 ? '' : 's'}</div></span></button>`;
  }).join('');
}

function evText(e) {
  if (e.type === 'join') return `<b>${esc(e.who)}</b> arrived at <b>${esc(e.where)}</b>`;
  if (e.type === 'leave') return `<b>${esc(e.who)}</b> left <b>${esc(e.where)}</b>`;
  if (e.type === 'helper') return `<b>${esc(e.who)}</b> <span style="color:var(--dim2)">${esc(e.where)}</span> ${e.sub === 'start' ? 'sent an intern to' : 'intern finished'}: <span style="color:var(--dim2)">${esc(String(e.label || '').slice(0, 48))}</span>`;
  const t = e.title ? ` <span style="color:var(--dim2)">— ${esc(e.title.slice(0, 40))}</span>` : '';
  return `<b>${esc(e.who)}</b> <span style="color:var(--dim2)">${esc(e.where)}</span> <span class="st" style="color:${STATUS_COLOR[e.status] || '#fff'}">${esc(e.from || '')}${e.from ? ' → ' : ''}${esc(e.status || '')}</span>${t}`;
}
function renderActivity() {
  const ol = $('activity');
  ol.innerHTML = [...S.activity].reverse().slice(0, 80).map((e) => `<li data-pane="${esc(e.pane || '')}"><time>${hhmm(e.ts)}</time><span>${evText(e)}</span></li>`).join('')
    || '<li style="cursor:default">Nothing yet. Agents will show up here as they work.</li>';
}

function onActivity(e) {
  S.activity.push(e); if (S.activity.length > 200) S.activity.shift();
  renderActivity();
  if (e.type === 'status' && (e.status === 'blocked' || e.status === 'done') && e.from !== 'unknown') {
    toast(e.status, `<b>${esc(e.who)}</b> ${e.status === 'blocked' ? 'needs you' : 'finished'} <span style="color:var(--dim)">· ${esc(e.where)}</span>`, e.pane);
    chime(e.status);
  }
}

function toast(kind, html, pane) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.innerHTML = html;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

let audioCtx = null;
function chime(kind) {
  if (!S.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const seq = kind === 'blocked' ? [[392, 0], [294, 0.14]] : [[523, 0], [659, 0.1], [784, 0.2]];
    for (const [f, d] of seq) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = f; g.gain.value = 0.04;
      o.connect(g).connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + d; g.gain.setValueAtTime(0.04, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.start(t0); o.stop(t0 + 0.18);
    }
  } catch { /* audio blocked */ }
}

function renderEmpty() {
  const el = $('empty');
  if (S.error) {
    el.hidden = false;
    el.innerHTML = `<div><h2>The building is dark</h2><div>${esc(S.error)}.<br>Start herdr and the lights come back on.</div></div>`;
  } else if (S.model && !S.model.workspaces.length) {
    el.hidden = false; el.innerHTML = '<div><h2>An empty building</h2><div>Create a herdr workspace to open the first floor.</div></div>';
  } else el.hidden = true;
}

// ------------------------------------------------------------------ drawer (terminal peek + input)
const drawer = { timer: null, lastText: null, paneId: null, busy: false, view: 'term', chat: 'none', picked: false };
const CHAT_KINDS = new Set(['claude', 'cursor', 'codex']); // harnesses the bridge can read a conversation from (server/harness/)
let chatView = null;
const stripAnsi = (t) => String(t || '').replace(/\x1b\[[0-9;:?]*[ -\/]*[@-~]/g, '');

function select(paneId, silent = false, locate = false) {
  if (!S.panes.has(paneId)) return;
  const pp = S.panePath.get(paneId);
  if (pp.ws.id !== S.cur) goFloor(pp.ws.id, { keepDrawer: true });
  S.selected = paneId;
  history.replaceState(null, '', `#${paneId}`);
  $('drawer').hidden = false;
  drawer.paneId = paneId; drawer.lastText = null; drawer.fails = 0; drawer.main = drawer.side = null; drawer.picked = false; drawer.shown = null;
  drawer.chat = CHAT_KINDS.has(S.panes.get(paneId)?.kind) ? 'pending' : 'none'; drawer.view = drawer.chat === 'none' ? 'term' : 'chat';
  clearPicsFn(); chatView.clear(); setChatStatus(S.panes.get(paneId)?.status);
  $('d-term').textContent = 'loading…';
  applyView();
  refreshDrawerHead();
  watchPane(paneId);
  pollTerminal(true);
  if (locate) renderer.locate(paneId);
  if (!silent && !locate) $('d-input').focus({ preventScroll: true });
  resizeSoon();
}

function closeDrawer() {
  S.selected = null; drawer.paneId = null; drawer.shown = null; $('drawer').hidden = true;
  clearTimeout(drawer.timer);
  watchPane(null);
  history.replaceState(null, '', S.cur ? `#${S.cur}` : '#');
  resizeSoon();
}

function refreshDrawerHead() {
  const p = S.selected && S.panes.get(S.selected);
  if (!p) return;
  const pp = S.panePath.get(p.id);
  $('d-name').textContent = p.name || p.kindLabel || 'Shell';
  // Under the agent's name: its workspace (the user's ask), with the terminal title on hover.
  $('d-sub').textContent = pp?.ws?.label || p.title || '—';
  $('d-sub').title = p.title || '';
  const av = $('d-avatar');
  if (!av.firstChild) { const c = document.createElement('canvas'); c.width = 40; c.height = 40; av.appendChild(c); }
  const ac = av.firstChild.getContext('2d'); ac.imageSmoothingEnabled = false; ac.clearRect(0, 0, 40, 40);
  if (p.kind && cast.ready) {
    const idx = castIndexFor(p.id), fr = castFrame(idx, kindColor(p.kind), 'S', 'stand');
    ac.drawImage(fr.cv, fr.sx + Math.round(fr.foot.x) - 8, fr.sy + fr.foot.top, 16, 16, 0, 0, 40, 40);
  } else if (p.kind) ac.drawImage(personFrame(makeLook(p.id, p.kind), 'S', 'stand', 0), 1, 0, 16, 16, 0, 0, 40, 40);
  else { ac.fillStyle = '#10202e'; ac.fillRect(6, 8, 28, 20); ac.fillStyle = '#9ae6b4'; ac.fillRect(10, 13, 6, 2); ac.fillRect(10, 19, 10, 2); }
  $('d-meta').innerHTML = `<span class="badge"><i style="background:${STATUS_COLOR[p.status]}"></i>${p.status}</span>
    <span class="badge">F${pp.ws.number} ${esc(pp.ws.label)} › tab ${esc(pp.tab.label)}</span>
    ${p.helpers?.length ? `<span class="badge helpers" title="${esc(p.helpers.map((h) => h.label).join(' · '))}">⚙ ${p.helpers.length} sub-agent${p.helpers.length > 1 ? 's' : ''} running</span>` : ''}
    <span class="badge">${esc(p.id)}</span>${p.cwd ? `<span class="badge path" title="${esc(p.cwd)}">${esc(shortPath(p.cwd))}</span>` : ''}`;
}

// Terminal content is pushed over the SSE stream (see watchPane). The one-off fetch below paints at once and
// is the fallback while the stream is down; it backs off instead of hammering a struggling server.
// A pane can hold two views (Claude Code draws its diff next to the chat). The server splits them; the panel
// shows one at a time so chat and diff text never interleave.
function renderTerm(text, force = false) {
  const term = $('d-term');
  if (text === drawer.lastText) return;
  const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
  term.innerHTML = text ? ansiToHtml(text) : '(empty)';
  drawer.lastText = text;
  if (atBottom || force) term.scrollTop = term.scrollHeight;
}
function renderFrame(f, force = false) {
  const prevSide = drawer.side;
  drawer.main = f.text; drawer.side = f.side || null;
  if (!drawer.side && drawer.view === 'side') drawer.view = 'term';
  applyView();
  $('d-tabs').querySelector('[data-view=side]').classList.toggle('dot', !!drawer.side && drawer.view !== 'side' && prevSide !== null && prevSide !== drawer.side);
  if (drawer.view !== 'chat') renderTerm(drawer.view === 'side' ? drawer.side : drawer.main, force);
  if (drawer.chat !== 'none') setChatStatus(S.panes.get(drawer.paneId)?.status, stripAnsi(drawer.main));
}

// Which of Chat / Terminal / Diff is shown, and which tabs exist. Chat is the default whenever the agent has a
// readable conversation; the user's own pick wins from then on.
// The quick-key row is for the terminal. In the chat it only appears when the agent needs a keypress: a decision or an open dialog.
function updateKeys(status = S.panes.get(drawer.paneId)?.status, text = stripAnsi(drawer.main || '')) {
  const need = drawer.view !== 'chat' || status === 'blocked' || dialogOpen(text);
  $('d-form').classList.toggle('chat-simple', !need);
  $('d-stop').hidden = !(drawer.view === 'chat' && status === 'working'); // interrupting only makes sense while a turn runs
}
function setChatStatus(status, text = '') { chatView.setStatus(status, text); updateKeys(status, text); }
const closeDialog = () => post(paneUrl('keys'), { keys: ['esc'] }).then(() => setTimeout(() => pollTerminal(true), 250));

function applyView() {
  if (drawer.chat === 'ready' && !drawer.picked) drawer.view = 'chat';
  if (drawer.chat === 'none' && drawer.view === 'chat') drawer.view = 'term';
  const tabs = $('d-tabs');
  const show = { chat: drawer.chat !== 'none', term: true, side: !!drawer.side };
  for (const b of tabs.children) { b.hidden = !show[b.dataset.view]; b.classList.toggle('on', b.dataset.view === drawer.view); }
  tabs.hidden = Object.values(show).filter(Boolean).length < 2;
  $('d-chat').hidden = drawer.view !== 'chat';
  document.querySelector('.term-wrap').hidden = drawer.view === 'chat';
  updateKeys();
  const shown = `${drawer.paneId}|${drawer.view}`;
  if (shown !== drawer.shown) { drawer.shown = shown; pinToEnd(); } // a pane or tab was just opened: show its latest content
  $('d-input').placeholder = drawer.view === 'chat' ? 'Message the agent… (Enter sends, Shift+Enter newline)' : 'Type to this pane… (Enter sends, Shift+Enter newline)';
}

// Jump to the newest message / output. Layout is still settling when a panel opens (it was hidden, the phone
// keyboard may resize it), so repeat once after it has.
function pinToEnd() {
  const go = () => {
    if (drawer.view === 'chat') chatView.jumpToEnd();
    else { const t = $('d-term'); t.scrollTop = t.scrollHeight; }
  };
  requestAnimationFrame(go); setTimeout(go, 250);
}

function onChatFrame(f) {
  if (f.pane !== drawer.paneId) return;
  drawer.chat = 'ready';
  if (f.reset) { chatView.reset(f.items, { more: f.more }); if (drawer.view === 'chat') pinToEnd(); } else chatView.apply(f.items);
  setChatStatus(S.panes.get(drawer.paneId)?.status, stripAnsi(drawer.main));
  applyView();
}
function onChatNone(f) {
  if (f.pane !== drawer.paneId) return;
  drawer.chat = 'none'; applyView();
}
async function loadEarlier(beforeSeq) {
  const r = await fetch(`/api/pane/${encodeURIComponent(drawer.paneId)}/chat?before=${beforeSeq}&limit=100`);
  return r.ok ? (await r.json()).items : [];
}
function onPaneFrame(f) {
  if (f.pane !== drawer.paneId) return;
  drawer.fails = 0; $('d-termstat').textContent = '';
  renderFrame(f, drawer.lastText === null);
}
function watchPane(id) {
  if (!cid) return;
  fetch('/api/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cid, pane: id, chat: !!id && CHAT_KINDS.has(S.panes.get(id)?.kind) }) })
    .then((r) => { if (r.status === 401) location.href = '/login'; })
    .catch(() => { /* the fallback poll covers it */ });
}

async function pollTerminal(now = false) {
  clearTimeout(drawer.timer);
  const id = drawer.paneId;
  if (!id) return;
  const live = es && es.readyState === EventSource.OPEN && cid;
  if (live && !now) return; // pushed frames drive the panel; no timer while the stream is healthy
  if (!now && document.hidden) { drawer.timer = setTimeout(() => pollTerminal(), 3000); return; }
  const stat = $('d-termstat');
  try {
    const r = await fetch(`/api/pane/${encodeURIComponent(id)}/read?lines=90&ansi=1`);
    if (r.status === 401) { location.href = '/login'; return; }
    const j = await r.json().catch(() => ({}));
    if (id !== drawer.paneId) return;
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    drawer.fails = 0; stat.textContent = '';
    renderFrame(j, now);
  } catch (e) {
    drawer.fails = (drawer.fails || 0) + 1;
    stat.textContent = 'reconnecting…'; // keep showing the last good screen
  }
  if (id === drawer.paneId && !(es && es.readyState === EventSource.OPEN && cid)) {
    drawer.timer = setTimeout(() => pollTerminal(), Math.min(1500 * 2 ** Math.min(drawer.fails || 0, 3), 12000));
  }
}

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 401) { location.href = '/login'; return null; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) toast('blocked', esc(j.error || 'request failed'));
  return r.ok ? j : null;
}
const paneUrl = (what) => `/api/pane/${encodeURIComponent(drawer.paneId)}/${what}`;

let clearPicsFn = () => {}; // drops pending image attachments (set by wireDrawer)
function wireDrawer() {
  chatView = new ChatView($('d-chat'), { loadEarlier, closeDialog, openTerminal: () => { drawer.picked = true; drawer.view = 'term'; drawer.lastText = null; applyView(); renderTerm(drawer.main, true); } });
  $('d-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    drawer.view = b.dataset.view; drawer.picked = true;
    b.classList.remove('dot'); drawer.lastText = null;
    applyView();
    if (drawer.view !== 'chat') renderTerm(drawer.view === 'side' ? drawer.side : drawer.main, true);
  });
  $('d-close').onclick = closeDrawer;
  const setFull = (on, save = true) => {
    $('drawer').classList.toggle('full', on);
    const b = $('d-full'); b.textContent = on ? '⤡' : '⤢'; b.title = b.ariaLabel = on ? 'Exit full screen' : 'Full screen'; b.setAttribute('aria-pressed', String(on));
    if (save) { try { localStorage.setItem('office.drawerFull', on ? '1' : '0'); } catch { /* storage blocked */ } }
    resizeSoon();
    if (chatView && drawer.view === 'chat') chatView.scrollToEnd();
  };
  try { if (localStorage.getItem('office.drawerFull') === '1') setFull(true, false); } catch { /* storage blocked */ }
  $('d-full').onclick = () => setFull(!$('drawer').classList.contains('full'));
  const input = $('d-input');
  // Images: stored by the bridge and handed to the agent as a file path in the message.
  const pics = []; // { file, url }
  const IMG_TYPES = /^image\/(png|jpeg|gif|webp)$/;
  const attStat = (msg, err = false) => { const el = $('d-attstat'); el.hidden = !msg; el.textContent = msg || ''; el.classList.toggle('err', err); };
  const drawPics = () => {
    const box = $('d-attach'); box.hidden = !pics.length; box.textContent = '';
    pics.forEach((p, i) => {
      const d = document.createElement('div'); d.className = 'd-att';
      const im = document.createElement('img'); im.src = p.url; im.alt = p.file.name || 'image'; im.title = `${p.file.name || 'image'} · ${Math.round(p.file.size / 1024)} KB`;
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.title = 'Remove'; x.setAttribute('aria-label', 'Remove image');
      x.onclick = () => { URL.revokeObjectURL(p.url); pics.splice(i, 1); drawPics(); };
      d.append(im, x); box.append(d);
    });
  };
  const addPics = (files) => {
    attStat('');
    for (const f of files) {
      if (!IMG_TYPES.test(f.type)) { attStat(`${f.name || 'That file'} (${f.type || 'unknown type'}) is not a png, jpeg, gif or webp image`, true); continue; }
      if (f.size > 10 * 1024 * 1024) { attStat(`${f.name || 'Image'} is over 10 MB`, true); continue; }
      if (pics.length >= 6) { attStat('Up to 6 images per message', true); break; }
      pics.push({ file: f, url: URL.createObjectURL(f) });
    }
    drawPics();
  };
  clearPicsFn = () => { attStat(''); pics.forEach((p) => URL.revokeObjectURL(p.url)); pics.length = 0; drawPics(); };
  $('d-file').onchange = (e) => { addPics([...e.target.files]); e.target.value = ''; };
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addPics(files); }
  });
  const form = $('d-form');
  form.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); form.classList.add('drop'); } });
  form.addEventListener('dragleave', () => form.classList.remove('drop'));
  form.addEventListener('drop', (e) => { e.preventDefault(); form.classList.remove('drop'); addPics([...(e.dataTransfer?.files || [])]); });
  const upload = async (file) => {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 60000);
    let r;
    try { r = await fetch(paneUrl('image'), { method: 'POST', body: file, headers: { 'content-type': file.type }, signal: ctl.signal }); }
    catch (e) { throw new Error(e.name === 'AbortError' ? 'upload timed out' : `upload failed (${e.message || 'network'})`); }
    finally { clearTimeout(t); }
    if (r.status === 401) { location.href = '/login'; throw new Error('signed out'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `upload failed (${r.status})`);
    return (await r.json()).path;
  };
  let sending = false;
  const send = async () => {
    const text = input.value;
    if ((!text.trim() && !pics.length) || !drawer.paneId || sending) return;
    sending = true;
    try {
      let msg = text.trim();
      if (pics.length) {
        let paths;
        attStat(`Uploading ${pics.length} image${pics.length > 1 ? 's' : ''}…`);
        try { paths = await Promise.all(pics.map((p) => upload(p.file))); } catch (err) { attStat(String(err.message || err), true); return; }
        attStat('');
        // Claude Code and Cursor attach an @-mentioned image; Codex takes a plain path.
        const at = S.panes.get(drawer.paneId)?.kind === 'codex' ? '' : '@';
        msg = [msg, ...paths.map((p) => at + p)].filter(Boolean).join(' ');
      }
      input.value = ''; const keep = pics.slice(); pics.length = 0; drawPics();
      // A dialog (/usage, a menu) would swallow the message: close it first. Never on a permission prompt, where Esc means "no".
      if (drawer.view === 'chat' && S.panes.get(drawer.paneId)?.status !== 'blocked' && dialogOpen(stripAnsi(drawer.main || ''))) {
        await post(paneUrl('keys'), { keys: ['esc'] }); await new Promise((r) => setTimeout(r, 300));
      }
      const ok = await post(paneUrl('text'), { text: msg, enter: true });
      if (!ok) { if (!input.value) input.value = text; pics.push(...keep); drawPics(); } // keep what was typed when delivery failed
      else keep.forEach((p) => URL.revokeObjectURL(p.url));
      setTimeout(() => pollTerminal(true), 250);
    } finally { sending = false; }
  };
  $('d-form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  // Phone keyboards often report Enter as key "Unidentified" (keyCode 229) and only emit a line-break input event,
  // so keydown alone never fires there. Catch the line break itself; Shift+Enter (desktop) still inserts one.
  let shiftDown = false;
  const isBreak = (t) => t === 'insertLineBreak' || t === 'insertParagraph';
  input.addEventListener('keydown', (e) => {
    shiftDown = e.shiftKey;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    if (e.key === 'Escape') input.blur();
  });
  input.addEventListener('beforeinput', (e) => {
    if (isBreak(e.inputType) && !shiftDown) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', (e) => { // some keyboards make the line break uncancelable while composing
    if (isBreak(e.inputType) && !shiftDown && /\n$/.test(input.value)) { input.value = input.value.replace(/\n+$/, ''); send(); }
  });
  $('d-form').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !drawer.paneId) return;
    if (b.dataset.key) await post(paneUrl('keys'), { keys: [b.dataset.key] });
    else if (b.dataset.text) await post(paneUrl('text'), { text: b.dataset.text });
    else if (b.id === 'd-stop') { // Cursor stops on Ctrl+C; Claude Code and Codex on Esc
      const ok = await post(paneUrl('keys'), { keys: [S.panes.get(drawer.paneId)?.kind === 'cursor' ? 'ctrl+c' : 'esc'] });
      if (ok) toast('blocked', 'Stop sent to the agent');
    }
    else if (b.id === 'd-focus') { await post(paneUrl('focus'), {}); toast('done', 'Focused in herdr'); return; }
    else return;
    setTimeout(() => pollTerminal(true), 200);
  });
}

// ------------------------------------------------------------------ canvas interaction
function wireStage() {
  const stage = $('stage'), cv = $('office'), tip = $('tip');
  const pts = new Map();
  let drag = null, pinch = null;
  const rel = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  cv.addEventListener('pointerdown', (e) => {
    renderer.goal = null;
    cv.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, rel(e));
    if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, cx: renderer.cam.cx, cy: renderer.cam.cy, moved: false };
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) }; drag = null; }
  });
  cv.addEventListener('pointermove', (e) => {
    const p = rel(e);
    if (pts.has(e.pointerId)) pts.set(e.pointerId, p);
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      renderer.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch.d); pinch.d = d; return;
    }
    if (drag && pts.has(e.pointerId)) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) { drag.moved = true; stage.classList.add('dragging'); }
      if (drag.moved) { renderer.cam.cx = drag.cx - dx / renderer.cam.zoom; renderer.cam.cy = drag.cy - dy / renderer.cam.zoom; renderer.clampCam(); }
      return;
    }
    if (e.pointerType === 'mouse') hover(p, e);
  });
  const end = (e) => {
    const was = drag;
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
    stage.classList.remove('dragging');
    if (was && !was.moved && e.type === 'pointerup') {
      const id = renderer.pick(rel(e).x, rel(e).y);
      if (id === 'herdy') pokeHerdy();
      else if (id) select(id); else if (S.selected) closeDrawer();
    }
    if (!pts.size) drag = null;
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', () => { S.hover = null; tip.hidden = true; stage.classList.remove('pointing'); });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault(); renderer.goal = null;
    const p = rel(e);
    renderer.zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });

  function hover(p, e) {
    const id = renderer.pick(p.x, p.y);
    S.hover = id;
    stage.classList.toggle('pointing', !!id);
    const pane = id && S.panes.get(id);
    if (!pane) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(pane.name || pane.kindLabel || 'shell')}</b> · <span style="color:${STATUS_COLOR[pane.status]}">${pane.status}</span>
      <div style="color:var(--dim)">${esc(pane.title || '').slice(0, 80)}</div><div style="color:var(--dim2)">${esc(shortPath(pane.cwd))}</div>`;
    const r = stage.getBoundingClientRect();
    tip.style.left = `${Math.min(p.x + 14, r.width - 240)}px`; tip.style.top = `${p.y + 16}px`;
  }

  $('zoom-in').onclick = () => renderer.zoomAt(renderer.w / 2, renderer.h / 2, 1.25);
  $('zoom-out').onclick = () => renderer.zoomAt(renderer.w / 2, renderer.h / 2, 0.8);
  $('btn-fit').onclick = () => renderer.fit(true);
}

function pokeHerdy() {
  const f = S.cur && S.floors.get(S.cur);
  if (!f) return;
  if (eggs?.herdyPoked()) return; // a fun fact, or the zoomies
  const c = {};
  for (const w of f.sim.workers.values()) c[w.status] = (c[w.status] || 0) + 1;
  const n = (k) => c[k] || 0;
  const line = n('blocked') ? `baa! ${n('blocked')} need${n('blocked') === 1 ? 's' : ''} you` : n('working') ? `${n('working')} working, all calm` : 'quiet floor… baa';
  f.sim.mascot.poke(f.sim.now, line);
}

function wireChrome() {
  $('floor-list').addEventListener('click', (e) => { const b = e.target.closest('.floor'); if (b) goFloor(b.dataset.ws); });
  $('activity').addEventListener('click', (e) => { const li = e.target.closest('li[data-pane]'); if (li?.dataset.pane && S.panes.has(li.dataset.pane)) select(li.dataset.pane, false, true); });
  $('btn-floors').onclick = () => $('floors').classList.toggle('open');
  const follow = $('btn-follow'), sound = $('btn-sound');
  const paint = () => { follow.classList.toggle('on', S.follow); follow.textContent = S.follow ? 'follow: on' : 'follow'; sound.classList.toggle('on', S.sound); sound.textContent = S.sound ? 'sound on' : 'sound off'; };
  follow.onclick = () => { S.follow = !S.follow; localStorage.setItem('ho.follow', S.follow ? '1' : '0'); if (S.follow && S.model?.focused.workspace) goFloor(S.model.focused.workspace); paint(); };
  sound.onclick = () => { S.sound = !S.sound; localStorage.setItem('ho.sound', S.sound ? '1' : '0'); if (S.sound) chime('done'); paint(); };
  paint();
  addEventListener('keydown', (e) => {
    if (e.target.matches('input,textarea') || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') closeDrawer();
    if ((e.key === '[' || e.key === ']') && S.model) {
      const wss = [...S.model.workspaces].sort((a, b) => a.number - b.number);
      const i = wss.findIndex((w) => w.id === S.cur);
      const n = wss[(i + (e.key === ']' ? 1 : -1) + wss.length) % wss.length];
      if (n) goFloor(n.id);
    }
  });
}

let resizeT = 0;
function resizeSoon() { cancelAnimationFrame(resizeT); resizeT = requestAnimationFrame(() => { const hadFloor = !!renderer.plan; renderer.resize(); if (hadFloor) renderer.clampCam(); }); }

// ------------------------------------------------------------------ main loop
let last = 0;
function loop(ms) {
  const t = ms / 1000, dt = Math.min(0.1, t - last || 0.016); last = t;
  const f = S.cur && S.floors.get(S.cur);
  if (f && renderer.plan === f.plan) {
    const hour = hourNow();
    f.sim.update(dt, hour);
    renderer.frame(t, { panes: S.panes, selected: S.selected, hover: S.hover, hour });
  }
  requestAnimationFrame(loop);
}

let eggs = null;
async function boot() {
  wireStage(); wireChrome(); wireDrawer();
  eggs = window.__office.eggs = installEggs({ $, renderer, toast, sim: () => (S.cur && S.floors.get(S.cur)?.sim) || null });
  installNewFloor({ $, S, goFloor, select, toast });
  renderer.resize();
  new ResizeObserver(() => { const hadFloor = !!renderer.plan; const z = renderer.cam.zoom; renderer.resize(); if (hadFloor) { renderer.clampCam(); } }).observe($('stage'));
  addEventListener('hashchange', () => { const id = location.hash.slice(1); if (S.panes.has(id) && id !== S.selected) select(id, true); });
  if (document.fonts?.load) { try { await Promise.all([document.fonts.load('600 12px "IBM Plex Mono"'), document.fonts.load('10px "Press Start 2P"')]); } catch { /* fonts optional */ } }
  await loadAssets();
  connect();
  requestAnimationFrame(loop);
}
boot();
