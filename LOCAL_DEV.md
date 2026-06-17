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

## Test automated email (Gmail)

Outbound mail sends through **Gmail SMTP** (`EMAIL_USER`). Parents still contact **`ben@benstadeyhockey.com`** on the site; replies to automated emails go there via `Reply-To`.

### One-time Gmail setup

1. Sign in to **benstadeyhockey@gmail.com**
2. Turn on **2-Step Verification** for that Google account
3. Create an **App Password**: [Google App Passwords](https://myaccount.google.com/apppasswords) → Mail → Other → name it `hockey-booking`
4. Add to `.env.local` (see `.env.local.example`):

```bash
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=465
EMAIL_SECURE=true
EMAIL_USER=benstadeyhockey@gmail.com
EMAIL_PASS=xxxx xxxx xxxx xxxx    # 16-char app password (spaces optional)
CONTACT_EMAIL=ben@benstadeyhockey.com
```

5. Restart the server — look for: `Email broadcast engine successfully connected`

### Send a test message

```bash
./scripts/test-email.sh you@example.com
```

Or complete a test registration on the calendar with your own email as the parent address.

| Problem | Fix |
|---------|-----|
| `Invalid login` / verification failed | Use an **App Password**, not the regular Gmail password |
| `Less secure app` errors | Google requires 2FA + App Password for SMTP |
| Email sends but wrong reply address | Set `CONTACT_EMAIL=ben@benstadeyhockey.com` on Render |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Invalid coach credentials` | Old server still on port 3000 — run `kill $(lsof -t -i :3000)` then restart with `.env.local` loaded |
| Server won’t start | `ADMIN_PASS` or `JWT_SECRET` missing — check `.env.local` |
| curl works, browser doesn’t | Wrong password typed, or stale token — log out of Coach Portal and log in again |
| PayPal button missing | Expected when checkout is disabled in coach settings |

## Calendar subscribe / add to calendar

| URL | Purpose |
|-----|---------|
| `/calendar/sessions.ics` | Public subscribe feed (upcoming non-private sessions) |
| `/api/sessions/:id/calendar.ics` | Download one session |
| `/api/sessions/:id/calendar-links` | Google + .ics URLs (JSON) |

Parents can subscribe on the calendar page or use **Add to Google Calendar** / **Download .ics** in the session overview modal. Confirmation emails include the same links after registration.

## Production (Render)

Render uses environment variables in the dashboard, not `.env.local`. After local testing, push your branch and set on Render:

- `ADMIN_PASS`, `JWT_SECRET`, PayPal vars
- `EMAIL_HOST=smtp.gmail.com`, `EMAIL_PORT=465`, `EMAIL_SECURE=true`
- `EMAIL_USER=benstadeyhockey@gmail.com`, `EMAIL_PASS=` (Google App Password)
- `CONTACT_EMAIL=ben@benstadeyhockey.com`
