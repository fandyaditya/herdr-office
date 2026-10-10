// Pack art/cast/<slug>/{south,east,north,west}.png + walk/<dir>/<n>.png into one atlas for the browser:
//   public/assets/cast.png  +  public/assets/cast.json
// Atlas rows per character: [stand S,E,N,W] then walk S, E, N, W (6 frames each); 32px cells, 6 columns.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, blit, blank, bbox } from './png.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
// usage: node tools/pack-cast.mjs [cast|mascot]   (default: cast)
const KIND = process.argv[2] || 'cast';
const SRC = path.join(ROOT, KIND === 'mascot' ? 'art/mascot' : 'art/cast');
const OUT = path.join(ROOT, 'public/assets');
const DIRS = ['south', 'east', 'north', 'west'];
const CELL = 32, COLS = 6, ROWS = 5;

const slugs = fs.readdirSync(SRC).filter((d) => fs.existsSync(path.join(SRC, d, 'south.png')) && fs.existsSync(path.join(SRC, d, 'walk', 'west', '5.png'))).sort();
if (!slugs.length) throw new Error(`no complete characters in ${SRC}`);
const atlas = blank(COLS * CELL, slugs.length * ROWS * CELL);
const chars = [];
slugs.forEach((slug, i) => {
  const rd = (f) => decodePng(fs.readFileSync(path.join(SRC, slug, f)));
  const y0 = i * ROWS * CELL;
  DIRS.forEach((d, c) => blit(atlas, rd(`${d}.png`), c * CELL, y0));
  DIRS.forEach((d, r) => { for (let f = 0; f < 6; f++) blit(atlas, rd(`walk/${d}/${f}.png`), f * CELL, y0 + (r + 1) * CELL); });
  const b = bbox(rd('south.png'));
  chars.push({ slug, box: b });
  console.log(slug, JSON.stringify(b));
});
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${KIND}.png`), encodePng(atlas));
fs.writeFileSync(path.join(OUT, `${KIND}.json`), JSON.stringify({ cell: CELL, cols: COLS, rows: ROWS, dirs: DIRS, chars }, null, 1));
console.log(`packed ${slugs.length} characters -> public/assets/${KIND}.png (${atlas.w}x${atlas.h})`);
