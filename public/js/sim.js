// Per-floor simulation: one Worker per agent pane. Status drives behaviour:
//   working/blocked/unknown -> at their desk      idle/done -> drift to the lounge, hallway, window...
//   ("done" = the agent finished its turn and is only waiting to be looked at: it cheers at the desk, then wanders)
import { T, makeLook, hash, rng } from './art.js';
import { findPath } from './nav.js';

const SPEED = 46; // px / s
const SEATED = new Set(['working', 'blocked', 'unknown']);
const FREE = new Set(['idle', 'done']); // not busy: allowed to leave the desk
// Night (viewer's local time): idle agents go back to their desks and sleep; Herdy curls up by the couch.
const SLEEP_FROM = 21, SLEEP_TO = 6;
export const isNight = (hour) => hour >= SLEEP_FROM || hour < SLEEP_TO;

export class Worker {
  constructor(pane, station, plan) {
    this.id = pane.id;
    this.pane = pane;
    this.look = makeLook(pane.id, pane.kind);
    this.r = rng(hash(pane.id) ^ 0x9e3779b9);
    this.station = station;
    this.status = pane.status;
    const s = station.seat;
    this.tx = s.tx; this.ty = s.ty;
    this.x = s.tx * T + 8; this.y = s.ty * T + 14;
    this.dir = station.facing;
    this.path = [];
    this.goal = 'seat';          // 'seat' | 'spot' | 'idle-seat'
    this.spot = null;
    this.dwell = 2 + this.r() * 6;
    this.seated = true;
    this.frame = 0; this.frameT = 0;
    this.cheer = 0;
    this.sinceStatus = 0;
  }
}

// Herdy, the herd mascot: wanders the floor, and trots over to any agent that needs a human.
export class Mascot {
  constructor(plan) {
    this.plan = plan;
    this.r = rng(hash(plan.id) ^ 0x51ed);
    const home = plan.spots.couch[0] || plan.spots.wander[0];
    this.tx = home.tx; this.ty = home.ty + 1;
    this.x = this.tx * T + 8; this.y = this.ty * T + 14;
    this.dir = 'S'; this.path = []; this.dist = 0; this.target = null; this.wait = 2; this.say = null; this.sayUntil = 0; this.hop = 0; this.zoom = 0;
  }
  #goTo(tx, ty) {
    const p = findPath(this.plan, this.tx, this.ty, tx, ty);
    this.path = p || [];
  }
  update(dt, workers, now, night = false) {
    if (this.hop > 0) this.hop -= dt;
    if (this.zoom > 0) { this.zoom -= dt; this.wait = Math.min(this.wait, 0.25); } // easter egg: Herdy runs laps
    this.asleep = false;
    // priority: someone is blocked -> go stand next to their desk
    const blocked = [...workers.values()].find((w) => w.status === 'blocked' && w.seated && w.goal === 'seat');
    if (blocked && this.target !== blocked.id) {
      this.target = blocked.id;
      const s = blocked.station.seat;
      const free = [[s.tx + 1, s.ty], [s.tx - 1, s.ty], [s.tx, s.ty + 3], [s.tx + 2, s.ty]].find(([x, y]) => x >= 0 && y >= 0 && x < this.plan.tw && !this.plan.blocked[y * this.plan.tw + x]);
      if (free) this.#goTo(free[0], free[1]);
      this.arriveSay = 'baa! needs you';
    } else if (!blocked && this.target) { this.target = null; this.wait = 1; }

    if (night && !blocked && !this.path.length) { // bedtime: by the first couch, until someone needs a human
      const bed = this.plan.spots.couch[0] || this.plan.spots.wander[0];
      const by = bed ? bed.ty + (this.plan.blocked[bed.ty * this.plan.tw + bed.tx] ? 1 : 0) : this.ty;
      if (!bed || (this.tx === bed.tx && this.ty === by)) { this.asleep = true; this.dir = 'S'; return; }
      this.#goTo(bed.tx, by);
      if (!this.path.length) { this.asleep = true; return; } // no way there: sleep where it stands
    }

    if (this.path.length) {
      const n = this.path[0], nx = n.x * T + 8, ny = n.y * T + 14;
      const dx = nx - this.x, dy = ny - this.y, d = Math.hypot(dx, dy), step = 34 * dt * (this.zoom > 0 ? 3 : 1);
      if (Math.abs(dx) > Math.abs(dy) + 0.5) this.dir = dx > 0 ? 'E' : 'W'; else if (d > 0.1) this.dir = dy > 0 ? 'S' : 'N';
      this.dist += Math.min(d, step);
      if (d <= step) { this.x = nx; this.y = ny; this.tx = n.x; this.ty = n.y; this.path.shift(); } else { this.x += (dx / d) * step; this.y += (dy / d) * step; }
      if (!this.path.length) { this.wait = 4 + this.r() * 8; if (this.arriveSay) { this.say = this.arriveSay; this.sayUntil = now + 4; this.arriveSay = null; this.hop = 0.6; } }
      return;
    }
    if (this.target) { // arrived and waiting for the human
      if (now > this.sayUntil + 3) { this.say = 'baa!'; this.sayUntil = now + 2; this.hop = 0.5; }
      return;
    }
    this.wait -= dt;
    if (this.wait <= 0) {
      const spots = this.plan.spots, kinds = ['couch', 'wander', 'coffee', 'pingpong', 'wander', 'window', 'cooler'];
      const list = spots[kinds[Math.floor(this.r() * kinds.length)]];
      const sp = list[Math.floor(this.r() * list.length)];
      if (sp) this.#goTo(sp.tx, sp.ty + (this.plan.blocked[sp.ty * this.plan.tw + sp.tx] ? 1 : 0));
      this.wait = 5 + this.r() * 9;
    }
  }
  poke(now, summary) { this.say = summary; this.sayUntil = now + 4; this.hop = 0.6; }
}

// An intern is one running sub-agent of an agent. It walks in from the pantry or lounge, works beside its parent's
// desk, and when the sub-agent finishes it cheers, drops its paper and walks back.
const SIDE = [[1, 0], [-1, 0], [2, 0], [-2, 0], [1, 1], [-1, 1], [0, 3], [2, 1], [-2, 1], [3, 0], [-3, 0]];
export class Intern {
  constructor(parent, h, plan, at) {
    this.id = `${parent.id}|${h.id}`; this.parentId = parent.id; this.h = h;
    this.r = rng(hash(this.id) ^ 0x1f3a);
    this.tx = at.tx; this.ty = at.ty; this.x = at.tx * T + 8; this.y = at.ty * T + 14;
    this.dir = 'S'; this.path = []; this.dist = 0; this.state = 'arrive'; this.cheer = 0; this.goal = null; this.age = 0;
  }
}

export class FloorSim {
  constructor(plan, ws, hour) {
    this.plan = plan;
    this.workers = new Map();
    this.taken = new Map(); // spot key -> worker id
    this.mascot = new Mascot(plan);
    this.interns = new Map();
    this.now = 0;
    this.night = hour !== undefined && isNight(hour);
    this.sync(ws, true);
  }

  sync(ws, first = false) {
    const live = new Set();
    for (const tab of ws.tabs) for (const pane of tab.panes) {
      const st = this.plan.stations.get(pane.id);
      if (!st || !pane.kind) continue; // plain shells have a desk but no worker
      live.add(pane.id);
      let w = this.workers.get(pane.id);
      if (!w) {
        w = new Worker(pane, st, this.plan);
        this.workers.set(pane.id, w);
        if (!first) this.#spawnAtDoor(w); // newcomers walk in through their room's door
      } else {
        w.station = st;
        const prev = w.status;
        w.pane = pane;
        w.status = pane.status;
        if (prev !== w.status) this.#onStatus(w, prev);
      }
    }
    for (const [id, w] of this.workers) if (!live.has(id)) { this.#release(w); this.workers.delete(id); }
    this.#syncInterns(ws, first);
    if (first) for (const w of this.workers.values()) this.#settle(w);
  }

  #walkable(tx, ty) { const p = this.plan; return tx >= 0 && ty >= 0 && tx < p.tw && ty < p.th && !p.blocked[ty * p.tw + tx]; }
  #workTile(parent, mine) {
    const s = parent.station.seat, taken = new Set([...this.interns.values()].filter((i) => i !== mine).map((i) => `${i.goal?.tx},${i.goal?.ty}`));
    for (const [dx, dy] of SIDE) {
      const tx = s.tx + dx, ty = s.ty + dy;
      if (this.#walkable(tx, ty) && !taken.has(`${tx},${ty}`)) return { tx, ty };
    }
    return { tx: s.tx, ty: s.ty + 1 };
  }
  #homeSpot(r) {
    const sp = this.plan.spots, list = [...sp.coffee, ...sp.couch, ...sp.wander];
    return list[Math.floor(r() * list.length)] || { tx: 1, ty: 1 };
  }
  #syncInterns(ws, first) {
    const want = new Map();
    for (const tab of ws.tabs) for (const pane of tab.panes) {
      const parent = this.workers.get(pane.id);
      if (parent) for (const h of pane.helpers || []) want.set(`${pane.id}|${h.id}`, { parent, h });
    }
    for (const [key, { parent, h }] of want) {
      let i = this.interns.get(key);
      if (!i) {
        const home = this.#homeSpot(rng(hash(key)));
        i = new Intern(parent, h, this.plan, home);
        this.interns.set(key, i);
        i.goal = this.#workTile(parent, i);
        if (first) { i.tx = i.goal.tx; i.ty = i.goal.ty; i.x = i.tx * T + 8; i.y = i.ty * T + 14; i.state = 'work'; i.dir = this.#faceParent(i, parent); }
      } else if (i.state === 'leave' || i.state === 'cheer') { i.state = 'arrive'; i.path = []; } // came back for another job
      i.h = h;
    }
    for (const [key, i] of this.interns) if (!want.has(key) && i.state !== 'leave' && i.state !== 'cheer') { i.state = 'cheer'; i.cheer = 1.8; }
  }
  #faceParent(i, parent) {
    const s = parent.station.seat, dx = s.tx - i.tx, dy = s.ty - i.ty;
    return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'S' : 'N');
  }
  #stepInterns(dt) {
    for (const [key, i] of this.interns) {
      i.age += dt;
      const parent = this.workers.get(i.parentId);
      if (i.state === 'cheer') { i.cheer -= dt; if (i.cheer <= 0) { const h = this.#homeSpot(i.r); i.goal = { tx: h.tx, ty: h.ty }; i.state = 'leave'; i.path = null; i.age = 0; } continue; }
      if (i.state === 'work') { if (parent) i.dir = this.#faceParent(i, parent); continue; }
      if (i.path === null || (i.path.length === 0 && (i.tx !== i.goal.tx || i.ty !== i.goal.ty))) {
        const p = findPath(this.plan, i.tx, i.ty, i.goal.tx, i.goal.ty);
        if (!p) { i.tx = i.goal.tx; i.ty = i.goal.ty; i.x = i.tx * T + 8; i.y = i.ty * T + 14; i.path = []; } else i.path = p;
      }
      if (i.path && i.path.length) {
        const n = i.path[0], nx = n.x * T + 8, ny = n.y * T + 14, dx = nx - i.x, dy = ny - i.y, d = Math.hypot(dx, dy), step = 40 * dt;
        if (Math.abs(dx) > Math.abs(dy) + 0.5) i.dir = dx > 0 ? 'E' : 'W'; else if (d > 0.1) i.dir = dy > 0 ? 'S' : 'N';
        i.dist += Math.min(d, step);
        if (d <= step) { i.x = nx; i.y = ny; i.tx = n.x; i.ty = n.y; i.path.shift(); } else { i.x += (dx / d) * step; i.y += (dy / d) * step; }
      }
      if (i.tx === i.goal.tx && i.ty === i.goal.ty && (!i.path || !i.path.length)) {
        if (i.state === 'arrive') { i.state = 'work'; if (parent) i.dir = this.#faceParent(i, parent); }
        else this.interns.delete(key); // walked home
      } else if (i.state === 'leave' && i.age > 25) this.interns.delete(key);
    }
  }

  #spawnAtDoor(w) {
    const room = this.plan.rooms[w.station.room];
    w.tx = room.door.tx; w.ty = room.door.ty + 1;
    w.x = w.tx * T + 8; w.y = w.ty * T + 14; w.seated = false; w.goal = 'seat'; w.path = null;
  }

  // Initial placement: seated workers at desks; idle ones scattered around the floor.
  #settle(w) {
    if (FREE.has(w.status) && !this.#sleepy(w) && w.r() < 0.7) this.#startBreak(w, true);
  }

  #sleepy(w) { return this.night && w.status === 'idle'; }

  #onStatus(w, prev) {
    w.sinceStatus = 0;
    if (w.status === 'done') { w.cheer = 2.4; this.#release(w); w.goal = 'seat'; w.path = null; w.dwell = 6 + w.r() * 4; } // celebrate at the desk, then wander
    else if (SEATED.has(w.status)) { this.#release(w); w.goal = 'seat'; w.path = null; w.dwell = 0; }
    else { w.dwell = 3 + w.r() * 6; if (!w.seated && w.goal === 'seat' && !w.spot) w.goal = 'seat'; }
  }

  #release(w) { if (w.spot) { this.taken.delete(w.spot.key); w.spot = null; } }

  #pickSpot(w) {
    const { spots } = this.plan;
    const order = w.r() < 0.55 ? ['couch', 'coffee', 'pingpong', 'vending', 'cooler', 'window', 'wander']
      : ['coffee', 'wander', 'window', 'couch', 'cooler', 'pingpong', 'vending'];
    const pool = [];
    for (const name of order) for (const s of spots[name]) {
      const key = `${name}:${s.tx},${s.ty}`;
      if (!this.taken.has(key)) pool.push({ ...s, name, key });
    }
    if (!pool.length) return null;
    // weighted: earlier kinds more likely
    const bias = Math.floor(w.r() * w.r() * pool.length);
    return pool[bias];
  }

  #startBreak(w, teleport = false) {
    const s = this.#pickSpot(w);
    if (!s) { w.dwell = 4; return; }
    this.#release(w);
    w.spot = s; this.taken.set(s.key, w.id);
    w.goal = 'spot';
    w.path = null;
    if (teleport) { w.tx = s.tx; w.ty = s.ty; w.x = s.tx * T + 8; w.y = s.ty * T + 14; w.seated = false; w.path = []; w.dir = s.face; w.dwell = 4 + w.r() * 10; }
  }

  update(dt, hour) {
    this.now += dt;
    if (hour !== undefined) this.night = isNight(hour);
    for (const w of this.workers.values()) {
      this.#step(w, dt);
      w.asleep = this.#sleepy(w) && w.goal === 'seat' && w.seated && !(w.path && w.path.length);
    }
    this.#stepInterns(dt);
    this.mascot.update(dt, this.workers, this.now, this.night);
  }

  #goTile(w) {
    if (w.goal === 'seat') return w.station.seat;
    if (w.goal === 'spot' && w.spot) return w.spot;
    return null;
  }

  #step(w, dt) {
    w.sinceStatus += dt;
    if (w.cheer > 0) w.cheer -= dt;
    w.frameT += dt;
    if (this.#sleepy(w) && w.goal !== 'seat') { this.#release(w); w.goal = 'seat'; w.path = null; } // bedtime: back to the desk
    const moving = w.path && w.path.length > 0;
    if (w.frameT > (moving ? 0.14 : 0.45)) { w.frameT = 0; w.frame = (w.frame + 1) % 4; }

    const goal = this.#goTile(w);
    if (!goal) return;
    const atGoal = w.tx === (goal.tx ?? goal.x) && w.ty === (goal.ty ?? goal.y) && (!w.path || !w.path.length);

    if (!atGoal && (w.path === null || w.path === undefined)) {
      const p = findPath(this.plan, w.tx, w.ty, goal.tx, goal.ty);
      if (!p) { // unreachable: teleport rather than get stuck
        w.tx = goal.tx; w.ty = goal.ty; w.x = w.tx * T + 8; w.y = w.ty * T + 14; w.path = [];
      } else w.path = p;
      w.seated = false;
    }

    if (w.path && w.path.length) {
      const n = w.path[0];
      const nx = n.x * T + 8, ny = n.y * T + 14;
      const dx = nx - w.x, dy = ny - w.y, d = Math.hypot(dx, dy);
      const step = SPEED * dt;
      if (Math.abs(dx) > Math.abs(dy) + 0.5) w.dir = dx > 0 ? 'E' : 'W'; else if (d > 0.1) w.dir = dy > 0 ? 'S' : 'N';
      w.dist = (w.dist || 0) + Math.min(d, step);
      if (d <= step) { w.x = nx; w.y = ny; w.tx = n.x; w.ty = n.y; w.path.shift(); } else { w.x += (dx / d) * step; w.y += (dy / d) * step; }
      if (!w.path.length) this.#arrive(w);
      return;
    }
    if (atGoal) this.#idleAt(w, dt);
  }

  #arrive(w) {
    if (w.goal === 'seat') { w.seated = true; w.dir = w.station.facing; w.x = w.tx * T + 8; w.y = w.ty * T + 14; }
    else if (w.spot) { w.dir = w.spot.face; w.seated = !!w.spot.sit; }
    w.path = [];
    w.dwell = FREE.has(w.status) ? 6 + w.r() * 14 : 0;
  }

  #idleAt(w, dt) {
    if (w.goal === 'seat') { w.seated = true; w.dir = w.station.facing; }
    if (!FREE.has(w.status) || this.#sleepy(w)) return; // asleep at the desk until work or morning
    w.dwell -= dt;
    if (w.dwell > 0) return;
    // idle: alternate between desk and a spot
    if (w.goal === 'seat') this.#startBreak(w);
    else if (w.r() < 0.3) { this.#release(w); w.goal = 'seat'; w.path = null; }
    else this.#startBreak(w);
  }
}
