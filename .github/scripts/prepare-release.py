"""Generate CI-only signing overrides and validate the exact release identity."""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys

BUNDLE = 'com.jimgreco.doorstep'
TEAM = 'V6JPQCD336'

if sys.argv[1] == 'project':
    # JSON is valid YAML. Local development retains automatic signing.
    config = {
        'include': ['project.yml'],
        'settings': {'base': {'CURRENT_PROJECT_VERSION': os.environ['IOS_BUILD_NUMBER']}},
        'targets': {'Doorstep': {'settings': {'configs': {'Release': {
            'CODE_SIGN_STYLE': 'Manual', 'DEVELOPMENT_TEAM': TEAM,
            'CODE_SIGN_IDENTITY': 'Apple Distribution',
            'PROVISIONING_PROFILE_SPECIFIER': os.environ['IOS_PROFILE_NAME'],
        }}}}},
    }
    Path('ios/ci-project.yml').write_text(json.dumps(config, indent=2))
    options = {'method': 'app-store-connect', 'destination': 'export', 'teamID': TEAM,
               'signingStyle': 'manual', 'signingCertificate': 'Apple Distribution',
               'provisioningProfiles': {BUNDLE: os.environ['IOS_PROFILE_NAME']},
               'manageAppVersionAndBuildNumber': False, 'stripSwiftSymbols': True, 'uploadSymbols': True}
    with (Path(os.environ['RUNNER_TEMP']) / 'ExportOptions.plist').open('wb') as output:
        plistlib.dump(options, output)
elif sys.argv[1] == 'archive':
    app = Path(os.environ['RUNNER_TEMP']) / 'Doorstep.xcarchive/Products/Applications/Doorstep.app'
    with (app / 'Info.plist').open('rb') as source:
        info = plistlib.load(source)
    assert info['CFBundleIdentifier'] == BUNDLE
    assert info['CFBundleVersion'] == os.environ['IOS_BUILD_NUMBER']
    assert BUNDLE in [s for t in info['CFBundleURLTypes'] for s in t['CFBundleURLSchemes']]
    assert info['ITSAppUsesNonExemptEncryption'] is False
    assert info['DoorstepAPIOrigin'] == 'https://packages.jim-greco.com'
    assert not info.get('NSAppTransportSecurity'), 'Release must not contain transport exceptions.'
    assert info['MinimumOSVersion'] == '18.0'
    binary = (app / 'Doorstep').read_bytes()
    assert b'--fixture' not in binary and b'Sample household' not in binary, 'Fixtures must be absent from Release.'
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    Path('.build-report').mkdir(exist_ok=True)
    Path('.build-report/release.json').write_text(json.dumps({
        'commit': os.environ['GITHUB_SHA'], 'bundle': BUNDLE,
        'version': info['CFBundleShortVersionString'], 'build': info['CFBundleVersion'],
    }, indent=2) + '\n')
else:
    raise SystemExit('Expected project or archive.')
