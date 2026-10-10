// Easter eggs. Rules: harmless, no network, nothing that blocks input, nothing while the user is typing in a field,
// quiet for prefers-reduced-motion. Found secrets are remembered in localStorage and counted in the About box (?).
// To add one: give it an entry in EGGS, call found('id') when it fires, and add its trigger in installEggs().
import { TRIVIA, randomTrivia } from './trivia.js';

export const EGGS = {
  konami: { name: 'The classic', hint: 'Some codes never die. Up, up, ...' },
  baa: { name: 'Fluent in sheep', hint: 'Herdy answers to its name. Say what it says.' },
  zoomies: { name: 'Zoomies', hint: 'Poke Herdy again. And again. And again.' },
  coffee: { name: 'Coffee break', hint: 'Every office runs on it. Type the word.' },
  logo: { name: 'Rebrand', hint: 'The logo has been waiting for attention.' },
  owl: { name: 'Night owl', hint: 'Visit between 02:00 and 05:00. Herdy has opinions.' },
};

const KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];
const CONFETTI = ['#ff5d5d', '#ffd166', '#5be584', '#4cc9f0', '#c77dff', '#ffffff'];
const store = {
  get() { try { return JSON.parse(localStorage.getItem('office.eggs') || '[]'); } catch { return []; } },
  set(v) { try { localStorage.setItem('office.eggs', JSON.stringify(v)); } catch { /* storage blocked */ } },
};
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// api: { sim() -> the current FloorSim | null, renderer, toast(kind, html), $ }
export function installEggs(api) {
  const { renderer, toast, $ } = api;
  const seen = new Set(store.get());
  const now = () => performance.now() / 1000;
  const found = (id) => {
    if (seen.has(id) || !EGGS[id]) return;
    seen.add(id); store.set([...seen]);
    toast('done', `Secret found: <b>${esc(EGGS[id].name)}</b> (${seen.size}/${Object.keys(EGGS).length})`);
    paintAbout();
  };

  // -- effects --
  let partyUntil = 0;
  function party() {
    found('konami');
    const sim = api.sim(); if (!sim) return;
    toast('done', '<b>Party mode!</b> Everybody cheers.');
    sim.mascot.poke(sim.now, 'PARTY! baa!');
    if (calm()) { for (const w of sim.workers.values()) w.cheer = 2.4; return; }
    partyUntil = now() + 8;
    const tick = () => {
      const s = api.sim(), t = now();
      if (!s || t > partyUntil) return;
      for (const w of s.workers.values()) {
        if (w.cheer < 1) w.cheer = 2.4;
        for (let i = 0; i < 3; i++) renderer.fx.push({ t0: t, kind: 'confetti', x: w.x + (Math.random() - 0.5) * 30, y: w.y - 22, dx: (Math.random() - 0.5) * 26, vy: -10 - Math.random() * 14, c: CONFETTI[Math.floor(Math.random() * CONFETTI.length)] });
      }
      s.mascot.hop = 0.5;
      setTimeout(tick, 160);
    };
    tick();
  }
  function coffee() {
    found('coffee');
    const sim = api.sim(); if (!sim) return;
    toast('blocked', '<b>Coffee break!</b>');
    sim.mascot.poke(sim.now, 'coffee... baa');
    const t = now();
    for (const w of sim.workers.values()) for (let i = 0; i < 4; i++) renderer.fx.push({ t0: t + i * 0.12, kind: 'spark', x: w.x + (Math.random() - 0.5) * 12, y: w.y - 24 });
  }
  function baa() { found('baa'); const sim = api.sim(); if (sim) sim.mascot.poke(sim.now, 'BAAAA!'); }

  // -- Herdy pokes: a status line, now and then a fun fact, and a fast poke streak makes it run --
  let pokes = 0, streak = [], lastFact = -1;
  const reset = () => { streak = []; };
  function herdyPoked() {
    pokes++;
    const t = now(); streak = streak.filter((x) => t - x < 3).concat(t);
    const sim = api.sim();
    if (streak.length >= 5 && sim) {
      streak = []; found('zoomies');
      sim.mascot.zoom = 6; sim.mascot.poke(sim.now, 'ZOOMIES!');
      return true;
    }
    if (pokes % 3 === 0) {
      lastFact = randomTrivia(lastFact);
      toast('done', `<b>Herdy says</b><br>${esc(TRIVIA[lastFact])}`);
      return true; // the fact replaces the usual status line
    }
    return false;
  }

  // -- the About box --
  const dlg = () => $('about');
  function paintAbout() {
    const d = dlg(); if (!d) return;
    const ids = Object.keys(EGGS);
    d.querySelector('[data-eggs]').innerHTML = ids.map((id) => seen.has(id)
      ? `<li class="got"><b>${esc(EGGS[id].name)}</b></li>`
      : `<li><b>???</b> <span>${esc(EGGS[id].hint)}</span></li>`).join('');
    d.querySelector('[data-count]').textContent = `${seen.size} of ${ids.length}`;
  }
  let factIx = -1;
  const nextFact = () => { factIx = randomTrivia(factIx); const el = dlg()?.querySelector('[data-fact]'); if (el) el.textContent = TRIVIA[factIx]; };
  function openAbout() { const d = dlg(); if (!d || d.open) return; paintAbout(); nextFact(); d.showModal(); }
  dlg()?.addEventListener('click', (e) => {
    if (e.target === dlg() || e.target.closest('[data-close]')) dlg().close();
    if (e.target.closest('[data-another]')) nextFact();
  });
  $('btn-about')?.addEventListener('click', openAbout);

  // -- the logo: five quick clicks --
  const logo = document.querySelector('.logo-text'); let logoClicks = [], logoTimer = 0;
  logo?.addEventListener('click', () => {
    const t = now(); logoClicks = logoClicks.filter((x) => t - x < 3).concat(t);
    if (logoClicks.length < 5) return;
    logoClicks = []; found('logo');
    const was = logo.dataset.name || logo.textContent; logo.dataset.name = was;
    logo.textContent = 'BAA OFFICE'; clearTimeout(logoTimer); logoTimer = setTimeout(() => { logo.textContent = was; }, 6000);
  });

  // -- keys --
  let buf = [];
  addEventListener('keydown', (e) => {
    if (e.target.matches?.('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '?') { e.preventDefault(); openAbout(); return; }
    buf = buf.concat(e.key.toLowerCase()).slice(-10);
    const tail = (s) => buf.slice(-s.length).join('') === s;
    if (buf.join('|') === KONAMI.join('|')) { buf = []; party(); }
    else if (tail('coffee')) { buf = []; coffee(); }
    else if (tail('baa')) { buf = []; baa(); }
  });

  // -- night owl: 02:00-04:59, once per visit, when the floor is up --
  const h = new Date().getHours();
  if (h >= 2 && h < 5) {
    const iv = setInterval(() => {
      const sim = api.sim(); if (!sim) return;
      clearInterval(iv); found('owl'); sim.mascot.poke(sim.now, 'go to bed... baa');
    }, 2500);
  }

  // -- for people who open devtools --
  try {
    console.log('%cHerdr Office', 'font:700 16px monospace;color:#ffd166');
    console.log('Hi! Curious about the code? It is plain ES modules, no build step. Start at AGENTS.md.\nThere are %d secrets in here. Press ? to see how many you have found.', Object.keys(EGGS).length);
  } catch { /* no console */ }

  return { herdyPoked, reset, found, openAbout };
}
