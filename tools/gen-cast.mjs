// Generate the office cast with Pixellab (resumable; state in art/cast/cast.json).
//   node tools/gen-cast.mjs            create characters, animate walking, download frames
// Cost: ~6 gens/character (8 directions) + 4 gens/character (walking, 4 directions).
import fs from 'node:fs';
import path from 'node:path';
import { api, waitJob, download, balance, ledger } from './pixellab.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const DIR = path.join(ROOT, 'art/cast');
const STATE = path.join(DIR, 'cast.json');
fs.mkdirSync(DIR, { recursive: true });
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));

const STYLE = 'chibi pixel art office worker, wearing a plain bright teal t-shirt and dark grey trousers, clean simple design';
const CAST = [
  ['ada', 'short black hair, light skin, round glasses'],
  ['bea', 'long dark red hair, fair skin, freckles'],
  ['cal', 'short curly black hair, dark brown skin'],
  ['dee', 'blond bob haircut, light skin'],
  ['eli', 'buzz cut, tan skin, short beard'],
  ['fay', 'brown ponytail, medium skin, headphones around the neck'],
  ['gus', 'grey hair and moustache, light skin, older man'],
  ['hana', 'black hair in a bun, light tan skin'],
];
const only = process.argv.slice(2);
const todo = CAST.filter(([s]) => !only.length || only.includes(s));
const start = await balance();

// Pixellab limits concurrent jobs (429); wait and retry instead of failing.
async function retry429(fn) {
  for (let i = 0; i < 90; i++) {
    try { return await fn(); } catch (e) { if (!String(e.message).includes(' 429 ')) throw e; await new Promise((r) => setTimeout(r, 20000)); }
  }
  throw new Error('still rate limited after 30 min');
}

async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); }));
}

await pool(todo, 2, async ([slug, look]) => {
  const st = (state[slug] ||= {});
  if (!st.id) {
    const res = await retry429(() => api('POST', '/create-character-pro-flash', {
      description: `${STYLE}, ${look}, front view standing`, name: slug, view: 'low top-down',
      image_size: { width: 32, height: 32 }, n_directions: 8, template_id: 'mannequin',
    }));
    st.id = res.character_id; st.job = res.background_job_id; save();
  }
  if (!st.created) {
    await waitJob(st.job); // also resumes a job started by an earlier run
    st.created = true; save();
    console.log('created', slug, st.id);
  }
  if (!st.anim) {
    const res = await retry429(() => api('POST', '/animate-character', { character_id: st.id, template_animation_id: 'walking', mode: 'template', directions: ['south', 'east', 'north', 'west'] }));
    st.anim = res.background_job_ids || [res.background_job_id]; save();
    await Promise.all(st.anim.map((j) => waitJob(j)));
    st.animated = true; save();
    console.log('animated', slug);
  }
  if (!st.downloaded) {
    const c = await api('GET', `/characters/${st.id}`);
    for (const [dir, url] of Object.entries(c.rotation_urls)) await download(url, path.join(DIR, slug, `${dir}.png`));
    const w = c.animations.find((a) => a.animation_type === 'walking');
    for (const d of w.directions) { let i = 0; for (const u of d.frames) await download(u, path.join(DIR, slug, 'walk', d.direction, `${i++}.png`)); }
    st.downloaded = true; save();
    console.log('downloaded', slug);
  }
});

const end = await balance();
ledger(`| ${new Date().toISOString().slice(0, 10)} | cast batch (${todo.map((t) => t[0]).join(',')}) | create 8dir + walking | ${(start - end).toFixed(2)} | ${end} (was ${start}) |`);
console.log('done; spent', start - end, 'balance', end);
