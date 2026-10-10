// Floor planner: workspace -> floor plan.
//   tab  -> room (1 pane = private office, 2+ panes = meeting room around a table)
//   pane -> seat
// Pure logic (no DOM) so it can run under node for tests.
import { T, shade } from './art.js';

export const K = { VOID: 0, HALL: 1, CARPET: 2, LOUNGE: 3, WALL_V: 4, WALL_H: 5, FACE: 6, DOOR: 7 };

const HALL_H = 3;       // corridor height between room rows
const LOUNGE_H = 7;     // lounge floor rows
const MAX_ROW_W = 46;   // wrap rooms to a new row past this width
const MIN_FLOOR_W = 30;

export const ROOM_THEMES = [
  { wall: '#566a9c', trim: '#3d4d7a', carpet: ['#6b7fb3', '#7287bb'], accent: '#7aa2ff' },
  { wall: '#9a6a50', trim: '#6e4a38', carpet: ['#b98a6a', '#c29372'], accent: '#ffb27a' },
  { wall: '#4f8a76', trim: '#386654', carpet: ['#68a690', '#70ae98'], accent: '#6ee7b7' },
  { wall: '#7d5a9a', trim: '#5a3f74', carpet: ['#9a78b8', '#a380c0'], accent: '#d0a8ff' },
  { wall: '#9a8a4a', trim: '#6e6234', carpet: ['#b8a864', '#c0b06c'], accent: '#ffe27a' },
  { wall: '#9a4f5e', trim: '#743a46', carpet: ['#b86e7e', '#c07686'], accent: '#ff8fa3' },
];

export function floorSignature(ws) {
  return ws.tabs.map((t) => `${t.id}:${t.panes.map((p) => p.id).join(',')}`).join('|');
}

export function planFloor(ws) {
  // ---- 1. size each room
  const rooms = ws.tabs.map((tab, idx) => {
    const n = Math.max(1, tab.panes.length);
    const meeting = n >= 2;
    const k = Math.ceil(n / 2);
    const iw = meeting ? Math.max(10, 3 * k + 4) : 8;
    const ih = meeting ? 9 : 6;
    return { idx, tabId: tab.id, label: tab.label, tab, meeting, k, iw, ih, ow: iw + 2, oh: ih + 3 };
  });

  // ---- 2. pack into rows
  const rows = [];
  let cur = [], curW = 0;
  for (const r of rooms) {
    const add = cur.length ? r.ow - 1 : r.ow;
    if (cur.length && curW + add > MAX_ROW_W) { rows.push(cur); cur = []; curW = 0; }
    curW += cur.length ? r.ow - 1 : r.ow;
    cur.push(r);
  }
  if (cur.length) rows.push(cur);
  const rowW = rows.map((row) => row.reduce((s, r, i) => s + (i ? r.ow - 1 : r.ow), 0));
  const tw = Math.max(MIN_FLOOR_W, Math.max(...rowW) + 3); // +3 leaves a side corridor linking every hall

  // ---- 3. vertical layout
  let y = 2 + HALL_H;
  rows.forEach((row) => {
    const rowH = Math.max(...row.map((r) => r.oh));
    let x = 0;
    row.forEach((r, i) => {
      r.x = x; r.y = y; r.oh = rowH; r.ih = rowH - 3;
      r.ix = r.x + 1; r.iy = r.y + 2;
      x += r.ow - 1;
      r.door = { tx: r.ix + (r.iw >> 1) - 1, ty: r.y + rowH - 1 };
    });
    y += rowH + HALL_H;
  });
  const loungeWallY = y;           // 2-row wall face
  const loungeY = y + 2;           // first lounge floor row
  const th = loungeY + LOUNGE_H + 1;

  const kind = new Uint8Array(tw * th);
  const roomOf = new Int16Array(tw * th).fill(-1);
  const blocked = new Uint8Array(tw * th);
  const at = (tx, ty) => ty * tw + tx;
  const inb = (tx, ty) => tx >= 0 && ty >= 0 && tx < tw && ty < th;
  const setK = (tx, ty, k, solid) => { if (inb(tx, ty)) { kind[at(tx, ty)] = k; blocked[at(tx, ty)] = solid ? 1 : 0; } };

  // building shell
  for (let tx = 0; tx < tw; tx++) { setK(tx, 0, K.FACE, true); setK(tx, 1, K.FACE, true); setK(tx, th - 1, K.WALL_H, true); }
  for (let ty = 2; ty < th - 1; ty++) { setK(0, ty, K.WALL_V, true); setK(tw - 1, ty, K.WALL_V, true); }
  // halls
  for (let ty = 2; ty < loungeWallY; ty++) for (let tx = 1; tx < tw - 1; tx++) setK(tx, ty, K.HALL, false);
  // lounge
  const gap = { tx0: 10, w: 3 }; // doorway from the hall into the lounge
  for (let tx = 0; tx < tw; tx++) {
    const inGap = tx >= gap.tx0 && tx < gap.tx0 + gap.w;
    setK(tx, loungeWallY, inGap ? K.HALL : K.FACE, !inGap); setK(tx, loungeWallY + 1, inGap ? K.HALL : K.FACE, !inGap);
  }
  for (let ty = loungeY; ty < th - 1; ty++) for (let tx = 1; tx < tw - 1; tx++) setK(tx, ty, K.LOUNGE, false);

  const furniture = [];
  const decor = [];       // static wall-mounted things
  const rugs = [];
  const stations = new Map();
  const furn = (type, tx, ty, fw, fh, opts = {}) => {
    const it = { type, tx, ty, fw, fh, px: tx * T, py: ty * T, z: (ty + fh) * T, ...opts };
    for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) if (inb(tx + i, ty + j)) blocked[at(tx + i, ty + j)] = 1;
    furniture.push(it);
    return it;
  };

  // ---- 4. rooms
  rooms.forEach((r) => {
    const theme = ROOM_THEMES[(hashStr(ws.id) + r.idx) % ROOM_THEMES.length];
    r.theme = theme;
    // back wall face
    for (let tx = r.x; tx < r.x + r.ow; tx++) { setK(tx, r.y, K.FACE, true); setK(tx, r.y + 1, K.FACE, true); }
    // interior carpet
    for (let ty = r.iy; ty < r.iy + r.ih; ty++) for (let tx = r.ix; tx < r.ix + r.iw; tx++) { setK(tx, ty, K.CARPET, false); roomOf[at(tx, ty)] = r.idx; }
    // side + bottom walls
    for (let ty = r.iy; ty < r.y + r.oh; ty++) { setK(r.x, ty, K.WALL_V, true); setK(r.x + r.ow - 1, ty, K.WALL_V, true); }
    for (let tx = r.x; tx < r.x + r.ow; tx++) setK(tx, r.y + r.oh - 1, K.WALL_H, true);
    // door gap (2 tiles)
    for (let i = 0; i < 2; i++) { setK(r.door.tx + i, r.door.ty, K.DOOR, false); }
    const panes = r.tab.panes;
    const sig = hashStr(r.tabId);
    if (!r.meeting) {
      const dx = r.ix + ((r.iw - 3) >> 1);
      const dy = r.iy + 2;
      const p = panes[0];
      furn('desk', dx, dy, 3, 2, { paneId: p?.id, room: r.idx });
      if (p) stations.set(p.id, { paneId: p.id, seat: { tx: dx + 1, ty: dy - 1 }, facing: 'S', kind: 'desk', room: r.idx,
        hit: { x: dx * T, y: (dy - 1) * T - 4, w: 3 * T, h: 3 * T + 4 }, index: 0 });
      furn('bookshelf', r.ix, r.iy, 2, 1, { py: (r.iy - 1) * T });
      furn('cabinet', r.ix + r.iw - 1, r.iy, 1, 1, { py: (r.iy - 1) * T });
      furn('plant', r.ix + r.iw - 1, r.iy + 3, 1, 1);
      furn('plant', r.ix, r.iy + r.ih - 1, 1, 1, { big: true });
      decor.push({ type: 'window', px: (r.ix + 4) * T + 2, py: (r.y + 0.5) * T });
      decor.push({ type: 'poster', px: (r.ix + 7) * T + 1, py: (r.y + 0.4) * T, seed: sig });
      rugs.push({ x: dx * T - 8, y: (dy + 2) * T, w: 3 * T + 16, h: 2 * T, col: shade(theme.carpet[0], 0.14) });
    } else {
      const tableTiles = 3 * r.k;
      const tx0 = r.ix + ((r.iw - tableTiles) >> 1);
      const ty0 = r.iy + 3;
      furn('table', tx0, ty0, tableTiles, 2, { room: r.idx, tiles: tableTiles });
      panes.forEach((p, i) => {
        const col = Math.floor(i / 2), top = i % 2 === 0;
        const stx = tx0 + 1 + col * 3, sty = top ? ty0 - 1 : ty0 + 2;
        stations.set(p.id, { paneId: p.id, seat: { tx: stx, ty: sty }, facing: top ? 'S' : 'N', kind: 'table', room: r.idx,
          hit: { x: (stx - 1) * T, y: (sty - 1) * T, w: 3 * T, h: 2.4 * T }, index: i });
      });
      const wbw = Math.min(5, r.iw - 6);
      decor.push({ type: 'whiteboard', px: (r.ix + r.iw - wbw - 1) * T, py: (r.y + 0.3) * T, w: wbw });
      furn('plant', r.ix, r.iy, 1, 1, { big: true });
      furn('plant', r.ix + r.iw - 1, r.iy, 1, 1);
      furn('lamp', r.ix + r.iw - 1, r.iy + r.ih - 3, 1, 1);
      rugs.push({ x: (tx0 - 1) * T, y: (ty0 - 1) * T - 2, w: (tableTiles + 2) * T, h: 4 * T + 4, col: shade(theme.carpet[0], 0.14) });
    }
    r.nameplate = { px: r.ix * T + 2, py: r.iy * T - 14, w: Math.min(r.iw * T - 4, 100) };
  });

  // ---- 5. back wall decor (building wall) + hallway furniture
  for (let tx = 4; tx < tw - 6; tx += 9) decor.push({ type: 'window', px: tx * T, py: 0.4 * T });
  decor.push({ type: 'clock', px: (tw >> 1) * T - 7, py: 0.5 * T });
  // empty floor area at the end of each row: a little break nook
  rows.forEach((row, ri) => {
    const rw = rowW[ri];
    const ry = row[0].y, rh = row[0].oh;
    if (tw - rw >= 5) {
      const nx = rw + 1;
      furn('plant', nx, ry + 2, 1, 1, { big: true });
      furn('cooler', nx + 2, ry + 1, 1, 2, { py: (ry + 1) * T });
      furn('plant', tw - 2, ry + rh - 2, 1, 1);
    }
  });

  // ---- 6. lounge
  const spots = { coffee: [], couch: [], pingpong: [], cooler: [], vending: [], tv: [], window: [], wander: [] };
  const ly = loungeY;
  const spot = (list, tx, ty, face, sit = false) => spots[list].push({ tx, ty, face, sit });

  furn('coffee', 2, ly, 2, 1, { py: (ly - 1) * T });
  spot('coffee', 2, ly + 1, 'N'); spot('coffee', 3, ly + 1, 'N');
  furn('vending', 5, ly, 2, 1, { py: (ly - 2) * T });
  spot('vending', 5, ly + 1, 'N'); spot('vending', 6, ly + 1, 'N');
  furn('cooler', 8, ly, 1, 1, { py: (ly - 1) * T });
  spot('cooler', 8, ly + 1, 'N');
  furn('trash', 9, ly, 1, 1);

  const cx = 11;
  rugs.push({ x: (cx - 1) * T, y: (ly + 1) * T, w: 11 * T, h: 5 * T + 4, col: '#8a78b4' });
  furn('couch', cx, ly + 1, 3, 2, { col: '#5a6ab0' });
  furn('couch', cx + 6, ly + 1, 3, 2, { col: '#b0645a' });
  furn('table_small', cx + 3, ly + 3, 2, 1, {});
  for (const dx of [0, 1, 2]) spot('couch', cx + dx, ly + 2, 'S', true);   // seated on couch seat row
  for (const dx of [6, 7, 8]) spot('couch', cx + dx, ly + 2, 'S', true);
  decor.push({ type: 'tv', px: (cx + 3) * T - 6, py: (loungeWallY + 0.2) * T });
  // The lounge wall is shared with the offices, so its windows look into a room, not outside.
  decor.push({ type: 'window_in', px: (cx + 8) * T, py: (loungeWallY + 0.4) * T });
  decor.push({ type: 'window_in', px: (tw - 6) * T, py: (loungeWallY + 0.4) * T });
  decor.push({ type: 'poster', px: (cx + 7) * T - 4, py: (loungeWallY + 0.3) * T, seed: 7 });
  decor.push({ type: 'sign', px: 2 * T, py: (loungeWallY + 0.1) * T, w: 8 * T, text: 'PANTRY', col: '#ffb27a' });
  decor.push({ type: 'sign', px: (cx + 1) * T, py: (loungeWallY + 1.4) * T, w: 7 * T, text: 'LOUNGE', col: '#7aa2ff' });

  const ppx = Math.max(cx + 12, tw - 8);
  furn('pingpong', ppx, ly + 2, 4, 2, {});
  spot('pingpong', ppx - 1, ly + 2, 'E'); spot('pingpong', ppx + 4, ly + 2, 'W');
  spot('pingpong', ppx - 1, ly + 3, 'E'); spot('pingpong', ppx + 4, ly + 3, 'W');
  furn('plant', tw - 2, ly, 1, 1, { big: true });
  furn('plant', 11, ly, 1, 1);
  furn('lamp', tw - 2, ly + 4, 1, 1);

  // window gazing + wander points on the halls
  const hallRows = [2, ...rows.map((row) => row[0].y + row[0].oh)];
  hallRows.forEach((hy, i) => {
    for (let tx = 3; tx < tw - 3; tx += 5) spot('wander', tx, hy + 1 + ((tx + i) % 2), 'S');
  });
  for (let tx = 4; tx < tw - 6; tx += 9) spot('window', tx + 1, 3, 'N');
  for (let tx = 14; tx < tw - 10; tx += 7) spot('wander', tx, ly + 5, 'S');

  // unblock nothing else; seat tiles stay walkable
  for (const st of stations.values()) blocked[at(st.seat.tx, st.seat.ty)] = 0;

  return {
    id: ws.id, sig: floorSignature(ws), tw, th, kind, roomOf, blocked, rooms, furniture, decor, rugs, stations, spots,
    loungeY, loungeWallY, gap, halls: hallRows, label: ws.label, number: ws.number,
    idx: (i, j) => j * tw + i,
  };
}

export function hashStr(s) { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
