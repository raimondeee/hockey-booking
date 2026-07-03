#!/usr/bin/env node
/**
 * Refreshes six reusable demo sessions for local checkout testing.
 * Runs on every test-checkout-local launch — dates are rolled forward to
 * this week / within the next month so they always appear on the calendar.
 */
const db = require('../database');

const DEMO_TITLE_PREFIX = 'Demo ';

const DEMO_SESSIONS = [
    {
        title: 'Demo Power Skating Clinic',
        dayOffset: 1,
        hour: 17,
        durationHours: 1,
        price: 45,
        event_type: 'large',
        location: 'Sherwood Ice Arena',
        event_color: 'blue'
    },
    {
        title: 'Demo Small Group Skills',
        dayOffset: 2,
        hour: 18,
        durationHours: 1,
        price: 55,
        event_type: 'small',
        location: 'Winterhawks Skating Center - Beaverton',
        event_color: 'green'
    },
    {
        title: 'Demo Stickhandling Session',
        dayOffset: 4,
        hour: 16,
        durationHours: 1.5,
        price: 40,
        event_type: 'large',
        location: 'The Veterans Memorial Coliseum (VMC)',
        event_color: 'blue'
    },
    {
        title: 'Demo Shooting & Scoring',
        dayOffset: 6,
        hour: 19,
        durationHours: 1,
        price: 50,
        event_type: 'large',
        location: 'Sherwood Ice Arena',
        event_color: 'red'
    },
    {
        title: 'Demo Elite Small Group',
        dayOffset: 12,
        hour: 17,
        durationHours: 1,
        price: 60,
        event_type: 'small',
        location: 'Winterhawks Skating Center - Beaverton',
        event_color: 'green'
    },
    {
        title: 'Demo Game Situations Clinic',
        dayOffset: 21,
        hour: 18,
        durationHours: 1.5,
        price: 42,
        event_type: 'large',
        location: 'The Veterans Memorial Coliseum (VMC)',
        event_color: 'red'
    }
];

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function pad(n) {
    return String(n).padStart(2, '0');
}

function toIsoLocal(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

function buildSessionWindow(now, demo) {
    const start = new Date(now);
    start.setDate(start.getDate() + demo.dayOffset);
    start.setHours(demo.hour, 0, 0, 0);
    start.setSeconds(0, 0);

    const end = new Date(start.getTime() + demo.durationHours * 60 * 60 * 1000);
    return { start, end };
}

async function ensurePayPalCheckoutEnabled() {
    const existing = await get(`SELECT value FROM site_settings WHERE key = 'paypal_checkout_enabled'`);
    if (existing) {
        await run(`UPDATE site_settings SET value = '1' WHERE key = 'paypal_checkout_enabled'`);
    } else {
        await run(`INSERT INTO site_settings (key, value) VALUES ('paypal_checkout_enabled', '1')`);
    }
}

async function upsertDemoSession(now, demo) {
    const { start, end } = buildSessionWindow(now, demo);
    const startIso = toIsoLocal(start);
    const endIso = toIsoLocal(end);

    const existing = await get(
        `SELECT id FROM sessions WHERE title = ? ORDER BY id ASC LIMIT 1`,
        [demo.title]
    );

    if (existing) {
        await run(
            `UPDATE sessions
             SET start_time = ?, end_time = ?, price = ?, event_type = ?, location = ?,
                 event_color = ?, cancelled_at = NULL, archived_at = NULL
             WHERE id = ?`,
            [startIso, endIso, demo.price, demo.event_type, demo.location, demo.event_color, existing.id]
        );
        console.log(`[seed] Updated "${demo.title}" → ${start.toLocaleDateString()} ${start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
        return existing.id;
    }

    const result = await run(
        `INSERT INTO sessions (title, start_time, end_time, price, event_type, location, event_color)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [demo.title, startIso, endIso, demo.price, demo.event_type, demo.location, demo.event_color]
    );
    console.log(`[seed] Created "${demo.title}" → ${start.toLocaleDateString()} ${start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    return result.lastID;
}

async function removeStaleDemoSessions(activeTitles) {
    const stale = await all(
        `SELECT id, title FROM sessions
         WHERE title LIKE ? AND title NOT IN (${activeTitles.map(() => '?').join(', ')})`,
        [`${DEMO_TITLE_PREFIX}%`, ...activeTitles]
    );

    for (const row of stale) {
        await run(`DELETE FROM sessions WHERE id = ?`, [row.id]);
        console.log(`[seed] Removed stale demo session "${row.title}" (id ${row.id})`);
    }
}

async function main() {
    await new Promise((resolve) => setTimeout(resolve, 250));

    await ensurePayPalCheckoutEnabled();

    const now = new Date();
    const activeTitles = DEMO_SESSIONS.map((demo) => demo.title);

    console.log(`[seed] Refreshing ${DEMO_SESSIONS.length} demo sessions (dates through ~${new Date(now.getTime() + 21 * 86400000).toLocaleDateString()})...`);

    for (const demo of DEMO_SESSIONS) {
        await upsertDemoSession(now, demo);
    }

    await removeStaleDemoSessions(activeTitles);

    console.log('[seed] 6 demo sessions ready on the calendar for checkout testing.');
    process.exit(0);
}

main().catch((err) => {
    console.error('[seed] Failed:', err.message);
    process.exit(1);
});
