// Canvas renderer for one floor. World units are art pixels (16 px tiles); text is drawn in
// screen space afterwards so labels stay crisp at any zoom.
import {
  T, PAL, R, box, shade, kindColor, STATUS_COLOR, personFrame, makeLook, hash, rng,
  drawDesk, drawChair, drawChairBack, drawPlant, drawBookshelf, drawCabinet, drawWhiteboard, drawWindow, drawInnerWindow, drawClock,
  drawPoster, drawCoffeeMachine, drawVending, drawCooler, drawCouch, drawRug, drawTV, drawPingPong, drawTrash,
  drawLamp, drawMeetingTable,
} from './art.js';
import { K } from './floorplan.js';
import { cast, mascot, castFrame, mascotFrame, castIndexFor } from './assets.js';

const FONT = '"Press Start 2P", ui-monospace, Menlo, monospace';
const UI_FONT = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.cam = { cx: 0, cy: 0, zoom: 2 };
    this.plan = null; this.sim = null; this.staticCv = null; this.staticSig = '';
    this.fx = [];
    this.w = 0; this.h = 0;
    this.assets = null; // optional generated sprites (see assets.js)
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.w = Math.max(1, Math.floor(r.width)); this.h = Math.max(1, Math.floor(r.height));
    this.canvas.width = Math.floor(this.w * this.dpr); this.canvas.height = Math.floor(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`; this.canvas.style.height = `${this.h}px`;
  }

  setFloor(plan, sim, keepCam = false) {
    this.plan = plan; this.sim = sim;
    if (!this.staticCv || this.staticSig !== plan.sig) { this.staticCv = buildStatic(plan); this.staticSig = plan.sig; }
    if (!keepCam) this.fit();
  }

  // Fit the whole floor; on small screens that is unreadably tiny, so zoom into the busiest room instead.
  fit(whole = false) {
    if (!this.plan) return;
    const ww = this.plan.tw * T, wh = this.plan.th * T;
    const z = Math.min((this.w - 16) / ww, (this.h - 16) / wh);
    this.goal = null;
    if (!whole && z < 1.3) {
      this.cam.zoom = Math.min(2.5, Math.max(1.6, this.w / 260));
      const p = this.#interestingPoint();
      this.cam.cx = p.x; this.cam.cy = p.y;
      this.clampCam();
      return;
    }
    this.cam.zoom = Math.max(0.5, Math.floor(z * 4) / 4);
    this.cam.cx = ww / 2; this.cam.cy = wh / 2;
  }

  #interestingPoint() {
    let best = null, score = -1;
    for (const r of this.plan.rooms) {
      let sc = 0;
      for (const p of r.tab.panes) sc += { blocked: 5, working: 3, done: 2, unknown: 1, idle: 1 }[p.status] || 0.2;
      if (sc > score) { score = sc; best = r; }
    }
    return best ? { x: (best.x + best.ow / 2) * T, y: (best.y + best.oh / 2) * T } : { x: this.plan.tw * T / 2, y: this.plan.th * T / 2 };
  }

  clampCam() {
    const ww = this.plan.tw * T, wh = this.plan.th * T, z = this.cam.zoom;
    const vw = this.w / z, vh = this.h / z;
    this.cam.cx = ww <= vw ? ww / 2 : Math.max(vw / 2 - 20, Math.min(ww - vw / 2 + 20, this.cam.cx));
    this.cam.cy = wh <= vh ? wh / 2 : Math.max(vh / 2 - 20, Math.min(wh - vh / 2 + 20, this.cam.cy));
  }

  // smoothly bring a pane's desk (or its walking worker) to the middle of the view
  locate(paneId) {
    const st = this.plan?.stations.get(paneId);
    const w = this.sim?.workers.get(paneId);
    const p = w && !(w.seated && w.goal === 'seat') ? { x: w.x, y: w.y } : st ? { x: st.hit.x + st.hit.w / 2, y: st.hit.y + st.hit.h / 2 } : null;
    if (!p) return;
    this.goal = { cx: p.x, cy: p.y, zoom: Math.max(this.cam.zoom, 3) };
  }

  toWorld(sx, sy) { return { x: (sx - this.w / 2) / this.cam.zoom + this.cam.cx, y: (sy - this.h / 2) / this.cam.zoom + this.cam.cy }; }
  toScreen(wx, wy) { return { x: (wx - this.cam.cx) * this.cam.zoom + this.w / 2, y: (wy - this.cam.cy) * this.cam.zoom + this.h / 2 }; }

  zoomAt(sx, sy, factor) {
    const before = this.toWorld(sx, sy);
    this.cam.zoom = Math.max(0.5, Math.min(8, this.cam.zoom * factor));
    const after = this.toWorld(sx, sy);
    this.cam.cx += before.x - after.x; this.cam.cy += before.y - after.y;
    this.clampCam();
  }

  // hit test in screen coords -> pane id | null
  pick(sx, sy) {
    if (!this.plan) return null;
    const p = this.toWorld(sx, sy);
    let best = null, bestZ = -1;
    for (const w of this.sim.workers.values()) {
      const d = this.#workerDraw(w);
      if (p.x >= d.fx - 9 && p.x <= d.fx + 9 && p.y >= d.fy - 24 && p.y <= d.fy + 2 && d.z >= bestZ) { best = w.id; bestZ = d.z; }
    }
    for (const i of this.sim.interns.values()) if (p.x >= i.x - 7 && p.x <= i.x + 7 && p.y >= i.y - 19 && p.y <= i.y + 2 && i.y >= bestZ) { best = i.parentId; bestZ = i.y; }
    if (best) return best;
    if (mascot.ready) { const m = this.sim.mascot; if (Math.abs(p.x - m.x) < 10 && p.y > m.y - 22 && p.y < m.y + 3) return 'herdy'; }
    for (const st of this.plan.stations.values()) {
      const h = st.hit;
      if (p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h) return st.paneId;
    }
    return null;
  }

  // Where a worker's feet are (fx, fy = sole line), plus draw order and pose.
  #workerDraw(w) {
    const atDesk = w.seated && w.goal === 'seat';
    if (atDesk) {
      const s = w.station.seat, north = w.station.facing === 'N';
      return { fx: s.tx * T + 8, fy: s.ty * T + (north ? 15 : 20), z: (s.ty + 1) * T + (north ? 0.5 : 0), pose: 'sit', dir: w.station.facing, crop: 0 };
    }
    if (w.seated) return { fx: Math.round(w.x), fy: Math.round(w.y) + 2, z: w.y + 28, pose: 'sit', dir: 'S', crop: 7 };
    return { fx: Math.round(w.x), fy: Math.round(w.y), z: w.y, pose: w.path && w.path.length ? 'walk' : 'stand', dir: w.dir, crop: 0 };
  }

  frame(t, state) {
    const { ctx, plan, sim } = this;
    if (!plan) return;
    const hour = state.hour ?? new Date().getHours() + new Date().getMinutes() / 60;
    if (this.goal) { // ease the camera toward a requested target
      const g = this.goal, k = 0.18;
      this.cam.cx += (g.cx - this.cam.cx) * k; this.cam.cy += (g.cy - this.cam.cy) * k; this.cam.zoom += (g.zoom - this.cam.zoom) * k;
      if (Math.abs(g.cx - this.cam.cx) + Math.abs(g.cy - this.cam.cy) < 0.5 && Math.abs(g.zoom - this.cam.zoom) < 0.02) this.goal = null;
      this.clampCam();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d0e17'; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const s = this.cam.zoom * this.dpr;
    ctx.setTransform(s, 0, 0, s, (this.w / 2 - this.cam.cx * this.cam.zoom) * this.dpr, (this.h / 2 - this.cam.cy * this.cam.zoom) * this.dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.staticCv, 0, 0);

    for (const d of plan.decor) this.#decor(ctx, d, t, hour);

    // ---- entities, y-sorted
    const panes = state.panes;
    const list = [];
    for (const f of plan.furniture) list.push({ z: f.z, f });
    for (const st of plan.stations.values()) {
      const pane = panes.get(st.paneId);
      const s0 = st.seat;
      if (st.facing === 'S') list.push({ z: (s0.ty + 1) * T - 1, chair: st });
      else list.push({ z: (s0.ty + 1) * T + 0.2, chairBack: st });
      if (st.kind === 'table' && !pane?.kind) list.push({ z: (s0.ty + 1) * T + 0.4, empty: st });
    }
    for (const w of sim.workers.values()) list.push({ z: this.#workerDraw(w).z, w });
    if (mascot.ready) list.push({ z: sim.mascot.y, m: sim.mascot });
    for (const i of sim.interns.values()) list.push({ z: i.y + 0.1, i });
    list.sort((a, b) => a.z - b.z);

    for (const e of list) {
      if (e.f) this.#furniture(ctx, e.f, t, panes, state);
      else if (e.chair) drawChair(ctx, e.chair.seat.tx * T, e.chair.seat.ty * T, chairColor(e.chair, this.plan));
      else if (e.chairBack) drawChairBack(ctx, e.chairBack.seat.tx * T, e.chairBack.seat.ty * T, chairColor(e.chairBack, this.plan));
      else if (e.w) this.#worker(ctx, e.w, t, state);
      else if (e.m) this.#mascot(ctx, e.m, t);
      else if (e.i) this.#intern(ctx, e.i, t);
    }

    // selection / hover outlines (world space)
    for (const [id, kind] of [[state.hover, 'hover'], [state.selected, 'sel']]) {
      const st = id && plan.stations.get(id);
      if (!st) continue;
      const h = st.hit, pulse = kind === 'sel' ? 0.55 + 0.45 * Math.sin(t * 5) : 0.6;
      ctx.strokeStyle = kind === 'sel' ? `rgba(255,236,120,${pulse})` : 'rgba(255,255,255,.55)';
      ctx.lineWidth = 1; ctx.setLineDash([3, 2]); ctx.lineDashOffset = -t * 6;
      ctx.strokeRect(h.x + 0.5, h.y + 0.5, h.w - 1, h.h - 1); ctx.setLineDash([]);
    }

    this.#particles(ctx, t);
    // evening/night: the floor darkens and only lamps, screens and busy desks light it (labels are drawn afterwards, untinted)
    const dark = hour >= 19.5 || hour < 5.5 ? 1 : hour >= 17 ? (hour - 17) / 2.5 : hour < 7 ? (7 - hour) / 1.5 : 0;
    if (dark > 0.02) this.#night(ctx, t, dark, panes);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.#overlay(t, state);
  }

  // Darkness on its own canvas with light pools cut out of it, then a faint coloured glow added on top.
  #night(c, t, dark, panes) {
    const W = this.plan.tw * T, H = this.plan.th * T;
    if (!this.nightCv || this.nightCv.width !== W || this.nightCv.height !== H) {
      this.nightCv = document.createElement('canvas'); this.nightCv.width = W; this.nightCv.height = H;
    }
    const n = this.nightCv.getContext('2d');
    n.globalCompositeOperation = 'source-over';
    n.clearRect(0, 0, W, H);
    n.fillStyle = `rgba(8,12,38,${(0.6 * dark).toFixed(3)})`; n.fillRect(0, 0, W, H);
    const lights = this.#lights(t, panes);
    n.globalCompositeOperation = 'destination-out';
    for (const L of lights) {
      const g = n.createRadialGradient(L.x, L.y, 0, L.x, L.y, L.r);
      g.addColorStop(0, `rgba(0,0,0,${L.a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      n.fillStyle = g; n.fillRect(L.x - L.r, L.y - L.r, L.r * 2, L.r * 2);
    }
    c.drawImage(this.nightCv, 0, 0);
    c.save(); c.globalCompositeOperation = 'lighter';
    for (const L of lights) {
      const r = L.r * 0.75, g = c.createRadialGradient(L.x, L.y, 0, L.x, L.y, r);
      g.addColorStop(0, `rgba(${L.rgb},${(0.18 * dark * L.a).toFixed(3)})`); g.addColorStop(1, `rgba(${L.rgb},0)`);
      c.fillStyle = g; c.fillRect(L.x - r, L.y - r, r * 2, r * 2);
    }
    c.restore();
  }

  #lights(t, panes) {
    const WARM = '255,196,120', SCREEN = '150,215,255', MOON = '160,175,255', RED = '255,110,110';
    const out = [], add = (x, y, r, a, rgb) => out.push({ x, y, r, a, rgb });
    for (const f of this.plan.furniture) {
      if (f.type === 'lamp') add(f.px + 8, f.py + 7, 60, 0.95, WARM);
      else if (f.type === 'vending') add(f.px + 16, f.py + 20, 34, 0.75, SCREEN);
      else if (f.type === 'coffee') add(f.px + 24, f.py + 4, 20, 0.5, WARM);
      else if (f.type === 'cooler') add(f.px + 8, f.py + 16, 14, 0.4, SCREEN);
    }
    for (const d of this.plan.decor) {
      if (d.type === 'tv') add(d.px + 23, d.py + 18, 46, 0.7 + 0.12 * Math.sin(t * 6.3) * Math.sin(t * 2.1), '130,150,255');
      else if (d.type === 'window_in') add(d.px + 14, d.py + 16, 28, 0.55, SCREEN);
      else if (d.type === 'window') add(d.px + 14, d.py + 18, 24, 0.3, MOON);
    }
    // a desk is lit while its agent is up and at it; sleeping agents and empty desks stay dark
    for (const st of this.plan.stations.values()) {
      const w = this.sim.workers.get(st.paneId), pane = panes.get(st.paneId);
      if (!w || !pane?.kind || w.asleep || !(w.seated && w.goal === 'seat')) continue;
      const h = st.hit, blocked = w.status === 'blocked';
      add(h.x + h.w / 2, h.y + h.h / 2, blocked ? 34 + 4 * Math.sin(t * 6) : 34, 0.85, blocked ? RED : SCREEN);
    }
    return out;
  }

  #decor(c, d, t, hour) {
    switch (d.type) {
      case 'window': drawWindow(c, d.px, d.py, hour, t + d.px); break;
      case 'window_in': drawInnerWindow(c, d.px, d.py, t + d.px); break;
      case 'clock': drawClock(c, d.px, d.py, new Date()); break;
      case 'poster': drawPoster(c, d.px, d.py, d.seed); break;
      case 'whiteboard': drawWhiteboard(c, d.px, d.py, d.w); break;
      case 'tv': drawTV(c, d.px, d.py, t); break;
      default: break;
    }
  }

  #furniture(c, f, t, panes, state) {
    switch (f.type) {
      case 'desk': {
        const pane = panes.get(f.paneId);
        drawDesk(c, f.px, f.py, pane ? pane.status : 'idle', t, f.tx, deskTint(this.plan, f));
        break;
      }
      case 'table': {
        const rs = tableStatus(this.plan, f, panes);
        drawMeetingTable(c, f.px, f.py, f.tiles, rs, t); break;
      }
      case 'bookshelf': drawBookshelf(c, f.px, f.py); break;
      case 'cabinet': drawCabinet(c, f.px, f.py); break;
      case 'plant': drawPlant(c, f.px, f.py - (f.big ? 0 : 0), t, f.big); break;
      case 'lamp': drawLamp(c, f.px, f.py, true); break;
      case 'coffee': drawCoffeeMachine(c, f.px, f.py, t); break;
      case 'vending': drawVending(c, f.px, f.py, t); break;
      case 'cooler': drawCooler(c, f.px, f.py, t); break;
      case 'trash': drawTrash(c, f.px, f.py); break;
      case 'couch': drawCouch(c, f.px, f.py, f.col); break;
      case 'table_small': box(c, f.px + 2, f.py + 2, 28, 12, PAL.woodLight, PAL.woodEdge); R(c, f.px + 6, f.py + 4, 6, 3, '#f4f1ea'); R(c, f.px + 18, f.py + 5, 8, 5, '#e05a5a'); break;
      case 'pingpong': drawPingPong(c, f.px, f.py, t); break;
      default: break;
    }
  }

  #worker(c, w, t, state) {
    const d = this.#workerDraw(w);
    const phase = hash(w.id) % 7;
    let { fx, fy } = d;
    let pose = d.pose;
    const atDesk = w.seated && w.goal === 'seat';
    const blocked = w.status === 'blocked' && atDesk;
    const cheering = w.cheer > 0 && atDesk;
    let lift = 0;
    if (cheering) lift = Math.round(Math.abs(Math.sin(t * 9)) * 3);
    else if (blocked) { lift = Math.round(Math.abs(Math.sin(t * 7)) * 2); fx += Math.floor(t * 8) % 2 ? 1 : -1; }
    else if (w.asleep) lift = -2 - (Math.floor(t * 0.7 + phase) % 2); // slumped over the desk, slow breathing
    else if (atDesk && w.status === 'working') lift = Math.floor(t * 2.5 + phase) % 2 ? 1 : 0; // typing bob
    if (pose !== 'sit') R(c, fx - 5, fy - 1, 10, 2, 'rgba(0,0,0,.28)');
    if (pose === 'walk' && w.dist === undefined) w.dist = 0;

    if (cast.ready) {
      const idx = castIndexFor(w.id), shirt = kindColor(w.pane.kind);
      const dirKey = d.dir || 'S';
      const fr = pose === 'walk' ? castFrame(idx, shirt, dirKey, 'walk', Math.floor((w.dist || 0) / 5)) : castFrame(idx, shirt, dirKey, 'stand');
      const sh = Math.min(fr.cell, fr.foot.y + 1 - (d.crop || 0));
      c.drawImage(fr.cv, fr.sx, fr.sy, fr.cell, sh, Math.round(fx - fr.foot.x), Math.round(fy - fr.foot.y - lift), fr.cell, sh);
    } else {
      let f = w.frame;
      if (pose === 'sit') f = w.status === 'working' ? Math.floor(t * 7) % 2 : (Math.floor(t / 3.1 + hash(w.id)) % 7 === 0 && w.frame === 3 ? 3 : 0);
      if (blocked) { pose = 'cheer'; f = Math.floor(t * 4) % 2; } else if (cheering) { pose = 'cheer'; f = Math.floor(t * 6) % 2; }
      const frame = personFrame(w.look, d.dir, pose === 'walk' ? 'walk' : pose, f);
      c.drawImage(frame, Math.round(fx) - 9, Math.round(fy) - 23 - lift);
    }
    const headY = fy - 24 - lift;
    if (w.status === 'idle' && atDesk && Math.random() < (w.asleep ? 0.035 : 0.012)) this.fx.push({ t0: t, x: fx + 5, y: headY + 4, kind: 'z' });
    if (w.cheer > 0 && Math.random() < 0.3) this.fx.push({ t0: t, x: fx + (Math.random() - 0.5) * 14, y: headY + 6, kind: 'spark' });
    if (w.status === 'working' && atDesk && Math.random() < 0.02) this.fx.push({ t0: t, x: fx + 12 + Math.random() * 6, y: headY + 10, kind: 'code' });
    if (state.selected === w.id) { // bobbing arrow above
      const y = headY - 4 + Math.round(Math.sin(t * 6) * 1.5);
      R(c, fx - 2, y, 4, 1, '#ffe27a'); R(c, fx - 1, y + 1, 2, 1, '#ffe27a');
    }
  }

  // A sub-agent: a smaller colleague in the parent's colour, carrying a paper on the way in.
  #intern(c, i, t) {
    const SC = 0.75, moving = i.path && i.path.length > 0, working = i.state === 'work';
    const phase = hash(i.id) % 7;
    let lift = 0;
    if (i.state === 'cheer') lift = Math.round(Math.abs(Math.sin(t * 9)) * 3);
    else if (working) lift = Math.floor(t * 3 + phase) % 2 ? 1 : 0; // busy bob
    const fx = Math.round(i.x), fy = Math.round(i.y);
    R(c, fx - 4, fy - 1, 8, 2, 'rgba(0,0,0,.28)');
    const parent = this.sim.workers.get(i.parentId);
    if (cast.ready) {
      const idx = (castIndexFor(i.id) + 1) % cast.meta.chars.length, shirt = kindColor(parent?.pane.kind);
      const fr = moving ? castFrame(idx, shirt, i.dir, 'walk', Math.floor(i.dist / 5)) : castFrame(idx, shirt, i.dir, 'stand');
      const sh = Math.min(fr.cell, fr.foot.y + 1);
      c.drawImage(fr.cv, fr.sx, fr.sy, fr.cell, sh, Math.round(fx - fr.foot.x * SC), Math.round(fy - fr.foot.y * SC - lift), Math.round(fr.cell * SC), Math.round(sh * SC));
    } else {
      const frame = personFrame(makeLook(i.id, parent?.pane.kind), i.dir, moving ? 'walk' : 'stand', Math.floor(i.dist / 5) % 4);
      c.drawImage(frame, Math.round(fx - 9 * SC), Math.round(fy - 23 * SC - lift), Math.round(frame.width * SC), Math.round(frame.height * SC));
    }
    if (i.state === 'arrive' && moving) { R(c, fx + 3, fy - 11, 4, 5, '#f4f1ea'); R(c, fx + 4, fy - 10, 2, 1, '#8c93a6'); R(c, fx + 4, fy - 8, 2, 1, '#8c93a6'); } // the paper to hand over
    if (working && Math.random() < 0.015) this.fx.push({ t0: t, x: fx + 4 + Math.random() * 4, y: fy - 14, kind: 'code' });
    if (i.state === 'cheer' && Math.random() < 0.3) this.fx.push({ t0: t, x: fx + (Math.random() - 0.5) * 10, y: fy - 14, kind: 'spark' });
  }

  #mascot(c, m, t) {
    const moving = m.path.length > 0;
    const fr = mascotFrame(m.dir, moving ? 'walk' : 'stand', Math.floor(m.dist / 4));
    const hop = m.hop > 0 ? Math.round(Math.abs(Math.sin(t * 14)) * 4) : 0;
    R(c, m.x - 6, m.y - 1, 12, 2, 'rgba(0,0,0,.25)');
    c.drawImage(fr.cv, fr.sx, fr.sy, fr.cell, fr.cell, Math.round(m.x - fr.foot.x), Math.round(m.y - fr.foot.y - hop), fr.cell, fr.cell);
    if (m.asleep && Math.random() < 0.025) this.fx.push({ t0: t, x: m.x + 4, y: m.y - 18, kind: 'z' });
  }

  #particles(c, t) {
    this.fx = this.fx.filter((p) => t - p.t0 < 1.6);
    for (const p of this.fx) {
      const a = 1 - (t - p.t0) / 1.6;
      c.globalAlpha = a;
      if (p.kind === 'z') { R(c, p.x + Math.sin((t - p.t0) * 3) * 2, p.y - (t - p.t0) * 9, 3, 1, '#cfe3ff'); R(c, p.x + 1 + Math.sin((t - p.t0) * 3) * 2, p.y - (t - p.t0) * 9 + 1, 1, 1, '#cfe3ff'); R(c, p.x + Math.sin((t - p.t0) * 3) * 2, p.y - (t - p.t0) * 9 + 2, 3, 1, '#cfe3ff'); }
      else if (p.kind === 'spark') { R(c, p.x, p.y - (t - p.t0) * 14, 1, 3, '#ffe27a'); R(c, p.x - 1, p.y - (t - p.t0) * 14 + 1, 3, 1, '#ffe27a'); }
      else if (p.kind === 'confetti') { const k = t - p.t0; R(c, p.x + p.dx * k, p.y + p.vy * k + 22 * k * k, 3, 3, p.c); }
      else if (p.kind === 'code') { R(c, p.x, p.y - (t - p.t0) * 10, 2, 1, '#58d0ff'); R(c, p.x + 1, p.y - (t - p.t0) * 10 + 2, 3, 1, '#9ae6b4'); }
      c.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------- screen-space overlay
  #overlay(t, state) {
    const c = this.ctx, dpr = this.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.textBaseline = 'middle';
    const z = this.cam.zoom;

    // room nameplates
    c.font = `600 ${Math.max(9, Math.min(13, 5 * z))}px ${UI_FONT}`;
    for (const r of this.plan.rooms) {
      const p = this.toScreen(r.ix * T + 3, r.y * T + 5);
      const label = roomTitle(r);
      const tw = c.measureText(label).width + 10, th = Math.max(13, Math.min(18, 7 * z));
      c.fillStyle = 'rgba(14,16,28,.82)'; c.fillRect(p.x, p.y, tw, th);
      c.fillStyle = r.theme.accent; c.fillRect(p.x, p.y, 3, th);
      c.fillStyle = '#eef1ff'; c.textAlign = 'left'; c.fillText(label, p.x + 7, p.y + th / 2 + 0.5);
    }
    const lp = this.toScreen(2 * T, this.plan.loungeWallY * T + 4);
    labelPlate(c, lp.x, lp.y, 'PANTRY', '#ffb27a', z);
    const lp2 = this.toScreen((Math.floor(this.plan.tw / 2) - 3) * T, this.plan.loungeWallY * T + 4);
    labelPlate(c, lp2.x, lp2.y, 'LOUNGE', '#7aa2ff', z);
    const fp = this.toScreen(3 * T, 0.6 * T);
    labelPlate(c, fp.x, fp.y, `FLOOR ${this.plan.number} · ${this.plan.label}`.toUpperCase(), '#ffe27a', z, true);

    // workers: labels + bubbles
    const showText = z >= 1.6;
    const sorted = [...this.sim.workers.values()].sort((a, b) => a.y - b.y);
    for (const w of sorted) {
      const d = this.#workerDraw(w);
      const head = this.toScreen(d.fx, d.fy - 24);
      const name = w.pane.name || w.pane.kindLabel || 'agent';
      const focus = state.selected === w.id || state.hover === w.id;
      c.font = `600 ${Math.max(9, Math.min(12, 4.6 * z))}px ${UI_FONT}`;
      const nw = c.measureText(name).width + 12;
      const nh = Math.max(13, Math.min(17, 6.4 * z));
      const nx = Math.round(head.x - nw / 2), ny = Math.round(head.y - nh - 2);
      const col = kindColor(w.pane.kind);
      c.fillStyle = col; c.fillRect(nx, ny, nw, nh);
      c.fillStyle = 'rgba(0,0,0,.28)'; c.fillRect(nx, ny + nh - 2, nw, 2);
      c.fillStyle = STATUS_COLOR[w.status] || '#999'; c.fillRect(nx + 2, ny + Math.floor(nh / 2) - 2, 4, 4);
      c.fillStyle = luminance(col) > 0.6 ? '#14121c' : '#ffffff';
      c.textAlign = 'left'; c.fillText(name, nx + 9, ny + nh / 2 + 0.5);

      // bubble
      const text = bubbleText(w, t);
      if (text && (showText || focus || w.status === 'blocked')) {
        drawBubble(c, head.x, ny - 3, text.text, text.col, text.fg, z, t);
      } else if (!text && w.status === 'idle' && w.seated && w.goal === 'seat') {
        // sleeping: nothing, particles handle it
      } else if (text) {
        drawBubble(c, head.x, ny - 3, text.icon, text.col, text.fg, z, t, true);
      }
    }
    // interns: a small gear bubble with what they are doing (the parent's selection or zoom reveals the text)
    const stack = new Map(); // several interns of one agent: stack their bubbles so none hides another
    for (const i of this.sim.interns.values()) {
      const p = this.toScreen(i.x, i.y - 19);
      const focus = state.selected === i.parentId || state.hover === i.parentId;
      const full = (showText || focus) && i.state !== 'cheer';
      const k = full ? (stack.get(i.parentId) || 0) : 0;
      if (full) stack.set(i.parentId, k + 1);
      const up = k * Math.max(16, Math.min(22, 7.2 * z));
      if (i.state === 'cheer') drawBubble(c, p.x, p.y - 2, '✓', '#c8ffd8', '#0d3a1f', z, t, true);
      else if (full) drawBubble(c, p.x, p.y - 2 - up, `⚙ ${i.h.label}`, '#fff3c4', '#3a3010', Math.min(z, 3), t);
      else drawBubble(c, p.x, p.y - 2, '⚙', '#fff3c4', '#3a3010', z, t, true);
    }
    if (mascot.ready) {
      const m = this.sim.mascot;
      const p = this.toScreen(m.x, m.y - 24);
      if (m.say && this.sim.now < m.sayUntil) drawBubble(c, p.x, p.y - 4, m.say, '#fff4e0', '#3a2a1a', z, t);
      else if (z >= 2.2 || state.hover === 'herdy') {
        c.font = `600 ${Math.max(9, Math.min(11, 4 * z))}px ${UI_FONT}`;
        const label = 'Herdy', w = c.measureText(label).width + 10;
        c.fillStyle = '#f3e7d0'; c.fillRect(p.x - w / 2, p.y - 14, w, 13); c.fillStyle = '#3a2a1a'; c.textAlign = 'center'; c.fillText(label, p.x, p.y - 7);
      }
    }
    // shell desks: tiny plate (only when zoomed in or hovered)
    for (const st of this.plan.stations.values()) {
      const pane = state.panes.get(st.paneId);
      if (!pane || pane.kind) continue;
      if (!(z >= 2 || state.hover === st.paneId || state.selected === st.paneId)) continue;
      const base = this.toScreen(st.seat.tx * T + 8, st.seat.ty * T + (st.facing === 'S' ? 4 : 10));
      c.font = `500 ${Math.max(9, Math.min(11, 4 * z))}px ${UI_FONT}`;
      const label = st.kind === 'desk' ? 'terminal' : 'shell';
      const tw = c.measureText(label).width + 10;
      c.fillStyle = 'rgba(30,34,52,.85)'; c.fillRect(base.x - tw / 2, base.y - 16, tw, 13);
      c.fillStyle = '#9aa3b5'; c.textAlign = 'center'; c.fillText(label, base.x, base.y - 9);
    }
  }
}

// ------------------------------------------------------------------ helpers
function roomTitle(r) {
  const named = r.label && !/^\d+$/.test(r.label);
  const base = named ? r.label : `ROOM ${r.tab.number}`;
  return r.meeting ? `${base} · MEETING` : base;
}
function labelPlate(c, x, y, text, accent, z, big = false) {
  c.font = `700 ${Math.max(9, Math.min(big ? 14 : 12, (big ? 5.5 : 5) * z))}px ${UI_FONT}`;
  const w = c.measureText(text).width + 12, h = Math.max(14, Math.min(big ? 20 : 17, (big ? 7.4 : 6.5) * z));
  c.fillStyle = 'rgba(14,16,28,.85)'; c.fillRect(x, y, w, h);
  c.fillStyle = accent; c.fillRect(x, y, 3, h);
  c.fillStyle = '#eef1ff'; c.textAlign = 'left'; c.fillText(text, x + 8, y + h / 2 + 0.5);
}

function luminance(col) {
  const m = /^#?([0-9a-f]{6})$/i.exec(col);
  let r = 128, g = 128, b = 128;
  if (m) { const n = parseInt(m[1], 16); r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255; }
  else { const h = /hsl\((\d+)/.exec(col); if (h) return 0.5; }
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function bubbleText(w, t) {
  const title = (w.pane.title || '').trim();
  const dots = '.'.repeat(1 + (Math.floor(t * 2) % 3));
  if (w.asleep) return { text: 'asleep', icon: 'z', col: '#cfe3ff', fg: '#1a2550' };
  switch (w.status) {
    case 'working': return { text: title && !/@.+:/.test(title) ? title : `working${dots}`, icon: '…', col: '#e9f7ff', fg: '#10202e' };
    case 'blocked': return { text: 'needs you!', icon: '!', col: '#ff5d5d', fg: '#fff' };
    case 'done': return { text: title ? `✓ ${title}` : 'done ✓', icon: '✓', col: '#c8ffd8', fg: '#0d3a1f' };
    case 'unknown': return { text: '?', icon: '?', col: '#f4e4a8', fg: '#3a3010' };
    default: return null;
  }
}

function drawBubble(c, cx, bottom, text, bg, fg, z, t, iconOnly = false) {
  const size = Math.max(9, Math.min(12, 4.4 * z));
  c.font = `500 ${size}px ${UI_FONT}`;
  let s = text;
  const max = iconOnly ? 20 : Math.max(120, 60 * z);
  while (c.measureText(s).width > max && s.length > 3) s = s.slice(0, -2);
  if (s !== text) s += '…';
  const w = Math.max(iconOnly ? 18 : 24, c.measureText(s).width + 12), h = iconOnly ? 18 : size + 9;
  const x = Math.round(cx - w / 2), y = Math.round(bottom - h - 5 + Math.sin(t * 3 + cx) * 1);
  c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(x + 2, y + 2, w, h);
  c.fillStyle = '#1a1625'; c.fillRect(x - 1, y - 1, w + 2, h + 2);
  c.fillStyle = bg; c.fillRect(x, y, w, h);
  c.beginPath(); c.moveTo(cx - 4, y + h); c.lineTo(cx + 4, y + h); c.lineTo(cx, y + h + 5); c.closePath();
  c.fillStyle = '#1a1625'; c.fill();
  c.beginPath(); c.moveTo(cx - 3, y + h - 1); c.lineTo(cx + 3, y + h - 1); c.lineTo(cx, y + h + 3); c.closePath();
  c.fillStyle = bg; c.fill();
  c.fillStyle = fg; c.textAlign = 'center'; c.fillText(s, cx, y + h / 2 + 0.5);
}

function chairColor(st, plan) { const r = plan.rooms[st.room]; return r ? shade(r.theme.trim, -0.15) : '#3a4259'; }
function deskTint(plan, f) { const r = plan.rooms[f.room]; return r ? shade('#a07850', ((hash(r.tabId) % 5) - 2) * 0.05) : '#a07850'; }
function tableStatus(plan, f, panes) {
  const r = plan.rooms[f.room];
  return r.tab.panes.some((p) => panes.get(p.id)?.status === 'working') ? 'working' : 'idle';
}

// ------------------------------------------------------------------ static layer
function buildStatic(plan) {
  const cv = document.createElement('canvas');
  cv.width = plan.tw * T; cv.height = plan.th * T;
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;
  const roomAt = (tx, ty) => plan.rooms.find((r) => tx >= r.x && tx < r.x + r.ow && ty >= r.y && ty < r.y + r.oh);

  for (let ty = 0; ty < plan.th; ty++) for (let tx = 0; tx < plan.tw; tx++) {
    const k = plan.kind[ty * plan.tw + tx], x = tx * T, y = ty * T;
    if (k === K.HALL || k === K.WALL_V || k === K.WALL_H || k === K.DOOR) {
      R(c, x, y, T, T, (tx + ty) % 2 ? '#c9ccd8' : '#d3d6e0');
      R(c, x, y, T, 1, 'rgba(0,0,0,.05)'); R(c, x, y, 1, T, 'rgba(0,0,0,.05)');
    } else if (k === K.CARPET) {
      const r = roomAt(tx, ty);
      const [a, b] = r ? r.theme.carpet : ['#8a8fb0', '#8e93b4'];
      R(c, x, y, T, T, (tx + ty) % 2 ? a : b);
      for (let i = 0; i < 4; i++) R(c, x + ((i * 5 + ty * 3) % 14), y + ((i * 7 + tx * 5) % 14), 1, 1, shade(a, -0.08));
    } else if (k === K.LOUNGE) {
      const row = ty % 2;
      R(c, x, y, T, T, row ? '#b88e60' : '#c29868');
      R(c, x, y + 7, T, 1, 'rgba(60,35,15,.35)'); R(c, x, y + 15, T, 1, 'rgba(60,35,15,.35)');
      R(c, x + ((tx * 7 + ty * 5) % 14) + 1, y + (row ? 0 : 8), 1, 8, 'rgba(60,35,15,.3)');
    }
  }
  for (const rug of plan.rugs) drawRug(c, rug.x, rug.y, rug.w, rug.h, rug.col);

  // walls
  const faceBand = (x, y, w, base, trim) => {
    R(c, x, y, w, 32, base);
    R(c, x, y + 18, w, 14, shade(base, -0.1));            // wainscot
    R(c, x, y + 17, w, 1, shade(base, 0.15));
    R(c, x, y + 28, w, 4, shade(base, -0.3));             // baseboard
    R(c, x, y, w, 2, shade(base, 0.2));                   // cap highlight
    for (let i = 0; i < w; i += 16) { R(c, x + i, y + 2, 1, 15, shade(base, -0.06)); R(c, x + i, y + 18, 1, 10, shade(base, -0.2)); }
    R(c, x, y + 32 - 1, w, 1, PAL.ink);
  };
  faceBand(0, 0, plan.tw * T, '#454d73', '#2b3150');
  faceBand(0, plan.loungeWallY * T, plan.gap.tx0 * T, '#8a6a58', '#5a4030');
  faceBand((plan.gap.tx0 + plan.gap.w) * T, plan.loungeWallY * T, (plan.tw - plan.gap.tx0 - plan.gap.w) * T, '#8a6a58', '#5a4030');
  for (const r of plan.rooms) faceBand(r.x * T, r.y * T, r.ow * T, r.theme.wall, r.theme.trim);

  const thin = (x, y, w, h, col) => { R(c, x, y, w, h, PAL.ink); R(c, x + 1, y + 1, w - 2, h - 2, col); R(c, x + 1, y + 1, w - 2, 1, shade(col, 0.25)); };
  for (let ty = 2; ty < plan.th; ty++) for (let tx = 0; tx < plan.tw; tx++) {
    const k = plan.kind[ty * plan.tw + tx];
    if (k !== K.WALL_V && k !== K.WALL_H) continue;
    const r = roomAt(tx, ty);
    const col = r ? r.theme.trim : '#2f3552';
    const x = tx * T, y = ty * T;
    if (k === K.WALL_V) thin(x + 5, y - (ty === 2 ? 0 : 0), 6, T + 1, col);
    else thin(x - (tx === 0 ? -5 : 0), y + 5, T + 1, 6, col);
  }
  // door frames
  for (const r of plan.rooms) {
    const x = r.door.tx * T, y = r.door.ty * T;
    R(c, x, y + 3, 2 * T, 10, '#d3d6e0'); // opening
    R(c, x - 2, y + 2, 3, 12, '#3a3050'); R(c, x + 2 * T - 1, y + 2, 3, 12, '#3a3050');
    R(c, x + 4, y + 13, 2 * T - 8, 2, 'rgba(120,70,40,.7)'); // doormat
  }
  // soft contact shadow under back walls
  for (const r of plan.rooms) { R(c, r.ix * T, r.iy * T, r.iw * T, 4, 'rgba(0,0,0,.12)'); }
  R(c, T, 2 * T, (plan.tw - 2) * T, 4, 'rgba(0,0,0,.12)');
  R(c, T, (plan.loungeWallY + 2) * T, (plan.tw - 2) * T, 4, 'rgba(0,0,0,.14)');
  return cv;
}
