"""Keep an explicit allowlist of release evidence locally, never signing assets."""
import os
from pathlib import Path
import shutil

os.umask(0o077)
dest = Path.home() / 'Library/Logs/PorchPongReleases' / (os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT']) / os.environ['GITHUB_JOB']
dest.mkdir(parents=True, exist_ok=True)
for name in ('release.json', 'testflight.json', 'verification-only.json',
             'ci-archive.log', 'ci-export.log', 'ci-upload.log'):
    source = Path('.build-report') / name
    if source.is_file():
        shutil.copy2(source, dest / name)
temp = Path(os.environ['RUNNER_TEMP'])
ipa = temp / 'export/PorchPong.ipa'
if ipa.is_file():
    shutil.copy2(ipa, dest / ipa.name)
archive = temp / 'PorchPong.xcarchive'
if archive.is_dir():
    shutil.copytree(archive, dest / archive.name, dirs_exist_ok=True)
with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
    summary.write(f'\nRelease evidence saved on the Mac: `{dest}`.\n')
print(f'Release evidence saved locally: {dest}')
