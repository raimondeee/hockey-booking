const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./hockey_booking.db');

db.serialize(() => {
    // Table for training sessions/events
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        start_time TEXT,
        end_time TEXT,
        price REAL DEFAULT 0.00
    )`);

    // Table for registered players (Active or Waitlist)
    db.run(`CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        player_name TEXT,
        parent_email TEXT,
        status TEXT, -- 'active' or 'waitlist'
        paypal_order_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
    )`);
});

module.exports = db;