// A fake herdr for development and demos (OFFICE_MOCK=1): same interface as HerdrClient,
// but invents a small building whose agents change status over time. Every agent's chat view shows the sample
// conversation in server/demo/session.jsonl (see demoAdapter below).
import { Transcript } from './harness/claude.js';

const DEMO_SESSION = new URL('./demo/session.jsonl', import.meta.url).pathname;
// Stands in for the real per-harness adapters in demo mode: every pane "has" the same sample session.
export const demoAdapter = {
  id: 'demo',
  locate: () => ({ sessionId: '00000000-0000-4000-8000-00000000d3a0', file: DEMO_SESSION, name: 'Fix flaky checkout test' }),
  Transcript,
};

const KINDS = ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'pi', 'grok', 'copilot'];
const TITLES = ['Refactor auth middleware', 'Fix flaky payment test', 'Write migration for orders', 'Review PR #482', 'Profile slow dashboard query',
  'Generate API client', 'Upgrade to React 19', 'Triage crash reports', 'Draft release notes', 'Tune CI cache'];
const FLOORS = [
  { label: 'storefront', tabs: [1, 1, 3] },
  { label: 'platform-api', tabs: [6, 1] },
  { label: 'ml-research', tabs: [2, 2, 1] },
  { label: 'docs-site', tabs: [1] },
  { label: 'infra', tabs: [9] },
];

const HELPER_LABELS = ['Triage crash reports', 'Check the docs', 'Run the test suite', 'Review the diff', 'Search the codebase', 'Draft the changelog'];

export class MockHerdr {
  constructor() {
    this.t0 = Date.now();
    let id = 1;
    this.panes = [];
    this.tabs = [];
    this.workspaces = FLOORS.map((f, wi) => {
      const wid = `w${wi + 1}`;
      f.tabs.forEach((n, ti) => {
        const tid = `${wid}:t${ti + 1}`;
        this.tabs.push({ tab_id: tid, workspace_id: wid, label: String(ti + 1), number: ti + 1 });
        for (let i = 0; i < n; i++) {
          const agent = (wi + ti + i) % 5 === 4 ? null : KINDS[(wi * 3 + ti * 2 + i) % KINDS.length];
          this.panes.push({
            pane_id: `${wid}:p${id++}`, tab_id: tid, workspace_id: wid, agent, agent_status: agent ? 'idle' : 'unknown',
            name: agent && i === 0 ? `${agent}-lead` : undefined, terminal_title_stripped: agent ? TITLES[(id + i) % TITLES.length] : 'user@host: ~/code',
            foreground_cwd: `/home/demo/${f.label}`, revision: 1, focused: false, buf: [`$ ${agent || 'bash'}`, 'ready.'],
          });
        }
      });
      return { workspace_id: wid, number: wi + 1, label: f.label, focused: wi === 0, active_tab_id: `${wid}:t1` };
    });
    this.nextPane = id; this.nextWs = this.workspaces.length + 1;
    this.helpers = new Map(); // pane id -> running sub-agents (the demo's interns)
    if (process.env.OFFICE_MOCK_STATIC !== '1') this.timer = setInterval(() => this.#tick(), 2500);
  }
  helpersFor(id) { return this.helpers.get(id) || []; }
  #setHelpers(p, n) {
    const keep = this.helpers.get(p.pane_id) || [];
    const list = keep.slice(0, n);
    while (list.length < n) { const i = list.length + Math.floor(Math.random() * 1000); list.push({ id: `h${i}`, label: HELPER_LABELS[i % HELPER_LABELS.length], type: 'general-purpose', bg: false, since: Date.now() }); }
    if (list.length) this.helpers.set(p.pane_id, list); else this.helpers.delete(p.pane_id);
  }
  #tick() {
    const agents = this.panes.filter((p) => p.agent);
    for (let i = 0; i < 2; i++) {
      const p = agents[Math.floor(Math.random() * agents.length)];
      const r = Math.random();
      p.agent_status = r < 0.45 ? 'working' : r < 0.65 ? 'idle' : r < 0.78 ? 'blocked' : r < 0.9 ? 'done' : 'unknown';
      p.terminal_title_stripped = TITLES[Math.floor(Math.random() * TITLES.length)];
      this.#setHelpers(p, p.agent === 'claude' && p.agent_status === 'working' ? Math.floor(Math.random() * 4) : 0);
      p.revision++;
      p.buf.push(`[${new Date().toLocaleTimeString()}] ${p.agent_status}: ${p.terminal_title_stripped}`);
      if (p.buf.length > 50) p.buf.shift();
    }
  }
  async snapshot() {
    const panes = this.panes.map(({ buf, name, ...p }) => ({ ...p, cwd: p.foreground_cwd }));
    return {
      version: 'mock', protocol: 22, focused_workspace_id: 'w1', focused_tab_id: 'w1:t1', focused_pane_id: this.panes[0].pane_id,
      workspaces: this.workspaces, tabs: this.tabs.map((t) => ({ ...t, agent_status: 'unknown', focused: false })), panes,
      agents: this.panes.filter((p) => p.agent).map((p) => ({ pane_id: p.pane_id, agent: p.agent, name: p.name, agent_status: p.agent_status, state_change_seq: p.revision })),
      layouts: [],
    };
  }
  async readPane(id, _source, _lines, _ansi) { const p = this.panes.find((x) => x.pane_id === id); if (!p) throw new Error('no such pane'); return { text: p.buf.join('\n'), revision: p.revision }; }
  async processInfo() { return { process_info: { foreground_processes: [] } }; }
  async sendText(id, text) { const p = this.panes.find((x) => x.pane_id === id); p?.buf.push(`> ${text}`); }
  async sendKeys(id, keys) { const p = this.panes.find((x) => x.pane_id === id); p?.buf.push(`<keys ${keys.join('+')}>`); }
  async focusPane() { /* no-op */ }
  async createWorkspace({ label, cwd }) {
    const wid = `w${this.nextWs++}`, tid = `${wid}:t1`, pid = `${wid}:p${this.nextPane++}`;
    const workspace = { workspace_id: wid, number: this.workspaces.length + 1, label: label || wid, focused: false, active_tab_id: tid };
    const tab = { tab_id: tid, workspace_id: wid, label: '1', number: 1 };
    const pane = { pane_id: pid, tab_id: tid, workspace_id: wid, agent: null, agent_status: 'unknown', terminal_title_stripped: 'user@host: ~/code',
      foreground_cwd: cwd || '/home/demo', revision: 1, focused: false, buf: ['$ '] };
    this.workspaces.push(workspace); this.tabs.push(tab); this.panes.push(pane);
    return { workspace, tab, root_pane: pane };
  }
  async startAgent(paneId, kind) {
    const p = this.panes.find((x) => x.pane_id === paneId); if (!p) throw new Error('no such pane');
    p.agent = kind; p.agent_status = 'idle'; p.buf.push(`$ ${kind}`, 'ready.'); p.revision++;
  }
  async closeWorkspace(id) {
    this.workspaces = this.workspaces.filter((w) => w.workspace_id !== id);
    this.tabs = this.tabs.filter((t) => t.workspace_id !== id); this.panes = this.panes.filter((p) => p.workspace_id !== id);
  }
  // test hook: force a pane's status (POST /api/mock/set, mock mode only)
  force(id, status, helpers) { const p = this.panes.find((x) => x.pane_id === id); if (p?.agent) { p.agent_status = status; if (helpers !== undefined) this.#setHelpers(p, Number(helpers) || 0); p.revision++; } }
}
