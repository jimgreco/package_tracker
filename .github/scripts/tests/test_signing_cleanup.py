import json
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
