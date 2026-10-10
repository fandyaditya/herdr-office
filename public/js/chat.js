// Chat view for an agent pane: bubbles, markdown replies, collapsible tool cards with real diffs.
// Fed with the normalised items the bridge builds from the agent's own session log (see server/harness/).
import { mdToHtml, escHtml as esc } from './markdown.js';

const hhmm = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '');
const base = (p) => String(p || '').split('/').slice(-2).join('/');
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
const clipLine = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pre = (text, cls = '') => `<pre class="c-pre ${cls}">${esc(text)}</pre>`;

function diffLines(lines) {
  return `<div class="c-diff">${lines.map((l) => {
    const c = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx';
    return `<div class="${c}">${esc(l || ' ')}</div>`;
  }).join('')}</div>`;
}
function patchOf(item) {
  const patch = item.result?.patch;
  if (patch) {
    const lines = []; let add = 0, del = 0;
    for (const h of patch) {
      lines.push(`@@ line ${h.oldStart ?? '?'} @@`);
      for (const l of h.lines) { lines.push(l[0] === '+' || l[0] === '-' ? l : ` ${l.replace(/^ /, '')}`); if (l[0] === '+') add++; else if (l[0] === '-') del++; }
    }
    return { lines, add, del };
  }
  const i = item.input || {};
  if (item.name === 'Edit' && (i.old_string !== undefined || i.new_string !== undefined)) {
    const o = String(i.old_string ?? '').split('\n').map((l) => `-${l}`), n = String(i.new_string ?? '').split('\n').map((l) => `+${l}`);
    return { lines: [...o, ...n], add: n.length, del: o.length };
  }
  if (item.name === 'Write' && i.content !== undefined) {
    const n = String(i.content).split('\n'); return { lines: n.slice(0, 80).map((l) => `+${l}`).concat(n.length > 80 ? [`… ${n.length - 80} more lines`] : []), add: n.length, del: 0 };
  }
  return null;
}

// -> { icon, title, sum, body }
function toolView(item) {
  const i = item.input || {}, r = item.result;
  const out = r?.text ? pre(r.text, r.error ? 'err' : '') : '';
  switch (item.name) {
    case 'Bash': return { icon: '$', title: 'Bash', sum: i.description || clipLine(firstLine(i.command)), body: pre(i.command || '', 'cmd') + out };
    case 'Read': return { icon: '▤', title: 'Read', sum: base(i.file_path), full: i.file_path, body: out && pre(r.text.split('\n').slice(0, 40).join('\n')) };
    case 'Edit': case 'Write': {
      const d = patchOf(item);
      return { icon: item.name === 'Edit' ? '✎' : '＋', title: item.name, sum: base(i.file_path), full: i.file_path, stat: d ? `+${d.add} −${d.del}` : '', body: (d ? diffLines(d.lines) : '') + (r?.error ? out : '') };
    }
    case 'Grep': return { icon: '⌕', title: 'Grep', sum: clipLine(i.pattern || ''), body: pre(`${i.pattern || ''}${i.path ? `   in ${i.path}` : ''}${i.glob ? `   (${i.glob})` : ''}`, 'cmd') + out };
    case 'Glob': return { icon: '⌕', title: 'Glob', sum: i.pattern || '', body: out };
    case 'TodoWrite': {
      const todos = i.todos || [];
      return { icon: '☑', title: 'Todos', sum: `${todos.filter((t) => t.status === 'completed').length}/${todos.length} done`, body: `<ul class="c-todos">${todos.map((t) => `<li class="${esc(t.status)}">${esc(t.content)}</li>`).join('')}</ul>` };
    }
    case 'Task': case 'Agent': return { icon: '◈', title: 'Agent', sum: i.description || i.subagent_type || '', body: (i.prompt ? pre(i.prompt, 'cmd') : '') + out };
    case 'WebFetch': return { icon: '⇩', title: 'Fetch', sum: clipLine(i.url || ''), body: out };
    case 'WebSearch': return { icon: '⌕', title: 'Search', sum: clipLine(i.query || ''), body: out };
    default: return { icon: '⚙', title: item.name || 'tool', sum: clipLine(firstLine(Object.values(i).find((v) => typeof v === 'string') || '')), body: pre(JSON.stringify(i, null, 1), 'cmd') + out };
  }
}

// A slash-command dialog (/usage, /status, a menu) takes over the agent's input: anything typed goes to the dialog, not the chat.
// Those screens end with an "Esc to cancel / close" hint. "esc to interrupt" (a running turn) deliberately does not match.
export function dialogOpen(screen) {
  const tail = String(screen || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-3);
  return tail.some((l) => /\besc(?:ape)?\s+to\s+(?:cancel|close|exit|go back|dismiss)\b/i.test(l));
}

const UPLOAD_PATH = /@?(?:\S*\/)?(img-[a-z0-9]+-[0-9a-f]{8}\.(?:png|jpg|gif|webp))/g;

function renderItem(item) {
  switch (item.kind) {
    case 'user': {
      // Images attached from the chat box arrive as saved-file paths: show them as thumbnails instead of the path.
      const pics = [];
      const text = String(item.text || '').replace(UPLOAD_PATH, (_, name) => { pics.push(name); return ''; }).trim();
      const thumbs = pics.map((n) => `<a href="/api/upload/${n}" target="_blank" rel="noopener"><img class="c-pic" src="/api/upload/${n}" alt="attached image" loading="lazy"></a>`).join('');
      return { cls: `c-msg c-user${item.queued ? ' c-queued' : ''}`, html: `<div class="c-bubble">${esc(text).replace(/\n/g, '<br>')}${thumbs ? `<div class="c-pics">${thumbs}</div>` : ''}${item.images ? `<div class="c-img">🖼 ${item.images} image${item.images > 1 ? 's' : ''}</div>` : ''}</div><time>${item.queued ? 'queued · the agent will read it when it can' : hhmm(item.ts)}</time>` };
    }
    case 'assistant': return { cls: 'c-msg c-asst', html: `<div class="c-md">${mdToHtml(item.text)}</div>` };
    case 'command': return { cls: 'c-cmd', html: `<span>${esc(item.text)}</span>` };
    case 'notice': return { cls: `c-notice ${esc(item.tone || '')}`, html: esc(item.text) };
    case 'thinking': {
      if (!(item.ms >= 4000) && !(item.text && item.text.trim().length > 3)) return { cls: 'c-hide', html: '' };
      const label = `✻ Thought${item.ms ? ` for ${(item.ms / 1000).toFixed(1)}s` : ''}`;
      return { cls: 'c-think', html: item.text ? `<details><summary>${label}</summary>${pre(item.text)}</details>` : label };
    }
    case 'tool': {
      const v = toolView(item);
      const st = !item.result ? '<i class="c-spin" title="running"></i>' : item.result.error ? '<b class="c-bad" title="failed">✗</b>' : '<b class="c-ok" title="done">✓</b>';
      return { cls: `c-tool${item.result?.error ? ' err' : ''}`, tool: true, html: `<summary><span class="c-ti">${v.icon}</span><b>${esc(v.title)}</b><span class="c-ts" ${v.full ? `title="${esc(v.full)}"` : ''}>${esc(v.sum || '')}</span>${v.stat ? `<span class="c-stat">${esc(v.stat)}</span>` : ''}${st}</summary><div class="c-tb">${v.body || '<div class="c-none">no output</div>'}</div>` };
    }
    default: return { cls: 'c-hide', html: '' };
  }
}

export class ChatView {
  // hooks: { loadEarlier(beforeSeq) -> Promise<items[]>, openTerminal() }
  constructor(root, hooks) {
    this.root = root; this.hooks = hooks;
    root.innerHTML = `<div class="c-scroll"><div class="c-earlier" hidden><button type="button">Load earlier messages</button></div><div class="c-list"></div><div class="c-foot"></div></div><button type="button" class="c-pill" hidden>↓ new messages</button>`;
    this.scroll = root.querySelector('.c-scroll'); this.list = root.querySelector('.c-list'); this.foot = root.querySelector('.c-foot');
    this.earlier = root.querySelector('.c-earlier'); this.pill = root.querySelector('.c-pill');
    this.els = new Map(); this.stick = true; this.firstSeq = null; this.status = null; this.screen = '';
    this.scroll.addEventListener('scroll', () => { this.stick = this.#nearBottom(); if (this.stick) this.pill.hidden = true; });
    this.pill.onclick = () => this.#toBottom();
    this.earlier.querySelector('button').onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = 'Loading…';
      try { this.prepend(await hooks.loadEarlier(this.firstSeq)); } finally { b.disabled = false; b.textContent = 'Load earlier messages'; }
    };
    this.foot.addEventListener('click', (e) => { if (e.target.closest('[data-open-term]')) hooks.openTerminal(); if (e.target.closest('[data-close-dialog]')) hooks.closeDialog?.(); });
  }
  #nearBottom() { return this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 70; }
  #toBottom() { this.scroll.scrollTop = this.scroll.scrollHeight; this.pill.hidden = true; this.stick = true; }

  jumpToEnd() { this.#toBottom(); }
  scrollToEnd() { if (this.stick) requestAnimationFrame(() => this.#toBottom()); }

  clear() { this.list.innerHTML = ''; this.els.clear(); this.firstSeq = null; this.earlier.hidden = true; this.stick = true; this.pill.hidden = true; this.#renderFoot(); }
  get empty() { return this.els.size === 0; }

  // Make or update the DOM node of one item.
  #put(item) {
    const v = renderItem(item);
    let el = this.els.get(item.id);
    if (!el) {
      el = document.createElement(v.tool ? 'details' : 'div');
      el.dataset.seq = item.seq; el.dataset.id = item.id;
      this.els.set(item.id, el);
      let after = this.list.lastElementChild;
      while (after && Number(after.dataset.seq) > item.seq) after = after.previousElementSibling;
      this.list.insertBefore(el, after ? after.nextSibling : this.list.firstChild);
    }
    el.className = v.cls; el.innerHTML = v.html;
    if (this.firstSeq === null || item.seq < this.firstSeq) this.firstSeq = item.seq;
  }

  reset(items, { more } = {}) { this.clear(); for (const i of items) this.#put(i); this.earlier.hidden = !more; this.#toBottom(); }
  apply(items) {
    const keep = this.#nearBottom() || this.stick;
    for (const i of items) {
      const el = this.els.get(i.id), open = el?.open; // do not collapse a card the user opened
      this.#put(i);
      if (open) this.els.get(i.id).open = true;
    }
    if (keep) this.#toBottom(); else this.pill.hidden = false;
  }
  prepend(items) {
    const before = this.scroll.scrollHeight - this.scroll.scrollTop;
    for (const i of items) this.#put(i);
    this.earlier.hidden = this.firstSeq === null || this.firstSeq <= 0;
    this.scroll.scrollTop = this.scroll.scrollHeight - before; // keep what you were reading in place
  }

  // The agent's state decides the footer: a typing indicator while it works, a prompt card when it is blocked.
  setStatus(status, screenText = '') { this.status = status; this.screen = screenText; this.#renderFoot(); if (this.stick) this.#toBottom(); }
  #renderFoot() {
    if (this.status === 'working') this.foot.innerHTML = '<div class="c-typing"><i></i><i></i><i></i><span>working…</span></div>';
    else if (this.status === 'blocked') {
      const tail = this.screen.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-9).join('\n');
      this.foot.innerHTML = `<div class="c-block"><b>Waiting for you</b><span>The agent is asking for a decision (permission, trust, a choice). Answer with the buttons below, or look at the terminal.</span>${tail ? pre(tail) : ''}<button type="button" data-open-term>Open terminal</button></div>`;
    } else if (dialogOpen(this.screen)) {
      this.foot.innerHTML = '<div class="c-block c-dialog"><b>A dialog is open in the terminal</b><span>Something like /usage or a menu is on screen, so the agent is not reading the chat yet. Close it, or just send: the dialog is closed first.</span><button type="button" data-close-dialog>Close it (Esc)</button> <button type="button" data-open-term>Open terminal</button></div>';
    } else this.foot.innerHTML = '';
  }
}
