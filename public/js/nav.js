// Grid pathfinding (A*, 8-way, no corner cutting) on the floor's blocked-tile map.
export function findPath(plan, sx, sy, gx, gy, limit = 4000) {
  const { tw, th, blocked } = plan;
  // the goal tile itself may be "blocked" (a couch cushion): you can step onto it, not through it
  const free = (x, y) => x >= 0 && y >= 0 && x < tw && y < th && (!blocked[y * tw + x] || (x === gx && y === gy));
  if (sx === gx && sy === gy) return [];
  const key = (x, y) => y * tw + x;
  const open = new Map(); // key -> node
  const closed = new Set();
  const heap = [];
  const push = (n) => { heap.push(n); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].f <= heap[i].f) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < heap.length && heap[l].f < heap[m].f) m = l; if (r < heap.length && heap[r].f < heap[m].f) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const h = (x, y) => { const dx = Math.abs(x - gx), dy = Math.abs(y - gy); return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy); };
  const start = { x: sx, y: sy, g: 0, f: h(sx, sy), parent: null };
  open.set(key(sx, sy), start); push(start);
  let iter = 0;
  while (heap.length && iter++ < limit) {
    const n = pop();
    const k = key(n.x, n.y);
    if (closed.has(k)) continue;
    closed.add(k);
    if (n.x === gx && n.y === gy) {
      const out = [];
      for (let c = n; c.parent; c = c.parent) out.push({ x: c.x, y: c.y });
      return out.reverse();
    }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = n.x + dx, ny = n.y + dy;
      if (!free(nx, ny)) continue;
      if (dx && dy && (!free(n.x + dx, n.y) || !free(n.x, n.y + dy))) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const g = n.g + (dx && dy ? Math.SQRT2 : 1);
      const ex = open.get(nk);
      if (ex && ex.g <= g) continue;
      const node = { x: nx, y: ny, g, f: g + h(nx, ny), parent: n };
      open.set(nk, node); push(node);
    }
  }
  return null;
}
