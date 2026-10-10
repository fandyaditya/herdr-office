// Tiny Pixellab v2 client for generating office art. The key comes from PIXELLAB_API_KEY (or a dotenv file named by PIXELLAB_ENV).
// Every spend is appended to art/ledger.md (git-ignored) so the generation budget stays visible.
//   node tools/pixellab.mjs balance
//   node tools/pixellab.mjs char <slug> "<description>" [size=24] [view=low top-down]
//   node tools/pixellab.mjs job <job_id>
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
function readKey() {
  if (process.env.PIXELLAB_API_KEY) return process.env.PIXELLAB_API_KEY;
  if (process.env.PIXELLAB_ENV) return Object.fromEntries(fs.readFileSync(process.env.PIXELLAB_ENV, 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s))).PIXELLAB_API_KEY;
  throw new Error('Set PIXELLAB_API_KEY (or PIXELLAB_ENV=<dotenv file>) to generate art.');
}
const KEY = readKey();
const BASE = 'https://api.pixellab.ai/v2';

export async function api(method, route, body) {
  const r = await fetch(BASE + route, { method, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(`${method} ${route} -> ${r.status} ${text.slice(0, 400)}`);
  return json;
}
export const balance = async () => (await api('GET', '/balance')).subscription.generations;
export function ledger(line) {
  const f = path.join(ROOT, 'art/ledger.md');
  if (!fs.existsSync(f)) fs.writeFileSync(f, '# Pixellab spend ledger (herdr-office)\n\n| date | operation | what | est. gens | balance after |\n|---|---|---|---:|---:|\n');
  fs.appendFileSync(f, line + '\n');
}
export async function waitJob(id, every = 4000, max = 240) {
  for (let i = 0; i < max; i++) {
    const j = await api('GET', `/background-jobs/${id}`);
    if (j.status === 'completed') return j;
    if (j.status === 'failed') throw new Error(`job failed: ${JSON.stringify(j).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error('job timeout');
}
export async function download(url, file) {
  const r = await fetch(url, { headers: url.startsWith(BASE) ? { authorization: `Bearer ${KEY}` } : {} });
  if (!r.ok) throw new Error(`download ${url} -> ${r.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'balance') console.log(await balance());
  else if (cmd === 'job') console.log(JSON.stringify(await api('GET', `/background-jobs/${args[0]}`), null, 1).slice(0, 3000));
  else if (cmd === 'char') {
    const [slug, description, size = '24', view = 'low top-down'] = args;
    const before = await balance();
    const res = await api('POST', '/create-character-pro-flash', { description, name: slug, view, image_size: { width: +size, height: +size }, n_directions: 8, template_id: 'mannequin' });
    console.log('started', JSON.stringify(res).slice(0, 300));
    const job = await waitJob(res.background_job_id);
    fs.mkdirSync(path.join(ROOT, 'art/raw'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, `art/raw/${slug}.job.json`), JSON.stringify({ res, job }, null, 1));
    const after = await balance();
    ledger(`| ${new Date().toISOString().slice(0, 10)} | create-character-pro-flash ${size}px 8dir | ${slug}: ${description.slice(0, 60)} | ${res.estimated_generations} | ${after} (was ${before}) |`);
    console.log('done; character_id', res.character_id, 'balance', after);
  } else if (cmd === 'anim') {
    // anim <slug> <character_id> <template_animation_id> [directions=south,east,north,west]
    const [slug, id, tpl, dirs = 'south,east,north,west'] = args;
    const before = await balance();
    const res = await api('POST', '/animate-character', { character_id: id, template_animation_id: tpl, mode: 'template', directions: dirs.split(',') });
    console.log('started', JSON.stringify(res).slice(0, 400));
    const ids = res.background_job_ids || [res.background_job_id];
    const job = (await Promise.all(ids.map((j) => waitJob(j))))[0];
    fs.mkdirSync(path.join(ROOT, 'art/raw'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, `art/raw/${slug}.${tpl}.job.json`), JSON.stringify({ res, job }, null, 1));
    const after = await balance();
    ledger(`| ${new Date().toISOString().slice(0, 10)} | animate-character template ${tpl} (${dirs}) | ${slug} | ${before - after} | ${after} (was ${before}) |`);
    console.log('done balance', after);
  } else console.log('commands: balance | job <id> | anim <slug> <character_id> <template> [dirs] | char <slug> "<desc>" [size] [view]');
}
