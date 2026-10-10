// Load probe: N parallel pollers hitting /read while an SSE client counts error events.
// BASE_URL (default http://127.0.0.1:4747) OFFICE_TOKEN from .env, SECS, PANES (comma list)
import fs from 'node:fs';
import http from 'node:http';
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:4747');
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const secs = Number(process.env.SECS || 20), panes = (process.env.PANES || 'w9:p1,wA:p1,w6:p2,w6:pN,w7:p1,w8:p1').split(',');
const lib = base.protocol === 'https:' ? (await import('node:https')).default : http;
const req = (path, opts = {}, body) => new Promise((res, rej) => {
  const r = lib.request(new URL(path, base), opts, (m) => { let b = ''; m.on('data', (d) => (b += d)); m.on('end', () => res({ status: m.statusCode, headers: m.headers, body: b })); });
  r.on('error', rej); if (body) r.write(body); r.end();
});
const login = await req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, `token=${encodeURIComponent(env.OFFICE_TOKEN)}`);
const cookie = login.headers['set-cookie'][0].split(';')[0];
const stats = {}; let sseErr = 0, sseEv = 0, sseClosed = 0;
const sse = () => lib.get(new URL('/api/events', base), { headers: { cookie } }, (m) => {
  m.setEncoding('utf8'); m.on('data', (d) => { for (const l of d.split('\n')) if (l.startsWith('event:')) { sseEv++; if (l.includes('error')) sseErr++; } });
  m.on('close', () => { sseClosed++; });
});
sse();
const end = Date.now() + secs * 1000;
await Promise.all(panes.map(async (p) => {
  while (Date.now() < end) {
    try { const r = await req(`/api/pane/${encodeURIComponent(p)}/read?lines=90&ansi=1`, { headers: { cookie } }); stats[r.status] = (stats[r.status] || 0) + 1; }
    catch (e) { stats[e.code || e.message] = (stats[e.code || e.message] || 0) + 1; }
    await new Promise((r) => setTimeout(r, 250));
  }
}));
console.log(JSON.stringify({ reads: stats, sseEvents: sseEv, sseErrorEvents: sseErr, sseClosed }));
process.exit(0);
