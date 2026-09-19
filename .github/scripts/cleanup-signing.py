"""Remove only this job's signing assets and restore the Mac's keychain list."""
import json
import os
from pathlib import Path
import subprocess

temp = Path(os.environ['RUNNER_TEMP']).resolve()
snapshot = temp / 'doorstep-original-keychains.json'
if snapshot.exists():
    keys = json.loads(snapshot.read_text())
    subprocess.run(['security', 'list-keychains', '-d', 'user', '-s', *keys], check=True)
    snapshot.unlink()
keychain = temp / 'doorstep-signing.keychain-db'
if keychain.exists():
    subprocess.run(['security', 'delete-keychain', str(keychain)], check=True)
for name in ('APP_STORE_CONNECT_API_KEY_PATH', 'IOS_PROFILE_PATH'):
    value = os.environ.get(name)
    if not value:
        continue
    path = Path(value).resolve()
    allowed = temp if name == 'APP_STORE_CONNECT_API_KEY_PATH' else Path.home() / 'Library/MobileDevice/Provisioning Profiles'
    if not path.is_relative_to(allowed):
        raise RuntimeError('Refusing to remove a signing asset outside its job location.')
    path.unlink(missing_ok=True)
for name in ('doorstep-distribution.p12', 'doorstep-cert.pem', 'doorstep-cert.der',
             'doorstep.mobileprovision'):
    (temp / name).unlink(missing_ok=True)
print('Temporary signing assets cleaned; existing Mac credentials preserved.')
