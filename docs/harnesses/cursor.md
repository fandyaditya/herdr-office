# Cursor CLI (`cursor-agent`)

**Status:** supported, exact pane matching. Code: `server/harness/cursor.js`. Tool results need Node ≥ 22.5
(`node:sqlite`); on older Node the timeline works and tool calls simply stay "running".

## Where the conversation lives

Two stores, both written live:

* **Timeline**: `~/.cursor/projects/<cwd with slashes as dashes>/agent-transcripts/<id>/<id>.jsonl`. Readable,
  append-only: `{ role, message.content[] }` lines with `text` and `tool_use` blocks, plus `{ type: "turn_ended" }`.
  It has **no tool ids, no tool results, no timestamps and no reasoning**.
* **Native store**: `~/.cursor/chats/<md5(cwd)>/<id>/store.db` (SQLite, content-addressed blobs). The tool results
  live here. The adapter reads it read-only and joins results to the timeline's tool calls.

## Matching a pane to a session

Cursor has no pid registry and puts no session id in argv or the environment. What it does do is keep its own
`store.db` open: `/proc/<pid>/fd` of the `cursor-agent` process contains `…/chats/<hash>/<sessionId>/store.db`. That
identifies the session exactly, including several Cursor panes in one folder. If nothing matches, no chat (never
"newest file in this folder").

## Mapping

| Cursor | Chat item |
|---|---|
| user line (`<user_query>…</user_query>`) | `user` (the `<timestamp>` / `<image_files>` wrappers are stripped, images counted) |
| assistant `text` | `assistant` |
| `Shell`, `Read`, `StrReplace`, `Write`, `Grep`, `Glob`, `Task`, … | `tool` with the names the UI knows (`Bash`, `Read`, `Edit`, `Write`, …) |
| result from `store.db` | `result` of the matching tool (matched by name + arguments, in order) |
| `turn_ended` aborted / error | warning notice |

Diffs are computed from the edit's old/new text (Cursor stores no patch).

Approval prompts ("Run this command?", trust dialog) are terminal-only. With `Run Everything` they never appear.
