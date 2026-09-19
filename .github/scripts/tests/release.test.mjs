import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAPI, makeToken } from '../asc-api.mjs';
import { ensureProfile } from '../ensure-app-store-profile.mjs';
import { nextBuildNumber, waitForBuild, checkLatestBuild, findDoorstepApp } from '../testflight.mjs';

test('verification-only Apple check reads existing state without attributing an upload', async () => {
  const api = {
    all: async path => {
      assert.match(path, /sort=-uploadedDate/);
      return [{ id: 'build-31', attributes: { version: '31', processingState: 'VALID' } }];
    },
    request: async (method, path) => {
      assert.equal(method, 'GET');
      assert.equal(path, 'builds/build-31/buildBetaDetail');
      return { data: { attributes: { internalBuildState: 'IN_BETA_TESTING' } } };
    },
  };
  assert.deepEqual(await checkLatestBuild(api, '1234567890'), {
    app_id: '1234567890', build_number: '31', processing_state: 'VALID',
    internal_testing_state: 'IN_BETA_TESTING', uploaded_by_this_run: false,
  });
  await assert.rejects(checkLatestBuild({ all: async () => [] }, '1234567890'), /No existing/);
});

test('API token uses a valid ES256 signature, issuer, audience and bounded expiry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doorstep-ci-key-test-'));
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const path = join(dir, 'synthetic.p8');
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const token = makeToken({ APP_STORE_CONNECT_KEY_ID: 'TEST', APP_STORE_CONNECT_ISSUER_ID: 'test-issuer',
      APP_STORE_CONNECT_API_KEY_PATH: path }, 1000);
    const [header, body, signature] = token.split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'ES256');
    assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url')), {
      iss: 'test-issuer', aud: 'appstoreconnect-v1', iat: 1000, exp: 2200,
    });
    assert(verify('sha256', Buffer.from(`${header}.${body}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  } finally { rmSync(dir, { recursive: true }); }
});

test('pagination reads every Apple page and never sends credentials to another origin', async () => {
  const urls = [];
  const api = createAPI({ token: () => 'synthetic', transport: async (url, options) => {
    urls.push(String(url));
    assert.equal(options.redirect, 'error');
    return Response.json({ data: [urls.length], links: { next: urls.length === 1
      ? 'https://api.appstoreconnect.apple.com/v1/builds?cursor=2' : null } });
  } });
  assert.deepEqual(await api.all('builds'), [1, 2]);
  await assert.rejects(api.request('GET', 'https://example.com/v1/builds'), /outside the API/);
  assert.equal(urls.length, 2);
});

test('API errors do not expose response bodies or credentials', async () => {
  const api = createAPI({ token: () => 'synthetic', transport: async () => new Response('private response', { status: 403 }) });
  await assert.rejects(api.request('GET', 'apps'), error => error.message.endsWith('HTTP 403') && !error.message.includes('private'));
});

test('CI numbering handles the pre-GitHub builds, commit count, retries and remote ordering', () => {
  const build = version => ({ attributes: { version } });
  assert.equal(nextBuildNumber(1, []), '3');
  assert.equal(nextBuildNumber(1, [build('1'), build('2')]), '3');
  assert.equal(nextBuildNumber(50, [build('3')]), '50');
  assert.equal(nextBuildNumber(50, [build('51'), build('2'), build('50')]), '52');
  assert.throws(() => nextBuildNumber('x', []), /Invalid/);
  assert.throws(() => nextBuildNumber(1, [build('1.2')]), /non-integer/);
});

function profileAPI({ existing = false, wrongCertificate = false, wrongBundle = false, expired = false } = {}) {
  const calls = [];
  const attributes = { name: 'Doorstep CI', profileState: 'ACTIVE', profileType: 'IOS_APP_STORE', expirationDate: '2099-01-01',
    profileContent: Buffer.from('synthetic-profile').toString('base64') };
  const api = {
    all: async path => {
      if (path.startsWith('bundleIds?')) return [{ id: 'bundle', attributes: { identifier: wrongBundle ? 'com.other' : 'com.jimgreco.doorstep' } }];
      if (path.startsWith('certificates?')) return [{ id: 'cert', attributes: { certificateType: 'DISTRIBUTION',
        activated: true, expirationDate: expired ? '2000-01-01' : '2099-01-01',
        certificateContent: Buffer.from(wrongCertificate ? 'wrong' : 'synthetic-cert').toString('base64') } }];
      return existing ? [{ id: 'existing', attributes, relationships: {
        bundleId: { data: { id: 'bundle' } }, certificates: { data: [{ id: 'cert' }] },
      } }] : [];
    },
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return { data: { id: 'created', attributes } };
    },
  };
  return { api, calls };
}
const profileOptions = { bundleId: 'com.jimgreco.doorstep', profileName: 'Doorstep CI', certificate: Buffer.from('synthetic-cert') };

test('profile creation binds only the exact registered bundle and imported distribution certificate', async () => {
  const { api, calls } = profileAPI();
  assert.equal((await ensureProfile(api, profileOptions)).toString(), 'synthetic-profile');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'profiles');
  assert.equal(calls[0].body.data.attributes.profileType, 'IOS_APP_STORE');
  assert.deepEqual(calls[0].body.data.relationships, {
    bundleId: { data: { type: 'bundleIds', id: 'bundle' } },
    certificates: { data: [{ type: 'certificates', id: 'cert' }] },
  });
});

test('matching profile is reused without mutating external resources', async () => {
  const { api, calls } = profileAPI({ existing: true });
  await ensureProfile(api, profileOptions);
  assert.equal(calls.length, 0);
});

test('wrong bundle, wrong certificate and expired certificate fail before profile creation', async () => {
  for (const options of [{ wrongBundle: true }, { wrongCertificate: true }, { expired: true }]) {
    const { api, calls } = profileAPI(options);
    await assert.rejects(ensureProfile(api, profileOptions));
    assert.equal(calls.length, 0);
  }
});

test('upload verification waits for exact build, processing and internal testing readiness', async () => {
  let clock = 0, count = 0;
  const api = {
    all: async () => {
      count++;
      if (count === 1) return [{ id: 'old', attributes: { version: '2', processingState: 'VALID' } }];
      return [{ id: 'new', attributes: { version: '3', processingState: count === 2 ? 'PROCESSING' : 'VALID' } }];
    },
    request: async () => ({ data: { attributes: { internalBuildState: count === 3 ? 'READY_FOR_BETA_TESTING' : 'IN_BETA_TESTING' } } }),
  };
  const result = await waitForBuild(api, 'app', '3', { now: () => clock, sleep: async ms => { clock += ms; } });
  assert.equal(result.build_id, 'new');
  assert.equal(result.internal_testing_state, 'IN_BETA_TESTING');
  assert.equal(count, 4);
});

test('processing failure, compliance blockage and timeout never claim release success', async () => {
  for (const processingState of ['INVALID', 'FAILED']) {
    await assert.rejects(waitForBuild({ all: async () => [{ attributes: { version: '3', processingState } }] }, 'app', '3'), /processing failed/);
  }
  await assert.rejects(waitForBuild({
    all: async () => [{ id: 'b', attributes: { version: '3', processingState: 'VALID' } }],
    request: async () => ({ data: { attributes: { internalBuildState: 'MISSING_EXPORT_COMPLIANCE' } } }),
  }, 'app', '3'), /needs attention/);
  let clock = 0;
  await assert.rejects(waitForBuild({ all: async () => [] }, 'app', '3', {
    now: () => clock, sleep: async ms => { clock += ms; }, timeout: 60000,
  }), /Upload may have succeeded/);
});


test('app lookup binds release to the unique Doorstep bundle before numbering or upload', async () => {
  const app = { id: '1234567890', attributes: { bundleId: 'com.jimgreco.doorstep' } };
  const api = { all: async path => {
    assert.match(path, /filter\[bundleId\]=com.jimgreco.doorstep/);
    return [app, { id: 'other', attributes: { bundleId: 'com.other' } }];
  } };
  assert.equal(await findDoorstepApp(api, 'com.jimgreco.doorstep'), app.id);
  await assert.rejects(findDoorstepApp(api, 'com.other'), /Expected Doorstep bundle/);
  for (const apps of [[], [app, app], [{...app, id: undefined}]]) {
    await assert.rejects(findDoorstepApp({all: async () => apps}, 'com.jimgreco.doorstep'), /existing Doorstep/);
  }
});
