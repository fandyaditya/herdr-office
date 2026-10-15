import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkNewWorkspace } from '../server/workspace.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-ws-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('new workspace: the name defaults to the folder, ~ expands, an empty request is fine', () => {
  assert.deepEqual(checkNewWorkspace({ cwd: dir }), { label: path.basename(dir), cwd: dir, agent: null });
  assert.equal(checkNewWorkspace({ cwd: '~' }).cwd, os.homedir());
  assert.deepEqual(checkNewWorkspace({}), { label: null, cwd: null, agent: null });
  assert.equal(checkNewWorkspace({ cwd: dir, label: '  api  ', agent: 'claude' }).label, 'api');
});

test('new workspace: only real folders, short clean names and known agents', () => {
  assert.match(checkNewWorkspace({ cwd: 'relative/dir' }).error, /absolute/);
  assert.match(checkNewWorkspace({ cwd: path.join(dir, 'nope') }).error, /does not exist/);
  const file = path.join(dir, 'f.txt'); fs.writeFileSync(file, 'x');
  assert.match(checkNewWorkspace({ cwd: file }).error, /not a folder/);
  assert.ok(checkNewWorkspace({ cwd: `${dir}\n` + 'x\u0000' }).error, 'control characters are refused');
  assert.ok(checkNewWorkspace({ label: 'x'.repeat(61) }).error);
  assert.ok(checkNewWorkspace({ label: 'a\nb' }).error);
  assert.match(checkNewWorkspace({ agent: 'rm -rf /' }).error, /agent must be/);
  for (const a of ['claude', 'codex', 'cursor']) assert.equal(checkNewWorkspace({ agent: a }).agent, a);
});
