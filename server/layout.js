// Claude Code (and some other TUIs) draw a side panel - the diff view - next to the chat inside ONE herdr pane.
// pane.read hands back whole screen rows, so chat text, the `│` divider and diff text end up interleaved on every
// line. This finds that divider column and cuts the screen into two independent views.

const ESC = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78MDEHc]/y;

function width(cp) {
  if (cp === 0x200b || cp === 0x200d || cp === 0xfe0f || (cp >= 0x300 && cp <= 0x36f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

// One line -> [{ esc } | { ch, w, col }]
function tokenize(line) {
  const out = []; let col = 0;
  for (let i = 0; i < line.length;) {
    if (line[i] === '\x1b') {
      ESC.lastIndex = i; const m = ESC.exec(line);
      if (m) { out.push({ esc: m[0] }); i += m[0].length; continue; }
    }
    const cp = line.codePointAt(i), ch = String.fromCodePoint(cp), w = width(cp);
    out.push({ ch, w, col }); col += w; i += ch.length;
  }
  return out;
}

const DIVIDERS = new Set(['│', '┃', '║']);
const MIN_ROWS = 6, MIN_SIDE = 12, MIN_MAIN = 20;

// -> { main, side } (side is null when the screen is a single view). Both keep their ANSI styling.
export function splitPanes(text) {
  if (!text) return { main: text, side: null };
  const lines = text.split('\n').map(tokenize);
  const counts = new Map(); let filled = 0, widest = 0;
  for (const toks of lines) {
    const last = toks.filter((t) => t.ch !== undefined).at(-1);
    if (!last || !toks.some((t) => t.ch && t.ch !== ' ')) continue;
    filled++; widest = Math.max(widest, last.col + last.w);
    for (const t of toks) if (t.ch !== undefined && DIVIDERS.has(t.ch)) counts.set(t.col, (counts.get(t.col) || 0) + 1);
  }
  let best = -1, bestN = 0;
  for (const [col, n] of counts) if (n > bestN) { best = col; bestN = n; }
  // a real divider spans most of the screen; a bordered box (a prompt, a table) does not
  if (best < 0 || bestN < MIN_ROWS || bestN < filled * 0.6 || best < MIN_MAIN || widest - best < MIN_SIDE) return { main: text, side: null };

  const left = [], right = [];
  for (const toks of lines) {
    const at = toks.find((t) => t.ch !== undefined && t.col === best);
    if (!at || !DIVIDERS.has(at.ch)) { left.push(toks.map((t) => t.esc ?? t.ch).join('')); right.push(''); continue; }
    let l = '', r = '', sgr = '', past = false;
    for (const t of toks) {
      if (t.esc !== undefined) {
        if (/m$/.test(t.esc)) sgr = /^\x1b\[0?m$/.test(t.esc) ? '' : sgr + t.esc;
        if (past) r += t.esc; else l += t.esc;
      } else if (t.col < best) l += t.ch;
      else if (t.col === best) { past = true; r = sgr; } // the divider is dropped; its colours carry into the side view
      else r += t.ch;
    }
    left.push(l); right.push(r);
  }
  return { main: tidy(left), side: tidy(right) || null };
}

const stripped = (s) => s.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, '');
// drop trailing blanks on every row and blank rows at both ends
function tidy(rows) {
  const trail = / +((?:\x1b\[[0-9;:?]*[ -/]*[@-~])*)$/;
  rows = rows.map((r) => { for (let prev = ''; prev !== r;) { prev = r; r = r.replace(trail, '$1'); } return r; });
  let a = 0, b = rows.length;
  while (a < b && !stripped(rows[a]).trim()) a++;
  while (b > a && !stripped(rows[b - 1]).trim()) b--;
  return rows.slice(a, b).join('\n');
}
