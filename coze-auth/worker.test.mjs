import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { before, test } from 'node:test';
import worker from './worker.mjs';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
const origin = 'https://fabricformat.github.io';
const route = 'https://sample.invalid/api/coze-token';
const code = 'test0123456789_abcdefghijklmnopqrstuvwxyz';
const env = { DEMO_ACCESS_CODE: code, COZE_CLIENT_ID: 'synthetic-client', COZE_PUBLIC_KEY_ID: 'synthetic-key', TOKEN_RATE_LIMIT: { limit: async () => ({ success: true }) } };
let publicKey;

before(async () => {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true, ['sign', 'verify'],
  );
  const privateBuffer = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
  env.COZE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(privateBuffer).toString('base64') + '\n-----END PRIVATE KEY-----';
  publicKey = keys.publicKey;
});

function request({ url = route, method = 'POST', site = origin, credential = code, headers = {}, body } = {}) {
  return new Request(url, { method, body, headers: {
    ...(site !== null ? { Origin: site } : {}),
    ...(credential !== null ? { Authorization: 'Bearer ' + credential } : {}),
    ...headers,
  } });
}

test('preflight accepts only Authorization from the exact origin for POST', async () => {
  const headers = { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' };
  const options = { method: 'OPTIONS', credential: null };
  const res = await worker.fetch(request({ ...options, headers }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(res.headers.get('Access-Control-Allow-Headers'), 'Authorization');
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null);
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  assert.equal((await worker.fetch(request({ ...options, headers: { ...headers, 'Access-Control-Request-Headers': 'authorization, x-unknown' } }), env)).status, 403);
  assert.equal((await worker.fetch(request({ ...options, headers: { ...headers, 'Access-Control-Request-Method': 'GET' } }), env)).status, 403);
});

test('invalid routes, origins, methods, codes and configuration never contact Coze', async (t) => {
  const mockFetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network call'); });
  for (const [options, config, status] of [
    [{ url: route + '?secret=anything' }, env, 404],
    [{ url: 'https://sample.invalid/not-the-route' }, env, 404],
    [{ site: origin + '.invalid' }, env, 403],
    [{ site: null }, env, 403],
    [{ method: 'GET' }, env, 405],
    [{ credential: null }, env, 401],
    [{ credential: code + 'wrong' }, env, 401],
    [{ body: '{"projectId":"other"}' }, env, 400],
    [{}, { ...env, DEMO_ACCESS_CODE: 'A'.repeat(40) }, 503],
    [{}, { ...env, COZE_PRIVATE_KEY: 'invalid-key' }, 503],
    [{}, { ...env, COZE_CLIENT_ID: undefined }, 503],
    [{}, { ...env, COZE_PUBLIC_KEY_ID: undefined }, 503],
    [{}, { ...env, PAGES_ORIGIN: '*' }, 503],
  ]) {
    const res = await worker.fetch(request(options), config);
    assert.equal(res.status, status);
    assert.match(res.headers.get('Cache-Control'), /no-store/);
    if ([403, 404].includes(status)) assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(mockFetch.mock.callCount(), 0);
});

test('signs a fresh connector-limited JWT, requests 900s, and returns only token and expiry', async (t) => {
  const claims = [];
  const endsAt = Math.floor(Date.now() / 1000) + 900;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.coze.cn/api/permission/oauth2/token');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', duration_seconds: 900,
    });
    assert.match(options.headers.Authorization, /^Bearer /);
    const [header, payload, sig] = options.headers.Authorization.slice(7).split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT', kid: env.COZE_PUBLIC_KEY_ID });
    assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, Buffer.from(sig, 'base64url'), Buffer.from(header + '.' + payload)), true);
    const claim = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claim.iss, env.COZE_CLIENT_ID);
    assert.equal(claim.aud, 'api.coze.cn');
    assert.ok(Math.abs(claim.iat - Math.floor(Date.now() / 1000)) <= 1);
    assert.equal(claim.exp - claim.iat, 60);
    assert.equal(claim.session_name, 'fabricformat-demo-owner');
    assert.equal(claim.session_context.connector_info.connector_id, '2001');
    assert.equal(Buffer.from(claim.jti, 'base64url').length, 32);
    claims.push(claim);
    return Response.json({ access_token: 'synthetic-token', expires_in: endsAt, unwanted: 'not returned' });
  });
  for (let i = 0; i < 2; i++) {
    const res = await worker.fetch(request(), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin);
    assert.match(res.headers.get('Cache-Control'), /no-store/);
    assert.deepEqual(await res.json(), { access_token: 'synthetic-token', expires_in: endsAt });
  }
  assert.notEqual(claims[0].jti, claims[1].jti);
});

test('upstream failure or malformed token is a generic fail-closed 502', async (t) => {
  const results = [
    () => Response.json({ error: 'sensitive upstream error' }, { status: 401 }),
    () => new Response('<html>unexpected data</html>'),
    () => Response.json({ access_token: 'synthetic-token', expires_in: 900 }),
    () => Response.json({ access_token: 'synthetic-token', expires_in: Math.floor(Date.now() / 1000) + 10000 }),
    () => { throw new Error('sensitive exception'); },
  ];
  t.mock.method(globalThis, 'fetch', () => results.shift()());
  for (let i = 0; i < 5; i++) {
    const res = await worker.fetch(request(), env);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'Could not issue demo token' });
  }
});

test('auth precedes rate limiting; absent or exhausted limit prevents issuance', async (t) => {
  const mockFetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network call'); });
  const checks = [];
  const config = { ...env, TOKEN_RATE_LIMIT: { limit: async (value) => { checks.push(value); return { success: false }; } } };
  assert.equal((await worker.fetch(request({ credential: null }), config)).status, 401);
  assert.equal(checks.length, 0);
  const res = await worker.fetch(request(), config);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.deepEqual(checks, [{ key: 'demo-owner-token' }]);
  assert.equal((await worker.fetch(request(), { ...env, TOKEN_RATE_LIMIT: undefined })).status, 503);
  assert.equal(mockFetch.mock.callCount(), 0);
});
