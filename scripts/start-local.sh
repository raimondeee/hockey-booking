#!/usr/bin/env bash
# Start the app locally with credentials from .env.local
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env.local ]]; then
  echo "Missing .env.local — run:"
  echo "  cp .env.local.example .env.local"
  echo "Then edit .env.local and set ADMIN_PASS and JWT_SECRET."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.local
set +a

if [[ -z "${ADMIN_PASS:-}" || -z "${JWT_SECRET:-}" ]]; then
  echo "ADMIN_PASS and JWT_SECRET must be set in .env.local"
  exit 1
fi

if lsof -t -i :3000 >/dev/null 2>&1; then
  echo "Stopping existing process on port 3000..."
  kill "$(lsof -t -i :3000)" 2>/dev/null || true
  sleep 1
fi

echo "Starting server (coach user: ${ADMIN_USER:-coach})"
echo "ADMIN_PASS length: ${#ADMIN_PASS}"
echo "JWT_SECRET length: ${#JWT_SECRET}"
echo "Open http://localhost:3000/calendar.html"
echo ""

npm start
