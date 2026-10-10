// Minimal client for herdr's local JSON-lines socket API (`herdr api schema` documents it).
// One persistent connection; requests are matched to responses by id.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// HERDR_SOCKET_PATH wins; otherwise HERDR_SESSION=<name> is resolved through `herdr session list --json`
// (the default session lives at ~/.config/herdr/herdr.sock).
export function defaultSocketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const base = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'herdr');
  const session = process.env.HERDR_SESSION;
  if (session && session !== 'default') {
    try {
      const out = JSON.parse(execFileSync('herdr', ['session', 'list', '--json'], { encoding: 'utf8', timeout: 5000 }));
      const hit = out.sessions?.find((x) => x.name === session);
      if (hit?.socket_path) return hit.socket_path;
    } catch { /* fall through to the conventional location */ }
    return path.join(base, 'sessions', session, 'herdr.sock');
  }
  return path.join(base, 'herdr.sock');
}

// One short-lived connection per call. herdr resets a socket that has several requests in flight (the
// snapshot poll, every open terminal panel and a send all overlap), which killed every call sharing it and
// surfaced as 502s. A fresh unix-socket connection costs microseconds and can never be left half dead.
export class HerdrClient {
  constructor(socketPath = defaultSocketPath()) {
    this.socketPath = socketPath;
    this.seq = 0;
  }

  async call(method, params = {}, timeoutMs = 8000) {
    try { return await this.#callOnce(method, params, timeoutMs); } catch (e) {
      if (!e.unsent) throw e;           // the request never reached herdr (connect refused / reset before write)
      return this.#callOnce(method, params, timeoutMs);
    }
  }

  #callOnce(method, params, timeoutMs) {
    const id = `o${++this.seq}`;
    return new Promise((resolve, reject) => {
      const s = net.connect(this.socketPath);
      let buf = '', sent = false, done = false;
      const finish = (err, val) => {
        if (done) return; done = true;
        clearTimeout(timer); s.destroy();
        if (err) { if (!sent) err.unsent = true; reject(err); } else resolve(val);
      };
      const timer = setTimeout(() => finish(new Error(`herdr ${method} timed out`)), timeoutMs);
      s.setEncoding('utf8');
      s.once('connect', () => s.write(JSON.stringify({ id, method, params }) + '\n', (err) => { if (err) finish(err); else sent = true; }));
      s.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id !== id) continue;
          if (msg.error) { const e = new Error(msg.error.message || 'herdr error'); e.code = msg.error.code; sent = true; return finish(e); }
          return finish(null, msg.result);
        }
      });
      s.on('error', (e) => finish(e));
      s.on('close', () => finish(new Error('herdr socket closed')));
    });
  }

  async snapshot() {
    const r = await this.call('session.snapshot');
    return r.snapshot || r;
  }
  async readPane(paneId, source = 'visible', lines = 60, ansi = false) {
    const r = await this.call('pane.read', ansi ? { pane_id: paneId, source, lines, format: 'ansi', strip_ansi: false } : { pane_id: paneId, source, lines });
    return r.read || r;
  }
  sendText(paneId, text) { return this.call('pane.send_text', { pane_id: paneId, text }); }
  sendKeys(paneId, keys) { return this.call('pane.send_keys', { pane_id: paneId, keys }); }
  processInfo(paneId) { return this.call('pane.process_info', { pane_id: paneId }); }
  focusPane(paneId) { return this.call('pane.focus', { pane_id: paneId }); }
}
