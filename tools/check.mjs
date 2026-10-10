#!/usr/bin/env node
// One command before every commit / PR:   npm run check
//   1. every .js/.mjs file parses            2. house rules the code relies on (see AGENTS.md)       3. the test suite
// Fast on purpose (a few seconds), no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (f) => path.relative(root, f);
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', '.dev', 'art', 'research', 'docs'].includes(e.name)) continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, out); else out.push(f);
  }
  return out;
};
const files = walk(root);
let failed = 0;
const fail = (msg) => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); };
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);

// 1. syntax
const code = files.filter((f) => /\.(m?js)$/.test(f));
let bad = 0;
for (const f of code) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; fail(`syntax: ${rel(f)}\n${r.stderr.split('\n').slice(0, 4).join('\n')}`); }
}
if (!bad) ok(`${code.length} JavaScript files parse`);

// 2. house rules
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.dependencies && Object.keys(pkg.dependencies).length) fail('package.json has runtime "dependencies": this project has zero (use Node built-ins)');
else ok('zero runtime dependencies');

const pub = files.filter((f) => f.startsWith(path.join(root, 'public')) && /\.(html|js|css)$/.test(f));
let rules = 0;
for (const f of pub) {
  const t = fs.readFileSync(f, 'utf8');
  if (f.endsWith('.html') && /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(t)) { rules++; fail(`${rel(f)}: inline <script> (the CSP forbids it; put it in public/js/)`); }
  if (/\son[a-z]+\s*=\s*["']/i.test(t) && f.endsWith('.html')) { rules++; fail(`${rel(f)}: inline event handler attribute (CSP)`); }
  const ext = t.match(/(?:src|href)\s*=\s*["']https?:\/\/(?!www\.w3\.org)[^"']+|url\(\s*["']?https?:\/\/[^)]+|@import\s+["']https?:/g);
  if (ext) { rules++; fail(`${rel(f)}: loads from a third-party host (${ext[0].slice(0, 60)}); everything must be self-hosted`); }
  if (f.endsWith('.js') && /\b(?:eval|new Function)\s*\(/.test(t)) { rules++; fail(`${rel(f)}: eval / new Function (CSP)`); }
}
if (!rules) ok('public/ is CSP-clean and self-contained');

const tracked = ['.env', 'deploy/deploy.env'].filter((f) => fs.existsSync(path.join(root, '.git')) && spawnSync('git', ['ls-files', '--error-unmatch', f], { cwd: root, stdio: 'ignore' }).status === 0);
if (tracked.length) fail(`${tracked.join(', ')} is tracked by git: it holds secrets`); else ok('no secrets tracked');

const secret = /(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const leaked = files.filter((f) => !/\.(png|woff2|jpg|gif|webp)$/.test(f) && !f.endsWith('.env') && secret.test(fs.readFileSync(f, 'utf8')) && f !== fileURLToPath(import.meta.url));
if (leaked.length) fail(`looks like a credential in: ${leaked.map(rel).join(', ')}`); else ok('no credential-shaped strings');

// 3. tests
if (process.argv.includes('--no-tests')) process.exit(failed ? 1 : 0);
console.log('  running tests...');
const t = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f))], { cwd: root, encoding: 'utf8' });
const m = (k) => Number((t.stdout.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1] || 0);
if (t.status === 0) ok(`${m('pass')} tests pass`); else { fail(`${m('fail')} test(s) failed`); console.log(t.stdout.split('\n').filter((l) => /^not ok|failureType|error:/.test(l)).slice(0, 20).join('\n')); }
console.log(failed ? `\n\x1b[31m${failed} problem(s)\x1b[0m` : '\n\x1b[32mAll checks passed.\x1b[0m');
process.exit(failed ? 1 : 0);
