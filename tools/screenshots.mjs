// Regenerates the README screenshots in docs/screenshots/ from the built-in demo building (no real herdr, no real
// sessions, no private data):   node tools/screenshots.mjs        (needs playwright-core, see tools/lib/browser.mjs)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './lib/browser.mjs';

const GIF_SECONDS = 11;
const PORT = 4799, base = `http://127.0.0.1:${PORT}`;
const out = new URL('../docs/screenshots/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });

const server = spawn('node', ['server/index.js'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, OFFICE_MOCK: '1', OFFICE_MOCK_STATIC: '1', OFFICE_TOKEN: '', PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore' });
const stop = () => server.kill();
process.on('exit', stop);
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }

const { model } = await (await fetch(`${base}/api/state`)).json();
const floor = model.workspaces.find((w) => w.label === 'platform-api');
const panes = floor.tabs.flatMap((t) => t.panes).filter((p) => p.kind);
// a believable mix of states
const states = ['working', 'working', 'blocked', 'done', 'working', 'idle', 'idle'];
const forced = Object.fromEntries(panes.map((p, i) => [p.id, states[i % states.length]]));
await fetch(`${base}/api/mock/set`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forced) });
const worker = panes.find((p) => forced[p.id] === 'working' && p.kind === 'claude') || panes.find((p) => forced[p.id] === 'working');
if (worker.kind === 'claude') await fetch(`${base}/api/mock/set`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [worker.id]: { status: 'working', helpers: 2 } }) }); // two interns (sub-agents) at its desk

const browser = await launch();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const page = await ctx.newPage();
  await page.goto(`${base}/#${floor.id}`);
  await page.waitForFunction(() => window.__office?.S?.model);
  await wait(3500); // let the workers settle at their desks / on break
  await page.waitForFunction(() => (() => { const sim = window.__office.renderer.sim; return !sim || ([...sim.interns.values()].every((i) => i.state === 'work') && [...sim.workers.values()].filter((w) => w.pane.helpers?.length).every((w) => w.seated && w.goal === 'seat')); })(), null, { timeout: 45000 }).catch(() => {}); // interns walk in from the pantry
  await page.evaluate(() => { document.getElementById('toasts').innerHTML = ''; }); // the load-time status toasts
  return page;
}

// 1. the office
let page = await open({ width: 1440, height: 900 });
await page.screenshot({ path: `${out}office.png` });

// 2. chat view
await page.evaluate((id) => window.__office.select(id), worker.id);
await page.waitForSelector('#d-chat:not([hidden]) .c-tool', { timeout: 10000 });
await wait(800);
await page.evaluate(() => { const l = document.querySelector('#d-chat .c-scroll'); l.scrollTop = 0; });
await wait(300);
await page.screenshot({ path: `${out}chat.png` });

// 3. an expanded diff card
await page.evaluate(() => {
  const d = [...document.querySelectorAll('#d-chat details.c-tool')].find((x) => x.querySelector('.c-diff'));
  d.open = true; d.scrollIntoView({ block: 'center' });
});
await wait(400);
await page.screenshot({ path: `${out}chat-diff.png` });
await page.context().close();

// 4. phone, full screen chat
page = await open({ width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.evaluate((id) => window.__office.select(id), worker.id);
await page.waitForSelector('#d-chat:not([hidden]) .c-tool', { timeout: 10000 });
await page.tap('#d-full');
await wait(700);
await page.evaluate(() => { const l = document.querySelector('#d-chat .c-scroll'); l.scrollTop = l.scrollHeight; });
await wait(300);
await page.screenshot({ path: `${out}mobile-chat.png` });

await page.context().close();

// 5. the phone, on the office floor
page = await open({ width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.screenshot({ path: `${out}mobile-office.png` });
await page.context().close();

// 6. a short animation for the README: the interns walk in from the pantry (frames -> ffmpeg, optional)
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) {
  const post = (body) => fetch(`${base}/api/mock/set`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post({ [worker.id]: { status: 'working', helpers: 0 } });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const g = await ctx.newPage();
  await g.goto(`${base}/#${floor.id}`);
  await g.waitForFunction(() => window.__office?.S?.model);
  await wait(3500);
  await g.evaluate(() => { document.getElementById('toasts').innerHTML = ''; });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-gif-'));
  await post({ [worker.id]: { status: 'working', helpers: 2 } });
  const t0 = Date.now(); let n = 0;
  while (Date.now() - t0 < GIF_SECONDS * 1000) { await g.screenshot({ path: path.join(tmp, `f${String(n++).padStart(4, '0')}.png`) }); }
  const fps = (n / ((Date.now() - t0) / 1000)).toFixed(2);
  const pal = path.join(tmp, 'pal.png');
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-framerate', fps, '-i', path.join(tmp, 'f%04d.png'), '-vf', 'scale=860:-1:flags=neighbor,palettegen=max_colors=96', pal]);
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-framerate', fps, '-i', path.join(tmp, 'f%04d.png'), '-i', pal, '-lavfi', 'scale=860:-1:flags=neighbor[x];[x][1:v]paletteuse=dither=none', '-loop', '0', `${out}office.gif`]);
  fs.rmSync(tmp, { recursive: true, force: true });
  await ctx.close();
} else console.log('ffmpeg not found: skipping office.gif');

await browser.close();
stop();
console.log(fs.readdirSync(out).map((f) => `${f} ${(fs.statSync(out + f).size / 1024) | 0} KB`).join('\n'));
