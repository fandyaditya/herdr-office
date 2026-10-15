# Architecture

```
 browser (canvas 2D, ES modules)             Node bridge (server/)                         herdr
+-------------------------------+   SSE   +--------------------------------+  unix socket (JSON lines)
| floorplan -> sim -> render    | <------ | shared snapshot poller         | <----------- herdr.sock
| chat view / terminal / diff   | -POST-> | per-pane + per-chat watchers   |
+-------------------------------+         | harness adapters               | <-- session logs on disk
                                          +--------------------------------+
```

## Entry point and tooling

`bin/herdr-office.mjs` is what `npm start` / `npm run demo` / `npm run doctor` run: it creates `.env` with a fresh token on
the first run, checks the port and herdr's socket, prints the URL and then imports `server/index.js`. `tools/check.mjs`
(`npm run check`) parses every file, enforces the house rules in [AGENTS.md](../AGENTS.md) and runs the tests.

## Server (`server/`)

| File | Role |
|---|---|
| `index.js` | HTTP server, auth gate, REST API, the SSE hub, snapshot poller and the per-pane / per-chat watchers. |
| `herdr.js` | herdr socket client. **One short-lived connection per call**: herdr resets a connection that carries several requests in flight. One retry, only when the write never reached herdr. |
| `model.js` | Turns `session.snapshot` into the building: workspace -> floor, tab -> room, pane -> seat and worker. |
| `layout.js` | `splitPanes()` separates Claude Code's diff side panel from the chat text on a pane screen. |
| `auth.js`, `login.js` | Token check (constant time), cookie session, attempt rate limit, login page. |
| `workspace.js` | Validates a "new floor" request (real folder, short clean name, known agent). |
| `upload.js` | Saves chat-box images (type sniffed from the bytes, owner-only files, 24 h cleanup). |
| `env.js` | Loads `.env` without a dependency. |
| `mock.js`, `demo/` | Demo building (`OFFICE_MOCK=1`) and a sample transcript served through the Claude adapter. |
| `harness/` | Chat adapters: `claude.js`, `cursor.js`, `codex.js` (+ `codex-sessions.js`), registered in `index.js`. |

`refresh()` adds `helpers` (running sub-agents, from `SubagentTracker` in `harness/claude.js`) to each Claude pane
before the model is compared and broadcast; `diffEvents` turns changes into `helper` activity events.

Polling is shared: one snapshot poll feeds every browser, and watchers only run for panes someone has open. When
nobody is connected the server idles. Errors from herdr are debounced (3 failures) before the UI shows its
"disconnected" overlay, and the state is re-broadcast on recovery.

### HTTP API

| Route | Purpose |
|---|---|
| `GET /api/events` | SSE stream (below). |
| `GET /api/state` | Current building model as JSON. |
| `POST /api/watch` | `{cid, pane, chat}`: tell the server which pane / chat this connection has open. |
| `GET /api/pane/:id/read` | One-off terminal read. |
| `GET /api/pane/:id/chat` | Chat items; supports `before`, `since`, `limit`. |
| `POST /api/workspace` | `{label?, cwd?, agent?}`: creates a herdr workspace (never steals focus), optionally starting `claude`, `codex` or `cursor` in its pane. The folder must exist; the agent is checked against a short list. Returns `{workspace, pane, agent, agentError?}`. |
| `POST /api/pane/:id/text`, `/keys`, `/focus` | Send text, send keys, focus the pane in herdr. |
| `GET /api/file?path=` | An image from disk for the chat thumbnails. Image bytes only, under home or the temp folder, no dot-folders. |
| `POST /api/pane/:id/image` | Raw image body (png/jpeg/gif/webp, max 10 MB); returns the saved file's `path`, which the client puts in the message. |
| `GET /healthz` | Liveness. |

Mutating routes check `Origin`. `POST /api/mock/set` exists in demo mode only.

### SSE events

`hello` (connection id), `state` (building model), `backlog` (recent activity), `activity`, `error`, `pane`
(terminal text + side panel), `paneerror`, `chat` (session meta + items, `reset` on first frame), `chatnone` (no
session found; use the terminal tab), `ping`.

## Chat adapters

See [chat-view.md](chat-view.md) for the adapter contract, the normalised item format and how a pane is matched to a
session, and [harnesses/](harnesses/) for each agent's log format.

## Client (`public/js/`)

| File | Role |
|---|---|
| `main.js` | Boot, SSE with backoff and a watchdog, floor list, activity feed, the pane drawer (chat / terminal / diff tabs), full-screen toggle, deep links. |
| `floorplan.js` | Packs a workspace's rooms into a tile map: doors, halls, lounge, seats. |
| `nav.js` | A\* pathfinding on that map. |
| `sim.js` | Workers and the status-driven behaviour (type, wave, cheer, wander). `FREE` states roam. Interns (sub-agents) walk in, work beside the parent's desk, cheer and walk home. |
| `render.js`, `art.js`, `assets.js` | Canvas renderer (16 px tiles, y-sorted), code-drawn building and furniture, sprite atlas loader with a code-drawn fallback. |
| `chat.js`, `markdown.js` | `ChatView` (items -> DOM, deltas, paging) and a small safe markdown renderer. |
| `ansi.js` | Terminal colours for the terminal tab. |
| `trivia.js`, `eggs.js` | Fun facts and small surprises. Nothing here touches the network. |

The markdown renderer escapes everything before formatting, and the page ships a CSP without inline scripts.
