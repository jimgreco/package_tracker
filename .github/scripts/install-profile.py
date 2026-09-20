"""Validate the downloaded App Store profile before installing it on a CI runner."""
from datetime import datetime, timezone
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

profile = Path(os.environ['RUNNER_TEMP']) / 'doorstep.mobileprovision'
data = plistlib.loads(subprocess.check_output(['security', 'cms', '-D', '-i', str(profile)]))
assert data['TeamIdentifier'] == ['V6JPQCD336']
assert data['Entitlements']['application-identifier'] == 'V6JPQCD336.com.jimgreco.doorstep'
assert data['Entitlements'].get('get-task-allow') is False
assert data['Entitlements'].get('aps-environment') == 'production', 'Profile must enable production push notifications'
assert not data.get('ProvisionedDevices') and not data.get('ProvisionsAllDevices')
assert data['ExpirationDate'].replace(tzinfo=timezone.utc) > datetime.now(timezone.utc)
assert (Path(os.environ['RUNNER_TEMP']) / 'doorstep-cert.der').read_bytes() in data['DeveloperCertificates']
directory = Path.home() / 'Library/MobileDevice/Provisioning Profiles'
directory.mkdir(parents=True, exist_ok=True)
destination = directory / f"{data['UUID']}.mobileprovision"
with open(os.environ['GITHUB_ENV'], 'a') as output:
    output.write(f"IOS_PROFILE_NAME={data['Name']}\nIOS_PROFILE_PATH={destination}\n")
shutil.copyfile(profile, destination)
print('Validated PorchPong App Store profile and matching distribution certificate.')
