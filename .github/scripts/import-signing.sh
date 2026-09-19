#!/bin/bash
# Same six signing secrets as Forge/Ritual Cue. Executed only on a CI release runner.
set -euo pipefail
umask 077
for name in APP_STORE_CONNECT_KEY_ID APP_STORE_CONNECT_ISSUER_ID APP_STORE_CONNECT_API_KEY IOS_DIST_CERT_P12 IOS_DIST_CERT_PASSWORD KEYCHAIN_PASSWORD; do
  test -n "${!name}" || { echo "Missing required secret: $name"; exit 1; }
done
KEYCHAIN_PATH="$RUNNER_TEMP/doorstep-signing.keychain-db"
printf 'KEYCHAIN_PATH=%s\n' "$KEYCHAIN_PATH" >> "$GITHUB_ENV"
bash .github/scripts/configure-connect-key.sh
python3 - <<'SNAPSHOT'
import json, os, shlex, subprocess
from pathlib import Path
keys = shlex.split(subprocess.check_output(['security', 'list-keychains', '-d', 'user'], text=True))
Path(os.environ['RUNNER_TEMP'], 'doorstep-original-keychains.json').write_text(json.dumps(keys))
SNAPSHOT
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
python3 - <<'SEARCH_LIST'
import json, os, subprocess
from pathlib import Path
keys = json.loads(Path(os.environ['RUNNER_TEMP'], 'doorstep-original-keychains.json').read_text())
subprocess.run(['security', 'list-keychains', '-d', 'user', '-s', str(Path(os.environ['RUNNER_TEMP'], 'doorstep-signing.keychain-db')), *keys], check=True)
SEARCH_LIST
printf '%s' "$IOS_DIST_CERT_P12" | base64 -d > "$RUNNER_TEMP/doorstep-distribution.p12"
run_pkcs12() {
  # macOS Bash 3.2 errors on an empty array under nounset.
  local pkcs12_help
  pkcs12_help="$(openssl pkcs12 -help 2>&1 || true)"
  if [[ "$pkcs12_help" == *'-legacy'* ]]; then
    openssl pkcs12 -legacy "$@"
  else
    openssl pkcs12 "$@"
  fi
}
run_pkcs12 -in "$RUNNER_TEMP/doorstep-distribution.p12" -clcerts -nokeys \
  -passin env:IOS_DIST_CERT_PASSWORD -out "$RUNNER_TEMP/doorstep-cert.pem"
openssl x509 -in "$RUNNER_TEMP/doorstep-cert.pem" -outform DER -out "$RUNNER_TEMP/doorstep-cert.der"
security import "$RUNNER_TEMP/doorstep-distribution.p12" -k "$KEYCHAIN_PATH" \
  -P "$IOS_DIST_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH" >/dev/null
