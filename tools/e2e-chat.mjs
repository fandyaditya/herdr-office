// Real-browser check of the chat view: open a Claude pane, send a message from the chat box, wait for the reply.
// BASE_URL PANE MSG OUT
import { launch, login } from './lib/browser.mjs';
const base = process.env.BASE_URL || 'http://127.0.0.1:4747', pane = process.env.PANE, msg = process.env.MSG || 'Reply with exactly: CHAT-OK';
const out = process.env.OUT || 'chat.png';
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await login(page, base);
await page.waitForFunction(() => window.__office?.S?.model, null, { timeout: 15000 });
await page.evaluate((id) => window.__office.select(id), pane);
await page.waitForSelector('#d-chat:not([hidden]) .c-scroll', { timeout: 10000 });
await page.waitForTimeout(1500);
const before = await page.locator('#d-chat .c-user').count();
await page.fill('#d-input', msg); await page.keyboard.press('Enter');
await page.waitForFunction((n) => document.querySelectorAll('#d-chat .c-user').length > n, before, { timeout: 15000 }).then(() => console.log('your message appeared as a bubble: yes'), () => console.log('your message appeared as a bubble: NO'));
await page.waitForFunction(() => { const a = [...document.querySelectorAll('#d-chat .c-asst')]; return a.length && /CHAT-OK|hello|hi/i.test(a.at(-1).innerText); }, null, { timeout: 60000 }).then(() => console.log('assistant reply rendered: yes'), () => console.log('assistant reply rendered: NO'));
await page.waitForTimeout(800);
const state = await page.evaluate(() => ({ view: document.querySelector('#d-tabs .on')?.textContent, user: [...document.querySelectorAll('#d-chat .c-user')].map((e) => e.innerText.slice(0, 60)), asst: [...document.querySelectorAll('#d-chat .c-asst')].map((e) => e.innerText.slice(0, 80)), typing: !!document.querySelector('#d-chat .c-typing') }));
console.log(JSON.stringify(state), 'errors:', JSON.stringify(errors));
await page.screenshot({ path: out });
if (process.env.TERM_TAB) { await page.click('#d-tabs [data-view=term]'); await page.waitForTimeout(500); await page.screenshot({ path: out.replace('.png', '-term.png') }); }
await browser.close();
