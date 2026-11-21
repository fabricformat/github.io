const ORIGIN = 'https://graceful-jelly-64d31b.netlify.app';
const UPSTREAM = 'https://mh2n22gcnm.coze.site/stream_run';
// Coze documents an integer. At this size JS Number would silently round it.
const PROJECT_ID_JSON = '7641895293088481286';
const QUOTA_URL = 'https://quota.invalid/reserve';
const encode = new TextEncoder();
const MINUTE = 60000;
const DAY = 86400000;
const DAY_LIMIT = 30;
const MINUTE_LIMIT = 5;
const MAX_REQUEST_BYTES = 8192;
const MAX_MESSAGE_BYTES = 1024;
const MAX_UPSTREAM_BYTES = 128 * 1024;
const MAX_ANSWER_BYTES = 8192;

function output(status, data, allowCors = false, more = {}) {
  const headers = {
    'Cache-Control': 'no-store, private',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    ...more,
  };
  if (allowCors) headers['Access-Control-Allow-Origin'] = ORIGIN;
  return new Response(data === null ? null : JSON.stringify(data), { status, headers });
}

async function timedRead(reader, signal) {
  signal.throwIfAborted();
  let aborted;
  const deadline = new Promise((_, reject) => {
    aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
  });
  try {
    return await Promise.race([reader.read(), deadline]);
  } finally {
    signal.removeEventListener('abort', aborted);
  }
}

async function boundedText(body, limit, signal) {
  const reader = body.getReader();
  const decode = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let value = '';
  try {
    for (;;) {
      const { done, value: chunk } = await timedRead(reader, signal);
      if (done) return value + decode.decode();
      size += chunk.byteLength;
      if (size > limit) throw new RangeError('body_too_large');
      value += decode.decode(chunk, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function answerFromSSE(text) {
  const chunks = new Map();
  let ended = false;
  let size = 0;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const lines = frame.split(/\r?\n/);
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    if (event && event !== 'message') {
      if (event === 'error') throw new Error('upstream_error');
      continue;
    }
    const payload = JSON.parse(data);
    if (payload?.type === 'error') throw new Error('upstream_error');
    if (ended) continue;
    if (payload?.type === 'message_end') {
      if (String(payload.content?.message_end?.code) !== '0') throw new Error('upstream_error');
      ended = true;
    } else if (payload?.type === 'answer') {
      const chunk = payload.content?.answer;
      const seq = payload.sequence_id;
      if (typeof chunk !== 'string' || !Number.isSafeInteger(seq) || seq < 0) throw new Error('bad_answer');
      if (chunks.has(seq)) {
        if (chunks.get(seq) !== chunk) throw new Error('bad_answer');
        continue;
      }
      size += encode.encode(chunk).length;
      if (size > MAX_ANSWER_BYTES) throw new Error('answer_too_large');
      chunks.set(seq, chunk);
    }
  }
  const answer = [...chunks].sort(([left], [right]) => left - right).map(([, value]) => value).join('');
  if (!ended || !answer.trim()) throw new Error('incomplete_answer');
  return answer;
}

export class GlobalQuota {
  constructor(ctx) {
    this.storage = ctx.storage;
    this.sql = this.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS reservations (ts INTEGER NOT NULL)');
  }

  fetch(request) {
    if (request.method !== 'POST' || request.url !== QUOTA_URL) return new Response(null, { status: 404 });
    const now = Date.now();
    const dayStart = Math.floor(now / DAY) * DAY;
    return this.storage.transactionSync(() => {
      // Keep enough history for the rolling minute even around UTC midnight.
      this.sql.exec('DELETE FROM reservations WHERE ts < ?', Math.min(dayStart, now - MINUTE));
      const daily = this.sql.exec('SELECT COUNT(*) AS total FROM reservations WHERE ts >= ?', dayStart).one().total;
      if (daily >= DAY_LIMIT) {
        return new Response(null, { status: 429, headers: { 'Retry-After': String(Math.ceil((dayStart + DAY - now) / 1000)) } });
      }
      const minute = this.sql.exec('SELECT COUNT(*) AS total, MIN(ts) AS oldest FROM reservations WHERE ts > ?', now - MINUTE).one();
      if (minute.total >= MINUTE_LIMIT) {
        return new Response(null, { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil((minute.oldest + MINUTE - now) / 1000))) } });
      }
      this.sql.exec('INSERT INTO reservations (ts) VALUES (?)', now);
      return new Response(null, { status: 204 });
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/chat' || url.search) return output(404, { error: 'not_found' });
    if (request.headers.get('Origin') !== ORIGIN) return output(403, { error: 'forbidden' });
    if (request.method === 'OPTIONS') {
      const header = request.headers.get('Access-Control-Request-Headers')?.trim().toLowerCase();
      if (request.headers.get('Access-Control-Request-Method') !== 'POST' || header !== 'content-type') {
        return output(403, { error: 'forbidden' }, true);
      }
      return output(204, null, true, {
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
    }
    if (request.method !== 'POST') return output(405, { error: 'method_not_allowed' }, true, { Allow: 'POST, OPTIONS' });
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(request.headers.get('Content-Type') ?? '')) {
      return output(415, { error: 'invalid_content_type' }, true);
    }
    if (request.headers.has('Authorization') || request.headers.has('Cookie')) return output(400, { error: 'invalid_request' }, true);
    const token = env.COZE_AGENT_API_TOKEN;
    if (typeof token !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(token)) return output(503, { error: 'not_configured' }, true);
    let message;
    try {
      if (!request.body) throw new Error('missing_body');
      const body = JSON.parse(await boundedText(request.body, MAX_REQUEST_BYTES, AbortSignal.timeout(3000)));
      if (!body || Object.keys(body).length !== 1 || typeof body.message !== 'string') throw new Error('invalid_body');
      message = body.message.trim();
      if (!message || /[\u0000-\u0008\u000B-\u001F\u007F]/u.test(message)) throw new Error('invalid_message');
      if (encode.encode(message).length > MAX_MESSAGE_BYTES) throw new RangeError('message_too_large');
    } catch (error) {
      const large = error instanceof RangeError;
      return output(large ? 413 : 400, { error: large ? 'message_too_large' : 'invalid_request' }, true);
    }

    try {
      const stub = env.GLOBAL_QUOTA.get(env.GLOBAL_QUOTA.idFromName('coze-public-demo-global'));
      const quota = await stub.fetch(QUOTA_URL, { method: 'POST', signal: AbortSignal.timeout(3000) });
      if (quota.status === 429) {
        const wait = quota.headers.get('Retry-After') ?? '60';
        return output(429, { error: 'rate_limited' }, true, { 'Retry-After': /^\d{1,5}$/.test(wait) ? wait : '60' });
      }
      if (quota.status !== 204) throw new Error('invalid_quota_response');
    } catch {
      return output(503, { error: 'temporarily_unavailable' }, true);
    }

    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(10)), b => b.toString(16).padStart(2, '0')).join('');
    const payload = JSON.stringify({
      type: 'query', session_id: sessionId,
      content: { query: { prompt: [{ type: 'text', content: { text: message } }] } },
    }).slice(0, -1) + ',"project_id":' + PROJECT_ID_JSON + '}';
    const deadline = AbortSignal.timeout(24000);
    try {
      const upstream = await fetch(UPSTREAM, {
        method: 'POST', redirect: 'error', signal: deadline,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: payload,
      });
      if (!upstream.ok || !upstream.body || !/^text\/event-stream(?:\s*;|$)/i.test(upstream.headers.get('Content-Type') ?? '')) {
        upstream.body?.cancel().catch(() => {});
        throw new Error('bad_upstream_response');
      }
      const answer = answerFromSSE(await boundedText(upstream.body, MAX_UPSTREAM_BYTES, deadline));
      if (answer.includes(token)) throw new Error('invalid_answer');
      return output(200, { answer }, true);
    } catch {
      if (deadline.aborted) return output(504, { error: 'upstream_timeout' }, true);
      return output(502, { error: 'upstream_error' }, true);
    }
  },
};
