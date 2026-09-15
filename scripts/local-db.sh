#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN="$(pg_config --bindir)"
mkdir -p .local
if [ ! -f .local/postgres/PG_VERSION ]; then
  "$PG_BIN/initdb" -D .local/postgres -U doorstep -A trust --encoding=UTF8 --no-locale >/dev/null
fi
if ! "$PG_BIN/pg_ctl" -D .local/postgres status >/dev/null 2>&1; then
  "$PG_BIN/pg_ctl" -D .local/postgres -l .local/postgres.log -o '-p 55439 -h 127.0.0.1' start
fi
if ! "$PG_BIN/psql" -h 127.0.0.1 -p 55439 -U doorstep -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='doorstep'" | rg -q 1; then
  "$PG_BIN/createdb" -h 127.0.0.1 -p 55439 -U doorstep doorstep
fi
