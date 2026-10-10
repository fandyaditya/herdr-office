import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAuth } from '../server/auth.js';

test('login issues a cookie that authenticates, wrong token does not', () => {
  const a = makeAuth('s3cret-token');
  assert.equal(a.isAuthed({ headers: {} }), false);
  assert.equal(a.tryLogin('1.1.1.1', 'nope').ok, false);
  const ok = a.tryLogin('1.1.1.1', 's3cret-token');
  assert.equal(ok.ok, true);
  const cookie = a.cookie(true).split(';')[0];
  assert.equal(a.isAuthed({ headers: { cookie } }), true);
  assert.equal(a.isAuthed({ headers: { cookie: 'ho_session=deadbeef' } }), false);
  assert.equal(a.isAuthed({ headers: { authorization: 'Bearer s3cret-token' } }), true);
  assert.match(a.cookie(true), /HttpOnly; SameSite=Strict/);
  assert.match(a.cookie(true), /Secure/);
});

test('login is rate limited per ip', () => {
  const a = makeAuth('tok');
  for (let i = 0; i < 8; i++) assert.equal(a.tryLogin('9.9.9.9', 'bad').limited, undefined);
  assert.equal(a.tryLogin('9.9.9.9', 'tok').limited, true, 'locked even for the right token while limited');
  assert.equal(a.tryLogin('8.8.8.8', 'tok').ok, true, 'other ips unaffected');
});

test('an empty token disables auth (dev only)', () => {
  assert.equal(makeAuth('').enabled, false);
  assert.equal(makeAuth('').isAuthed({ headers: {} }), true);
});
