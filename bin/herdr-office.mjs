#!/usr/bin/env node
// The one command to run Herdr Office:   npm start        (or: node bin/herdr-office.mjs [options])
//   (no options)   start the office against your running herdr. The first run creates .env with a fresh access token.
//   --demo         start the demo building instead (no herdr needed, no login, loopback only)
//   doctor         check that everything the office needs is in place, and say what to fix
//   --port N  --host ADDR  --open  --help  --version
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { ROOT, loadEnv } from '../server/env.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ENV_FILE = path.join(ROOT, '.env');
const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` }
  : { b: (s) => s, g: (s) => s, r: (s) => s, y: (s) => s, d: (s) => s };

if (has('--help') || has('-h')) {
  console.log(`${c.b('Herdr Office')} ${pkg.version}  -  a pixel-art office for your herdr session

  npm start                 start the office (first run creates .env with a new access token)
  npm run demo              start the demo building, no herdr needed
  npm run doctor            check your setup

Options
  --demo                    demo building (same as npm run demo)
  --port N                  listen port (default 4747)
  --host ADDR[,ADDR]        bind address(es) (default 127.0.0.1)
  --open                    open the browser when it is up
  -v, --version`);
  process.exit(0);
}
if (has('--version') || has('-v')) { console.log(pkg.version); process.exit(0); }

loadEnv();
if (val('--port')) process.env.PORT = val('--port');
if (val('--host')) process.env.HOST = val('--host');

const newToken = () => crypto.randomBytes(24).toString('base64url');

// First run: .env from the template, with a fresh token. Owner-only, never overwrites an existing file.
function ensureEnv() {
  if (process.env.OFFICE_TOKEN && process.env.OFFICE_TOKEN !== 'change-me-to-a-long-random-string') return null;
  const token = newToken();
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'); } catch { text = 'OFFICE_TOKEN=\nPORT=4747\n'; }
  text = /^OFFICE_TOKEN=.*$/m.test(text) ? text.replace(/^OFFICE_TOKEN=.*$/m, `OFFICE_TOKEN=${token}`) : `OFFICE_TOKEN=${token}\n${text}`;
  if (fs.existsSync(ENV_FILE)) { // an .env exists but has no usable token: only fill that one line in
    const cur = fs.readFileSync(ENV_FILE, 'utf8');
    text = /^OFFICE_TOKEN=.*$/m.test(cur) ? cur.replace(/^OFFICE_TOKEN=.*$/m, `OFFICE_TOKEN=${token}`) : `OFFICE_TOKEN=${token}\n${cur}`;
  }
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
  process.env.OFFICE_TOKEN = token;
  return token;
}

const herdrSocket = async () => {
  const { defaultSocketPath, HerdrClient } = await import('../server/herdr.js');
  const p = defaultSocketPath();
  if (!fs.existsSync(p)) return { path: p, ok: false, why: 'socket not found - is herdr running?' };
  try { await new HerdrClient(p).call('session.snapshot', {}, 3000); return { path: p, ok: true }; } catch (e) { return { path: p, ok: false, why: String(e.message || e) }; }
};
const portFree = (port, host = '127.0.0.1') => new Promise((res) => {
  const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)));
  s.listen(port, host);
});
const which = (cmd) => new Promise((res) => execFile('sh', ['-c', `command -v ${cmd}`], (e, out) => res(e ? '' : out.trim())));

async function doctor() {
  let bad = 0;
  const line = (ok, what, hint = '') => { if (!ok) bad++; console.log(`  ${ok ? c.g('✓') : c.r('✗')} ${what}${!ok && hint ? c.d(`  -> ${hint}`) : ''}`); };
  const warn = (what, hint) => console.log(`  ${c.y('!')} ${what}${c.d(`  -> ${hint}`)}`);
  console.log(c.b('\nHerdr Office doctor\n'));
  line(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.versions.node}`, 'Node 20 or newer is required');
  const tok = process.env.OFFICE_TOKEN;
  if (tok && tok !== 'change-me-to-a-long-random-string') line(tok.length >= 16, `access token set${tok.length < 16 ? ' (but short)' : ''}`, 'use a longer token, or delete .env and run npm start');
  else warn('no access token yet', 'npm start creates one for you in .env');
  const h = await herdrSocket();
  line(h.ok, `herdr socket ${h.path}`, h.why || '');
  if (!h.ok) console.log(c.d('      no herdr? `npm run demo` shows the office with a made-up building.'));
  const port = Number(process.env.PORT || 4747);
  const free = await portFree(port);
  if (free) line(true, `port ${port} is free`); else warn(`port ${port} is in use`, 'already running? otherwise set PORT=... in .env');
  console.log(c.b('\nChat view (optional, per agent)'));
  for (const [name, dir, env] of [['Claude Code', '.claude', 'CLAUDE_CONFIG_DIR'], ['Cursor CLI', '.cursor', 'CURSOR_CONFIG_DIR'], ['Codex CLI', '.codex', 'CODEX_HOME']]) {
    const d = process.env[env] || path.join(os.homedir(), dir);
    console.log(`  ${fs.existsSync(d) ? c.g('✓') : c.d('-')} ${name}${fs.existsSync(d) ? '' : c.d(`  (no ${d}; fine if you do not use it)`)}`);
  }
  if (!(await which('python3'))) warn('python3 not found', 'only needed for the Codex chat view');
  console.log(bad ? `\n${c.r(`${bad} problem${bad > 1 ? 's' : ''}`)} to fix above.\n` : `\n${c.g('All good.')} Run ${c.b('npm start')}.\n`);
  process.exit(bad ? 1 : 0);
}

if (args[0] === 'doctor') await doctor();

const demo = has('--demo');
let created = null;
if (demo) {
  process.env.OFFICE_MOCK = '1'; process.env.OFFICE_TOKEN = ''; process.env.HOST = '127.0.0.1';
} else {
  created = ensureEnv();
}

const port = Number(process.env.PORT || 4747);
if (!(await portFree(port, (process.env.HOST || '127.0.0.1').split(',')[0]))) {
  console.error(`${c.r('Port ' + port + ' is already in use.')} Is the office already running? Otherwise: npm start -- --port ${port + 1}`);
  process.exit(1);
}

if (!demo) {
  const h = await herdrSocket();
  if (!h.ok) {
    console.error(`${c.y('Could not reach herdr')} (${h.why}).`);
    console.error(`  Start herdr first, or try ${c.b('npm run demo')} to see the office without it. ${c.d('npm run doctor for details')}\n`);
    // keep going: the office shows a "waiting for herdr" state and connects as soon as herdr is up
  }
}

const url = `http://127.0.0.1:${port}`;
console.log(`\n  ${c.b('🐑 Herdr Office')} ${c.d(pkg.version)}${demo ? c.y('  demo building') : ''}`);
console.log(`  ${c.b('Open')}  ${url}`);
if (created) console.log(`  ${c.b('Token')} ${created}  ${c.d('(saved to .env, owner-only)')}`);
else if (!demo) console.log(`  ${c.b('Token')} ${c.d('in .env (OFFICE_TOKEN)')}`);
console.log(c.d(`  Ctrl+C to stop. Phone? put it behind HTTPS first, see README > Deploy.\n`));

if (has('--open')) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(opener, [url], () => {});
}

// Node prints an "experimental" notice when the Cursor adapter probes node:sqlite; it is noise for a first run.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emitWarning.call(process, w, ...rest));
await import('../server/index.js');
