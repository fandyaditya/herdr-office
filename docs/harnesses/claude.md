# Claude Code

**Status:** supported, exact pane matching. Code: `server/harness/claude.js`.

## Where the conversation lives

`~/.claude/projects/<project>/<sessionId>.jsonl` (or `$CLAUDE_CONFIG_DIR`), one JSON event per line, appended as the
session runs. `<project>` is the working directory with every non-alphanumeric character turned into `-`.

## Matching a pane to a session

1. `pane.process_info` gives the foreground process of the pane (`claude`, with its pid).
2. `~/.claude/sessions/<pid>.json` is a per-process registry: `{ pid, sessionId, cwd, name, status, ... }`.
3. The log is `projects/*/<sessionId>.jsonl`. A session that has not said anything yet has no file; the expected
   path is derived from `cwd` so the chat opens empty and fills in on the first message.

This is exact even when several Claude panes share a folder. It is re-evaluated every few seconds, so `/clear` and
`/resume` switch the chat to the new session.

## Log format (what the parser relies on)

| Entry | Handling |
|---|---|
| `user` with string / text blocks | `user` item (or `command` / `notice` for `<command-name>`, `<task-notification>`, interrupts) |
| `user` with `tool_result` blocks | attaches `result` to the tool call with the same `tool_use_id`; `toolUseResult.structuredPatch` gives edit diffs |
| `assistant` content blocks | **one log line per block**, same `message.id`: `text` → `assistant`, `tool_use` → `tool`, `thinking` → `thinking` (text is usually empty, only `thinkingDurationMs`) |
| `system` / `compact_boundary` | "Conversation compacted" notice |
| `ai-title` | session title |
| `isMeta`, `isCompactSummary`, `isSidechain`, attachments, snapshots, queue operations | ignored |

Known limits: after a rewind/fork the abandoned branch is still in the file and is shown (entries are read in file
order, not by following `parentUuid`); sub-agent transcripts (`<session>/subagents/`) are not inlined, the parent only
shows the `Task` call.
