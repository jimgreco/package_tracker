#!/bin/bash
# Configure the Connect key on either the signing or processing runner.
set -euo pipefail
umask 077
for name in APP_STORE_CONNECT_KEY_ID APP_STORE_CONNECT_ISSUER_ID APP_STORE_CONNECT_API_KEY; do
  test -n "${!name}" || { echo "Missing required secret: $name"; exit 1; }
done
KEY_PATH="$RUNNER_TEMP/doorstep-private-keys/AuthKey_${APP_STORE_CONNECT_KEY_ID}.p8"
printf 'API_PRIVATE_KEYS_DIR=%s\n' "$(dirname "$KEY_PATH")" >> "$GITHUB_ENV"
# Register the cleanup location before any operation that can fail.
printf 'APP_STORE_CONNECT_API_KEY_PATH=%s\n' "$KEY_PATH" >> "$GITHUB_ENV"
mkdir -p "$(dirname "$KEY_PATH")"
export KEY_PATH
python3 - <<'PY'
import base64, os
from pathlib import Path
key = os.environ['APP_STORE_CONNECT_API_KEY'].strip()
if '\\n' in key and '\n' not in key:
    key = key.replace('\\n', '\n')
if not key.startswith('-----BEGIN PRIVATE KEY-----'):
    key = base64.b64decode(key, validate=True).decode()
if not key.startswith('-----BEGIN PRIVATE KEY-----'):
    raise SystemExit('APP_STORE_CONNECT_API_KEY must contain a PEM API key or its base64 encoding.')
Path(os.environ['KEY_PATH']).write_text(key.rstrip() + '\n')
PY
chmod 600 "$KEY_PATH"
openssl pkey -in "$KEY_PATH" -check -noout >/dev/null
