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

// Create Table for training sessions/events with classification routing
db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    start_time TEXT,
    end_time TEXT,
    price REAL DEFAULT 0.00,
    event_type TEXT DEFAULT 'all'
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

module.exports = db;