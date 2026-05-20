const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Determine the correct database storage location
let dbPath;

if (process.env.RENDER) {
    // This path matches the target location inside your permanent Render Disk mount
    const diskDir = '/opt/ben-hockey-data';
    
    // Safety check: ensure the folder exists on the Render disk before trying to read it
    if (!fs.existsSync(diskDir)){
        fs.mkdirSync(diskDir, { recursive: true });
    }
    dbPath = path.join(diskDir, 'hockey_booking.db');
} else {
    // Local fallback for testing on your own laptop
    dbPath = './hockey_booking.db';
}

console.log(`[Database] Connecting to database at: ${dbPath}`);

const db = new sqlite3.Database(dbPath);

// Create Table for training sessions/events with Access Code integration
db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    start_time TEXT,
    end_time TEXT,
    price REAL DEFAULT 0.00,
    event_type TEXT DEFAULT 'all',
    access_code TEXT DEFAULT NULL
)`);

// Create Table for registered players with comprehensive legal waiver logging
db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    player_name TEXT,
    parent_name TEXT,
    parent_email TEXT,
    status TEXT, -- 'active' or 'waitlist'
    paypal_order_id TEXT,
    waiver_accepted INTEGER DEFAULT 0,  -- 1 for Approved, 0 for Empty
    waiver_timestamp TEXT,              -- Server ISO timestamp string
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
)`);

// Create Table to store discount codes managed by the coach
db.run(`CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,              -- The code parents type (e.g., 'SAVE10')
    discount_type TEXT,            -- 'fixed' ($ off) or 'percent' (% off)
    discount_value REAL,           -- e.g., 10.00 or 15.00
    active INTEGER DEFAULT 1       -- 1 for valid, 0 for expired
)`, () => {
    // Seed a couple of default test coupons into the new table row matrix automatically
    db.run(`INSERT OR IGNORE INTO coupons (code, discount_type, discount_value, active) VALUES ('SAVE10', 'fixed', 10.00, 1)`);
    db.run(`INSERT OR IGNORE INTO coupons (code, discount_type, discount_value, active) VALUES ('SIBLING15', 'percent', 15.00, 1)`);
});

module.exports = db;