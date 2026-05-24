const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken'); // Secure cryptographic tokens
const db = require('./database');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public')); // Serves landing pages and calendar assets

// Secure Production Profile Configurations
const ADMIN_USERNAME = process.env.ADMIN_USER || "coach";
const ADMIN_PASSWORD = process.env.ADMIN_PASS; 
const JWT_SECRET = process.env.JWT_SECRET;

// Fail-Safe Boot Checks to shield Ben's server on the open internet
if (!ADMIN_PASSWORD || !JWT_SECRET) {
    console.error("\n[CRITICAL ERROR] Missing vital environment parameters (ADMIN_PASS or JWT_SECRET)!");
    console.error("Please configure these fields immediately in your Render Environment tab Dashboard.\n");
}

// Helper function to fetch an authorization token from PayPal's Live production API
async function getPayPalAccessToken() {
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
    const paypalHost = process.env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    
    const response = await fetch(`${paypalHost}/v1/oauth2/token`, {
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

// 2. Public: Validate a coupon code and return its value to the frontend layout
app.post('/api/validate-coupon', (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "No code provided" });

    db.get(`SELECT * FROM coupons WHERE code = ? AND active = 1`, [code.toUpperCase().trim()], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(400).json({ error: "Invalid or expired coupon code." });
        
        res.json({ success: true, discount_type: row.discount_type, discount_value: row.discount_value });
    });
});

// 3. Public: Submit a registration (Enforces security blacklist interceptions, verifies PayPal, locks waivers)
app.post('/api/book', async (req, res) => {
    const { session_id, player_name, parent_email, parent_name, paypal_order_id } = req.body;
    if (!parent_email) return res.status(400).json({ error: "Parent email pattern is required for mapping." });

    const cleanEmail = parent_email.toLowerCase().trim();

    // INTERCEPT CHECK: Halt blacklisted consumers at the structural gate
    db.get(`SELECT email FROM banned_emails WHERE email = ?`, [cleanEmail], async (err, banRecord) => {
        if (err) return res.status(500).json({ error: "Internal security handshake check fault." });
        
        if (banRecord) {
            return res.status(403).json({ error: "Registration denied. Please contact Coach Ben directly for scheduling alternatives." });
        }

        // blacklisted check clear. Proceed to verify order tokens if applicable
        if (paypal_order_id && paypal_order_id !== 'WAITLIST_FREE') {
            try {
                const accessToken = await getPayPalAccessToken();
                const paypalHost = process.env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
                
                const verifyResponse = await fetch(`${paypalHost}/v2/checkout/orders/${paypal_order_id}`, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
                });
                const orderDetails = await verifyResponse.json();

                if (orderDetails.status !== 'COMPLETED') {
                    return res.status(400).json({ error: "Payment verification checks dropped. Roster spot rejected." });
                }
            } catch (error) {
                return res.status(500).json({ error: "Unable to complete security processing with merchant gateway." });
            }
        }

        // Dynamic Capacity Check based on active event classifications
        db.get(`SELECT event_type FROM sessions WHERE id = ?`, [session_id], (err, session) => {
            if (err || !session) return res.status(400).json({ error: "Target training event session matrix not found." });

            let maxActive = session.event_type === 'small' ? 6 : 25;
            let maxWaitlist = session.event_type === 'small' ? 3 : 15;

            const countQuery = `SELECT 
                (SELECT COUNT(*) FROM bookings WHERE session_id = ? AND status = 'active') as active,
                (SELECT COUNT(*) FROM bookings WHERE session_id = ? AND status = 'waitlist') as waitlist`;

            db.get(countQuery, [session_id, session_id], (err, counts) => {
                if (err) return res.status(500).json({ error: err.message });

                let status = 'active';
                if (counts.active >= maxActive) {
                    if (counts.waitlist >= maxWaitlist) {
                        return res.status(400).json({ error: `This training session and its waitlist bounds are completely full.` });
                    }
                    status = 'waitlist';
                }

                const waiverTimestamp = new Date().toISOString(); 
                const waiverAcceptedFlag = 1;

                const insertQuery = `
                    INSERT INTO bookings (
                        session_id, player_name, parent_name, parent_email, 
                        status, paypal_order_id, waiver_accepted, waiver_timestamp
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

                db.run(insertQuery, [
                    session_id, player_name, parent_name, cleanEmail, status, 
                    paypal_order_id || 'WAITLIST_FREE', waiverAcceptedFlag, waiverTimestamp
                ], function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, status: status, booking_id: this.lastID });
                });
            });
        });
    });
});

// 4. Admin Portal: System Authentication endpoint (Issues secure dynamic tokens expiring in 2 hours)
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (!ADMIN_PASSWORD) {
        return res.status(500).json({ error: "Server authentication values are not configured on the dashboard host." });
    }

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '2h' });
        return res.json({ success: true, token: token });
    }
    res.status(401).json({ error: "Invalid coach credentials." });
});

// --- ENFORCED MIDDLEWARE: Protects down-line Admin routes using cryptographic verification loops ---
function verifyAdminToken(req, res, next) {
    const token = req.body.token || (req.headers['authorization'] ? req.headers['authorization'].split(' ')[1] : null);
    if (!token) return res.status(403).json({ error: "Access denied. Auth token footprint is missing." });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.adminContext = decoded;
        next(); 
    } catch (err) {
        return res.status(401).json({ error: "Your portal login session has expired. Please refresh and log back in." });
    }
}

// 5. Admin Portal: Create an empty calendar slot
app.post('/api/admin/sessions', verifyAdminToken, (req, res) => {
    const { title, start_time, end_time, price, event_type, access_code } = req.body; 
    const insertQuery = `INSERT INTO sessions (title, start_time, end_time, price, event_type, access_code) VALUES (?, ?, ?, ?, ?, ?)`;
    db.run(insertQuery, [title, start_time, end_time, price, event_type || 'large', access_code ? access_code.trim() : null], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

// 6. Admin Portal: Delete a session and purge connected registrations
app.delete('/api/admin/sessions/:id', verifyAdminToken, (req, res) => {
    const sessionId = req.params.id;
    db.run(`DELETE FROM bookings WHERE session_id = ?`, [sessionId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// 7. Admin Portal: Fetch coupons inside the generator vault
app.post('/api/admin/coupons/list', verifyAdminToken, (req, res) => {
    db.all(`SELECT * FROM coupons ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 8. Admin Portal: Generate a brand new functional coupon code record
app.post('/api/admin/coupons/create', verifyAdminToken, (req, res) => {
    const { code, discount_type, discount_value } = req.body;
    if (!code || !discount_value) return res.status(400).json({ error: "Missing required properties" });

    const cleanCode = code.toUpperCase().trim();
    const insertQuery = `INSERT INTO coupons (code, discount_type, discount_value, active) VALUES (?, ?, ?, 1)`;

    db.run(insertQuery, [cleanCode, discount_type, parseFloat(discount_value)], function(err) {
        if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "A coupon with this exact code name already exists." });
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, id: this.lastID });
    });
});

// 9. Admin Portal: Terminate/Revoke an active coupon code by index key
app.delete('/api/admin/coupons/:id', verifyAdminToken, (req, res) => {
    const couponId = req.params.id;
    db.run(`DELETE FROM coupons WHERE id = ?`, [couponId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// 10. Admin Portal: Fetch active roster and waitlist for a specific session block
app.post('/api/admin/sessions/:id/roster', verifyAdminToken, (req, res) => {
    const sessionId = req.params.id;
    const query = `SELECT id, player_name, parent_name, parent_email, status, created_at 
                   FROM bookings 
                   WHERE session_id = ? 
                   ORDER BY status ASC, created_at ASC`;
    
    db.all(query, [sessionId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const active = rows.filter(r => r.status === 'active');
        const waitlist = rows.filter(r => r.status === 'waitlist');
        res.json({ active, waitlist });
    });
});

// 11. Admin Portal: Remove player from roster entirely (manually cancels/drops spot)
app.post('/api/admin/bookings/:id/remove', verifyAdminToken, (req, res) => {
    const bookingId = req.params.id;
    db.get(`SELECT session_id, status FROM bookings WHERE id = ?`, [bookingId], (err, booking) => {
        if (err || !booking) return res.status(500).json({ error: "Booking record not found." });
        
        const sessionId = booking.session_id;
        const wasActive = booking.status === 'active';

        db.run(`DELETE FROM bookings WHERE id = ?`, [bookingId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (wasActive) promoteNextWaitlistPlayer(sessionId, res);
            else res.json({ success: true, message: "Player removed from waitlist successfully." });
        });
    });
});

// 12. Admin Portal: Push active player down to waitlist and pull next player up
app.post('/api/admin/bookings/:id/demote', verifyAdminToken, (req, res) => {
    const bookingId = req.params.id;
    db.get(`SELECT session_id FROM bookings WHERE id = ?`, [bookingId], (err, booking) => {
        if (err || !booking) return res.status(500).json({ error: "Booking record not found." });
        
        const sessionId = booking.session_id;
        db.run(`UPDATE bookings SET status = 'waitlist' WHERE id = ?`, [bookingId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            promoteNextWaitlistPlayer(sessionId, res);
        });
    });
});

// 13. NEW ADMIN ROUTE: Append an email address to the security blacklist vault
app.post('/api/admin/blacklist/add', verifyAdminToken, (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "No target email provided." });

    const targetEmail = email.toLowerCase().trim();
    db.run(`INSERT INTO banned_emails (email) VALUES (?)`, [targetEmail], function(err) {
        if (err) {
            if (err.message.includes("UNIQUE")) return res.status(400).json({ error: "This specific user profile is already locked out." });
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: `Successfully blacklisted ${targetEmail} from system access loops.` });
    });
});

// 14. NEW ADMIN ROUTE: Remove an email from the blacklist vault (Lift ban)
app.delete('/api/admin/blacklist/remove', verifyAdminToken, (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "No email pattern passed." });

    const targetEmail = email.toLowerCase().trim();
    db.run(`DELETE FROM banned_emails WHERE email = ?`, [targetEmail], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: `Ban cleared safely for user account record: ${targetEmail}.` });
    });
});

// AUTOMATED LOGIC CONTROLLER: Upgrades the longest-waiting alternate player to active status
function promoteNextWaitlistPlayer(sessionId, res) {
    db.get(`SELECT id FROM bookings WHERE session_id = ? AND status = 'waitlist' ORDER BY created_at ASC LIMIT 1`, [sessionId], (err, nextUp) => {
        if (err) return res.status(500).json({ error: err.message });
        
        if (nextUp) {
            db.run(`UPDATE bookings SET status = 'active' WHERE id = ?`, [nextUp.id], (updateErr) => {
                if (updateErr) return res.status(500).json({ error: updateErr.message });
                res.json({ success: true, message: "Roster updated. Next waitlist player promoted automatically." });
            });
        } else {
            res.json({ success: true, message: "Player removed. Waitlist is completely empty." });
        }
    });
}

// Start the Application Engine
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Secure Server executing smoothly on network port ${PORT}`));