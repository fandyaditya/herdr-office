// Writes server/demo/session.jsonl: a hand-written conversation in Claude Code's session-log format, used by the
// demo mode (OFFICE_MOCK=1) so the chat view can be shown without any real agent.   node tools/make-demo-session.mjs
import fs from 'node:fs';

const SID = '00000000-0000-4000-8000-00000000d3a0';
let n = 0, t = Date.parse('2026-03-14T09:12:00Z'), prev = null;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const lines = [];
function push(o, dt = 4000) {
  t += dt;
  const uuid = uid();
  lines.push({ parentUuid: prev, isSidechain: false, uuid, timestamp: new Date(t).toISOString(), sessionId: SID, cwd: '/home/demo/storefront', version: '2.1.0', ...o });
  prev = uuid;
  return uuid;
}
const user = (text) => push({ type: 'user', message: { role: 'user', content: text } }, 20000);
const say = (text, mid) => push({ type: 'assistant', message: { id: mid, model: 'claude-demo', role: 'assistant', content: [{ type: 'text', text }] } });
const think = (ms, mid) => push({ type: 'assistant', thinkingDurationMs: ms, message: { id: mid, model: 'claude-demo', role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } });
let tool = 0;
function call(mid, name, input, result, extra = {}) {
  const id = `toolu_demo_${++tool}`;
  push({ type: 'assistant', message: { id: mid, model: 'claude-demo', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  if (result !== undefined) push({ type: 'user', toolUseResult: extra.toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: !!extra.error }] } }, 2500);
}

user('The checkout test is flaky on CI. Can you find out why and fix it?');
think(6200, 'm1');
say("I'll start by finding the test and how it waits for the page to be ready.", 'm1');
call('m1', 'Grep', { pattern: 'checkout', path: 'tests', output_mode: 'files_with_matches' }, 'tests/checkout.spec.ts\ntests/helpers/cart.ts\ntests/payment.spec.ts');
call('m1', 'Read', { file_path: '/home/demo/storefront/tests/checkout.spec.ts' }, "import { test, expect } from '@playwright/test';\nimport { addToCart } from './helpers/cart';\n\ntest('pays for a cart', async ({ page }) => {\n  await addToCart(page, 'sku-123');\n  await page.click('text=Checkout');\n  await page.waitForTimeout(500); // wait for the totals\n  await expect(page.locator('#total')).toHaveText('$24.00');\n});");
say('Found it. The test waits a fixed **500 ms** for the totals to render, which is not always enough on a busy CI runner. Let me confirm by running it repeatedly.', 'm2');
call('m2', 'Bash', { command: 'npx playwright test checkout --repeat-each 20 --workers 4', description: 'Run the checkout test 20 times' }, 'Running 20 tests using 4 workers\n\n  18 passed\n  2 failed\n    [chromium] › checkout.spec.ts:5:1 › pays for a cart  (repeat 7, repeat 15)\n\nError: expect(locator).toHaveText(expected)\nExpected: "$24.00"\nReceived: "$0.00"');
think(3100, 'm3');
call('m3', 'Edit', { file_path: '/home/demo/storefront/tests/checkout.spec.ts', old_string: "  await page.waitForTimeout(500); // wait for the totals\n  await expect(page.locator('#total')).toHaveText('$24.00');", new_string: "  await expect(page.locator('#total')).toHaveText('$24.00'); // retries until the totals render" }, 'The file /home/demo/storefront/tests/checkout.spec.ts has been updated.', {
  toolUseResult: { filePath: '/home/demo/storefront/tests/checkout.spec.ts', structuredPatch: [{ oldStart: 5, oldLines: 7, newStart: 5, newLines: 6, lines: [
    "   await addToCart(page, 'sku-123');", "   await page.click('text=Checkout');", '-  await page.waitForTimeout(500); // wait for the totals',
    "-  await expect(page.locator('#total')).toHaveText('$24.00');", "+  await expect(page.locator('#total')).toHaveText('$24.00'); // retries until the totals render", ' });'] }] } });
call('m3', 'Bash', { command: 'npx playwright test checkout --repeat-each 20 --workers 4', description: 'Run the checkout test 20 times again' }, 'Running 20 tests using 4 workers\n\n  20 passed (14.2s)');
say(`Fixed. The flake was a race, not a bug in checkout itself.

## What was wrong
- \`checkout.spec.ts\` slept for a fixed 500 ms, then asserted the total.
- On a slow runner the totals had not rendered yet, so the page still showed \`$0.00\`.

## What I changed
Removed the sleep and let Playwright's auto-retrying assertion wait for the text instead:

\`\`\`ts
await expect(page.locator('#total')).toHaveText('$24.00');
\`\`\`

| Run | Before | After |
|---|---|---|
| 20 repeats | 18 pass, 2 fail | 20 pass |
| Duration | 9.1 s | 14.2 s (4 workers, no sleep) |

Want me to add a regression test that slows the totals request down on purpose?`, 'm4');
user('Yes please, that would catch it if somebody adds a sleep again.');
think(2400, 'm5');
say("Good idea. I'll add a test that delays the totals request by two seconds, so only a retrying assertion can pass.", 'm5');
call('m5', 'Write', { file_path: '/home/demo/storefront/tests/checkout-slow.spec.ts', content: "import { test, expect } from '@playwright/test';\nimport { addToCart } from './helpers/cart';\n\ntest('waits for slow totals', async ({ page }) => {\n  await page.route('**/api/totals', async (route) => {\n    await new Promise((r) => setTimeout(r, 2000));\n    await route.continue();\n  });\n  await addToCart(page, 'sku-123');\n  await page.click('text=Checkout');\n  await expect(page.locator('#total')).toHaveText('$24.00');\n});\n" }, 'File created successfully at: /home/demo/storefront/tests/checkout-slow.spec.ts');
call('m5', 'Bash', { command: 'npx playwright test checkout-slow', description: 'Run the new regression test' });

fs.mkdirSync(new URL('../server/demo/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../server/demo/session.jsonl', import.meta.url), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
console.log(`wrote server/demo/session.jsonl (${lines.length} entries)`);
