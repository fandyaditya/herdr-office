import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, diffEvents, summarize } from '../server/model.js';

const snap = (status = 'working') => ({
  version: '0.9.0', focused_workspace_id: 'w1', focused_tab_id: 'w1:t1', focused_pane_id: 'w1:p1',
  workspaces: [{ workspace_id: 'w1', number: 1, label: 'proj', focused: true, active_tab_id: 'w1:t1', agent_status: status }],
  tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 1, agent_status: status }],
  panes: [
    { pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', agent_status: 'unknown', terminal_title_stripped: 'sh', revision: 1 },
    { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', agent: 'claude', agent_status: status, terminal_title_stripped: 'Fix bug', revision: 3 },
  ],
  agents: [{ pane_id: 'w1:p1', agent: 'claude', name: 'lead', agent_status: status, state_change_seq: 9 }],
  layouts: [{ tab_id: 'w1:t1', focused_pane_id: 'w1:p1', zoomed: false, panes: [
    { pane_id: 'w1:p1', rect: { x: 0, y: 0, width: 50, height: 40 } }, { pane_id: 'w1:p2', rect: { x: 50, y: 0, width: 50, height: 40 } }] }],
});

test('buildModel nests workspace > tab > pane and merges agent info', () => {
  const m = buildModel(snap());
  const panes = m.workspaces[0].tabs[0].panes;
  assert.deepEqual(panes.map((p) => p.id), ['w1:p1', 'w1:p2'], 'ordered by layout position');
  assert.equal(panes[0].name, 'lead');
  assert.equal(panes[0].kindLabel, 'Claude');
  assert.equal(panes[0].status, 'working');
  assert.equal(panes[1].status, 'shell', 'a pane without an agent is a plain shell');
  assert.equal(m.focused.workspace, 'w1');
});

test('summarize counts statuses', () => {
  const c = summarize(buildModel(snap()));
  assert.equal(c.working, 1);
  assert.equal(c.shell, 1);
});

test('diffEvents reports status changes, joins and leaves', () => {
  const a = buildModel(snap('working'));
  const b = buildModel(snap('idle'));
  const ev = diffEvents(a, b);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].type, ev[0].from, ev[0].status, ev[0].who], ['status', 'working', 'idle', 'lead']);
  const s2 = snap(); s2.panes.pop(); s2.agents = [];
  const leave = diffEvents(a, buildModel(s2)).filter((e) => e.type === 'leave');
  assert.equal(leave.length, 1);
  assert.equal(leave[0].pane, 'w1:p1');
  assert.equal(diffEvents(null, a).length, 0);
});
