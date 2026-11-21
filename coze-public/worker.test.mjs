import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { GlobalQuota } from './worker.mjs';

const origin = 'https://graceful-jelly-64d31b.netlify.app';
const route = 'https://fixture.invalid/api/chat';
const token = 'synthetic-test-secret-not-a-live-credential';

function request(body = { message: '公开问题' }, overrides = {}) {
  const { headers = {}, method = 'POST', url = route, ...remaining } = overrides;
  return new Request(url, {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    ...(['GET', 'OPTIONS'].includes(method) ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    ...remaining,
  });
}

function env(status = 204) {
  const expectedId = {};
  let calls = 0;
  return {
    COZE_AGENT_API_TOKEN: token,
    get reservations() { return calls; },
    GLOBAL_QUOTA: {
      get(id) {
        assert.equal(id, expectedId);
        return { async fetch(url, init) {
          calls++;
          assert.equal(url, 'https://quota.invalid/reserve');
          assert.equal(init.method, 'POST');
          return new Response(null, { status, headers: { 'Retry-After': '42' } });
        } };
      },
      idFromName(name) {
        assert.equal(name, 'coze-public-demo-global');
        return expectedId;
      },
    },
  };
}

function stream(...data) {
  return new Response(data.map(frame => 'event: message\r\ndata: ' + JSON.stringify(frame) + '\r\n\r\n').join(''),
    { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
const answer = (sequence_id, value) => ({ type: 'answer', sequence_id, content: { answer: value } });
const done = { type: 'message_end', content: { message_end: { code: '0' } } };

test('CORS allows exactly one origin and a JSON POST; never allows credentials', async () => {
  const e = env();
  const fake = await worker.fetch(request(undefined, { headers: { Origin: origin + '.example' } }), e);
  assert.equal(fake.status, 403);
  assert.equal(fake.headers.get('Access-Control-Allow-Origin'), null);
  const preflight = await worker.fetch(request(undefined, { method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
  } }), e);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal((await worker.fetch(request(undefined, { method: 'GET' }), e)).status, 405);
  assert.equal((await worker.fetch(request(undefined, { url: route + '?x=y' }), e)).status, 404);
  assert.equal((await worker.fetch(request(undefined, { url: 'https://fixture.invalid/api/coze-token' }), e)).status, 404);
  assert.equal(e.reservations, 0);
});

test('rejects malformed, extra, credential-bearing and oversized inputs before quota/upstream', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected fetch'); });
  const e = env();
  for (const [r, status] of [
    [request('{not json}'), 400],
    [request({ message: '' }), 400],
    [request({ message: 'text', session_id: 'foreign' }), 400],
    [request({ message: '字'.repeat(342) }), 413],
    [request('x'.repeat(8193)), 413],
    [request({ message: 'text' }, { headers: { Authorization: 'Bearer client-supplied' } }), 400],
    [request({ message: 'text' }, { headers: { Cookie: 'id=client-session' } }), 400],
    [request({ message: 'text' }, { headers: { 'Content-Type': 'text/plain' } }), 415],
  ]) {
    assert.equal((await worker.fetch(r, e)).status, status);
  }
  assert.equal((await worker.fetch(request(), {})).status, 503);
  assert.equal(e.reservations, 0);
  assert.equal(upstream.mock.callCount(), 0);
});

test('request uses fixed endpoint and exact lexical project ID; forwards only sorted text; independent sessions', async (t) => {
  const sessions = new Set();
  const e = env();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://mh2n22gcnm.coze.site/stream_run');
    assert.equal(init.headers.Authorization, 'Bearer ' + token);
    assert.equal(init.redirect, 'error');
    assert.match(init.body, /"project_id":7641895293088481286}$/);
    const payload = JSON.parse(init.body);
    assert.equal(payload.type, 'query');
    assert.match(payload.session_id, /^[0-9a-f]{20}$/);
    sessions.add(payload.session_id);
    assert.deepEqual(payload.content.query.prompt, [{ type: 'text', content: { text: '公开问题' } }]);
    return stream(answer(3, '！'), { type: 'tool_response', content: { tool_response: 'not public' } }, answer(2, '答复'), done);
  });
  for (let j = 0; j < 2; j++) {
    const res = await worker.fetch(request(), e);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Cache-Control'), /no-store/);
    assert.equal(res.headers.get('Set-Cookie'), null);
    assert.deepEqual(await res.json(), { answer: '答复！' });
  }
  assert.equal(sessions.size, 2);
  assert.equal(e.reservations, 2);
});

test('denial or quota failure never reaches Coze', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected upstream'); });
  const denied = await worker.fetch(request(), env(429));
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('Retry-After'), '42');
  assert.deepEqual(await denied.json(), { error: 'rate_limited' });
  assert.equal((await worker.fetch(request(), env(500))).status, 503);
  assert.equal((await worker.fetch(request(), { COZE_AGENT_API_TOKEN: token })).status, 503);
  assert.equal(mock.mock.callCount(), 0);
});

test('fails closed on incomplete, error and oversized streams; no raw upstream/credential', async (t) => {
  const list = [
    () => stream(answer(1, 'Partial')),
    () => stream(answer(1, 'Payload leaked?'), { type: 'error' }, done),
    () => stream(answer(1, token.slice(0, 20)), answer(2, token.slice(20)), done),
    () => stream(answer(1, '字'.repeat(4000)), done),
    () => new Response('non-SSE'),
    () => new Response('sensitive auth error', { status: 401 }),
  ];
  t.mock.method(globalThis, 'fetch', () => list.shift()());
  while (list.length) {
    const res = await worker.fetch(request(), env());
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'upstream_error' });
  }
});

test('strict rolling-minute and UTC-day limits using actual SQLite SQL', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const storage = {
    sql: { exec(sql, ...args) { const p = db.prepare(sql); return /^SELECT/.test(sql) ? { one: () => p.get(...args) } : p.run(...args); } },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const res = fn(); db.exec('COMMIT'); return res; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  const q = new GlobalQuota({ storage });
  let now = Date.UTC(2026, 10, 21, 23, 53, 50);
  t.mock.method(Date, 'now', () => now);
  const reserve = () => q.fetch(new Request('https://quota.invalid/reserve', { method: 'POST' }));
  for (let minute = 0; minute < 6; minute++) {
    for (let i = 0; i < 5; i++) assert.equal(reserve().status, 204);
    assert.equal(reserve().status, 429);
    now += 60000;
  }
  assert.equal(reserve().status, 429); // 30 in this UTC date
  now = Date.UTC(2026, 10, 22, 23, 59, 50);
  for (let i = 0; i < 5; i++) assert.equal(reserve().status, 204);
  now += 15000;
  assert.equal(reserve().status, 429); // new date, but still within rolling minute
  now += 45000;
  assert.equal(reserve().status, 204);
});
