// Codex's shared daemon owns the rollout, while the TUI publishes the selected
// thread's name in OSC 0. Resolve that name in the local state DB, read-only.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Python's standard-library SQLite keeps this usable on Node 20 without a native
// addon. No log bodies, environment values, or credentials enter this query.
const QUERY = `
import json,sqlite3,sys,pathlib
db,cwd=sys.argv[1:]
c=sqlite3.connect(pathlib.Path(db).as_uri()+'?mode=ro',uri=True,timeout=0.1)
c.execute('pragma query_only=ON')
rows=c.execute('select id,rollout_path,cwd,name from threads where cwd=? and name is not null limit 201',(cwd,)).fetchall()
print(json.dumps(rows if len(rows)<=200 else []))
`;
const cache = new Map();
export function namedSessions(home, cwd) {
  const key = `${home}\0${cwd}`, previous = cache.get(key);
  if (previous && Date.now() - previous.at < 1500) return previous.rows;
  let rows = [];
  try {
    // A newer schema must not be interpreted using an older DB left behind.
    const file = fs.readdirSync(home).filter((n) => /^state_\d+\.sqlite$/.test(n))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
    if (file) rows = JSON.parse(execFileSync('python3', ['-c', QUERY, path.join(home, file), cwd], {
      encoding: 'utf8', timeout: 750, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })).map(([sessionId, file, cwd, name]) => ({ sessionId, file, cwd, name }));
  } catch { /* unavailable Python/DB/schema, busy migration: use Terminal and retry */ }
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

// Match Codex's terminal sanitizer (Unicode terminal mode). Activity indicators
// are removed separately; names themselves may contain punctuation or pipes.
export const cleanTitle = (s) => [...String(s || '')].filter((c) => !/[\p{Cc}\p{Cf}]/u.test(c)).join('').replace(/\s+/gu, ' ').trim();
export function titleMatches(title, name, cwd) {
  title = cleanTitle(title).replace(/^[\u2800-\u28ff●○◉◌]\s*/u, '');
  const expected = cleanTitle(`${name} | ${path.basename(cwd)}`);
  // Codex truncates OSC titles at 240 chars. Truncation could merge distinct names.
  return !!name && [...expected].length < 240 && title === expected;
}
