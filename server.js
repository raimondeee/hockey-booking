const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const db = require('./database');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Simple Hardcoded Credentials for the Coach
const ADMIN_USERNAME = "coach";
const ADMIN_PASSWORD = "HockeyPassword2026!"; // Change this to a secure password

// 1. Get all sessions with current registration counts
app.get('/api/sessions', (req, res) => {
    const query = `
        SELECT s.*, 
        SUM(CASE WHEN b.status = 'active' THEN 1 ELSE 0 END) as active_count,
        SUM(CASE WHEN b.status = 'waitlist' THEN 1 ELSE 0 END) as waitlist_count
        FROM sessions s
        LEFT JOIN bookings b ON s.id = b.session_id
        GROUP BY s.id`;
    
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 2. Process a booking (Public Route)
app.post('/api/book', (req, res) => {
    const { session_id, player_name, parent_email, paypal_order_id } = req.body;

    const countQuery = `SELECT 
        (SELECT COUNT(*) FROM bookings WHERE session_id = ? AND status = 'active') as active,
        (SELECT COUNT(*) FROM bookings WHERE session_id = ? AND status = 'waitlist') as waitlist`;

    db.get(countQuery, [session_id, session_id], (err, counts) => {
        if (err) return res.status(500).json({ error: err.message });

        let status = 'active';
        if (counts.active >= 30) {
            if (counts.waitlist >= 15) {
                return res.status(400).json({ error: "This session and waitlist are completely full." });
            }
            status = 'waitlist';
        }

        const insertQuery = `INSERT INTO bookings (session_id, player_name, parent_email, status, paypal_order_id) VALUES (?, ?, ?, ?, ?)`;
        db.run(insertQuery, [session_id, player_name, parent_email, status, paypal_order_id || 'WAITLIST_FREE'], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, status: status, booking_id: this.lastID });
        });
    });
});

// 3. Admin Login Authentication Endpoint
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        return res.json({ success: true, token: "session_token_mock_abc123" }); // Simple token assignment
    }
    res.status(401).json({ error: "Invalid coach credentials." });
});

// 4. Admin Action: Create a New Training Slot
app.post('/api/admin/sessions', (req, res) => {
    const { token, title, start_time, end_time, price } = req.body;
    if (token !== "session_token_mock_abc123") return res.status(403).json({ error: "Unauthorized" });

    const insertQuery = `INSERT INTO sessions (title, start_time, end_time, price) VALUES (?, ?, ?, ?)`;
    db.run(insertQuery, [title, start_time, end_time, price], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

// 5. Admin Action: Delete an Existing Slot
app.delete('/api/admin/sessions/:id', (req, res) => {
    const { token } = req.body;
    const sessionId = req.params.id;
    if (token !== "session_token_mock_abc123") return res.status(403).json({ error: "Unauthorized" });

    // Remove connected bookings first to prevent stray data corruption
    db.run(`DELETE FROM bookings WHERE session_id = ?`, [sessionId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));