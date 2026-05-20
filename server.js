const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const db = require('./database');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public')); // Serves your landing page and calendar frontend files

// Secure Admin Dashboard Access Credentials
const ADMIN_USERNAME = "coach";
const ADMIN_PASSWORD = "HockeyPassword2026!"; // Coach can change this later

// Helper function to fetch a secure authentication token from PayPal's OAuth API
async function getPayPalAccessToken() {
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
    const response = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
        method: 'POST',
        body: 'grant_type=client_credentials',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const data = await response.json();
    return data.access_token;
}

// 1. Public: Get all scheduled sessions alongside dynamic active and waitlist numbers
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

// 2. Public: Validate a coupon code and return its mathematical value to the calendar interface
app.post('/api/validate-coupon', (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "No code provided" });

    db.get(`SELECT * FROM coupons WHERE code = ? AND active = 1`, [code.toUpperCase().trim()], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(400).json({ error: "Invalid or expired coupon code." });
        
        res.json({ success: true, discount_type: row.discount_type, discount_value: row.discount_value });
    });
});

// 3. Public: Submit a registration (Enforces server-side PayPal authentication checks and saves legal waiver logs)
app.post('/api/book', async (req, res) => {
    const { session_id, player_name, parent_email, parent_name, paypal_order_id } = req.body;

    // Secure Verification: Confirm payment status directly via PayPal's API if an Order ID exists
    if (paypal_order_id && paypal_order_id !== 'WAITLIST_FREE') {
        try {
            const accessToken = await getPayPalAccessToken();
            const verifyResponse = await fetch(`https://api-m.paypal.com/v2/checkout/orders/${paypal_order_id}`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
            });
            const orderDetails = await verifyResponse.json();

            if (orderDetails.status !== 'COMPLETED') {
                return res.status(400).json({ error: "Payment verification failed. Roster spot not assigned." });
            }
        } catch (error) {
            return res.status(500).json({ error: "Unable to process validation with payment network gateway." });
        }
    }

    // Capacity Verification Loop: Check current limits (25 active, 15 waitlist)
    const countQuery = `SELECT 
        (SELECT COUNT(*) FROM bookings WHERE session_id = ? AND status = 'active') as active,
        (SELECT COUNT(*) FROM bookings WHERE session_id = ? AND status = 'waitlist') as waitlist`;

    db.get(countQuery, [session_id, session_id], (err, counts) => {
        if (err) return res.status(500).json({ error: err.message });

        let status = 'active';
        if (counts.active >= 25) {
            if (counts.waitlist >= 15) {
                return res.status(400).json({ error: "This training session and waitlist are completely full." });
            }
            status = 'waitlist';
        }

        // Establish waiver tracking criteria parameters
        const waiverTimestamp = new Date().toISOString(); // Records precise signature timing
        const waiverAcceptedFlag = 1;

        const insertQuery = `
            INSERT INTO bookings (
                session_id, player_name, parent_name, parent_email, 
                status, paypal_order_id, waiver_accepted, waiver_timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

        db.run(insertQuery, [
            session_id, 
            player_name, 
            parent_name, 
            parent_email, 
            status, 
            paypal_order_id || 'WAITLIST_FREE',
            waiverAcceptedFlag,
            waiverTimestamp
        ], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, status: status, booking_id: this.lastID });
        });
    });
});

// 4. Admin Portal: System Authentication endpoint
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        return res.json({ success: true, token: "session_token_mock_abc123" });
    }
    res.status(401).json({ error: "Invalid coach credentials." });
});

// 5. Admin Portal: Create an empty calendar slot (with classification & access controls)
app.post('/api/admin/sessions', (req, res) => {
    const { token, title, start_time, end_time, price, event_type, access_code } = req.body; 
    if (token !== "session_token_mock_abc123") return res.status(403).json({ error: "Unauthorized" });

    const insertQuery = `INSERT INTO sessions (title, start_time, end_time, price, event_type, access_code) VALUES (?, ?, ?, ?, ?, ?)`;
    db.run(insertQuery, [title, start_time, end_time, price, event_type || 'large', access_code ? access_code.trim() : null], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

// 6. Admin Portal: Delete a session and clean up connected roster files
app.delete('/api/admin/sessions/:id', (req, res) => {
    const { token } = req.body;
    const sessionId = req.params.id;
    if (token !== "session_token_mock_abc123") return res.status(403).json({ error: "Unauthorized" });

    db.run(`DELETE FROM bookings WHERE session_id = ?`, [sessionId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// 7. Admin Portal: Fetch all coupons inside the generator vault
app.post('/api/admin/coupons/list', (req, res) => {
    const { token } = req.body;
    if (token !== "session_token_mock_abc123") return res.status(403).json({ error: "Unauthorized" });

    db.all(`SELECT * FROM coupons ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 8. Admin Portal: Generate a brand new functional coupon code record
app.post('/api/admin/coupons/create', (req, res) => {
    const { token, code, discount_type, discount_value } = req.body;
    if (token !== "session_token_mock_abc123") return res.status(403).json({ error: "Unauthorized" });
    if (!code || !discount_value) return res.status(400).json({ error: "Missing required values" });

    const cleanCode = code.toUpperCase().trim();
    const insertQuery = `INSERT INTO coupons (code, discount_type, discount_value, active) VALUES (?, ?, ?, 1)`;

    db.run(insertQuery, [cleanCode, discount_type, parseFloat(discount_value)], function(err) {
        if (err) {
            if (err.message.includes("UNIQUE")) {
                return res.status(400).json({ error: "A coupon with this exact code name already exists." });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, id: this.lastID });
    });
});

// 9. Admin Portal: Terminate/Revoke an active coupon code by index key
app.delete('/api/admin/coupons/:id', (req, res) => {
    const { token } = req.body;
    const couponId = req.params.id;
    if (token !== "session_token_mock_abc123") return res.status(403).json({ error: "Unauthorized" });

    db.run(`DELETE FROM coupons WHERE id = ?`, [couponId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Start the Application Engine
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server executing smoothly on network port ${PORT}`));