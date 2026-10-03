#!/usr/bin/env bash
set -euo pipefail
build=${1:?Expected full commit SHA}
image=${2:?Expected versioned image}
preflight_only=${PREFLIGHT_ONLY:-0}
[[ "$preflight_only" == 0 || "$preflight_only" == 1 ]] || { echo "PREFLIGHT_ONLY must be 0 or 1"; exit 1; }
[[ "$build" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid build SHA"; exit 1; }
[[ "$image" == "ghcr.io/jimgreco/package_tracker:$build" ]] || { echo "Unexpected image"; exit 1; }
cd "$HOME/deploy"
exec 9>"$HOME/doorstep/deploy.lock"
flock -w 300 9
# Reuse the host's existing registry access; application releases never copy
# registry credentials to the shared host.
export DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"
export COMPOSE_PROFILES=doorstep
export DOORSTEP_IMAGE="$image"
compose() { docker-compose -f docker-compose.yml "$@"; }
# Drain Compose output so an early grep exit cannot cause SIGPIPE under pipefail.
compose config --services | grep -x doorstep >/dev/null
python3 - <<'PY'
from pathlib import Path
import re
p=Path('.env')
if not p.is_file():
 raise SystemExit('Existing deployment .env is required; provisioning is separate')
lines=p.read_text().splitlines()
values=dict(line.split('=',1) for line in lines if '=' in line and not line.startswith('#'))
for key in ['DOORSTEP_DB_PASSWORD','DOORSTEP_ENCRYPTION_KEY']:
 if not re.fullmatch(r'[0-9a-f]{64}', values.get(key,'')):
  raise SystemExit(key+' must already be configured as 64 hexadecimal characters')
PY
compose config --quiet
# The shared database is already running. Do not recreate unrelated services.
docker exec shared_db pg_isready -U admin >/dev/null
# Preserve all previous images for operator-controlled rollback. Pull and check
# existing application database access before creating an interruption.
compose pull doorstep doorstep-worker
# Compare values only in host memory. Report key names, never configuration or
# credentials. Refuse a release that would silently change effective app config.
python3 - <<'PY'
import json,os,subprocess,sys
def run(*args):
 return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL)
def env_map(items):
 return dict(item.split('=',1) for item in items if '=' in item)
try:
 config=json.loads(run('docker-compose','-f','docker-compose.yml','config','--format','json'))
 image=json.loads(run('docker','image','inspect',os.environ['DOORSTEP_IMAGE']))[0]
 defaults=env_map(image['Config'].get('Env') or [])
 expected_labels={
  'com.docker.compose.project':'deploy',
  'com.docker.compose.project.working_dir':os.getcwd(),
  'com.docker.compose.project.config_files':os.path.join(os.getcwd(),'docker-compose.yml'),
 }
 for service in ['doorstep','doorstep-worker']:
  container=run('docker-compose','-f','docker-compose.yml','ps','-a','-q',service).strip()
  if not container:
   raise RuntimeError('Existing container required for '+service)
  current=json.loads(run('docker','inspect',container))[0]['Config']
  labels=current.get('Labels') or {}
  if any(labels.get(key)!=value for key,value in expected_labels.items()):
   raise RuntimeError('Compose source mismatch for '+service)
  expected=dict(defaults)
  expected.update({key:str(value) for key,value in config['services'][service].get('environment',{}).items() if value is not None})
  actual=env_map(current.get('Env') or [])
  # Image version metadata may change with the release; application settings may not.
  changes=sorted(key for key in expected.keys() | actual.keys()
   if key not in ['APP_BUILD','NODE_VERSION','YARN_VERSION'] and expected.get(key)!=actual.get(key))
  if changes:
   raise RuntimeError(service+' effective environment differs for keys: '+', '.join(changes))
 print('Existing Compose sources and effective application environment verified')
except RuntimeError as error:
 print(str(error),file=sys.stderr)
 sys.exit(1)
except Exception:
 print('Could not verify existing effective application configuration',file=sys.stderr)
 sys.exit(1)
PY
compose run --rm --no-deps -T doorstep node --input-type=module -e 'import pg from "pg";const p=new pg.Pool({connectionString:process.env.DATABASE_URL});try{await p.query("SELECT 1")}finally{await p.end()}' </dev/null
if [ "$preflight_only" = 1 ]; then
  echo "PorchPong preflight passed; no services stopped, migrations applied, or release pin changed"
  exit 0
fi
# Stop both old processes before migration: old Calendar workers do not enforce
# the generation/membership fence. Do not automatically restart old code after a
# successful forward-only migration. A failed release requires a compatible image.
for service in doorstep doorstep-worker; do
  container=$(compose ps -q "$service")
  if [ -n "$container" ]; then
    docker inspect --format '{{.Name}} previous image: {{.Config.Image}} ({{.Image}})' "$container"
    previous_id=$(docker inspect --format '{{.Image}}' "$container")
    [[ "$previous_id" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Invalid previous image ID for $service"; exit 1; }
    rollback_image="local/porchpong-rollback:$service-${previous_id#sha256:}"
    docker image tag "$previous_id" "$rollback_image"
    echo "$service retained as $rollback_image"
  fi
done
compose stop --timeout 120 doorstep doorstep-worker
compose run --rm --no-deps -T doorstep ./node_modules/.bin/tsx scripts/migrate.ts </dev/null
compose up -d --no-deps --no-build doorstep doorstep-worker
for service in doorstep doorstep-worker; do
  container=$(compose ps -q "$service")
  test "$(docker inspect --format '{{.Config.Image}}' "$container")" = "$image"
  for attempt in $(seq 1 45); do
    health=$(docker inspect --format '{{.State.Health.Status}}' "$container")
    if [ "$health" = healthy ]; then break; fi
    if [ "$attempt" = 45 ]; then
      echo "$service failed its health check"
      compose logs --tail=60 "$service"
      exit 1
    fi
    sleep 2
  done
  echo "$service healthy ($build)"
done
compose exec -T doorstep node -e 'fetch("http://127.0.0.1:4317/api/health").then(async r=>{const h=await r.json();if(!r.ok||h.build!==process.env.APP_BUILD||h.database!=="ready")process.exit(1);console.log("Healthy PorchPong build:",h.build)}).catch(()=>process.exit(1))' </dev/null
# Persist only a healthy release pin for subsequent consolidated deployments.
DOORSTEP_RELEASE_IMAGE="$image" python3 - <<'PY'
from pathlib import Path
import os
p=Path('.env'); lines=[x for x in p.read_text().splitlines() if not x.startswith('DOORSTEP_IMAGE=')]
lines.append('DOORSTEP_IMAGE='+os.environ['DOORSTEP_RELEASE_IMAGE'])
p.write_text('\n'.join(lines)+'\n'); os.chmod(p,0o600)
PY
