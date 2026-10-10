import test from 'node:test';
import assert from 'node:assert/strict';
import { ansiToHtml } from '../public/js/ansi.js';

test('colours, truecolor and resets', () => {
  assert.equal(ansiToHtml('plain'), 'plain');
  assert.match(ansiToHtml('\x1b[31mred\x1b[0m ok'), /<span style="color:#e0636b">red<\/span> ok/);
  assert.match(ansiToHtml('\x1b[38;2;10;20;30mx'), /color:rgb\(10,20,30\)/);
  assert.match(ansiToHtml('\x1b[48;5;196mx'), /background:rgb\(255,0,0\)/);
  assert.match(ansiToHtml('\x1b[1;4mb'), /font-weight:700;text-decoration:underline/);
});
test('output is escaped and other escapes are stripped', () => {
  assert.equal(ansiToHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(ansiToHtml('a\x1b[2Kb\x1b[10;5Hc\x1b]0;title\x07d\r\n'), 'abcd\n');
  assert.ok(!ansiToHtml('\x1b[31m<img onerror=x>').includes('<img'));
});
