# AGENTS.md

Instructions for AI coding agents (Claude Code, Cursor, Codex, ...) working on **Herdr Office**. Humans: this is
also a decent 2-minute tour of the codebase. `CLAUDE.md` points here.

Herdr Office is a pixel-art virtual office for a [herdr](https://herdr.dev) terminal session, plus a chat view for
the coding agents running in it. A zero-dependency Node bridge talks to herdr's unix socket; the browser is vanilla
ES modules on a 2D canvas. **No build step, no runtime dependencies, no framework.** Please keep it that way.

## Do this first

```bash
npm run demo        # the office with a made-up building, no herdr needed -> http://127.0.0.1:4747
npm run check       # syntax + house rules + the test suite. Run it before you say "done".
npm run doctor      # what is wrong with my setup?
```

You never need a real herdr to work on the UI, the sim or the chat view: demo mode covers them (details below).

## Map of the code

| Area | Where | Notes |
|---|---|---|
| Bridge (HTTP, SSE, auth, polling) | `server/index.js` | One shared snapshot poller; per-pane and per-chat watchers run only while a browser has them open. |
| herdr client | `server/herdr.js` | One short-lived socket connection per call. Do not hold a connection open: herdr resets it under overlap. |
| Building model | `server/model.js` | snapshot -> workspace/tab/pane; `diffEvents` feeds the activity feed. |
| Chat adapters | `server/harness/{claude,cursor,codex}.js` | Read each agent's own session log. Contract: `docs/chat-view.md`. |
| Demo building | `server/mock.js`, `server/demo/` | `OFFICE_MOCK=1`. `POST /api/mock/set` forces states: `{ "<paneId>": "working" }` or `{ "<paneId>": { "status": "working", "helpers": 2 } }`. |
| Floor layout and pathfinding | `public/js/floorplan.js`, `nav.js` | Workspace -> tile map (16 px tiles). |
| Simulation | `public/js/sim.js` | `Worker`, `Mascot` (Herdy), `Intern`, `FloorSim`. Status drives behaviour. |
| Rendering and art | `public/js/render.js`, `art.js`, `assets.js` | Canvas 2D, y-sorted; building and furniture are drawn in code; characters come from `public/assets/*.png`. |
| UI shell and chat panel | `public/js/main.js`, `chat.js`, `markdown.js`, `public/style.css` | `window.__office` exposes `S`, `renderer`, `select()` for tests. |
| Fun stuff | `public/js/trivia.js`, `public/js/eggs.js` | Trivia and easter eggs. **Keep the eggs secret**: do not list or describe them in the README, docs, screenshots or PR text (the in-app About box gives hints). |
| Tests | `test/*.test.js` | `node --test`, fixtures inline. |
| Tools | `tools/` | `check.mjs`, `screenshots.mjs`, `e2e*.mjs` (need `playwright-core`, see `tools/lib/browser.mjs`). |

Deeper: `docs/architecture.md` (modules, HTTP API, SSE events), `docs/chat-view.md`, `docs/harnesses/`.

## House rules (`npm run check` enforces the first five)

1. **Zero runtime dependencies.** Use Node built-ins. `playwright-core` is allowed as a *dev* tool only.
2. **Strict CSP**: no inline `<script>`, no inline `on*=` handlers, no `eval`, nothing loaded from a third-party
   host. Fonts and images are self-hosted in `public/`.
3. **Never commit secrets.** `.env` and `deploy/deploy.env` are gitignored. Do not paste tokens, hostnames of real
   deployments, or real conversations into code, tests, docs or screenshots.
4. Plain ES modules, Node >= 20, no TypeScript, no transpiling, no bundler.
5. Fail closed: the server refuses to start without a token (demo mode excepted) and checks `Origin` on every
   mutating request. Never loosen that to make something work.
6. Match the surrounding style: comment density, naming, idiom. Comments say *why*, not *what*.
7. The server can type into people's terminals. Treat every new endpoint as security-relevant: validate pane ids
   and keys (see `PANE_ID` / `KEY` in `server/index.js`), cap body sizes, never shell out with user input.
8. Chat adapters must prefer *no chat view* over a wrong pane-to-session match.
9. Test server behaviour. Fixtures are small and scrubbed; never copy real session logs.
10. Keep the README claims true. If you add or change a feature, update the README feature list and the relevant doc.

## Verifying your change

- **Server / adapters:** add a test in `test/`, run `npm run check`.
- **UI / sim / art:** run `npm run demo`, then drive it with a headless browser. A minimal recipe:

  ```js
  import { launch } from './tools/lib/browser.mjs';        // set PLAYWRIGHT_CORE_PATH if playwright-core lives elsewhere
  const b = await launch(), page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:4747/');                // demo mode has no login
  await page.waitForFunction(() => window.__office?.S?.model);
  await page.screenshot({ path: 'out.png' });               // look at it
  ```

  Useful handles: `window.__office.select('w1:p1')`, `.S.model`, `.renderer`, `POST /api/mock/set`.
  Set `OFFICE_MOCK_STATIC=1` to freeze the demo's random status changes while you work.
- **Regenerate the README screenshots** after visible changes: `npm run screenshots` (uses the demo, so nothing private).
- Look at what you built. A passing test does not tell you the sheep is on screen.

## Recipes

**Add a chat adapter for another agent** (Gemini CLI, OpenCode, ...): follow `docs/chat-view.md`. Implement
`locate(processInfo)` and a `Transcript`, register it in `server/harness/index.js`, add the kind to `CHAT_KINDS` in
`public/js/main.js`, write `docs/harnesses/<name>.md`, add the row to the README table, add fixture tests.

**Add a trivia line:** append a string to `TRIVIA` in `public/js/trivia.js`. One sentence, true, no links, no
trademarks used as jokes about people. Run `npm test` (a test checks length and duplicates).

**Add an easter egg:** see `public/js/eggs.js`. Register it with a trigger and keep it harmless: no network, no
persistence beyond `localStorage`, never blocks input, `prefers-reduced-motion` respected, and it must not fire
while the user is typing in a text field.

**Add furniture or a room style:** furniture is drawn in code in `public/js/art.js`, placed by
`public/js/floorplan.js`. Add a test in `test/floorplan.test.js` if you change placement rules.

**Change what a worker does for a status:** `public/js/sim.js` (`#onStatus`, `FREE`, `SEATED`). Pathing is `nav.js`.

**Add a setting:** document it in the `.env.example` comments, the README configuration table and
`bin/herdr-office.mjs --help` if it is a flag.

## Definition of done

- [ ] `npm run check` is green.
- [ ] You looked at the change in the demo (screenshot or run), on a phone-sized viewport too if it is UI.
- [ ] README / docs updated when behaviour or setup changed.
- [ ] No secrets, no personal paths, no real conversations in the diff.
- [ ] You say what you did *and what you could not verify* (for example "not tried against a live Codex pane").

## Things that look like bugs but are not

- A tool says "SQLite is experimental": the Cursor adapter probes `node:sqlite`; the CLI hides the notice.
- The Codex chat view needs `python3`; without it that pane falls back to the terminal tab. By design.
- Clicking a floor in the list closes an open chat from another floor. By design.
- Idle workers go back to their desks at night (21:00-06:00 local) and Herdy sleeps by the couch. By design.
