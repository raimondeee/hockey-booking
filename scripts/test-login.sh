#!/usr/bin/env bash
# Verify coach login against the local server (run in a second terminal)
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env.local ]]; then
  echo "Missing .env.local — see LOCAL_DEV.md"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.local
set +a

USER="${ADMIN_USER:-coach}"

curl -s -X POST http://localhost:3000/api/admin/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${USER}\",\"password\":\"${ADMIN_PASS}\"}" | python3 -m json.tool
