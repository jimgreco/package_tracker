#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createAPI } from './asc-api.mjs';

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
  if (!build) throw new Error('No existing Doorstep build found.');
  const detail = await api.request('GET', `builds/${encodeURIComponent(build.id)}/buildBetaDetail`);
  return { app_id: appId, build_number: build.attributes.version,
    processing_state: build.attributes.processingState,
    internal_testing_state: detail.data?.attributes?.internalBuildState,
    uploaded_by_this_run: false };
}

export async function waitForBuild(api, appId, number, {
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeout = 20 * 60 * 1000,
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
          return { app_id: appId, build_number: number, build_id: build.id,
            processing_state: state, internal_testing_state: internalState };
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

export async function findDoorstepApp(api, bundle) {
  if (bundle !== 'com.jimgreco.doorstep') throw new Error('Expected Doorstep bundle ID.');
  const apps = await api.all(`apps?filter[bundleId]=${encodeURIComponent(bundle)}&limit=200`);
  const matches = apps.filter(app => app.attributes?.bundleId === bundle);
  if (matches.length !== 1 || !/^\d+$/.test(matches[0].id)) {
    throw new Error('Expected the existing Doorstep App Store Connect app.');
  }
  return matches[0].id;
}

async function main() {
  const api = createAPI();
  const appId = await findDoorstepApp(api, process.env.IOS_BUNDLE_ID);
  if (process.argv[2] === 'number') {
    const builds = await api.all(`builds?filter[app]=${appId}&fields[builds]=version&limit=200`);
    const number = nextBuildNumber(process.env.COMMIT_COUNT, builds);
    appendFileSync(process.env.GITHUB_ENV, `IOS_BUILD_NUMBER=${number}\n`);
    console.log(`Doorstep build number: ${number}`);
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
      `### Doorstep TestFlight\n\nBuild **${number}** (${result.commit}) processed and is **IN_BETA_TESTING** for internal testers.\n\n` +
      `[App Store Connect](https://appstoreconnect.apple.com/apps/${appId}/testflight/ios)\n\n` +
      'No external tester invitations or App Store release were performed.\n');
  } else throw new Error('Expected number, check or wait command.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
