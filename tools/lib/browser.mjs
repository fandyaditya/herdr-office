// Shared headless-browser helper for the dev tools (screenshots, end-to-end checks).
// Playwright is a dev-only convenience, not a runtime dependency:  npm i -D playwright-core && npx playwright install chromium
//   PLAYWRIGHT_CORE_PATH  path to a package.json / folder that can resolve playwright-core (if it is not installed here)
//   CHROMIUM_PATH         an existing chromium / chrome-headless-shell binary (otherwise Playwright's own is used)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function loadPlaywright() {
  const from = process.env.PLAYWRIGHT_CORE_PATH;
  try { return createRequire(from ? path.resolve(from) : path.join(process.cwd(), 'package.json'))('playwright-core'); } catch {
    console.error('playwright-core not found. Run:  npm i -D playwright-core && npx playwright install chromium\n(or set PLAYWRIGHT_CORE_PATH to a project that has it)');
    process.exit(2);
  }
}

// An already-downloaded chromium in the default Playwright cache, if any.
function cachedChromium() {
  const root = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const d of fs.readdirSync(root).sort().reverse()) {
      for (const rel of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = path.join(root, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch { /* no cache */ }
  return undefined;
}

export async function launch() {
  const { chromium } = loadPlaywright();
  const executablePath = process.env.CHROMIUM_PATH || cachedChromium();
  return chromium.launch({ executablePath, args: ['--no-sandbox'] });
}

// OFFICE_TOKEN from the environment or the project's .env
export function officeToken() {
  if (process.env.OFFICE_TOKEN) return process.env.OFFICE_TOKEN;
  try {
    const env = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    return /^OFFICE_TOKEN=(.*)$/m.exec(env)?.[1]?.trim() || '';
  } catch { return ''; }
}

export async function login(page, base, token = officeToken()) {
  await page.goto(`${base}/login`);
  if (!page.url().includes('/login')) return; // no token configured: already in
  await page.fill('input', token);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.keyboard.press('Enter')]);
}
