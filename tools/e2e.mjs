// End-to-end check in a real browser: open a pane panel, watch it for a while, report failures.
// BASE_URL PANE SECS    -> prints counts of /read statuses, pushed frames, dark-overlay sightings, console errors
import { launch, login } from './lib/browser.mjs';
const base = process.env.BASE_URL || 'http://127.0.0.1:4747', pane = process.env.PANE || 'w9:p1', secs = Number(process.env.SECS || 20);
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const status = {}, errors = []; let watch = 0;
page.on('response', (r) => { const u = new URL(r.url()); if (u.pathname.endsWith('/read')) status[r.status()] = (status[r.status()] || 0) + 1; if (u.pathname === '/api/watch') watch = r.status(); });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await login(page, base);
await page.waitForFunction(() => window.__office?.S?.model, null, { timeout: 15000 });
await page.evaluate((id) => window.__office.select(id), pane);
let dark = 0, last = '';
const restartAt = Number(process.env.RESTART_AT || 0);
for (let i = 0; i < secs * 2; i++) {
  await page.waitForTimeout(500);
  if (restartAt && i === restartAt * 2) (await import('node:child_process')).execSync('systemctl --user restart herdr-office');
  const s = await page.evaluate(() => ({ dark: !document.getElementById('empty').hidden, conn: document.querySelector('#conn span').textContent, term: document.getElementById('d-term').innerText.length, stat: document.getElementById('d-termstat').textContent }));
  if (s.dark) dark++;
  last = JSON.stringify(s);
}
// type a command through the panel and see it come back via the push stream
const marker = `E2E-${Date.now() % 100000}`;
if (process.env.TYPE) {
  await page.fill('#d-input', `echo ${marker}`); await page.keyboard.press('Enter');
  await page.waitForFunction((m) => document.getElementById('d-term').innerText.includes(m), marker, { timeout: 8000 }).then(() => console.log('typed command echoed back in panel: yes'), () => console.log('typed command echoed back in panel: NO'));
}
await page.screenshot({ path: process.env.OUT || 'e2e.png' });
if (process.env.SIDE) {
  const tabs = await page.evaluate(() => ({ hidden: document.getElementById('d-tabs').hidden, mainText: document.getElementById('d-term').innerText.slice(0, 160) }));
  console.log('tabs visible:', !tabs.hidden, '| chat view starts:', JSON.stringify(tabs.mainText));
  if (!tabs.hidden) { await page.click('#d-tabs [data-view=side]'); await page.waitForTimeout(400); console.log('diff view starts:', JSON.stringify((await page.evaluate(() => document.getElementById('d-term').innerText)).slice(0, 160))); await page.screenshot({ path: (process.env.OUT || 'e2e.png').replace('.png', '-side.png') }); }
}
console.log(JSON.stringify({ readRequests: status, watchStatus: watch, darkSamples: dark, lastState: JSON.parse(last), consoleErrors: errors }));
await browser.close();
