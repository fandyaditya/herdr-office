# Chat view

herdr exposes a pane as a terminal screen: text, colours, nothing else. There are no messages, no tool calls, no
diffs, which makes long agent conversations tiring to read. The chat view rebuilds the conversation from the thing
every coding agent already keeps: **its own session log on disk**.

```
herdr pane ──(pane.process_info)──▶ the agent's pid / terminal ──▶ the agent's session ──▶ log file on disk
                                                                                            │ append-only, tailed
 browser ◀── SSE `chat` events ◀── normalised items (user, assistant, tool + result, diff, notice) ◀┘
```

## Supported agents

| Agent | Chat view | How a pane is matched to its session | Notes |
|---|---|---|---|
| **Claude Code** | ✅ | exact: `pid` → `~/.claude/sessions/<pid>.json` → `sessionId` | [docs/harnesses/claude.md](harnesses/claude.md) |
| **Cursor CLI** (`cursor-agent`) | ✅ | exact: the `store.db` the process holds open (`/proc/<pid>/fd`) | tool results need Node ≥ 22.5 (`node:sqlite`); [notes](harnesses/cursor.md) |
| **Codex CLI** | ✅ | an explicit session binding or an owned file handle (exact), else a *unique* terminal-title match; otherwise the terminal tab | needs `python3` for the title lookup; [notes](harnesses/codex.md) |
| anything else herdr detects (pi, gemini, opencode, copilot, …) | terminal tab only | n/a | status, desks and the terminal tab still work |

Every pane always has the **Terminal** tab; the chat view is an extra tab that appears when a session is found, and
becomes the default for that pane. Approval and trust prompts are not written to any log, so they only exist on
screen: a blocked agent shows a **Waiting for you** card with the prompt text and a link to the Terminal tab.

## What the chat shows

* your messages as bubbles, replies as formatted markdown (lists, tables, code blocks, links)
* every tool call as a collapsible card with its result: `Bash`, `Read`, `Edit`/`Write` (with a real diff), `Grep`,
  `Glob`, todo lists, sub-agent tasks, web fetch/search, MCP and other tools
* a spinner on tool calls that are still running and a typing indicator while the agent works
* notices: interrupted turns, compaction, background-task reports; slash commands
* messages you typed while the agent was busy appear at once as *queued* (Claude Code logs them as `queue-operation`
  entries) and become normal messages in place when delivered
* images you attach from the chat box, and any image path in your message (absolute or `~/`), appear as clickable thumbnails; a path the bridge will not serve falls back to plain text
* a **Stop** button while the agent is working: `Esc` for Claude Code and Codex, `Ctrl+C` for Cursor (Cursor's screen says
  "ctrl+c to stop"; the Codex key is unverified on a live pane)
* "Load earlier messages" paging, "new messages" pill when you scrolled up, full-screen mode on phones

## How a harness plugs in

An adapter is one module in `server/harness/` and is registered in `server/harness/index.js`:

```js
export function locate(processInfo, ...)   // herdr's pane.process_info (+ optional binding) -> { sessionId, file, name? } | null
export class Transcript {                  // tails one session
  constructor(file)
  refresh()            // read what was appended since last time; true if anything changed
  delta(sinceVersion)  // items changed after a version (every change bumps `ver`)
  before(seq, limit)   // older items, for "load earlier"
  items, ver, title
}
```

Items are plain objects with a stable `id`, an increasing `seq` and the version `v` they last changed at:

| `kind` | fields |
|---|---|
| `user` | `text`, `images` (count) |
| `assistant` | `text` (markdown), `model?` |
| `thinking` | `ms?`, `text?` |
| `tool` | `name`, `input`, `result?` = `{ text, error, patch? }`; `patch` is `[{ oldStart, newStart, lines: ['+x', '-y', ' ctx'] }]` |
| `notice` | `text`, `tone` (`info` · `warn` · `task` · `output`) |
| `command` | `text` (a slash command) |

Tool names are mapped to the ones the UI knows (`Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`, `TodoWrite`, `Task`,
`WebFetch`, `WebSearch`); anything else renders as a generic card. A result may arrive after its call: update the
same item (same `id`), the version bump pushes the change to the browser.

Rules every adapter follows (see the existing ones and their tests):

1. **Never guess.** If the session cannot be identified exactly, return `null` and let the terminal tab handle it.
   A wrong conversation is worse than none.
2. **Parse defensively.** Session logs are undocumented and change between releases: skip unknown entry types and
   bad lines, make every field optional, tail with a byte offset and keep half-written lines for the next read, decode
   with a `StringDecoder` (multi-byte characters straddle chunk boundaries).
3. **Bound everything.** Clip long tool output, cap retained items, read only the tail of huge files.
4. **Keep secrets out.** Allow-list the fields you ship; never read credential files.

Demo mode (`npm run demo`) swaps every adapter for one that serves `server/demo/session.jsonl`, a hand-written
conversation in Claude Code's log format (regenerate it with `node tools/make-demo-session.mjs`).

## Dialogs and sub-agents

* **Dialogs.** A slash command like `/usage` opens a dialog that takes over the agent's input. The chat view detects
  the "Esc to cancel / close" footer on the pane's screen, shows a notice, and sends `Esc` before your message so it
  reaches the agent. It never does this while the agent is blocked on a permission prompt, where `Esc` means "no".
  `esc to interrupt` (a running turn) is deliberately not treated as a dialog.
* **Sub-agents** (Claude Code only so far). herdr reports one status per pane and nothing about sub-agents, so the
  bridge reads the session log: an `Agent`/`Task` tool call is running until its tool result arrives (foreground) or
  until its final `<task-notification>` arrives (background agents answer "launched" immediately and then give their `agentId`).
  A notification whose result says "has not reported yet" is interim, because the agent itself is still waiting on background
  work, so it does not end the agent. The final report names only the `<task-id>`, which is that `agentId`. The
  running ones are added to the pane as `helpers` in the building model and drawn as interns. Only the last 1.5 MB of a
  log is scanned on first sight, and a launch older than 6 hours with no end is treated as dead.
