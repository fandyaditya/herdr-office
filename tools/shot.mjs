// Screenshot the running office:  node tools/shot.mjs out.png [url-hash] [widthxheight] [waitMs]
// Needs playwright-core (see tools/lib/browser.mjs).  BASE_URL (default http://127.0.0.1:4747), EVAL=<js to run>.
import { launch, officeToken } from './lib/browser.mjs';

const [out = 'shot.png', hash = '', size = '1440x900', wait = '2500'] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
const base = process.env.BASE_URL || 'http://127.0.0.1:4747';
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, extraHTTPHeaders: { Authorization: `Bearer ${officeToken()}` } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${base}/${hash ? '#' + hash : ''}`);
await page.waitForTimeout(Number(wait));
if (process.env.EVAL) { console.log(JSON.stringify(await page.evaluate(process.env.EVAL))); await page.waitForTimeout(600); }
await page.screenshot({ path: out });
console.log('saved', out, errors.length ? `\nERRORS:\n${errors.join('\n')}` : '(no console errors)');
await browser.close();
