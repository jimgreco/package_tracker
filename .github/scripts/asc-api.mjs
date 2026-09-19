// App Store Connect JWT/API pattern shared with Forge and Ritual Cue.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = 'https://api.appstoreconnect.apple.com/v1/';

export function makeToken(env = process.env, now = Math.floor(Date.now() / 1000)) {
  for (const name of ['APP_STORE_CONNECT_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID', 'APP_STORE_CONNECT_API_KEY_PATH']) {
    if (!env[name]) throw new Error(`Missing ${name}`);
  }
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'ES256', kid: env.APP_STORE_CONNECT_KEY_ID, typ: 'JWT' })}.${encode({
    iss: env.APP_STORE_CONNECT_ISSUER_ID, aud: 'appstoreconnect-v1', iat: now, exp: now + 1200,
  })}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: createPrivateKey(readFileSync(env.APP_STORE_CONNECT_API_KEY_PATH)), dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${signature.toString('base64url')}`;
}

export function createAPI({ token = makeToken, transport = fetch } = {}) {
  async function request(method, path, body) {
    const url = new URL(path, BASE);
    if (url.origin !== new URL(BASE).origin || !url.pathname.startsWith('/v1/')) {
      throw new Error('Refusing an App Store Connect URL outside the API.');
    }
    const response = await transport(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token()}`, Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    // Do not dump response bodies, tokens, profile content or credentials into CI logs.
    if (!response.ok) throw new Error(`App Store Connect ${method} ${url.pathname}: HTTP ${response.status}`);
    return response.status === 204 ? {} : response.json();
  }
  async function all(path) {
    const result = [], seen = new Set();
    while (path) {
      if (seen.has(path)) throw new Error('Repeated App Store Connect pagination URL.');
      seen.add(path);
      const page = await request('GET', path);
      if (!Array.isArray(page.data)) throw new Error('Missing App Store Connect data array.');
      result.push(...page.data);
      path = page.links?.next;
    }
    return result;
  }
  return { request, all };
}
