// "New floor": validates the request for creating a herdr workspace (a folder to open, a name, optionally an agent).
// A workspace is a shell in a folder the caller picks, so the folder must be a real directory and the agent a known one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The agents the office has a chat view for. herdr can start more, but these are the ones worth a button.
export const START_AGENTS = ['claude', 'codex', 'cursor'];
const NO_CONTROL = /[\u0000-\u001f\u007f]/;

// Returns { label, cwd, agent } or { error }. cwd is null when the caller did not pick one (herdr then decides).
export function checkNewWorkspace(body) {
  let cwd = body.cwd == null ? '' : String(body.cwd).trim();
  if (cwd.length > 1024 || NO_CONTROL.test(cwd)) return { error: 'bad folder' };
  if (cwd === '~' || cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(1));
  if (cwd) {
    if (!path.isAbsolute(cwd)) return { error: 'folder must be an absolute path (or start with ~/)' };
    try { if (!fs.statSync(cwd).isDirectory()) return { error: 'that is not a folder' }; } catch { return { error: 'that folder does not exist' }; }
  }
  const label = String(body.label ?? '').trim() || (cwd ? path.basename(cwd) : '');
  if (label.length > 60 || NO_CONTROL.test(label)) return { error: 'name is too long or has control characters (max 60)' };
  const agent = body.agent ? String(body.agent) : null;
  if (agent && !START_AGENTS.includes(agent)) return { error: `agent must be one of ${START_AGENTS.join(', ')}` };
  return { label: label || null, cwd: cwd || null, agent };
}
