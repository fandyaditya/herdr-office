import test from 'node:test';
import assert from 'node:assert/strict';
import { planFloor, K } from '../public/js/floorplan.js';
import { findPath } from '../public/js/nav.js';

const ws = (tabSizes) => ({
  id: 'wT', number: 1, label: 'test',
  tabs: tabSizes.map((n, ti) => ({
    id: `wT:t${ti + 1}`, number: ti + 1, label: String(ti + 1),
    panes: Array.from({ length: n }, (_, i) => ({ id: `wT:p${ti}_${i}`, kind: i % 3 ? 'claude' : null, status: 'idle' })),
  })),
});

for (const sizes of [[1], [1, 1, 1], [2], [5, 1], [12], [1, 7, 3, 9, 1, 2, 4]]) {
  test(`floor for tabs ${JSON.stringify(sizes)}: every seat and spot is reachable`, () => {
    const w = ws(sizes);
    const plan = planFloor(w);
    const total = sizes.reduce((a, b) => a + b, 0);
    assert.equal(plan.stations.size, total, 'one station per pane');
    assert.equal(plan.rooms.length, sizes.length);
    const start = { x: plan.spots.wander[0].tx, y: plan.spots.wander[0].ty };
    assert.equal(plan.blocked[start.y * plan.tw + start.x], 0, 'start tile free');
    for (const st of plan.stations.values()) {
      const { tx, ty } = st.seat;
      assert.equal(plan.blocked[ty * plan.tw + tx], 0, `seat ${st.paneId} is walkable`);
      assert.ok(findPath(plan, start.x, start.y, tx, ty), `seat ${st.paneId} reachable`);
    }
    for (const [name, list] of Object.entries(plan.spots)) for (const s of list) {
      if (name !== 'couch') assert.equal(plan.blocked[s.ty * plan.tw + s.tx], 0, `${name} spot (${s.tx},${s.ty}) is on a free tile`);
      assert.ok(findPath(plan, start.x, start.y, s.tx, s.ty), `${name} spot (${s.tx},${s.ty}) reachable`);
    }
    for (const r of plan.rooms) assert.equal(plan.kind[r.door.ty * plan.tw + r.door.tx], K.DOOR);
  });
}

test('rooms never overlap and stay inside the floor', () => {
  const plan = planFloor(ws([3, 9, 1, 6, 2, 8, 1]));
  for (const a of plan.rooms) {
    assert.ok(a.x >= 0 && a.x + a.ow <= plan.tw && a.y + a.oh <= plan.th);
    for (const b of plan.rooms) if (a !== b && a.y === b.y) assert.ok(a.x + a.ow - 1 <= b.x || b.x + b.ow - 1 <= a.x, 'rooms may share a wall tile only');
  }
});

test('A* routes around walls and returns null when sealed off', () => {
  const plan = { tw: 5, th: 5, blocked: new Uint8Array(25) };
  for (let y = 0; y < 4; y++) plan.blocked[y * 5 + 2] = 1; // wall with a gap at the bottom
  const p = findPath(plan, 0, 0, 4, 0);
  assert.ok(p && p.some((n) => n.y === 4), 'goes through the gap');
  plan.blocked[4 * 5 + 2] = 1;
  assert.equal(findPath(plan, 0, 0, 4, 0), null);
});
