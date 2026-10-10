// Chat-view adapters, one per agent harness. An adapter turns "this herdr pane" into a stream of normalised chat
// items by reading what that agent writes to disk (herdr itself only exposes the terminal screen).
//
//   locate(processInfo) -> { sessionId, file, ... } | null
//   Transcript(file)    -> .refresh() .delta(sinceVersion, limit) .before(seq, limit) .items .ver .title
//
// Other harnesses fall back to the terminal view.
import * as claude from './claude.js';
import * as cursor from './cursor.js';
import * as codex from './codex.js';

export const adapters = { claude, cursor, codex };
export const adapterFor = (kind) => adapters[kind] || null;
