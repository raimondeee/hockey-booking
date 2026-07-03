#!/usr/bin/env bash
# Local checkout test runner — simulated PayPal, real booking + email flows.
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

export SIMULATE_PAYPAL_CHECKOUT=1
export NODE_ENV="${NODE_ENV:-development}"

if lsof -t -i :3000 >/dev/null 2>&1; then
  echo "Stopping existing process on port 3000..."
  kill "$(lsof -t -i :3000)" 2>/dev/null || true
  sleep 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Hockey Booking — LOCAL CHECKOUT TEST MODE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  PayPal:     SIMULATED (no real charges, no PayPal API)"
echo "  Bookings:   Real database inserts + roster updates"
echo "  Emails:     Sent if EMAIL_USER / EMAIL_PASS are set in .env.local"
echo "  Coach view: One-click toggle — no password (Switch to Coach View button)"
echo "  Demo data:  6 sessions seeded/refreshed on each run (this week + next 3 weeks)"
echo ""
echo "  What to try on the calendar:"
echo "    • Single session + multiple children (+ button)"
echo "    • Add several sessions to cart → one checkout"
echo "    • Look for purple \"Simulate PayPal Checkout\" buttons"
echo ""
echo "  Coach portal: ${ADMIN_USER:-coach} / (your ADMIN_PASS from .env.local)"
echo "  Calendar:     http://localhost:3000/calendar.html"
echo ""
echo "  Press Ctrl+C in this window to stop the server."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

node scripts/seed-demo-sessions.js || true

(
  sleep 2
  if command -v open >/dev/null 2>&1; then
    open "http://localhost:3000/calendar.html"
  fi
) &

npm start
