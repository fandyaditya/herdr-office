import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRIVIA, triviaAt, randomTrivia } from '../public/js/trivia.js';
import { EGGS } from '../public/js/eggs.js';

test('trivia lines are short, single-sentence-ish, link-free and unique', () => {
  assert.ok(TRIVIA.length >= 20);
  const seen = new Set();
  for (const t of TRIVIA) {
    assert.ok(t.length >= 20 && t.length <= 140, `bad length (${t.length}): ${t}`);
    assert.ok(!/\n|https?:|www\./.test(t), `no newlines or links: ${t}`);
    assert.ok(/[.!?]$/.test(t), `ends like a sentence: ${t}`);
    assert.ok(!seen.has(t.toLowerCase()), `duplicate: ${t}`);
    seen.add(t.toLowerCase());
  }
});

test('triviaAt wraps and randomTrivia avoids repeating the last line', () => {
  assert.equal(triviaAt(TRIVIA.length), TRIVIA[0]);
  assert.equal(triviaAt(-1), TRIVIA.at(-1));
  for (let i = 0; i < 200; i++) assert.notEqual(randomTrivia(3), 3);
});

test('every easter egg has a name and a hint', () => {
  for (const [id, e] of Object.entries(EGGS)) assert.ok(e.name && e.hint && /^[a-z]+$/.test(id), id);
});
