// "New floor" dialog: creates a herdr workspace (a shell in a folder you pick), optionally starting an agent in it.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function installNewFloor({ $, S, goFloor, select, toast }) {
  const dlg = $('newfloor'), form = $('nf-form'), stat = $('nf-stat'), go = $('nf-go');
  if (!dlg) return;
  const fail = (msg) => { stat.hidden = false; stat.className = 'nf-stat err'; stat.textContent = msg; };
  const busy = (on, msg = '') => { go.disabled = on; $('nf-cancel').disabled = on; stat.hidden = !on; stat.className = 'nf-stat'; stat.textContent = msg; };

  const open = () => {
    // Folders agents are already working in make the best suggestions.
    const dirs = [...new Set([...S.panes.values()].map((p) => p.cwd).filter(Boolean))].sort();
    $('nf-dirs').innerHTML = dirs.map((d) => `<option value="${esc(d)}"></option>`).join('');
    busy(false); form.reset();
    dlg.showModal(); $('nf-cwd').focus();
  };
  const waitForFloor = async (id) => { // the new floor arrives with the next state push
    for (let i = 0; i < 40; i++) { if (S.model?.workspaces.some((w) => w.id === id)) return true; await new Promise((r) => setTimeout(r, 100)); }
    return false;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const agent = form.elements.agent.value;
    busy(true, agent ? `Creating the floor and starting ${agent}… (up to 30 s)` : 'Creating the floor…');
    let j;
    try {
      const r = await fetch('/api/workspace', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: $('nf-label').value, cwd: $('nf-cwd').value, agent: agent || undefined }) });
      if (r.status === 401) { location.href = '/login'; return; }
      j = await r.json().catch(() => ({}));
      if (!r.ok) return busy(false), fail(j.error || 'could not create the floor');
    } catch { return busy(false), fail('could not reach the server'); }
    busy(false); dlg.close();
    if (await waitForFloor(j.workspace)) { goFloor(j.workspace); if (j.pane && S.panes.has(j.pane)) select(j.pane); }
    toast(j.agentError ? 'blocked' : 'done', j.agentError ? `Floor created, but ${esc(agent)} did not start: ${esc(j.agentError)}` : `New floor ready${j.agent ? ` with ${esc(j.agent)}` : ''}`);
  });
  $('nf-cancel').addEventListener('click', () => dlg.close());
  $('btn-newfloor')?.addEventListener('click', open);
}
