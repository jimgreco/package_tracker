#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createAPI } from './asc-api.mjs';

const approvedTesterHash = 'a46343858cf3e5e2fda6339f7063190f295ece10dea50979932e69ec57ea4baa';
export async function verifyAudience(api, appId, testerHash = approvedTesterHash) {
  if (appId !== '6813927476') throw new Error('Unexpected PorchPong App Store app.');
  const approved = tester => tester?.type === 'betaTesters'
    && typeof tester.attributes?.email === 'string'
    && createHash('sha256').update(tester.attributes.email.trim().toLowerCase()).digest('hex') === testerHash
    && tester.attributes.inviteType !== 'PUBLIC_LINK';
  const groups = await api.all(`apps/${appId}/betaGroups?limit=200`);
  if (groups.length !== 1) throw new Error('Exactly the existing Owner group is required; no groups will be changed.');
  const group = groups[0], a = group.attributes;
  if (group.type !== 'betaGroups' || !group.id || a?.name !== 'Owner' || a.isInternalGroup !== true
    || a.hasAccessToAllBuilds !== true || !Object.hasOwn(a, 'publicLinkEnabled')
    || ![false, null].includes(a.publicLinkEnabled) || a.publicLink || a.publicLinkId) {
    throw new Error('Existing Owner group must remain internal, automatic and non-public.');
  }
  const testers = await api.all(`betaGroups/${encodeURIComponent(group.id)}/betaTesters?limit=200`);
  const all = await api.all(`betaTesters?filter[apps]=${appId}&limit=200`);
  if (testers.length !== 1 || all.length !== 1 || !testers[0].id || testers[0].id !== all[0].id
    || !approved(testers[0]) || !approved(all[0])) {
    throw new Error('PorchPong audience must be exactly Jim in Owner; no testers will be changed.');
  }
  return { groupId: group.id, testerId: testers[0].id };
}

export function nextBuildNumber(commitCount, builds) {
  if (!/^[1-9]\d*$/.test(String(commitCount))) throw new Error('Invalid git commit count.');
  // Same commit-count baseline as sibling apps; account for local builds and CI retries.
  const previous = builds.map(b => b.attributes?.version);
  if (previous.some(v => !/^[1-9]\d*$/.test(String(v)))) {
    throw new Error('An existing build has a non-integer version; choose an explicit migration before releasing.');
  }
  const number = Math.max(3, Number(commitCount), ...previous.map(v => Number(v) + 1));
  if (!Number.isSafeInteger(number)) throw new Error('Invalid build number.');
  return String(number);
}

export async function checkLatestBuild(api, appId) {
  const builds = await api.all(`builds?filter[app]=${appId}&sort=-uploadedDate&limit=1`);
  const build = builds[0];
  if (!build) throw new Error('No existing PorchPong build found.');
  const detail = await api.request('GET', `builds/${encodeURIComponent(build.id)}/buildBetaDetail`);
  return { app_id: appId, build_number: build.attributes.version,
    processing_state: build.attributes.processingState,
    internal_testing_state: detail.data?.attributes?.internalBuildState,
    uploaded_by_this_run: false };
}

export async function waitForBuild(api, appId, number, {
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeout = 20 * 60 * 1000, testerHash = approvedTesterHash,
} = {}) {
  const deadline = now() + timeout;
  while (now() < deadline) {
    const builds = await api.all(`builds?filter[app]=${appId}&filter[version]=${number}&limit=200`);
    const build = builds.find(b => b.attributes?.version === number);
    if (build) {
      const state = build.attributes.processingState;
      if (['INVALID', 'FAILED'].includes(state)) throw new Error(`Apple processing failed: ${state}.`);
      if (state === 'VALID') {
        if (build.attributes.expired) throw new Error('Uploaded build is expired.');
        const detail = await api.request('GET', `builds/${encodeURIComponent(build.id)}/buildBetaDetail`);
        const internalState = detail.data?.attributes?.internalBuildState;
        if (internalState === 'IN_BETA_TESTING') {
          if (build.attributes.buildAudienceType !== 'INTERNAL_ONLY') throw new Error('Expected an internal-only build.');
          const audience = await verifyAudience(api, appId, testerHash);
          const groupBuilds = await api.all(`betaGroups/${encodeURIComponent(audience.groupId)}/builds?limit=200`);
          const individuals = await api.all(`builds/${encodeURIComponent(build.id)}/individualTesters?limit=200`);
          if (individuals.length > 1 || individuals.some(t => t.id !== audience.testerId)) {
            throw new Error('Build has an unapproved individual tester.');
          }
          if (!groupBuilds.some(b => b.id === build.id)) {
            await sleep(30000);
            continue;
          }
          return { app_id: appId, build_number: number, build_id: build.id,
            processing_state: state, internal_testing_state: internalState, approved_group_attached: true };
        }
        if (['MISSING_EXPORT_COMPLIANCE', 'PROCESSING_EXCEPTION', 'EXPIRED'].includes(internalState)) {
          throw new Error(`Build needs attention in App Store Connect: ${internalState}.`);
        }
        console.log(`Build ${number} processed; waiting for internal testing (${internalState ?? 'unknown'}).`);
      } else console.log(`Build ${number}: ${state ?? 'unknown'}.`);
    } else console.log(`Waiting for uploaded build ${number} to appear.`);
    await sleep(30000);
  }
  throw new Error(`Timed out waiting for build ${number}. Upload may have succeeded; inspect App Store Connect before retrying.`);
}

export async function findPorchPongApp(api, bundle) {
  if (bundle !== 'com.jimgreco.doorstep') throw new Error('Expected PorchPong bundle ID.');
  const apps = await api.all(`apps?filter[bundleId]=${encodeURIComponent(bundle)}&limit=200`);
  const matches = apps.filter(app => app.attributes?.bundleId === bundle);
  if (matches.length !== 1 || !/^\d+$/.test(matches[0].id)) {
    throw new Error('Expected the existing PorchPong App Store Connect app.');
  }
  return matches[0].id;
}

export async function renameApp(api, bundle, name, locale = 'en-US') {
  if (!name || name.length > 30) throw new Error('App name must be between 1 and 30 characters.');
  const appId = await findPorchPongApp(api, bundle);
  const infos = await api.all(`apps/${appId}/appInfos?limit=200`);
  const localizations = [];
  for (const info of infos) {
    localizations.push(...await api.all(
      `appInfos/${encodeURIComponent(info.id)}/appInfoLocalizations?fields[appInfoLocalizations]=locale,name&limit=200`,
    ));
  }
  const matches = localizations.filter(item => item.attributes?.locale === locale);
  if (matches.length !== 1) throw new Error(`Expected one ${locale} app info localization.`);
  if (matches[0].attributes?.name === name) return { app_id: appId, name, locale, changed: false };
  const result = await api.request('PATCH', `appInfoLocalizations/${encodeURIComponent(matches[0].id)}`, {
    data: { type: 'appInfoLocalizations', id: matches[0].id, attributes: { name } },
  });
  if (result.data?.attributes?.name !== name) throw new Error('App Store Connect did not confirm the new app name.');
  return { app_id: appId, name, locale, changed: true };
}

async function main() {
  const api = createAPI();
  const appId = await findPorchPongApp(api, process.env.IOS_BUNDLE_ID);
  if (process.argv[2] === 'number') {
    const builds = await api.all(`builds?filter[app]=${appId}&fields[builds]=version&limit=200`);
    const number = nextBuildNumber(process.env.COMMIT_COUNT, builds);
    appendFileSync(process.env.GITHUB_ENV, `IOS_BUILD_NUMBER=${number}\n`);
    console.log(`PorchPong build number: ${number}`);
  } else if (process.argv[2] === 'audience') {
    await verifyAudience(api, appId);
    console.log('Existing Owner group verified: exactly Jim, internal-only, no public links.');
  } else if (process.argv[2] === 'rename') {
    const result = await renameApp(api, process.env.IOS_BUNDLE_ID, process.argv[3], process.argv[4]);
    console.log(`${result.name} is registered for ${result.locale}.`);
  } else if (process.argv[2] === 'check') {
    const result = await checkLatestBuild(api, appId);
    writeFileSync('.build-report/verification-only.json', JSON.stringify(result, null, 2) + '\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Verification-only run: Apple access succeeded. Existing build **${result.build_number}**: ` +
      `${result.processing_state}, ${result.internal_testing_state}. No build uploaded by this run.\n`);
    console.log(`Apple access verified; existing build ${result.build_number}: ${result.processing_state}, ${result.internal_testing_state}. No new upload.`);
  } else if (process.argv[2] === 'wait') {
    const number = process.env.IOS_BUILD_NUMBER;
    if (!/^[1-9]\d*$/.test(number ?? '')) throw new Error('Missing build number.');
    const result = await waitForBuild(api, appId, number);
    result.commit = process.env.GITHUB_SHA;
    writeFileSync('.build-report/testflight.json', JSON.stringify(result, null, 2) + '\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### PorchPong TestFlight\n\nBuild **${number}** (${result.commit}) processed and is **IN_BETA_TESTING** for internal testers.\n\n` +
      `[App Store Connect](https://appstoreconnect.apple.com/apps/${appId}/testflight/ios)\n\n` +
      'No external tester invitations or App Store release were performed.\n');
  } else throw new Error('Expected number, rename, check or wait command.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
