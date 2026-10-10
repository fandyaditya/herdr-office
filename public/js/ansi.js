// ANSI (SGR) -> safe HTML for the terminal peek. Handles 16/256/truecolor, bold, dim, italic, underline,
// inverse; strips every other escape sequence. Output is escaped, so it is safe for innerHTML.
const BASIC = ['#1f2230', '#e0636b', '#6fcf8a', '#e5c76b', '#6aa3f0', '#c58af0', '#5fd0d6', '#cfd6ee',
  '#5b6179', '#ff7b86', '#8cf0a8', '#ffe08a', '#8dbdff', '#dba6ff', '#85efe9', '#ffffff'];

function color256(n) {
  if (n < 16) return BASIC[n];
  if (n < 232) { n -= 16; const c = [Math.floor(n / 36), Math.floor(n / 6) % 6, n % 6].map((v) => (v ? 55 + v * 40 : 0)); return `rgb(${c})`; }
  const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`;
}
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function ansiToHtml(input) {
  const st = { fg: null, bg: null, bold: false, dim: false, italic: false, ul: false, inv: false };
  const reset = () => Object.assign(st, { fg: null, bg: null, bold: false, dim: false, italic: false, ul: false, inv: false });
  let out = '';
  const emit = (text) => {
    if (!text) return;
    let fg = st.fg, bg = st.bg;
    if (st.inv) [fg, bg] = [bg || '#0a0b12', fg || '#cfd6ee'];
    const css = [];
    if (fg) css.push(`color:${fg}`);
    if (bg) css.push(`background:${bg}`);
    if (st.bold) css.push('font-weight:700');
    if (st.dim) css.push('opacity:.6');
    if (st.italic) css.push('font-style:italic');
    if (st.ul) css.push('text-decoration:underline');
    out += css.length ? `<span style="${css.join(';')}">${esc(text)}</span>` : esc(text);
  };
  const sgr = (params) => {
    const p = params.length ? params.split(/[;:]/).map((x) => (x === '' ? 0 : Number(x))) : [0];
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) reset(); else if (c === 1) st.bold = true; else if (c === 2) st.dim = true; else if (c === 3) st.italic = true;
      else if (c === 4) st.ul = true; else if (c === 7) st.inv = true; else if (c === 22) { st.bold = false; st.dim = false; }
      else if (c === 23) st.italic = false; else if (c === 24) st.ul = false; else if (c === 27) st.inv = false;
      else if (c >= 30 && c <= 37) st.fg = BASIC[c - 30]; else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = BASIC[c - 40]; else if (c === 49) st.bg = null;
      else if (c >= 90 && c <= 97) st.fg = BASIC[c - 90 + 8]; else if (c >= 100 && c <= 107) st.bg = BASIC[c - 100 + 8];
      else if (c === 38 || c === 48) {
        const target = c === 38 ? 'fg' : 'bg';
        if (p[i + 1] === 5) { st[target] = color256(p[i + 2] | 0); i += 2; }
        else if (p[i + 1] === 2) { st[target] = `rgb(${p[i + 2] | 0},${p[i + 3] | 0},${p[i + 4] | 0})`; i += 4; }
      }
    }
  };
  const re = /\x1b\[([0-9;:?]*)([ -/]*[@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
  let last = 0, m;
  while ((m = re.exec(input))) {
    emit(input.slice(last, m.index).replace(/\r/g, ''));
    if (m[2] === 'm') sgr(m[1]);
    last = re.lastIndex;
  }
  emit(input.slice(last).replace(/\r/g, ''));
  return out;
}
