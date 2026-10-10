import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { HerdrClient } from '../server/herdr.js';

// A fake herdr that answers one request per connection and then hangs up, like a socket gone stale.
test('client reconnects and resends when the persistent socket went stale', async () => {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-')), 'h.sock');
  const got = [];
  const srv = net.createServer((c) => {
    c.setEncoding('utf8');
    c.on('data', (d) => {
      for (const line of d.split('\n').filter(Boolean)) {
        const m = JSON.parse(line); got.push(m.method);
        c.end(JSON.stringify({ id: m.id, result: { ok: true } }) + '\n');
      }
    });
    c.on('error', () => {});
  });
  await new Promise((r) => srv.listen(sock, r));
  const cl = new HerdrClient(sock);
  assert.deepEqual(await cl.sendText('w1:p1', 'a'), { ok: true });
  await new Promise((r) => setTimeout(r, 50)); // let the hang-up land
  assert.deepEqual(await cl.sendKeys('w1:p1', ['enter']), { ok: true });
  assert.deepEqual(got, ['pane.send_text', 'pane.send_keys']);
  srv.close();
});

// herdr resets a connection that carries more than one request at a time; calls must not share one.
test('concurrent calls each get their own connection', async () => {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-')), 'h.sock');
  const srv = net.createServer((c) => {
    c.setEncoding('utf8'); let n = 0;
    c.on('error', () => {});
    c.on('data', (d) => {
      for (const line of d.split('\n').filter(Boolean)) {
        if (++n > 1) return c.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
        const m = JSON.parse(line); setTimeout(() => c.write(JSON.stringify({ id: m.id, result: { ok: m.method } }) + '\n'), 20);
      }
    });
  });
  await new Promise((r) => srv.listen(sock, r));
  const cl = new HerdrClient(sock);
  const out = await Promise.all(Array.from({ length: 8 }, (_, i) => cl.call(`m${i}`)));
  assert.deepEqual(out.map((o) => o.ok), Array.from({ length: 8 }, (_, i) => `m${i}`));
  srv.close();
});
