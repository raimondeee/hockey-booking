const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Safely identify the host architecture context using Render's native build flags
const dbPath = process.env.RENDER
    ? '/opt/ben-hockey-data/hockey_booking.db'
    : path.join(__dirname, 'hockey_booking.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("CRITICAL: Failed to establish connection to SQLite engine instance:", err.message);
    } else {
        console.log(`SQLite Engine successfully binding to permanent storage at: ${dbPath}`);
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
        custom_capacity INTEGER DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 2. Master Consumer Bookings Table Configuration
    db.run(`CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        player_name TEXT NOT NULL,
        parent_name TEXT NOT NULL,
        parent_email TEXT NOT NULL,
        status TEXT NOT NULL,
        paypal_order_id TEXT,
        waiver_accepted INTEGER DEFAULT 0,
        waiver_timestamp TEXT,
        queue_position INTEGER DEFAULT NULL,
        invitation_sent_at TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`);

    // 3. Vault Coupons Table Configuration
    db.run(`CREATE TABLE IF NOT EXISTS coupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        discount_type TEXT NOT NULL,
        discount_value REAL NOT NULL,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 4. Unified Security Blacklist Table Configuration
    db.run(`CREATE TABLE IF NOT EXISTS banned_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Safe background migrations
    db.run(`ALTER TABLE sessions ADD COLUMN custom_capacity INTEGER DEFAULT NULL`, (err) => {});
    db.run(`ALTER TABLE bookings ADD COLUMN queue_position INTEGER DEFAULT NULL`, (err) => {});
    db.run(`ALTER TABLE bookings ADD COLUMN invitation_sent_at TEXT DEFAULT NULL`, (err) => {});
});

module.exports = db;