#!/bin/bash
set -euo pipefail
selected_xcode=$(python3 - <<'PY'
from pathlib import Path
import re
paths = [p for p in Path('/Applications').glob('Xcode*.app')
         if re.fullmatch(r'Xcode[_-]?26(?:[._-]\d+)*\.app', p.name)]
if not paths:
    paths = [p for p in [Path('/Applications/Xcode.app')] if p.exists()]
if not paths:
    raise SystemExit('Xcode is required on the runner.')
print(max(paths, key=lambda p: tuple(map(int, re.findall(r'\d+', p.name)))))
PY
)
export DEVELOPER_DIR="$selected_xcode/Contents/Developer"
printf 'DEVELOPER_DIR=%s\n' "$DEVELOPER_DIR" >> "$GITHUB_ENV"
xcode_version="$(xcodebuild -version)"
printf '%s\n' "$xcode_version"
# xcodebuild can abort on SIGPIPE when grep -q exits before its second line.
grep -Eq '^Xcode 26(\.|$)' <<< "$xcode_version" || { echo 'Xcode 26 is required.'; exit 1; }
if ! command -v xcodegen >/dev/null; then
  brew install xcodegen
fi
xcodegen --version
