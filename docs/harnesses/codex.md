# Codex CLI

**Status:** supported. A pane is only bound to a session on real evidence (never cwd / newest file). Code: `server/harness/codex.js`,
`codex-sessions.js`. One lookup needs `python3` (see below).

## Where the conversation lives

`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl` (or `$CODEX_HOME`), written live, one
`{ timestamp, type, payload }` record per line. Two layouts exist, chosen by `session_meta.payload.history_mode`:

* **paginated** (current): completed items arrive as `event_msg / item_completed` with `UserMessage`, `AgentMessage`,
  `Reasoning`, `CommandExecution`, `FileChange` (a ready-made unified diff per file), `McpToolCall`, `WebSearch`, …
* **legacy**: protocol records (`response_item` messages, `function_call` / `function_call_output`, `custom_tool_call`).

The adapter handles both and drops metadata, usage, system/developer instructions and encrypted reasoning.

## Matching a pane to a session

Codex TUIs usually talk to one shared background daemon, so there is no per-pane process that owns a rollout file
and cwd/recency cannot tell panes apart. In order of trust:

1. **An explicit binding**: `agent_session_id` / `agent_session_path` published by herdr for the pane
   (`herdr pane report-agent-session`), or a manual mapping in `OFFICE_CODEX_SESSIONS` (JSON, must name the pid).
2. **An owned rollout / writer-lock file handle** on the pane's Codex process (or its children).
3. **A unique title match** (strong evidence, not proof: the adapter marks it `exact: false`): the TUI sets the terminal title to `<thread name> | <folder>`; that is resolved against
   the thread names in Codex's local state database (opened read-only through `python3`'s `sqlite3`). Exactly one
   match is required.

If none of these identifies a single session, the pane falls back to the Terminal tab. The binding is recomputed on
every locate, so `/new` and `/resume` follow along.

## Secrets

The adapter keeps an allow-list of display fields and redacts common credential shapes (API keys, bearer tokens,
private keys, `password=` assignments, signed URLs) and results of reads of credential files. That is
defense in depth, not a guarantee: ordinary tool output can contain secrets. See "Security" in the README.

## Known limits

* Approval / permission prompts and the trust dialog are not persisted: terminal only.
* Persisted command output is truncated by Codex itself (64 KiB), and text deltas are not stored, so a reply appears
  when it is complete, not token by token.
* The format changes between releases (observed 0.157 – 0.162); unknown record types are skipped.
