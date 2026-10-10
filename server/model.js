// Turn herdr's raw session snapshot into the building model the office renders:
//   workspace -> floor, tab -> room, pane -> desk/seat (with a worker when an agent lives there).

const KIND_LABEL = {
  claude: 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', pi: 'Pi', grok: 'Grok',
  opencode: 'OpenCode', copilot: 'Copilot', droid: 'Droid', amp: 'Amp', hermes: 'Hermes',
};

function paneOrder(layout, panes) {
  // Reading order from the layout rects (top-to-bottom, then left-to-right), so the
  // office seats mirror how the panes are arranged on screen.
  const rects = new Map((layout?.panes || []).map((p) => [p.pane_id, p.rect]));
  return [...panes].sort((a, b) => {
    const ra = rects.get(a.pane_id), rb = rects.get(b.pane_id);
    if (!ra || !rb) return 0;
    return ra.x - rb.x || ra.y - rb.y;
  });
}

export function buildModel(snap) {
  const agents = new Map((snap.agents || []).map((a) => [a.pane_id, a]));
  const layouts = new Map((snap.layouts || []).map((l) => [l.tab_id, l]));
  const panesByTab = new Map();
  for (const p of snap.panes || []) {
    if (!panesByTab.has(p.tab_id)) panesByTab.set(p.tab_id, []);
    panesByTab.get(p.tab_id).push(p);
  }
  const tabsByWs = new Map();
  for (const t of snap.tabs || []) {
    if (!tabsByWs.has(t.workspace_id)) tabsByWs.set(t.workspace_id, []);
    tabsByWs.get(t.workspace_id).push(t);
  }

  const workspaces = (snap.workspaces || []).map((w) => {
    const tabs = (tabsByWs.get(w.workspace_id) || [])
      .sort((a, b) => a.number - b.number)
      .map((t) => {
        const layout = layouts.get(t.tab_id);
        const panes = paneOrder(layout, panesByTab.get(t.tab_id) || []).map((p) => {
          const a = agents.get(p.pane_id);
          const kind = a?.agent || p.agent || null;
          return {
            id: p.pane_id,
            kind,
            kindLabel: kind ? KIND_LABEL[kind] || kind : null,
            name: a?.name || null,
            status: kind ? p.agent_status || a?.agent_status || 'unknown' : 'shell',
            title: p.terminal_title_stripped || p.terminal_title || '',
            cwd: p.foreground_cwd || p.cwd || '',
            focused: !!p.focused,
            rev: p.revision || 0,
            seq: a?.state_change_seq ?? 0,
            zoomed: !!layout?.zoomed && layout.focused_pane_id === p.pane_id,
          };
        });
        return { id: t.tab_id, number: t.number, label: t.label, status: t.agent_status, focused: !!t.focused, panes };
      });
    return {
      id: w.workspace_id, number: w.number, label: w.label, status: w.agent_status,
      focused: !!w.focused, activeTab: w.active_tab_id, tabs,
    };
  });

  return {
    version: snap.version,
    focused: { workspace: snap.focused_workspace_id, tab: snap.focused_tab_id, pane: snap.focused_pane_id },
    workspaces,
  };
}

export function summarize(model) {
  const c = { working: 0, idle: 0, blocked: 0, done: 0, unknown: 0, shell: 0 };
  for (const w of model.workspaces) for (const t of w.tabs) for (const p of t.panes) c[p.status] = (c[p.status] || 0) + 1;
  return c;
}

// Status transitions between two models, used for the activity feed.
export function diffEvents(prev, next) {
  if (!prev) return [];
  const before = new Map();
  for (const w of prev.workspaces) for (const t of w.tabs) for (const p of t.panes) before.set(p.id, { p, w, t });
  const events = [];
  const seen = new Set();
  for (const w of next.workspaces) for (const t of w.tabs) for (const p of t.panes) {
    seen.add(p.id);
    const old = before.get(p.id);
    const who = p.name || p.kindLabel || 'shell';
    const where = `${w.label}`;
    if (!old) events.push({ type: 'join', pane: p.id, who, where, status: p.status });
    else {
      const was = new Map((old.p.helpers || []).map((h) => [h.id, h])), now = new Map((p.helpers || []).map((h) => [h.id, h]));
      for (const [id, h] of now) if (!was.has(id)) events.push({ type: 'helper', sub: 'start', pane: p.id, who, where, label: h.label });
      for (const [id, h] of was) if (!now.has(id)) events.push({ type: 'helper', sub: 'end', pane: p.id, who, where, label: h.label });
    }
    if (old && old.p.status !== p.status) events.push({ type: 'status', pane: p.id, who, where, from: old.p.status, status: p.status, title: p.title });
  }
  for (const [id, { p, w }] of before) if (!seen.has(id)) events.push({ type: 'leave', pane: id, who: p.name || p.kindLabel || 'shell', where: w.label });
  return events;
}
