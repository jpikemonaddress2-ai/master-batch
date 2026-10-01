import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedHostSet, checkRequest } from '../guard.mjs';

const allowed = allowedHostSet({
  hostname: 'PU',
  interfaces: { eth: [{ family: 'IPv4', address: '192.168.1.10' }, { family: 'IPv6', address: 'fe80::1%12' }] },
  extra: ['pu.example.local:5173'],
});
const req = (method, path, headers) => ({ method, path, headers });
const status = r => checkRequest(r, allowed)?.status ?? 200;

test('許可するアドレス: localhost・PC名・IP・EXTRA_HOSTS（ポート付きで書いても可）', () => {
  for (const host of ['localhost:5173', '127.0.0.1:5173', '[::1]:5173', 'pu:5173', 'PU', '192.168.1.10:5173', '[fe80::1]:5173', 'pu.example.local:5173']) {
    assert.equal(status(req('GET', '/', { host })), 200, host);
  }
});

test('知らないアドレス（DNS rebinding）は GET も拒否する', () => {
  assert.equal(status(req('GET', '/api/recipes', { host: 'evil.example.com:5173' })), 403);
  assert.equal(status(req('GET', '/', {})), 403);
});

test('書き込みは同じオリジンの application/json だけ受け付ける', () => {
  const host = 'pu:5173';
  const json = { host, 'content-type': 'application/json' };
  assert.equal(status(req('POST', '/api/samples', { ...json, origin: 'http://pu:5173' })), 200);
  assert.equal(status(req('POST', '/api/samples', json)), 200);   // Origin なし（同じページからの古いブラウザなど）
  assert.equal(status(req('POST', '/api/samples', { ...json, origin: 'http://evil.example.com' })), 403);
  assert.equal(status(req('POST', '/api/samples', { ...json, origin: 'null' })), 403);
  assert.equal(status(req('DELETE', '/api/samples/1', { host, 'content-type': 'text/plain' })), 415);
  assert.equal(status(req('PUT', '/api/samples/1', { host, 'content-type': 'application/json-patch' })), 415);
  assert.equal(status(req('POST', '/api/samples', { host, 'content-type': 'application/json; charset=utf-8' })), 200);
});
