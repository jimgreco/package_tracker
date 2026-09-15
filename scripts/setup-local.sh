#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  cp .env.example .env
  node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; let s=fs.readFileSync(".env","utf8").replace("DEMO_MODE=false","DEMO_MODE=true").replace("ENCRYPTION_KEY=","ENCRYPTION_KEY="+crypto.randomBytes(32).toString("hex")); fs.writeFileSync(".env",s,{mode:0o600});'
fi
chmod 600 .env
bash scripts/local-db.sh
npm run db:migrate
npm run db:seed
