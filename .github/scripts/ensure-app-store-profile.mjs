#!/usr/bin/env node
// Adapted from workouts/.github/scripts/ensure-app-store-profile.mjs.
// Doorstep has one app target with Apple push notifications.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createAPI } from './asc-api.mjs';

export async function ensureProfile(api, { bundleId, profileName, certificate, now = Date.now() }) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const bundles = await api.all(`bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&filter[platform]=IOS&limit=200`);
  const matching = bundles.filter(b => b.attributes?.identifier === bundleId);
  if (matching.length !== 1) throw new Error(`Expected the existing registered bundle ${bundleId}.`);
  const bundle = matching[0];
  const certificates = await api.all('certificates?fields[certificates]=certificateType,activated,expirationDate,certificateContent&limit=200');
  const cert = certificates.find(c => ['DISTRIBUTION', 'IOS_DISTRIBUTION'].includes(c.attributes?.certificateType)
    && c.attributes.activated !== false && Date.parse(c.attributes.expirationDate) > now
    && c.attributes.certificateContent
    && hash(Buffer.from(c.attributes.certificateContent, 'base64')) === hash(certificate));
  if (!cert) throw new Error('IOS_DIST_CERT_P12 does not match an active, unexpired distribution certificate.');
  const capabilities = await api.all(`bundleIds/${bundle.id}/bundleIdCapabilities`);
  const addedPush = !capabilities.some(c => c.attributes?.capabilityType === 'PUSH_NOTIFICATIONS');
  if (addedPush) {
    await api.request('POST', 'bundleIdCapabilities', { data: {
      type: 'bundleIdCapabilities', attributes: { capabilityType: 'PUSH_NOTIFICATIONS' },
      relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } } }
    }});
  }
  const profiles = await api.all(`profiles?filter[name]=${encodeURIComponent(profileName)}&filter[profileType]=IOS_APP_STORE&filter[profileState]=ACTIVE&include=bundleId,certificates&limit=200`);
  let profile = !addedPush && profiles.find(p => p.attributes?.profileState === 'ACTIVE'
    && p.attributes.name === profileName && p.attributes.profileType === 'IOS_APP_STORE'
    && Date.parse(p.attributes.expirationDate) > now
    && p.relationships?.bundleId?.data?.id === bundle.id
    && p.relationships?.certificates?.data?.some(c => c.id === cert.id));
  if (!profile) {
    const response = await api.request('POST', 'profiles', { data: {
      type: 'profiles', attributes: { name: profileName, profileType: 'IOS_APP_STORE' },
      relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } },
        certificates: { data: [{ type: 'certificates', id: cert.id }] } },
    } });
    profile = response.data;
  }
  if (!profile?.attributes?.profileContent) {
    if (!profile?.id) throw new Error('App Store Connect did not return a profile.');
    profile = (await api.request('GET', `profiles/${encodeURIComponent(profile.id)}`)).data;
  }
  if (!profile?.attributes?.profileContent) throw new Error('App Store Connect did not return profileContent.');
  return Buffer.from(profile.attributes.profileContent, 'base64');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 8) throw new Error('Expected --bundle-id, --profile-name, --certificate-der, --output.');
  const options = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  for (const key of ['--bundle-id', '--profile-name', '--certificate-der', '--output']) {
    if (!options[key]) throw new Error(`Missing ${key}`);
  }
  const bytes = await ensureProfile(createAPI(), {
    bundleId: options['--bundle-id'], profileName: options['--profile-name'],
    certificate: readFileSync(options['--certificate-der']),
  });
  writeFileSync(options['--output'], bytes, { mode: 0o600 });
  console.log('App Store provisioning profile prepared.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
