// Small, safe markdown -> HTML for agent replies. Everything is HTML-escaped FIRST; only constructs this file
// generates become tags, and links are limited to http(s) and mailto. Covers what agents actually write:
// headings, paragraphs, bold/italic/strike, inline code, fenced code, lists (nested by indent), task lists,
// blockquotes, tables, rules, links and bare URLs.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`); // protect code spans
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`);
  s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[i]);
}

const isRule = (l) => /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(l);
const listItem = (l) => /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(l);
const tableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function mdToHtml(src) {
  const fences = [];
  // fenced code first, so nothing inside it is interpreted
  let text = String(src ?? '').replace(/\r\n?/g, '\n').replace(/^ {0,3}(`{3,}|~{3,})[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|$)/gm, (_, f, lang, body) => {
    fences.push(`<pre class="c-code"><code${lang ? ` data-lang="${escHtml(lang)}"` : ''}>${escHtml(body)}</code></pre>`);
    return `\n\u0001${fences.length - 1}\u0001\n`;
  });
  return render(escHtml(text).replace(/&gt;/g, '>'), fences); // raw ">" is harmless text and lets blockquotes be detected
}

// `text` is already HTML-escaped; `fences` holds the finished code blocks the placeholders stand for.
function render(text, fences) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const fence = /^\u0001(\d+)\u0001$/.exec(l.trim());
    if (fence) { out.push(fences[+fence[1]]); i++; continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(l);
    if (h) { const n = Math.min(h[1].length + 1, 5); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (isRule(l)) { out.push('<hr>'); i++; continue; }
    if (l.startsWith('>')) {
      const q = [];
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${render(q.join('\n'), fences)}</blockquote>`);
      continue;
    }
    if (l.includes('|') && i + 1 < lines.length && tableSep(lines[i + 1])) {
      const head = cells(l); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="c-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (listItem(l)) {
      const stack = []; // { indent, ordered }
      let html = '';
      while (i < lines.length) {
        const m = listItem(lines[i]);
        if (!m) { if (lines[i].trim() === '' && i + 1 < lines.length && listItem(lines[i + 1])) { i++; continue; } break; }
        const indent = m[1].replace(/\t/g, '    ').length, ordered = /\d/.test(m[2]);
        while (stack.length && indent < stack.at(-1).indent) html += `</li></${stack.pop().ordered ? 'ol' : 'ul'}>`;
        if (stack.length && indent === stack.at(-1).indent && ordered !== stack.at(-1).ordered) html += `</li></${stack.pop().ordered ? 'ol' : 'ul'}>`; // list type changed
        if (!stack.length || indent > stack.at(-1).indent) { stack.push({ indent, ordered }); html += ordered ? '<ol>' : '<ul>'; }
        else html += '</li>';
        const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
        html += task ? `<li class="c-task${task[1] === ' ' ? '' : ' done'}">${inline(task[2])}` : `<li>${inline(m[3])}`;
        i++;
      }
      while (stack.length) html += `</li></${stack.pop().ordered ? 'ol' : 'ul'}>`;
      out.push(html);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\u0001\d+\u0001$/.test(lines[i].trim()) && !/^#{1,6}\s/.test(lines[i]) && !lines[i].startsWith('>') && !isRule(lines[i]) && !listItem(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}
