// Procedural pixel art. 1 world unit = 1 art pixel, 1 tile = 16 px.
// Everything is drawn with fillRect so it stays crisp at any integer zoom.
export const T = 16;

export const PAL = {
  ink: '#1a1625', ink2: '#2b2438',
  wood: '#a07850', woodLight: '#bd9468', woodDark: '#6e5038', woodEdge: '#3b2a22',
  steel: '#9aa3b5', steelDark: '#5d6578', steelLight: '#c9d0de',
  white: '#f4f1ea', cream: '#e8dfc8',
  green: '#4caf6a', greenDark: '#2f7d4c', greenLight: '#7fd48e',
  red: '#e05a5a', redDark: '#a63a3a', yellow: '#f2c14e', blue: '#4f8fe0', orange: '#e8864a',
  screen: '#10202e', screenGlow: '#58d0ff',
};

export const KIND_COLOR = {
  claude: '#e0764a', codex: '#2fb386', cursor: '#7c7cf0', gemini: '#4f8fe8', pi: '#e0b84a', grok: '#b8b8cc',
  opencode: '#35cfc8', copilot: '#9a6be0', droid: '#7fc65a', amp: '#e0507a', hermes: '#e8a23a',
};
export const STATUS_COLOR = {
  working: '#4cc9f0', idle: '#9aa3b5', blocked: '#ff5d5d', done: '#5be584', unknown: '#c9a64a', shell: '#6b7390',
};

export function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
export function kindColor(kind) {
  if (!kind) return '#8890a8';
  return KIND_COLOR[kind] || `hsl(${hash(kind) % 360} 55% 58%)`;
}

export function shade(hex, amt) {
  const c = parse(hex);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + amt * (amt < 0 ? v : 255 - v))));
  return `rgb(${f(c[0])},${f(c[1])},${f(c[2])})`;
}
function parse(col) {
  if (col.startsWith('#')) {
    const n = parseInt(col.length === 4 ? col.replace(/./g, (m, i) => (i ? m + m : m)).slice(1) : col.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const probe = parse._c || (parse._c = document.createElement('canvas').getContext('2d'));
  probe.fillStyle = '#000'; probe.fillStyle = col;
  return parse(probe.fillStyle.startsWith('#') ? probe.fillStyle : '#808080');
}

export const R = (c, x, y, w, h, col) => { c.fillStyle = col; c.fillRect(Math.round(x), Math.round(y), w, h); };
// filled box with a 1px outline
export function box(c, x, y, w, h, fill, edge = PAL.woodEdge) {
  R(c, x, y, w, h, edge); R(c, x + 1, y + 1, w - 2, h - 2, fill);
}

// ---------------------------------------------------------------- people
const SKINS = ['#f5d0b0', '#e8b890', '#c68a62', '#9a6440', '#6e4430', '#fbe0c8'];
const HAIRS = ['#2a1d18', '#4a3022', '#7a4a2a', '#c9a24a', '#d8d8e0', '#c03a3a', '#3a5ac0', '#2e2e3e', '#e07aa8'];
const PANTS = ['#2f3650', '#3a3a44', '#3d4a3a', '#4a3a3a', '#27304a'];

export function makeLook(paneId, kind) {
  const r = rng(hash(`${paneId}:${kind}`));
  const pick = (a) => a[Math.floor(r() * a.length)];
  return {
    skin: pick(SKINS), hair: pick(HAIRS), style: Math.floor(r() * 5), pants: pick(PANTS),
    shirt: kindColor(kind), glasses: r() < 0.3, headset: r() < 0.25,
  };
}

// Draw one person frame into ctx. (ox,oy) = top-left of a 16x24 cell, feet at oy+22.
// dir: 'S' | 'N' | 'E' | 'W'   pose: 'stand' | 'walk' | 'sit' | 'cheer'    f: frame index
export function drawPerson(c, look, dir, pose, f = 0) {
  if (dir === 'W') { c.save(); c.translate(16, 0); c.scale(-1, 1); drawPerson(c, look, 'E', pose, f); c.restore(); return; }
  const { skin, hair, shirt, pants } = look;
  const dark = shade(shirt, -0.28), light = shade(shirt, 0.22), hairD = shade(hair, -0.3);
  const seated = pose === 'sit';
  const walk = pose === 'walk';
  const bob = walk && (f === 1 || f === 3) ? -1 : 0;
  const cheer = pose === 'cheer';
  const y0 = 1 + bob + (cheer && f % 2 ? -2 : 0); // top of hair
  const side = dir === 'E';
  const back = dir === 'N';

  // --- legs
  if (!seated) {
    const lf = walk ? [0, 1, 2, 1][f % 4] : 1, rf = walk ? [2, 1, 0, 1][f % 4] : 1; // 0 back,1 mid,2 fwd
    if (side) {
      const a = walk ? [-2, 0, 2, 0][f % 4] : 0;
      R(c, 7 + a, y0 + 17, 3, 4 - (a > 0 ? 1 : 0), pants); R(c, 7 + a, y0 + 20 - (a > 0 ? 1 : 0), 3, 1, '#2a2230');
      R(c, 6 - a, y0 + 17, 3, 4 - (a < 0 ? 1 : 0), shade(pants, -0.18)); R(c, 6 - a, y0 + 20 - (a < 0 ? 1 : 0), 3, 1, '#2a2230');
    } else {
      R(c, 4, y0 + 17, 3, 3 + (lf > 0 ? 1 : 0) - (lf === 0 ? 1 : 0), pants); R(c, 9, y0 + 17, 3, 3 + (rf > 0 ? 1 : 0) - (rf === 0 ? 1 : 0), pants);
      R(c, 4, y0 + 19 + (lf > 0 ? 1 : 0) - (lf === 0 ? 1 : 0), 3, 1, '#2a2230'); R(c, 9, y0 + 19 + (rf > 0 ? 1 : 0) - (rf === 0 ? 1 : 0), 3, 1, '#2a2230');
    }
  }
  // --- torso
  const bodyH = seated ? 6 : 7;
  if (side) { R(c, 5, y0 + 10, 6, bodyH, shirt); R(c, 5, y0 + 10 + bodyH - 1, 6, 1, dark); R(c, 6, y0 + 10, 4, 1, light); }
  else { R(c, 4, y0 + 10, 8, bodyH, shirt); R(c, 4, y0 + 10 + bodyH - 1, 8, 1, dark); R(c, 5, y0 + 10, 6, 1, light);
    if (!back) { R(c, 7, y0 + 11, 2, 1, light); R(c, 6, y0 + 10, 1, 2, dark); R(c, 9, y0 + 10, 1, 2, dark); } }
  // --- arms
  const swing = walk ? [-1, 0, 1, 0][f % 4] : 0;
  if (seated) {
    const t = f % 2;
    if (side) { R(c, 9, y0 + 12 + t, 3, 2, shirt); R(c, 11, y0 + 12 + t, 1, 2, skin); }
    else { R(c, 2, y0 + 11, 2, 3, shirt); R(c, 12, y0 + 11, 2, 3, shirt);
      R(c, 2 + 1, y0 + 14 + (t ? 1 : 0), 2, 2, skin); R(c, 11, y0 + 14 + (t ? 0 : 1), 2, 2, skin); }
  } else if (cheer) {
    const up = f % 2 ? 1 : 0;
    R(c, 2, y0 + 5 - up, 2, 6, shirt); R(c, 12, y0 + 5 - up, 2, 6, shirt); R(c, 2, y0 + 3 - up, 2, 2, skin); R(c, 12, y0 + 3 - up, 2, 2, skin);
  } else if (side) {
    R(c, 7 + swing, y0 + 11, 2, 5, shirt); R(c, 7 + swing, y0 + 15, 2, 2, skin);
  } else {
    R(c, 2, y0 + 11 + (swing > 0 ? 1 : 0), 2, 5, shirt); R(c, 12, y0 + 11 + (swing < 0 ? 1 : 0), 2, 5, shirt);
    R(c, 2, y0 + 15 + (swing > 0 ? 1 : 0), 2, 2, skin); R(c, 12, y0 + 15 + (swing < 0 ? 1 : 0), 2, 2, skin);
  }
  // --- head
  if (side) {
    R(c, 5, y0 + 2, 7, 8, skin); R(c, 12, y0 + 6, 1, 2, skin); // nose
    R(c, 5, y0, 7, 3, hair); R(c, 4, y0 + 1, 3, 8, hair); R(c, 7, y0 + 3, 3, 1, hair);
    if (look.style === 1) R(c, 3, y0 + 4, 3, 7, hair);
    if (look.style === 4) R(c, 3, y0, 3, 3, hair);
    R(c, 9, y0 + 5, 1, 2, PAL.ink); if (look.glasses) { R(c, 9, y0 + 5, 3, 1, '#d6e4ff'); }
    R(c, 6, y0 + 6, 1, 1, shade(skin, -0.2));
  } else if (back) {
    R(c, 4, y0 + 2, 8, 8, hair); R(c, 5, y0 + 9, 6, 1, skin);
    if (look.style === 1) R(c, 3, y0 + 4, 10, 8, hair);
    if (look.style === 3) { R(c, 7, y0 - 1, 2, 2, hair); }
    R(c, 6, y0 + 4, 4, 1, hairD);
  } else {
    R(c, 4, y0 + 2, 8, 8, skin);
    R(c, 4, y0, 8, 3, hair); R(c, 3, y0 + 1, 1, 6, hair); R(c, 12, y0 + 1, 1, 6, hair);
    switch (look.style) {
      case 0: R(c, 4, y0 + 3, 2, 1, hair); R(c, 10, y0 + 3, 2, 1, hair); break;                       // short, side-swept
      case 1: R(c, 3, y0 + 3, 2, 8, hair); R(c, 11, y0 + 3, 2, 8, hair); R(c, 4, y0 + 3, 3, 1, hair); break; // long
      case 2: R(c, 5, y0 - 1, 1, 1, hair); R(c, 8, y0 - 1, 2, 1, hair); R(c, 11, y0 - 1, 1, 1, hair); break; // spiky
      case 3: R(c, 7, y0 - 2, 2, 2, hair); R(c, 4, y0 + 3, 8, 1, hair); break;                           // top bun
      default: R(c, 4, y0 + 3, 8, 1, hair); R(c, 3, y0 + 3, 1, 3, hair); R(c, 12, y0 + 3, 1, 3, hair); break; // fringe
    }
    R(c, 5, y0 + 6, 2, 2, '#fff'); R(c, 9, y0 + 6, 2, 2, '#fff');
    const blink = pose === 'sit' && f === 3;
    R(c, 6, y0 + 6, 1, blink ? 1 : 2, PAL.ink); R(c, 10, y0 + 6, 1, blink ? 1 : 2, PAL.ink);
    R(c, 7, y0 + 9, 2, 1, shade(skin, -0.25));
    if (look.glasses) { R(c, 5, y0 + 5, 3, 1, '#8aa0c8'); R(c, 8, y0 + 5, 3, 1, '#8aa0c8'); R(c, 5, y0 + 8, 3, 1, '#8aa0c8'); R(c, 8, y0 + 8, 3, 1, '#8aa0c8'); R(c, 5, y0 + 6, 1, 2, '#8aa0c8'); R(c, 10, y0 + 6, 1, 2, '#8aa0c8'); }
  }
  if (look.headset) {
    if (side) { R(c, 4, y0 + 4, 2, 3, '#303848'); } else { R(c, 2, y0 + 4, 2, 4, '#303848'); R(c, 12, y0 + 4, 2, 4, '#303848'); R(c, 4, y0 - 1, 8, 1, '#303848'); }
  }
}

// Bake a person frame into a cached, outlined canvas.
const frameCache = new Map();
export function personFrame(look, dir, pose, f) {
  const key = `${look.skin}${look.hair}${look.style}${look.shirt}${look.pants}${+look.glasses}${+look.headset}|${dir}|${pose}|${f}`;
  let cv = frameCache.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas'); cv.width = 18; cv.height = 26;
  const raw = document.createElement('canvas'); raw.width = 16; raw.height = 24;
  drawPerson(raw.getContext('2d'), look, dir, pose, f);
  const c = cv.getContext('2d');
  // 1px dark outline: stamp the silhouette in 4 directions underneath
  const sil = document.createElement('canvas'); sil.width = 16; sil.height = 24;
  const sc = sil.getContext('2d'); sc.drawImage(raw, 0, 0); sc.globalCompositeOperation = 'source-in'; sc.fillStyle = PAL.ink; sc.fillRect(0, 0, 16, 24);
  for (const [dx, dy] of [[1, 2], [3, 2], [2, 1], [2, 3]]) c.drawImage(sil, dx - 1, dy - 1 + 0);
  c.drawImage(raw, 1, 1);
  frameCache.set(key, cv);
  return cv;
}

// ---------------------------------------------------------------- furniture
// Each fn draws at (x,y) = top-left in world px.  `t` is seconds (for animation), `s` extra state.

export function deskScreen(c, x, y, w, h, status, t, seed = 0) {
  R(c, x, y, w, h, PAL.screen);
  const line = (i, len, col) => R(c, x + 1, y + 1 + i * 2, Math.min(len, w - 2), 1, col);
  if (status === 'working') {
    const off = Math.floor(t * 6 + seed) % 7;
    for (let i = 0; i < Math.floor((h - 2) / 2); i++) {
      const len = 3 + ((i + off) * 5) % (w - 4);
      line(i, len, ['#58d0ff', '#9ae6b4', '#f6e58d', '#d6b3ff'][(i + off) % 4]);
    }
  } else if (status === 'blocked') {
    R(c, x, y, w, h, Math.floor(t * 3) % 2 ? '#5a1d24' : '#3a1118');
    R(c, x + (w >> 1) - 1, y + 1, 2, h - 4, '#ff6b6b'); R(c, x + (w >> 1) - 1, y + h - 2, 2, 1, '#ff6b6b');
  } else if (status === 'done') {
    R(c, x, y, w, h, '#123a26');
    R(c, x + (w >> 1) - 3, y + (h >> 1), 2, 2, '#5be584'); R(c, x + (w >> 1) - 1, y + (h >> 1) + 1, 2, 2, '#5be584'); R(c, x + (w >> 1) + 1, y + (h >> 1) - 2, 2, 3, '#5be584');
  } else if (status === 'shell') {
    R(c, x + 1, y + 1, 2, 1, '#9ae6b4'); R(c, x + 4, y + 1, 4, 1, '#9ae6b4'); R(c, x + 1, y + 3, 2, 1, '#9ae6b4');
    if (Math.floor(t * 2) % 2) R(c, x + 4, y + 3, 2, 2, '#9ae6b4');
  } else if (status === 'unknown') {
    R(c, x + (w >> 1) - 1, y + 1, 2, 1, '#c9a64a'); R(c, x + (w >> 1), y + 2, 1, 1, '#c9a64a'); R(c, x + (w >> 1), y + 4, 1, 1, '#c9a64a');
  } else { // idle: slow screensaver dot
    const px = (Math.floor(t * 4 + seed) % (w - 4)) + 1;
    R(c, x + px, y + 1 + (px % (h - 2)), 2, 2, '#4a5a78');
  }
  R(c, x, y, w, 1, 'rgba(255,255,255,.12)');
}

function monitor(c, x, y, status, t, seed) {
  box(c, x, y, 15, 12, '#3b4256', PAL.ink);
  deskScreen(c, x + 2, y + 2, 11, 7, status, t, seed);
  R(c, x + 6, y + 12, 3, 2, '#2c3244'); R(c, x + 4, y + 14, 7, 1, '#2c3244');
}

// Workstation desk: 3 tiles wide x 2 tiles tall. Seat tile sits directly above it.
export function drawDesk(c, x, y, status, t, seed, tint = PAL.wood) {
  const top = tint, front = shade(tint, -0.22), light = shade(tint, 0.18);
  R(c, x, y + 1, 48, 3, 'rgba(0,0,0,.18)'); // soft shadow lip above (contact with floor behind)
  box(c, x, y + 2, 48, 30, front, PAL.woodEdge);
  R(c, x + 1, y + 3, 46, 13, top); R(c, x + 1, y + 3, 46, 1, light); // top surface
  R(c, x + 1, y + 16, 46, 1, shade(tint, -0.4));
  // drawers
  R(c, x + 4, y + 19, 12, 10, shade(tint, -0.12)); R(c, x + 4, y + 19, 12, 1, light); R(c, x + 8, y + 23, 4, 1, PAL.steelLight);
  R(c, x + 32, y + 19, 12, 10, shade(tint, -0.12)); R(c, x + 32, y + 19, 12, 1, light); R(c, x + 36, y + 23, 4, 1, PAL.steelLight);
  // desk items
  monitor(c, x + 29, y - 8, status, t, seed);
  R(c, x + 12, y + 9, 12, 4, '#cfd5e2'); R(c, x + 12, y + 12, 12, 1, '#8c93a6'); // keyboard
  for (let i = 0; i < 5; i++) R(c, x + 13 + i * 2, y + 10, 1, 1, '#8c93a6');
  R(c, x + 5, y + 6, 4, 5, '#f4f1ea'); R(c, x + 5, y + 6, 4, 1, '#d8cfb8'); R(c, x + 9, y + 7, 1, 3, '#f4f1ea'); // mug
  R(c, x + 6, y + 7, 2, 1, '#6b4a30');
}

export function drawChair(c, x, y, col = '#3a4259') {
  // x,y = top-left of seat tile; chair back peeks out behind the person
  box(c, x + 2, y + 2, 12, 15, col, PAL.ink);
  R(c, x + 3, y + 3, 10, 2, shade(col, 0.2));
  R(c, x + 1, y + 11, 2, 5, shade(col, -0.2)); R(c, x + 13, y + 11, 2, 5, shade(col, -0.2));
}
export function drawChairBack(c, x, y, col = '#3a4259') { // seen from behind, drawn after the person
  box(c, x + 1, y + 5, 14, 11, col, PAL.ink); R(c, x + 2, y + 6, 12, 2, shade(col, 0.2));
}

export function drawPlant(c, x, y, t, big = false) {
  const sway = Math.round(Math.sin(t * 1.4 + x) * 0.6);
  R(c, x + 3, y + 21, 10, 1, 'rgba(0,0,0,.2)');
  box(c, x + 4, y + 15, 8, 6, '#b5653f', PAL.ink); R(c, x + 4, y + 15, 8, 2, '#cf7d52');
  const blob = (bx, by, w, h, col) => R(c, x + bx + sway, y + by, w, h, col);
  if (big) {
    R(c, x + 7, y + 4, 2, 12, PAL.greenDark);
    blob(1, 4, 6, 5, PAL.green); blob(9, 3, 6, 5, PAL.green); blob(4, -4, 8, 7, PAL.green); blob(0, 9, 5, 4, PAL.greenDark); blob(11, 9, 5, 4, PAL.greenDark);
    blob(5, -3, 3, 3, PAL.greenLight); blob(2, 5, 2, 2, PAL.greenLight); blob(10, 4, 2, 2, PAL.greenLight);
  } else {
    blob(5, 6, 6, 9, PAL.green); blob(2, 8, 4, 5, PAL.green); blob(10, 8, 4, 5, PAL.green); blob(6, 2, 4, 5, PAL.green);
    blob(6, 4, 2, 6, PAL.greenLight); blob(3, 9, 2, 3, PAL.greenLight);
    R(c, x + 8, y + 12, 1, 4, PAL.greenDark);
  }
}

export function drawBookshelf(c, x, y) { // 2 tiles wide, 2 tall (32x32)
  box(c, x, y, 32, 32, '#7a5538', PAL.woodEdge);
  for (let r = 0; r < 3; r++) {
    const by = y + 2 + r * 10;
    R(c, x + 2, by, 28, 9, '#4a3324');
    const rr = rng(r * 17 + x);
    let bx = x + 3;
    while (bx < x + 28) {
      const w = 2 + Math.floor(rr() * 3), h = 5 + Math.floor(rr() * 4);
      R(c, bx, by + 9 - h, w, h, ['#c04a4a', '#4a7ac0', '#d8b04a', '#4aa070', '#8a5ac0', '#e8e0d0'][Math.floor(rr() * 6)]);
      bx += w;
    }
    R(c, x + 2, by + 9, 28, 1, '#2e2018');
  }
}

export function drawCabinet(c, x, y) { // 1 tile x 2 tiles
  box(c, x + 1, y + 2, 14, 30, PAL.steel, PAL.ink);
  for (let i = 0; i < 3; i++) { R(c, x + 3, y + 5 + i * 9, 10, 7, PAL.steelLight); R(c, x + 6, y + 8 + i * 9, 4, 1, PAL.steelDark); }
}

export function drawWhiteboard(c, x, y, w = 3) { // wall mounted, w tiles wide, 2 tiles tall
  const W = w * T;
  box(c, x, y, W, 26, '#cfd5e2', PAL.ink); R(c, x + 2, y + 2, W - 4, 22, '#f6f7fb');
  const r = rng(w * 91 + x);
  for (let i = 0; i < 4; i++) R(c, x + 4, y + 4 + i * 5, 6 + Math.floor(r() * (W - 20)), 1, ['#4f8fe0', '#e05a5a', '#4aa070', '#333'][i]);
  R(c, x + W - 12, y + 6, 7, 7, '#f2c14e'); R(c, x + 4, y + 25, W - 8, 2, '#8c93a6');
}

export function skyColors(hour) {
  // returns [top, bottom, starsAlpha]
  if (hour >= 7 && hour < 17) return ['#74c3ff', '#c5ecff', 0];
  if (hour >= 17 && hour < 19.5) return ['#f08a5d', '#ffd29a', 0];
  if (hour >= 5.5 && hour < 7) return ['#6b78c8', '#f4b896', 0.3];
  return ['#101a40', '#27356b', 1];
}
export function drawWindow(c, x, y, hour, t) { // 2 tiles wide, 2 tall wall window
  box(c, x, y, 28, 26, '#e8e2d0', PAL.ink);
  const [top, bot, stars] = skyColors(hour);
  const g = c.createLinearGradient(0, y + 2, 0, y + 24); g.addColorStop(0, top); g.addColorStop(1, bot);
  c.fillStyle = g; c.fillRect(x + 2, y + 2, 24, 22);
  if (stars) { c.globalAlpha = stars; for (let i = 0; i < 6; i++) R(c, x + 4 + ((i * 7) % 20), y + 4 + ((i * 5) % 12), 1, 1, '#fff'); c.globalAlpha = 1; }
  else { const cx = x + 4 + ((t * 0.8 + x) % 28); R(c, cx - 4, y + 8, 8, 3, 'rgba(255,255,255,.85)'); R(c, cx - 2, y + 6, 5, 2, 'rgba(255,255,255,.85)'); }
  R(c, x + 13, y + 2, 2, 22, '#e8e2d0'); R(c, x + 2, y + 12, 24, 2, '#e8e2d0');
  R(c, x - 1, y + 25, 30, 3, '#cdc4ac');
}
// A window in an inside wall (the lounge looks into the offices): the room behind it, not the sky.
// Upper pane: half-down blinds and a picture; lower pane: a desk with two lit monitors and a chair back.
export function drawInnerWindow(c, x, y, t) { // same 2 x 2 tile frame as drawWindow
  box(c, x, y, 28, 26, '#e8e2d0', PAL.ink);
  R(c, x + 2, y + 2, 24, 22, '#d8cfbc');                                   // the office's far wall
  for (let i = 0; i < 3; i++) { R(c, x + 2, y + 2 + i * 2, 24, 1, '#f3eee2'); R(c, x + 2, y + 3 + i * 2, 24, 1, '#c9bfa9'); }
  R(c, x + 2, y + 8, 24, 1, '#b8ae98');                                    // blinds' bottom rail
  R(c, x + 18, y + 9, 5, 3, PAL.ink); R(c, x + 19, y + 10, 3, 1, '#e0764a'); // a small picture
  R(c, x + 2, y + 22, 24, 2, '#9c8a72');                                   // floor under the desk
  R(c, x + 3, y + 20, 22, 2, '#8a6a4c'); R(c, x + 4, y + 22, 1, 2, '#6b4f38'); R(c, x + 23, y + 22, 1, 2, '#6b4f38');
  const glow = Math.floor(t * 1.5) % 5 ? '#8fdcff' : '#c4efff';           // someone is typing
  R(c, x + 4, y + 15, 7, 5, '#1f2738'); R(c, x + 5, y + 16, 5, 3, glow);
  R(c, x + 17, y + 15, 7, 5, '#1f2738'); R(c, x + 18, y + 16, 5, 3, '#9ae6b4');
  R(c, x + 6, y + 21, 4, 3, '#3a4259');                                    // chair back
  c.fillStyle = 'rgba(190,225,240,.16)'; c.fillRect(x + 2, y + 2, 24, 22); // glass tint
  for (let i = 0; i < 5; i++) R(c, x + 19 + i, y + 3 + i, 1, 1, 'rgba(255,255,255,.4)');
  R(c, x + 13, y + 2, 2, 22, '#e8e2d0'); R(c, x + 2, y + 12, 24, 2, '#e8e2d0');
  R(c, x - 1, y + 25, 30, 3, '#cdc4ac');
}

export function drawClock(c, x, y, now) {
  box(c, x, y, 14, 14, '#f4f1ea', PAL.ink);
  const cx = x + 7, cy = y + 7;
  const h = now.getHours() % 12 + now.getMinutes() / 60, m = now.getMinutes();
  const hand = (ang, len, col) => { const a = ang * Math.PI * 2 - Math.PI / 2; for (let i = 0; i <= len; i++) R(c, cx + Math.round(Math.cos(a) * i), cy + Math.round(Math.sin(a) * i), 1, 1, col); };
  hand(h / 12, 3, PAL.ink); hand(m / 60, 5, '#a63a3a'); R(c, cx, cy, 1, 1, PAL.ink);
}

export function drawPoster(c, x, y, seed) {
  const r = rng(seed);
  box(c, x, y, 14, 18, '#f0e8d4', PAL.ink);
  const col = ['#e0764a', '#4f8fe0', '#4caf6a', '#9a6be0'][Math.floor(r() * 4)];
  R(c, x + 2, y + 2, 10, 8, col); R(c, x + 2, y + 12, 10, 1, '#8c93a6'); R(c, x + 2, y + 14, 6, 1, '#8c93a6');
  R(c, x + 4 + Math.floor(r() * 4), y + 4, 3, 3, '#fff');
}

export function drawCoffeeMachine(c, x, y, t) { // counter 2 tiles wide x 2 tall
  box(c, x, y + 10, 32, 22, '#7a5a40', PAL.woodEdge); R(c, x + 1, y + 11, 30, 3, PAL.woodLight);
  R(c, x + 3, y + 18, 12, 10, '#6a4c36'); R(c, x + 17, y + 18, 12, 10, '#6a4c36');
  box(c, x + 18, y - 4, 11, 15, '#3a4259', PAL.ink); R(c, x + 20, y - 2, 7, 4, '#1a2236');
  R(c, x + 21, y - 1, 2, 1, '#e05a5a'); R(c, x + 21, y + 5, 5, 3, '#222'); R(c, x + 23, y + 8, 3, 3, '#f4f1ea');
  if (Math.floor(t * 2) % 2) { R(c, x + 24, y - 6 - Math.floor(t * 3) % 3, 1, 2, 'rgba(255,255,255,.7)'); }
  R(c, x + 4, y + 4, 8, 7, '#f4f1ea'); R(c, x + 12, y + 6, 2, 3, '#f4f1ea'); R(c, x + 5, y + 5, 6, 1, '#6b4a30'); // spare mug
}

export function drawVending(c, x, y, t) { // 2 tiles wide x 3 tall (32x48)
  box(c, x, y, 32, 46, '#c8403f', PAL.ink); R(c, x + 3, y + 3, 20, 30, '#10202e');
  const cols = ['#e8c14a', '#58d0ff', '#9ae6b4', '#ff8a8a', '#d6b3ff'];
  for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) R(c, x + 4 + k * 5, y + 5 + r * 7, 4, 5, cols[(r * 3 + k) % cols.length]);
  R(c, x + 25, y + 5, 5, 12, '#2a2230'); R(c, x + 26, y + 7 + (Math.floor(t) % 2), 3, 2, '#5be584');
  R(c, x + 4, y + 36, 24, 7, '#1a1625'); R(c, x + 5, y + 37, 22, 1, '#3a3a50');
}

export function drawCooler(c, x, y, t) { // 1x2 tiles
  R(c, x + 3, y + 30, 10, 2, 'rgba(0,0,0,.2)');
  box(c, x + 3, y + 14, 10, 17, '#d7dee8', PAL.ink); R(c, x + 5, y + 18, 3, 3, '#4f8fe0'); R(c, x + 9, y + 18, 3, 3, '#e05a5a'); R(c, x + 6, y + 25, 4, 2, '#8c93a6');
  box(c, x + 4, y + 1, 8, 13, '#9fd8ff', PAL.ink); R(c, x + 5, y + 3, 2, 8, 'rgba(255,255,255,.55)');
  if (Math.floor(t * 0.7) % 3 === 0) R(c, x + 7, y + 6 - (Math.floor(t * 4) % 4), 1, 1, '#fff');
}

export function drawCouch(c, x, y, col = '#5a6ab0') { // 3 tiles wide x 2 tall
  const d = shade(col, -0.25), l = shade(col, 0.2);
  box(c, x, y + 2, 48, 14, d, PAL.ink); R(c, x + 2, y + 4, 44, 10, col);
  box(c, x, y + 14, 48, 17, col, PAL.ink); R(c, x + 3, y + 16, 20, 10, l); R(c, x + 25, y + 16, 20, 10, l);
  R(c, x + 24, y + 16, 1, 11, d); R(c, x, y + 10, 4, 21, d); R(c, x + 44, y + 10, 4, 21, d);
}

export function drawRug(c, x, y, w, h, col) {
  R(c, x, y, w, h, shade(col, -0.2)); R(c, x + 2, y + 2, w - 4, h - 4, col);
  R(c, x + 4, y + 4, w - 8, h - 8, shade(col, 0.1));
  for (let i = 0; i < w; i += 4) { R(c, x + i, y - 1, 2, 1, shade(col, -0.2)); R(c, x + i, y + h, 2, 1, shade(col, -0.2)); }
}

export function drawTV(c, x, y, t) { // wall TV 3 tiles x 2
  box(c, x, y, 46, 28, '#1a1a22', PAL.ink);
  const g = c.createLinearGradient(x, y, x + 46, y + 28);
  const p = (Math.sin(t * 0.5) + 1) / 2;
  g.addColorStop(0, `hsl(${200 + p * 60} 70% 40%)`); g.addColorStop(1, `hsl(${280 + p * 40} 60% 30%)`);
  c.fillStyle = g; c.fillRect(x + 2, y + 2, 42, 22);
  R(c, x + 6, y + 6, 10, 2, 'rgba(255,255,255,.6)'); R(c, x + 6, y + 10, 16, 1, 'rgba(255,255,255,.35)');
  const bx = x + 24 + Math.round(Math.sin(t * 2) * 8); R(c, bx, y + 14, 3, 3, '#fff');
  R(c, x + 20, y + 26, 6, 2, '#333');
}

export function drawPingPong(c, x, y, t) { // 4 tiles x 2 tall (64x32)
  R(c, x + 4, y + 28, 56, 3, 'rgba(0,0,0,.2)');
  R(c, x + 4, y + 22, 3, 8, '#333'); R(c, x + 57, y + 22, 3, 8, '#333');
  box(c, x, y + 2, 64, 22, '#2f7d5a', PAL.ink); R(c, x + 2, y + 4, 60, 18, '#3a9a70');
  R(c, x + 2, y + 12, 60, 1, '#e8f4ec'); R(c, x + 31, y + 4, 2, 18, '#e8f4ec'); R(c, x + 31, y + 2, 2, 22, 'rgba(255,255,255,.55)');
  const bx = x + 32 + Math.round(Math.sin(t * 3) * 22), by = y + 8 + Math.round(Math.abs(Math.sin(t * 6)) * 6);
  R(c, bx, by, 2, 2, '#fff');
}

export function drawTrash(c, x, y) { box(c, x + 4, y + 8, 8, 8, '#6a7088', PAL.ink); R(c, x + 3, y + 7, 10, 2, '#8c93a6'); }

export function drawSign(c, x, y, w, text, col) { // wall nameplate, w px wide
  box(c, x, y, w, 11, '#222a40', PAL.ink); R(c, x + 1, y + 1, w - 2, 1, col);
  c.fillStyle = '#f4f1ea'; c.font = '8px "Press Start 2P", ui-monospace, monospace'; c.textBaseline = 'top';
  let s = text;
  while (c.measureText(s).width > w - 6 && s.length > 2) s = s.slice(0, -2) + '…';
  c.fillText(s, x + 3, y + 2);
}

export function drawLamp(c, x, y, on = true) {
  R(c, x + 7, y + 10, 2, 12, '#3a3a4a'); R(c, x + 4, y + 22, 8, 2, '#3a3a4a');
  R(c, x + 3, y + 3, 10, 8, on ? '#ffe9a8' : '#c8c0a0'); R(c, x + 4, y + 2, 8, 1, '#e8d890');
}

export function drawDoor(c, x, y, open) { // door gap 2 tiles wide, 1 tall: threshold + hinged panel
  R(c, x, y, 32, 16, '#6b6050'); R(c, x + 2, y + 2, 28, 12, '#8a7c66');
  if (!open) { R(c, x, y + 2, 3, 12, '#4a3a2a'); R(c, x + 29, y + 2, 3, 12, '#4a3a2a'); }
}

export function drawMeetingTable(c, x, y, tiles, status, t) { // tiles wide x 2 tiles tall
  const W = tiles * T;
  R(c, x + 2, y + 28, W - 4, 3, 'rgba(0,0,0,.18)');
  box(c, x, y, W, 29, '#7a5a40', PAL.woodEdge);
  R(c, x + 1, y + 1, W - 2, 22, PAL.woodLight); R(c, x + 1, y + 1, W - 2, 1, '#d8b88a');
  R(c, x + 1, y + 23, W - 2, 1, '#4a3322');
  for (let i = 0; i < tiles; i++) { // laptops / papers per seat pair
    const px = x + 4 + i * T * 1;
    if (i % 2 === 0) { R(c, px, y + 5, 10, 7, '#cfd5e2'); R(c, px + 1, y + 6, 8, 5, status === 'working' ? '#58d0ff' : '#20384e'); }
    else { R(c, px + 1, y + 7, 7, 8, '#f4f1ea'); R(c, px + 2, y + 9, 5, 1, '#8c93a6'); R(c, px + 2, y + 11, 4, 1, '#8c93a6'); }
  }
  R(c, x + (W >> 1) - 5, y + 12, 3, 4, '#f4f1ea'); // mug in the middle
}
