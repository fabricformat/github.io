const TOKEN_PATH = '/api/coze-token';
const DEFAULT_ORIGIN = 'https://fabricformat.github.io';
const COZE_TOKEN_URL = 'https://api.coze.cn/api/permission/oauth2/token';
const TOKEN_TTL = 900;
const encoder = new TextEncoder();

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function equalSecret(actual, expected) {
  const [left, right] = await Promise.all(
    [actual, expected].map(secret => crypto.subtle.digest('SHA-256', encoder.encode(secret)))
  );
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(left, right);
  }
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

function validOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && origin === url.origin;
  } catch {
    return false;
  }
}

function validCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(code) && new Set(code).size >= 12;
}

function response(status, payload, origin, extra = {}) {
  const headers = {
    'Cache-Control': 'no-store, private',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    ...extra,
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(payload === null ? null : JSON.stringify(payload), { status, headers });
}

async function signAssertion(env) {
  const pem = env.COZE_PRIVATE_KEY.trim().match(/^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/);
  if (!pem) throw new Error('Invalid key format');
  const binary = Uint8Array.from(atob(pem[1].replace(/\s/g, '')), char => char.charCodeAt(0));
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const key = await crypto.subtle.importKey('pkcs8', binary, algorithm, false, ['sign']);
  if (key.algorithm.modulusLength < 2048) throw new Error('Invalid key size');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: env.COZE_PUBLIC_KEY_ID };
  const payload = {
    iss: env.COZE_CLIENT_ID,
    aud: 'api.coze.cn',
    iat: now,
    exp: now + 60,
    jti: base64url(crypto.getRandomValues(new Uint8Array(32))),
    session_name: 'fabricformat-demo-owner',
    session_context: { connector_info: { connector_id: '2001' } },
  };
  const unsigned = [header, payload].map(part => base64url(encoder.encode(JSON.stringify(part)))).join('.');
  const signature = await crypto.subtle.sign(algorithm.name, key, encoder.encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== TOKEN_PATH || url.search) return response(404, { error: 'Not found' });

    const origin = env.PAGES_ORIGIN ?? DEFAULT_ORIGIN;
    if (!validOrigin(origin)) return response(503, { error: 'Service unavailable' });
    if (request.headers.get('Origin') !== origin) return response(403, { error: 'Forbidden' });

    if (request.method === 'OPTIONS') {
      const headers = request.headers.get('Access-Control-Request-Headers')
        ?.toLowerCase().split(',').map(header => header.trim());
      if (request.headers.get('Access-Control-Request-Method') !== 'POST' ||
          headers?.length !== 1 || headers[0] !== 'authorization') {
        return response(403, { error: 'Forbidden' }, origin);
      }
      return response(204, null, origin, {
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Authorization',
      });
    }

    if (request.method !== 'POST') {
      return response(405, { error: 'Method not allowed' }, origin, { Allow: 'POST, OPTIONS' });
    }

    if (!validCode(env.DEMO_ACCESS_CODE) ||
        ![env.COZE_CLIENT_ID, env.COZE_PUBLIC_KEY_ID].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)) ||
        typeof env.COZE_PRIVATE_KEY !== 'string' || !env.COZE_PRIVATE_KEY.trim()) {
      return response(503, { error: 'Service unavailable' }, origin);
    }

    const match = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/i);
    if (!match || !await equalSecret(match[1], env.DEMO_ACCESS_CODE)) {
      return response(401, { error: 'Unauthorized' }, origin);
    }
    if (request.body !== null) return response(400, { error: 'Unexpected request body' }, origin);

    try {
      const { success } = await env.TOKEN_RATE_LIMIT.limit({ key: 'demo-owner-token' });
      if (success === false) {
        return response(429, { error: 'Too many token requests' }, origin, { 'Retry-After': '60' });
      }
      if (success !== true) throw new Error('Unexpected rate limit result');
    } catch {
      return response(503, { error: 'Service unavailable' }, origin);
    }

    let assertion;
    try {
      assertion = await signAssertion(env);
    } catch {
      return response(503, { error: 'Service unavailable' }, origin);
    }

    try {
      const upstream = await fetch(COZE_TOKEN_URL, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${assertion}` },
        body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', duration_seconds: TOKEN_TTL }),
        signal: AbortSignal.timeout(4000),
      });
      if (!upstream.ok) throw new Error('Exchange failed');
      const { access_token, expires_in } = await upstream.json();
      const now = Math.floor(Date.now() / 1000);
      if (typeof access_token !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(access_token) ||
          !Number.isSafeInteger(expires_in) || expires_in <= now || expires_in > now + TOKEN_TTL + 60) {
        throw new Error('Unexpected exchange result');
      }
      return response(200, { access_token, expires_in }, origin);
    } catch {
      return response(502, { error: 'Could not issue demo token' }, origin);
    }
  },
};
