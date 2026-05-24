const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Determine path: uses Render persistent disk mount if present, otherwise safe local fallback
const dbPath = process.env.RENDER_DATA_DIR 
    ? path.join('/opt/ben-hockey-data', 'hockey_booking.db')
    : path.join(__dirname, 'hockey_booking.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("CRITICAL: Failed to establish connection to SQLite engine instance:", err.message);
    } else {
        console.log(`SQLite Engine successfully binding to storage layer at: ${dbPath}`);
    }
});

db.serialize(() => {
    // 1. Master Sessions Table Configuration
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        price REAL NOT NULL,
        event_type TEXT DEFAULT 'large',
        access_code TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 2. Master Consumer Bookings Table Configuration (with liability tracking stamps)
    db.run(`CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        player_name TEXT NOT NULL,
        parent_name TEXT NOT NULL,
        parent_email TEXT NOT NULL,
        status TEXT NOT NULL, -- 'active' or 'waitlist'
        paypal_order_id TEXT,
        waiver_accepted INTEGER DEFAULT 0,
        waiver_timestamp TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`);

    // 3. Vault Coupons Table Configuration
    db.run(`CREATE TABLE IF NOT EXISTS coupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        discount_type TEXT NOT NULL, -- 'fixed' or 'percent'
        discount_value REAL NOT NULL,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 4. NEW: Unified Security Blacklist Table Configuration
    db.run(`CREATE TABLE IF NOT EXISTS banned_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.error("Error setting up security blacklist storage schema mapping:", err.message);
        else console.log("Administrative blacklist layer mounted safely inside core transactional database matrix.");
    });
});

module.exports = db;