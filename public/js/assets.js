// Generated sprite assets (Pixellab cast). Optional: if the atlas is missing the procedural
// people from art.js are used, so the office always renders.
import { hash } from './art.js';

export const cast = { ready: false, meta: null, atlas: null, cache: new Map(), feet: null };
export const mascot = { ready: false, meta: null, atlas: null, feet: null };

async function loadAtlas(name, into) {
  try {
    const meta = await (await fetch(`/assets/${name}.json`)).json();
    const img = new Image();
    img.src = `/assets/${name}.png`;
    await img.decode();
    into.meta = meta; into.atlas = img; into.feet = measureFeet(img, meta); into.ready = true;
  } catch { into.ready = false; }
}
export async function loadAssets() { await Promise.all([loadAtlas('cast', cast), loadAtlas('mascot', mascot)]); }

// Where the soles are in every cell. Standing cells are measured per direction; walk rows use the
// median of their frames so feet do not bounce when a leg lifts.
function measureFeet(img, meta) {
  const { cell, cols, rows } = meta;
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const c = cv.getContext('2d', { willReadFrequently: true }); c.drawImage(img, 0, 0);
  const box = (cx, cy) => {
    const d = c.getImageData(cx * cell, cy * cell, cell, cell).data;
    let x0 = cell, x1 = -1, y0 = cell, y1 = -1;
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) if (d[(y * cell + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return { x: (x0 + x1 + 1) / 2, y: y1 + 1, top: y0 };
  };
  const med = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
  return meta.chars.map((_, i) => {
    const out = { stand: [], walk: [] };
    for (let col = 0; col < 4; col++) out.stand.push(box(col, i * rows));
    for (let r = 1; r < rows; r++) {
      const f = Array.from({ length: cols }, (_, col) => box(col, i * rows + r));
      out.walk.push({ x: Math.round(med(f.map((b) => b.x))), y: med(f.map((b) => b.y)), top: med(f.map((b) => b.top)) });
    }
    return out;
  });
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255];
}
function parseColor(col) {
  const c = document.createElement('canvas').getContext('2d'); c.fillStyle = col; const v = c.fillStyle;
  if (v.startsWith('#')) { const n = parseInt(v.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  const m = /rgba?\((\d+), (\d+), (\d+)/.exec(v); return m ? [+m[1], +m[2], +m[3]] : [128, 128, 128];
}

// Recolour the teal shirt of one character's strip to `shirt`. Cached per (character, colour).
function strip(charIdx, shirt) {
  const key = `${charIdx}|${shirt}`;
  let cv = cast.cache.get(key);
  if (cv) return cv;
  const { cell, cols, rows } = cast.meta;
  cv = document.createElement('canvas'); cv.width = cell * cols; cv.height = cell * rows;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.drawImage(cast.atlas, 0, charIdx * rows * cell, cv.width, cv.height, 0, 0, cv.width, cv.height);
  const img = c.getImageData(0, 0, cv.width, cv.height), d = img.data;
  const [tr, tg, tb] = parseColor(shirt);
  const [th, ts, tl] = rgbToHsl(tr, tg, tb);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    if (h < 0.4 || h > 0.58 || s < 0.3) continue; // not teal
    // keep the sprite's shading, move it onto the target colour
    const nl = Math.max(0.05, Math.min(0.95, tl + (l - 0.45) * 0.9));
    const ns = Math.min(1, ts * (0.55 + s * 0.6));
    const [r, g, b] = hslToRgb(th, ns, nl);
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  c.putImageData(img, 0, 0);
  cast.cache.set(key, cv);
  return cv;
}

export const castCount = () => (cast.ready ? cast.meta.chars.length : 0);
export const castIndexFor = (paneId) => (cast.ready ? hash(paneId) % cast.meta.chars.length : -1);

const DIR_INDEX = { S: 0, E: 1, N: 2, W: 3 };
// -> { cv, sx, sy, cell, foot:{x,y,top} }     dir: 'S'|'E'|'N'|'W'     anim: 'stand' | 'walk'
export function castFrame(charIdx, shirt, dir, anim, frame = 0) {
  const { cell } = cast.meta;
  const di = DIR_INDEX[dir] ?? 0;
  const feet = cast.feet[charIdx];
  return {
    cv: strip(charIdx, shirt),
    sx: anim === 'walk' ? (frame % 6) * cell : di * cell,
    sy: anim === 'walk' ? (di + 1) * cell : 0,
    cell, foot: anim === 'walk' ? feet.walk[di] : feet.stand[di],
  };
}

// The sheep mascot (single character, no recolouring).
export function mascotFrame(dir, anim, frame = 0) {
  const { cell } = mascot.meta;
  const di = DIR_INDEX[dir] ?? 0;
  const feet = mascot.feet[0];
  return {
    cv: mascot.atlas,
    sx: anim === 'walk' ? (frame % 6) * cell : di * cell,
    sy: anim === 'walk' ? (di + 1) * cell : 0,
    cell, foot: anim === 'walk' ? feet.walk[di] : feet.stand[di],
  };
}
