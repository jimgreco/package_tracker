import json
import plistlib
from datetime import datetime
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'cleanup-signing.py'


class SigningCleanupTests(unittest.TestCase):
    def test_restores_original_search_list_before_removing_job_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            keys = ['/synthetic/login.keychain-db', '/synthetic/other.keychain-db']
            (root / 'doorstep-original-keychains.json').write_text(json.dumps(keys))
            (root / 'doorstep-signing.keychain-db').touch()
            private = root / 'synthetic.p8'
            private.write_text('synthetic-only')
            (root / 'doorstep-distribution.p12').touch()
            env = {'RUNNER_TEMP': directory, 'APP_STORE_CONNECT_API_KEY_PATH': str(private)}
            with patch.dict(os.environ, env, clear=True), patch('subprocess.run') as run:
                runpy.run_path(str(SCRIPT))
            self.assertEqual(run.call_args_list[0].args[0], ['security', 'list-keychains', '-d', 'user', '-s', *keys])
            self.assertEqual(run.call_args_list[1].args[0], ['security', 'delete-keychain', str(root / 'doorstep-signing.keychain-db')])
            self.assertFalse(private.exists())
            self.assertFalse((root / 'doorstep-distribution.p12').exists())

    def test_rejects_credentials_outside_job_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            job = root / 'job'
            job.mkdir()
            existing = root / 'existing.p8'
            existing.write_text('synthetic-existing')
            env = {'RUNNER_TEMP': str(job), 'APP_STORE_CONNECT_API_KEY_PATH': str(existing)}
            with patch.dict(os.environ, env, clear=True), self.assertRaises(RuntimeError):
                runpy.run_path(str(SCRIPT))
            self.assertEqual(existing.read_text(), 'synthetic-existing')

    def test_cleanup_preserves_existing_profile_and_removes_only_job_created_profile(self):
        for created in ('false', '', 'true'):
            with self.subTest(created=created), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                profiles = root / 'Library/MobileDevice/Provisioning Profiles'
                profiles.mkdir(parents=True)
                profile = profiles / 'synthetic.mobileprovision'
                profile.write_bytes(b'existing')
                env = {'RUNNER_TEMP': str(root), 'IOS_PROFILE_PATH': str(profile), 'IOS_PROFILE_CREATED': created}
                with patch.dict(os.environ, env, clear=True), patch('pathlib.Path.home', return_value=root):
                    runpy.run_path(str(SCRIPT))
                self.assertEqual(profile.exists(), created != 'true')

    def test_install_reuses_identical_cache_and_refuses_conflicting_cache(self):
        install = SCRIPT.with_name('install-profile.py')
        for cached in (None, b'synthetic-profile', b'other-profile'):
            with self.subTest(cached=cached), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                (root / 'doorstep.mobileprovision').write_bytes(b'synthetic-profile')
                (root / 'doorstep-cert.der').write_bytes(b'synthetic-cert')
                profiles = root / 'Library/MobileDevice/Provisioning Profiles'
                profiles.mkdir(parents=True)
                destination = profiles / 'synthetic-uuid.mobileprovision'
                if cached is not None:
                    destination.write_bytes(cached)
                data = {'TeamIdentifier': ['V6JPQCD336'], 'UUID': 'synthetic-uuid', 'Name': 'Existing profile',
                        'Entitlements': {'application-identifier': 'V6JPQCD336.com.jimgreco.doorstep',
                                         'get-task-allow': False, 'aps-environment': 'production'},
                        'ExpirationDate': datetime(2099, 1, 1), 'DeveloperCertificates': [b'synthetic-cert']}
                env_file = root / 'env'
                env = {'RUNNER_TEMP': str(root), 'GITHUB_ENV': str(env_file)}
                with patch.dict(os.environ, env, clear=True), patch('pathlib.Path.home', return_value=root), patch('subprocess.check_output', return_value=plistlib.dumps(data)):
                    if cached == b'other-profile':
                        with self.assertRaisesRegex(RuntimeError, 'not be overwritten'):
                            runpy.run_path(str(install))
                        self.assertFalse(env_file.exists())
                    else:
                        runpy.run_path(str(install))
                        expected = 'true' if cached is None else 'false'
                        self.assertIn('IOS_PROFILE_CREATED=' + expected, env_file.read_text())
                self.assertEqual(destination.read_bytes(), cached or b'synthetic-profile')
