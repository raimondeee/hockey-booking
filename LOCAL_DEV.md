# Local development quick reference

Use this when testing on your Mac before pushing to Render.

## One-time setup

```bash
cd /Users/robertraimondi/Desktop/hockey-booking
npm install
cp .env.local.example .env.local
```

Edit `.env.local` and set at least:

- `ADMIN_PASS` — coach portal password (local only; can match production or differ)
- `JWT_SECRET` — any long random string for local dev

**Important:** Use straight ASCII quotes in the file, not curly quotes (`‘` `’`).

`.env.local` is gitignored — do not commit it.

## Start the server (terminal 1)

**Option A — helper script (recommended)**

```bash
chmod +x scripts/start-local.sh scripts/test-login.sh
./scripts/start-local.sh
```

**Option B — manual exports**

```bash
cd /Users/robertraimondi/Desktop/hockey-booking

# Stop a stale server if login suddenly fails
kill $(lsof -t -i :3000) 2>/dev/null

set -a
source .env.local
set +a

npm start
```

Leave this terminal running. You should see SQLite bind success and **no** `[CRITICAL ERROR] Missing vital environment parameters`.

App URLs:

| Page | URL |
|------|-----|
| Home | http://localhost:3000/index.html |
| Calendar / coach portal | http://localhost:3000/calendar.html |
| Dashboard | http://localhost:3000/dashboard.html |
| Claim spot (waitlist) | http://localhost:3000/claim-spot.html?booking_id=ID |

## Verify coach login (terminal 2)

```bash
cd /Users/robertraimondi/Desktop/hockey-booking
./scripts/test-login.sh
```

Success:

```json
{
  "success": true,
  "token": "eyJ..."
}
```

Manual curl (same as the script):

```bash
set -a && source .env.local && set +a

curl -s -X POST http://localhost:3000/api/admin/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${ADMIN_USER:-coach}\",\"password\":\"${ADMIN_PASS}\"}" | python3 -m json.tool
```

## Browser check

1. Open http://localhost:3000/calendar.html
2. **Coach Portal** → username `coach` (or your `ADMIN_USER`) + password from `.env.local`
3. Open a session → **Site Checkout & Notices** to test PayPal toggle and parent banner

Coach JWT expires after **2 hours** — log in again if admin tools stop working.

## Test payment pause / banner (no PayPal required)

With coach logged in:

1. Uncheck **PayPal checkout enabled**
2. Check **Show notice banner to parents**
3. Save (auto-saves on toggle / banner blur)

In a private/incognito window, confirm the yellow banner and “contact Ben” message instead of PayPal.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Invalid coach credentials` | Old server still on port 3000 — run `kill $(lsof -t -i :3000)` then restart with `.env.local` loaded |
| Server won’t start | `ADMIN_PASS` or `JWT_SECRET` missing — check `.env.local` |
| curl works, browser doesn’t | Wrong password typed, or stale token — log out of Coach Portal and log in again |
| PayPal button missing | Expected when checkout is disabled in coach settings |

## Production (Render)

Render uses environment variables in the dashboard, not `.env.local`. After local testing, push your branch and confirm the same keys exist on Render (`ADMIN_PASS`, `JWT_SECRET`, PayPal vars, etc.).
