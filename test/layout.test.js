import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPanes } from '../server/layout.js';

const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - [...s].length));

test('splits a chat + diff screen on the divider column', () => {
  const text = rows(10, (i) => `${pad(`chat line ${i} with some words`, 50)}│diff line ${i}`);
  const { main, side } = splitPanes(text);
  assert.equal(main.split('\n')[3], 'chat line 3 with some words');
  assert.equal(side.split('\n')[3], 'diff line 3');
  assert.ok(!main.includes('│') && !side.includes('│'));
});

test('keeps colours: the side view starts with the style active at the divider', () => {
  const text = rows(8, (i) => `${pad(`chat ${i}`, 40)}\x1b[32m│\x1b[0m\x1b[32m+added line number ${i}\x1b[0m`);
  const { side } = splitPanes(text);
  assert.ok(side.split('\n')[2].startsWith('\x1b[32m'));
  assert.ok(side.includes('+added line number 2'));
});

test('rows without the divider stay in the chat view', () => {
  const lines = rows(10, (i) => `${pad(`chat ${i}`, 40)}│diff line number ${i}`).split('\n');
  lines[5] = 'full width status line';
  const { main, side } = splitPanes(lines.join('\n'));
  assert.ok(main.includes('full width status line'));
  assert.ok(!side.includes('status'));
});

test('a bordered box or a single view is left alone', () => {
  const box = ['plain output', '┌──────────────┐', '│ follow-up    │', '│ enter steer  │', '└──────────────┘', 'more output'].join('\n');
  assert.equal(splitPanes(box).side, null);
  assert.equal(splitPanes('just\ntext').side, null);
  assert.equal(splitPanes('').side, null);
});
