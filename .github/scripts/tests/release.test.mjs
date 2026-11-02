import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAPI, makeToken } from '../asc-api.mjs';
import { ensureProfile } from '../ensure-app-store-profile.mjs';
import { nextBuildNumber, waitForBuild, checkLatestBuild, findPorchPongApp, renameApp, verifyAudience } from '../testflight.mjs';

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
  const attributes = { name: 'PorchPong CI', profileState: 'ACTIVE', profileType: 'IOS_APP_STORE', expirationDate: '2099-01-01',
    profileContent: Buffer.from('synthetic-profile').toString('base64') };
  const api = {
    all: async path => {
      if (path.startsWith('bundleIds?')) return [{ id: 'bundle', attributes: { identifier: wrongBundle ? 'com.other' : 'com.jimgreco.doorstep' } }];
      if (path.endsWith('/bundleIdCapabilities')) return [{attributes:{capabilityType:'PUSH_NOTIFICATIONS'}}];
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
const profileOptions = { bundleId: 'com.jimgreco.doorstep', profileName: 'PorchPong CI', certificate: Buffer.from('synthetic-cert') };

test('missing profile stops without creating signing assets', async () => {
  const { api, calls } = profileAPI();
  await assert.rejects(ensureProfile(api, profileOptions), /no profile will be created/);
  assert.equal(calls.length, 0);
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

const testerHash = createHash('sha256').update('jim@example.invalid').digest('hex');
function audienceFixture() {
  const tester = { type: 'betaTesters', id: 'jim', attributes: { email: ' Jim@Example.Invalid ', inviteType: 'EMAIL' } };
  const routes = {
    'apps/6813927476/betaGroups?limit=200': [{ type: 'betaGroups', id: 'owner', attributes: {
      name: 'Owner', isInternalGroup: true, hasAccessToAllBuilds: true, publicLinkEnabled: false,
    } }],
    'betaGroups/owner/betaTesters?limit=200': [structuredClone(tester)],
    'betaTesters?filter[apps]=6813927476&limit=200': [structuredClone(tester)],
    'betaGroups/owner/builds?limit=200': [{ id: 'new' }],
    'builds/new/individualTesters?limit=200': [],
  };
  const all = async path => { assert.ok(routes[path], `Unexpected path: ${path}`); return routes[path]; };
  return { routes, all };
}
test('exact existing Owner audience passes and all broadened or changed scopes fail', async () => {
  const good = audienceFixture();
  assert.equal((await verifyAudience(good, '6813927476', testerHash)).groupId, 'owner');
  for (const change of ['app', 'extra-group', 'external', 'public', 'missing-public', 'automatic', 'extra-tester', 'replacement', 'app-extra', 'app-identity']) {
    const f = audienceFixture(), group = f.routes['apps/6813927476/betaGroups?limit=200'][0];
    if (change === 'extra-group') f.routes['apps/6813927476/betaGroups?limit=200'].push(structuredClone(group));
    if (change === 'external') group.attributes.isInternalGroup = false;
    if (change === 'public') group.attributes.publicLinkEnabled = true;
    if (change === 'missing-public') delete group.attributes.publicLinkEnabled;
    if (change === 'automatic') group.attributes.hasAccessToAllBuilds = false;
    if (change === 'extra-tester') f.routes['betaGroups/owner/betaTesters?limit=200'].push({ id: 'other' });
    if (change === 'replacement') f.routes['betaGroups/owner/betaTesters?limit=200'][0].attributes.email = 'other@example.invalid';
    if (change === 'app-extra') f.routes['betaTesters?filter[apps]=6813927476&limit=200'].push({ id: 'other' });
    if (change === 'app-identity') f.routes['betaTesters?filter[apps]=6813927476&limit=200'][0].id = 'different';
    await assert.rejects(verifyAudience(f, change === 'app' ? 'other-app' : '6813927476', testerHash), change);
  }
});

test('upload verification waits for exact build, processing and internal testing readiness', async () => {
  let clock = 0, count = 0;
  const audience = audienceFixture();
  const api = {
    all: async path => {
      if (!path.startsWith('builds?')) return audience.all(path);
      count++;
      if (count === 1) return [{ id: 'old', attributes: { version: '2', processingState: 'VALID' } }];
      return [{ id: 'new', attributes: { version: '3', processingState: count === 2 ? 'PROCESSING' : 'VALID', buildAudienceType: 'INTERNAL_ONLY' } }];
    },
    request: async () => ({ data: { attributes: { internalBuildState: count === 3 ? 'READY_FOR_BETA_TESTING' : 'IN_BETA_TESTING' } } }),
  };
  const result = await waitForBuild(api, '6813927476', '3', { now: () => clock, sleep: async ms => { clock += ms; }, testerHash });
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


test('app lookup binds release to the unique PorchPong bundle before numbering or upload', async () => {
  const app = { id: '1234567890', attributes: { bundleId: 'com.jimgreco.doorstep' } };
  const api = { all: async path => {
    assert.match(path, /filter\[bundleId\]=com.jimgreco.doorstep/);
    return [app, { id: 'other', attributes: { bundleId: 'com.other' } }];
  } };
  assert.equal(await findPorchPongApp(api, 'com.jimgreco.doorstep'), app.id);
  await assert.rejects(findPorchPongApp(api, 'com.other'), /Expected PorchPong bundle/);
  for (const apps of [[], [app, app], [{...app, id: undefined}]]) {
    await assert.rejects(findPorchPongApp({all: async () => apps}, 'com.jimgreco.doorstep'), /existing PorchPong/);
  }
});

test('app rename updates only the exact English localization and is idempotent', async () => {
  const calls = [];
  const app = { id: '1234567890', attributes: { bundleId: 'com.jimgreco.doorstep' } };
  const localization = { id: 'localization', attributes: { locale: 'en-US', name: 'Doorstep Package Tracker' } };
  const api = {
    all: async path => {
      if (path.startsWith('apps?')) return [app];
      if (path.startsWith('apps/1234567890/appInfos?')) return [{ id: 'info' }];
      if (path.startsWith('appInfos/info/appInfoLocalizations?')) return [localization];
      throw new Error(`Unexpected path: ${path}`);
    },
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return { data: { ...localization, attributes: { ...localization.attributes, name: body.data.attributes.name } } };
    },
  };
  assert.deepEqual(await renameApp(api, 'com.jimgreco.doorstep', 'PorchPong'), {
    app_id: app.id, name: 'PorchPong', locale: 'en-US', changed: true,
  });
  assert.deepEqual(calls, [{ method: 'PATCH', path: 'appInfoLocalizations/localization', body: {
    data: { type: 'appInfoLocalizations', id: 'localization', attributes: { name: 'PorchPong' } },
  } }]);
  localization.attributes.name = 'PorchPong';
  assert.equal((await renameApp(api, 'com.jimgreco.doorstep', 'PorchPong')).changed, false);
  assert.equal(calls.length, 1);
});

test('missing push capability stops without changing Apple configuration', async () => {
  const { api, calls } = profileAPI({ existing: true });
  const original = api.all;
  api.all = path => path.endsWith('/bundleIdCapabilities') ? Promise.resolve([]) : original(path);
  await assert.rejects(ensureProfile(api, profileOptions), /no Apple configuration/);
  assert.equal(calls.length, 0);
});


test('post-upload verification rejects broadened builds and waits for the approved group', async () => {
  for (const change of ['public-build', 'extra-individual', 'other-individual', 'missing-group']) {
    const f = audienceFixture();
    let clock = 0;
    if (change === 'extra-individual') f.routes['builds/new/individualTesters?limit=200'] = [{ id: 'jim' }, { id: 'other' }];
    if (change === 'other-individual') f.routes['builds/new/individualTesters?limit=200'] = [{ id: 'other' }];
    if (change === 'missing-group') f.routes['betaGroups/owner/builds?limit=200'] = [];
    const api = {
      all: path => path.startsWith('builds?') ? Promise.resolve([{ id: 'new', attributes: {
        version: '3', processingState: 'VALID', buildAudienceType: change === 'public-build' ? 'APP_STORE_ELIGIBLE' : 'INTERNAL_ONLY',
      } }]) : f.all(path),
      request: async () => ({ data: { attributes: { internalBuildState: 'IN_BETA_TESTING' } } }),
    };
    await assert.rejects(waitForBuild(api, '6813927476', '3', {
      testerHash, now: () => clock, sleep: async ms => { clock += ms; }, timeout: 60000,
    }), change === 'missing-group' ? /Upload may have succeeded/ : change === 'public-build' ? /internal-only/ : /unapproved individual/);
  }
});
