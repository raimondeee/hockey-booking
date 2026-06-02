const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken'); 
const nodemailer = require('nodemailer'); 
const db = require('./database');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public')); 

// Secure Production Profile Configurations
const ADMIN_USERNAME = process.env.ADMIN_USER || "coach";
const ADMIN_PASSWORD = process.env.ADMIN_PASS; 
const JWT_SECRET = process.env.JWT_SECRET;

// Initialize the secure email engine transporter map configuration
const transporter = nodemailer.createTransport({
    host: 'smtp.office365.com', // Updated to GoDaddy/Microsoft 365
    port: 587,                  // Secure submission port for Microsoft 365
    secure: false,              // Must be false for port 587 (uses STARTTLS)
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: {
        ciphers: 'SSLv3',
        rejectUnauthorized: false
    }
});

// Fail-Safe Boot Checks to shield Ben's server on the open internet
if (!ADMIN_PASSWORD || !JWT_SECRET) {
    console.error("\n[CRITICAL ERROR] Missing vital environment parameters (ADMIN_PASS or JWT_SECRET)!");
    console.error("Please configure these fields immediately in your Render Environment tab Dashboard.\n");
}

if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    transporter.verify((error) => {
        if (error) console.warn("[WARN] Email broadcast engine configuration failed verification:", error.message);
        else console.log("Email broadcast engine successfully connected and authenticated to SMTP host.");
    });
}

// Background Expiration Sweeper Utility Function
function runExpiredReservationsSweep(callback) {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    // Find all invitations that have aged past 24 hours without checking out
    db.all(`SELECT id, session_id, player_name FROM bookings WHERE status = 'pending_payment' AND invitation_sent_at < ?`, [twentyFourHoursAgo], (err, expiredBookings) => {
        if (err || !expiredBookings || expiredBookings.length === 0) {
            return callback ? callback() : null;
        }

        let processedCount = 0;
        expiredBookings.forEach(booking => {
            // Drop expired holds back into standard waitlist queue and clear their timer stamp
            db.run(`UPDATE bookings SET status = 'waitlist', invitation_sent_at = NULL WHERE id = ?`, [booking.id], (updateErr) => {
                processedCount++;
                // Trigger the next person in line to receive an invite for this opening
                promoteNextWaitlistPlayer(booking.session_id);
                
                if (processedCount === expiredBookings.length && callback) {
                    callback();
                }
            });
        });
    });
}

// Helper function to fetch an authorization token from PayPal's Live production API
async function getPayPalAccessToken() {
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
    // FIX: Removed the duplicate duplicated subdomain string in the fallback URL
    const paypalHost = process.env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    
    const response = await fetch(`${paypalHost}/v1/oauth2/token`, {
        method: 'POST',
        body: 'grant_type=client_credentials',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const data = await response.json();
    return data.access_token;
}

function getPayPalHost() {
    return process.env.PAYPAL_MODE === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
}

function isRefundablePayPalOrder(paypalOrderId) {
    if (!paypalOrderId) return false;
    if (paypalOrderId === 'WAITLIST_FREE' || paypalOrderId === 'WAIVED_FREE') return false;
    if (paypalOrderId.startsWith('REFUNDED:')) return false;
    return true;
}

function resolvePayPalOrderId(paypalOrderId) {
    if (paypalOrderId && paypalOrderId.startsWith('REFUNDED:')) {
        return paypalOrderId.slice('REFUNDED:'.length);
    }
    return paypalOrderId;
}

/** Issues a PayPal capture refund and updates the booking row. Returns { success, ... } or throws with { status, error }. */
async function issuePayPalRefund(bookingId, refundAmount, options = {}) {
    const { promoteWaitlist = false } = options;

    if (!refundAmount || isNaN(parseFloat(refundAmount)) || parseFloat(refundAmount) <= 0) {
        const err = new Error('A valid refund amount is required.');
        err.status = 400;
        throw err;
    }

    const booking = await new Promise((resolve, reject) => {
        db.get(
            `SELECT b.id, b.session_id, b.paypal_order_id, b.status, b.player_name, s.price as session_price
             FROM bookings b
             JOIN sessions s ON b.session_id = s.id
             WHERE b.id = ?`,
            [bookingId],
            (dbErr, row) => (dbErr ? reject(dbErr) : resolve(row))
        );
    });

    if (!booking) {
        const err = new Error('Booking record not found.');
        err.status = 404;
        throw err;
    }

    if (!isRefundablePayPalOrder(booking.paypal_order_id)) {
        const err = new Error('No PayPal payment on record for this booking — nothing to refund.');
        err.status = 400;
        throw err;
    }

    if (booking.status === 'refunded') {
        const err = new Error('This booking has already been refunded.');
        err.status = 400;
        throw err;
    }

    const refundValue = parseFloat(refundAmount).toFixed(2);
    const paypalOrderId = resolvePayPalOrderId(booking.paypal_order_id);
    const accessToken = await getPayPalAccessToken();
    const paypalHost = getPayPalHost();

    const orderRes = await fetch(`${paypalHost}/v2/checkout/orders/${paypalOrderId}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    });
    const orderData = await orderRes.json();

    const captureId = orderData?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    if (!captureId) {
        const err = new Error('Could not locate a completed PayPal capture to refund. The order may not have been fully captured.');
        err.status = 400;
        throw err;
    }

    const refundRes = await fetch(`${paypalHost}/v2/payments/captures/${captureId}/refund`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            amount: { value: refundValue, currency_code: 'USD' },
            note_to_payer: `Refund issued by Coach Ben for ${booking.player_name}'s hockey training session.`
        })
    });
    const refundData = await refundRes.json();

    if (!refundRes.ok || refundData.status === 'FAILED') {
        console.error('[REFUND ERROR] PayPal refund response:', JSON.stringify(refundData));
        const err = new Error(`PayPal declined the refund: ${refundData?.message || 'Unknown error'}`);
        err.status = 500;
        throw err;
    }

    const refundedAt = new Date().toISOString();
    const originalOrderId = booking.paypal_order_id;

    await new Promise((resolve, reject) => {
        db.run(
            `UPDATE bookings SET status = 'refunded', paypal_order_id = ?, refund_amount = ?, refunded_at = ?, paypal_refund_id = ? WHERE id = ?`,
            [`REFUNDED:${originalOrderId}`, parseFloat(refundValue), refundedAt, refundData.id, bookingId],
            (dbErr) => (dbErr ? reject(dbErr) : resolve())
        );
    });

    await new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO system_logs (event_type, message, metadata) VALUES (?, ?, ?)`,
            [
                'REFUND_ISSUED',
                `Refund of $${refundValue} issued for ${booking.player_name} (Booking #${bookingId})`,
                JSON.stringify({
                    booking_id: bookingId,
                    session_id: booking.session_id,
                    refund_amount: refundValue,
                    paypal_refund_id: refundData.id,
                    original_order_id: originalOrderId
                })
            ],
            (dbErr) => (dbErr ? reject(dbErr) : resolve())
        );
    });

    if (promoteWaitlist && booking.status === 'active') {
        promoteNextWaitlistPlayer(booking.session_id);
    }

    return {
        success: true,
        booking_id: bookingId,
        session_id: booking.session_id,
        player_name: booking.player_name,
        message: `Refund of $${refundValue} successfully issued to PayPal for ${booking.player_name}.`,
        paypal_refund_id: refundData.id,
        refund_status: refundData.status,
        refund_amount: refundValue,
        refunded_at: refundedAt
    };
}

// 1. Public: Get all scheduled sessions alongside dynamic active and waitlist numbers
app.get('/api/sessions', (req, res) => {
    // Run the expiration logic sweep right before sending schedule updates to ensure client view precision
    runExpiredReservationsSweep(() => {
        const query = `
            SELECT s.*, 
            SUM(CASE WHEN b.status = 'active' THEN 1 ELSE 0 END) as active_count,
            SUM(CASE WHEN b.status = 'waitlist' OR b.status = 'pending_payment' THEN 1 ELSE 0 END) as waitlist_count
            FROM sessions s
            LEFT JOIN bookings b ON s.id = b.session_id
            GROUP BY s.id`;
        
        db.all(query, [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        });
    });
});

// New Public Endpoint to let frontend pages safely request the active Client ID configuration
app.get('/api/config/paypal-client-id', (req, res) => {
    if (!process.env.PAYPAL_CLIENT_ID) {
        return res.status(500).json({ error: "Merchant client token signature is unassigned on server profiles." });
    }
    res.json({ clientId: process.env.PAYPAL_CLIENT_ID });
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
    const { session_id, player_name, parent_email, parent_name, paypal_order_id, existing_booking_id } = req.body;
    if (!parent_email) return res.status(400).json({ error: "Parent email pattern is required for mapping." });

    const cleanEmail = parent_email.toLowerCase().trim();

    db.get(`SELECT email FROM banned_emails WHERE email = ?`, [cleanEmail], async (err, banRecord) => {
        if (err) return res.status(500).json({ error: "Internal security handshake check fault." });
        if (banRecord) return res.status(403).json({ error: "Registration denied. Please contact Coach Ben directly for scheduling alternatives." });

        if (paypal_order_id && paypal_order_id !== 'WAITLIST_FREE' && paypal_order_id !== 'WAIVED_FREE') {
            try {
                const accessToken = await getPayPalAccessToken();
                const paypalHost = process.env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
                
                const verifyResponse = await fetch(`${paypalHost}/v2/checkout/orders/${paypal_order_id}`, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
                });
                const orderDetails = await verifyResponse.json();

                if (orderDetails.status !== 'COMPLETED') return res.status(400).json({ error: "Payment verification checks dropped. Roster spot rejected." });
            } catch (error) {
                return res.status(500).json({ error: "Unable to complete security processing with merchant gateway." });
            }
        }

        db.get(`SELECT event_type, custom_capacity FROM sessions WHERE id = ?`, [session_id], (err, session) => {
            if (err || !session) return res.status(400).json({ error: "Target training event session matrix not found." });

            // Honor custom_capacity override if configured, otherwise drop back to template standards
            let maxActive = session.custom_capacity ? session.custom_capacity : (session.event_type === 'small' ? 6 : 25);
            let maxWaitlist = session.event_type === 'small' ? 3 : 15;

            // Handle the unique checkout flow for a waitlist player claiming an active position hold
            if (existing_booking_id) {
                db.get(`SELECT id, status FROM bookings WHERE id = ? AND session_id = ?`, [existing_booking_id, session_id], (err, bRecord) => {
                    if (err || !bRecord) return res.status(400).json({ error: "Claim token footprint match missing." });
                    
                    db.run(`UPDATE bookings SET status = 'active', paypal_order_id = ?, invitation_sent_at = NULL WHERE id = ?`, [paypal_order_id, existing_booking_id], function(err) {
                        if (err) return res.status(500).json({ error: err.message });
                        return res.json({ success: true, status: 'active', booking_id: existing_booking_id });
                    });
                });
                return;
            }

            const countQuery = `SELECT 
                (SELECT COUNT(*) FROM bookings WHERE session_id = ? AND status = 'active') as active,
                (SELECT COUNT(*) FROM bookings WHERE session_id = ? AND (status = 'waitlist' OR status = 'pending_payment')) as waitlist`;

            db.get(countQuery, [session_id, session_id], (err, counts) => {
                if (err) return res.status(500).json({ error: err.message });

                let status = 'active';
                if (counts.active >= maxActive) {
                    if (counts.waitlist >= maxWaitlist) return res.status(400).json({ error: `This training session and its waitlist bounds are completely full.` });
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

// 3b. Public Landing Page Endpoint: Look up details for a player claiming an open spot
app.post('/api/claim-spot/lookup', (req, res) => {
    const { booking_id } = req.body;
    const query = `
        SELECT b.id as booking_id, b.player_name, b.parent_name, b.parent_email, b.status,
               s.id as session_id, s.title, s.start_time, s.price, s.location
        FROM bookings b
        JOIN sessions s ON b.session_id = s.id
        WHERE b.id = ? AND b.status = 'pending_payment'`;

    db.get(query, [booking_id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(400).json({ error: "Invitation record is either invalid, expired, or completed." });
        res.json({ success: true, record: row });
    });
});

// 4. Admin Portal: System Authentication endpoint
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '2h' });
        return res.json({ success: true, token: token });
    }
    res.status(401).json({ error: "Invalid coach credentials." });
});

function verifyAdminToken(req, res, next) {
    const token = req.body.token || (req.headers['authorization'] ? req.headers['authorization'].split(' ')[1] : null);
    if (!token) return res.status(403).json({ error: "Access denied. Auth token footprint is missing." });
    try {
        req.adminContext = jwt.verify(token, JWT_SECRET);
        next(); 
    } catch (err) { return res.status(401).json({ error: "Your portal login session has expired." }); }
}

// 5. Admin Portal: Create an empty calendar slot
app.post('/api/admin/sessions', verifyAdminToken, (req, res) => {
    const { title, start_time, end_time, price, event_type, access_code, location } = req.body; 
    const insertQuery = `INSERT INTO sessions (title, start_time, end_time, price, event_type, access_code, location) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.run(insertQuery, [title, start_time, end_time, price, event_type || 'large', access_code ? access_code.trim() : null, location || null], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

// 5b. Admin Portal: Override capacity settings on an individual session block level
app.post('/api/admin/sessions/:id/capacity', verifyAdminToken, (req, res) => {
    const sessionId = req.params.id;
    const capacityVal = req.body.custom_capacity ? parseInt(req.body.custom_capacity) : null;
    
    db.run(`UPDATE sessions SET custom_capacity = ? WHERE id = ?`, [capacityVal, sessionId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        // Immediately run the promotion engine logic to sweep queues for newfound openings!
        promoteNextWaitlistPlayer(sessionId);
        
        res.json({ success: true, message: "Capacity updated and waitlist queue checked dynamically." });
    });
});

// 6. Admin Portal: Delete a session and purge connected registrations
app.delete('/api/admin/sessions/:id', verifyAdminToken, (req, res) => {
    db.run(`DELETE FROM bookings WHERE session_id = ?`, [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run(`DELETE FROM sessions WHERE id = ?`, [req.params.id], function(err) {
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
    db.run(`INSERT INTO coupons (code, discount_type, discount_value, active) VALUES (?, ?, ?, 1)`, [code.toUpperCase().trim(), discount_type, parseFloat(discount_value)], function(err) {
        if (err) return res.status(500).json({ error: "Failed to append code configuration tracking models." });
        res.json({ success: true, id: this.lastID });
    });
});

// 9. Admin Portal: Terminate/Revoke an active coupon code by index key
app.delete('/api/admin/coupons/:id', verifyAdminToken, (req, res) => {
    db.run(`DELETE FROM coupons WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// 10. Admin Portal: Fetch active roster and waitlist for a specific session block
app.post('/api/admin/sessions/:id/roster', verifyAdminToken, (req, res) => {
    db.all(
        `SELECT id, player_name, parent_name, parent_email, status, paypal_order_id,
                invitation_sent_at, refund_amount, refunded_at, paypal_refund_id
         FROM bookings WHERE session_id = ?
         ORDER BY status ASC, queue_position ASC, created_at ASC`,
        [req.params.id],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({
                active: rows.filter(r => r.status === 'active'),
                waitlist: rows.filter(r => r.status === 'waitlist' || r.status === 'pending_payment'),
                refunded: rows.filter(r => r.status === 'refunded')
            });
        }
    );
});

// 10b. Admin Portal: Reorder structural waitlist queue indexes manually
app.post('/api/admin/sessions/:id/reorder-waitlist', verifyAdminToken, (req, res) => {
    const { ordered_ids } = req.body; 
    if (!Array.isArray(ordered_ids)) return res.status(400).json({ error: "Malformed sorting mapping request context." });
    
    let processed = 0;
    ordered_ids.forEach((id, index) => {
        db.run(`UPDATE bookings SET queue_position = ? WHERE id = ?`, [index + 1, id], () => {
            processed++;
            if (processed === ordered_ids.length) res.json({ success: true });
        });
    });
});

// 11. Admin Portal: Remove player from roster entirely (manually cancels/drops spot)
app.post('/api/admin/bookings/:id/remove', verifyAdminToken, (req, res) => {
    db.get(`SELECT session_id, status FROM bookings WHERE id = ?`, [req.params.id], (err, booking) => {
        if (err || !booking) return res.status(500).json({ error: "Booking record not found." });
        db.run(`DELETE FROM bookings WHERE id = ?`, [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (booking.status === 'active') promoteNextWaitlistPlayer(booking.session_id, res);
            else res.json({ success: true, message: "Player removed from waitlist successfully." });
        });
    });
});

// 11b. Admin Portal: Issue a PayPal refund for a booking (full or partial)
app.post('/api/admin/bookings/:id/refund', verifyAdminToken, async (req, res) => {
    const { refund_amount, promote_waitlist } = req.body;
    try {
        const result = await issuePayPalRefund(req.params.id, refund_amount, {
            promoteWaitlist: !!promote_waitlist
        });
        res.json(result);
    } catch (error) {
        console.error('[REFUND ERROR] Unexpected exception:', error);
        res.status(error.status || 500).json({
            error: error.message || 'An unexpected error occurred while communicating with PayPal. No refund was issued.'
        });
    }
});

// 11c. Admin Portal: Refund catalog — all paid bookings grouped by session (past / current / future)
app.post('/api/admin/refunds/catalog', verifyAdminToken, (req, res) => {
    const timeframe = (req.body.timeframe || 'all').toLowerCase();
    const nowIso = new Date().toISOString();

    let timeClause = '';
    if (timeframe === 'past') {
        timeClause = `AND s.end_time < '${nowIso}'`;
    } else if (timeframe === 'future') {
        timeClause = `AND s.start_time > '${nowIso}'`;
    } else if (timeframe === 'current') {
        timeClause = `AND s.start_time <= '${nowIso}' AND s.end_time >= '${nowIso}'`;
    }

    const query = `
        SELECT
            s.id AS session_id,
            s.title AS session_title,
            s.start_time,
            s.end_time,
            s.price AS session_price,
            s.location,
            s.event_type,
            b.id AS booking_id,
            b.player_name,
            b.parent_name,
            b.parent_email,
            b.status,
            b.paypal_order_id,
            b.refund_amount,
            b.refunded_at,
            b.paypal_refund_id,
            b.created_at AS booked_at
        FROM sessions s
        INNER JOIN bookings b ON b.session_id = s.id
        WHERE b.paypal_order_id IS NOT NULL
          AND b.paypal_order_id != 'WAITLIST_FREE'
          AND b.paypal_order_id != 'WAIVED_FREE'
          ${timeClause}
        ORDER BY s.start_time DESC, b.id ASC`;

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const sessionsMap = new Map();
        rows.forEach(row => {
            if (!sessionsMap.has(row.session_id)) {
                const start = new Date(row.start_time);
                const end = new Date(row.end_time);
                const now = new Date();
                let temporal = 'future';
                if (end < now) temporal = 'past';
                else if (start <= now && end >= now) temporal = 'current';

                sessionsMap.set(row.session_id, {
                    session_id: row.session_id,
                    title: row.session_title,
                    start_time: row.start_time,
                    end_time: row.end_time,
                    price: row.session_price,
                    location: row.location,
                    event_type: row.event_type,
                    temporal,
                    bookings: []
                });
            }

            const refundable = row.status !== 'refunded' && isRefundablePayPalOrder(row.paypal_order_id);
            sessionsMap.get(row.session_id).bookings.push({
                booking_id: row.booking_id,
                player_name: row.player_name,
                parent_name: row.parent_name,
                parent_email: row.parent_email,
                status: row.status,
                paypal_order_id: row.paypal_order_id,
                refundable,
                default_refund_amount: row.session_price,
                refund_amount: row.refund_amount,
                refunded_at: row.refunded_at,
                paypal_refund_id: row.paypal_refund_id,
                booked_at: row.booked_at
            });
        });

        const sessions = Array.from(sessionsMap.values());
        const summary = {
            session_count: sessions.length,
            refundable_count: sessions.reduce((n, s) => n + s.bookings.filter(b => b.refundable).length, 0),
            refunded_count: sessions.reduce((n, s) => n + s.bookings.filter(b => b.status === 'refunded').length, 0)
        };

        res.json({ success: true, timeframe, summary, sessions });
    });
});

// 11d. Admin Portal: Programmatic bulk refunds (manual amounts per booking or session price default)
app.post('/api/admin/refunds/bulk', verifyAdminToken, async (req, res) => {
    const { items, promote_waitlist } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Provide a non-empty items array: [{ booking_id, refund_amount? }, ...]' });
    }

    const results = [];
    for (const item of items) {
        const bookingId = item.booking_id;
        if (!bookingId) {
            results.push({ booking_id: null, success: false, error: 'Missing booking_id' });
            continue;
        }

        let amount = item.refund_amount;
        if (amount == null || amount === '') {
            const booking = await new Promise((resolve, reject) => {
                db.get(
                    `SELECT s.price FROM bookings b JOIN sessions s ON b.session_id = s.id WHERE b.id = ?`,
                    [bookingId],
                    (dbErr, row) => (dbErr ? reject(dbErr) : resolve(row))
                );
            });
            if (!booking) {
                results.push({ booking_id: bookingId, success: false, error: 'Booking not found' });
                continue;
            }
            amount = booking.price;
        }

        try {
            const result = await issuePayPalRefund(bookingId, amount, {
                promoteWaitlist: !!promote_waitlist
            });
            results.push({ booking_id: bookingId, success: true, ...result });
        } catch (error) {
            results.push({ booking_id: bookingId, success: false, error: error.message });
        }
    }

    const succeeded = results.filter(r => r.success).length;
    res.json({
        success: succeeded === results.length,
        message: `Processed ${results.length} refund(s): ${succeeded} succeeded, ${results.length - succeeded} failed.`,
        results
    });
});

// 12. Admin Portal: Push active player down to waitlist and pull next player up
app.post('/api/admin/bookings/:id/demote', verifyAdminToken, (req, res) => {
    db.get(`SELECT session_id FROM bookings WHERE id = ?`, [req.params.id], (err, booking) => {
        if (err || !booking) return res.status(500).json({ error: "Booking record not found." });
        db.run(`UPDATE bookings SET status = 'waitlist', invitation_sent_at = NULL WHERE id = ?`, [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            promoteNextWaitlistPlayer(booking.session_id, res);
        });
    });
});

// 13. Admin Portal: Append an email address to the security blacklist vault
app.post('/api/admin/blacklist/add', verifyAdminToken, (req, res) => {
    db.run(`INSERT INTO banned_emails (email) VALUES (?)`, [req.body.email.toLowerCase().trim()], function(err) {
        if (err) return res.status(400).json({ error: "This email is already blocked." });
        res.json({ success: true, message: "Successfully blacklisted user email account path." });
    });
});

// 14. Admin Portal: Remove an email from the blacklist vault (Lift ban)
app.delete('/api/admin/blacklist/remove', verifyAdminToken, (req, res) => {
    db.run(`DELETE FROM banned_emails WHERE email = ?`, [req.body.email.toLowerCase().trim()], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: "Ban cleared safely." });
    });
});

// 14b. Admin Portal: Fetch the full structural blacklist mapping array
app.post('/api/admin/blacklist/list', verifyAdminToken, (req, res) => {
    db.all(`SELECT email, created_at FROM banned_emails ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 15. Admin Portal: Send a global broadcast email to everyone registered for a specific session slot
app.post('/api/admin/sessions/:id/broadcast', verifyAdminToken, (req, res) => {
    const sessionId = req.params.id;
    const { subject, message } = req.body;

    if (!subject || !message) return res.status(400).json({ error: "Missing required properties: subject or message." });

    db.get(`SELECT title, location FROM sessions WHERE id = ?`, [sessionId], (err, session) => {
        if (err || !session) return res.status(400).json({ error: "Target training session not found." });

        db.all(`SELECT DISTINCT parent_email FROM bookings WHERE session_id = ?`, [sessionId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            if (rows.length === 0) return res.json({ success: true, message: "Broadcast skipped. Roster empty." });

            const emailList = rows.map(r => r.parent_email);
            const locationContext = session.location ? `\n📍 Location: ${session.location}` : "";
            
            const mailOptions = {
                from: `"Ben Stadey Hockey Training" <${process.env.EMAIL_USER}>`,
                to: process.env.EMAIL_USER, 
                bcc: emailList, 
                subject: `[SCHEDULE UPDATE] ${session.title} - ${subject}`,
                text: `${message}\n\n---\nSession Details: ${session.title}${locationContext}\n\nDo not reply directly to this automated blast. For any further coordination inquiries, reach out to Ben directly at ben@benstadeyhockey.com.`
            };

            transporter.sendMail(mailOptions, (mailErr) => {
                if (mailErr) return res.status(500).json({ error: `Mail transmission failed: ${mailErr.message}` });
                res.json({ success: true, message: `Broadcast successfully sent out to ${emailList.length} family contacts.` });
            });
        });
    });
});

// 16. Admin Portal: Fetch Account Ledger financial overview statistics & utilization metrics
app.post('/api/admin/ledger/summary', verifyAdminToken, (req, res) => {
    const financeQuery = `
        SELECT 
            COUNT(b.id) as total_registrations,
            SUM(s.price) as gross_revenue,
            (SELECT COUNT(*) FROM bookings WHERE status = 'waitlist' OR status = 'pending_payment') as total_waitlisted
        FROM bookings b
        JOIN sessions s ON b.session_id = s.id
        WHERE b.status = 'active'`;

    db.get(financeQuery, [], (err, financeRow) => {
        if (err) return res.status(500).json({ error: err.message });

        db.all(`SELECT id, event_type, custom_capacity FROM sessions`, [], (err, sessions) => {
            if (err) return res.status(500).json({ error: err.message });

            let maxPossibleCapacity = 0;
            sessions.forEach(s => { 
                maxPossibleCapacity += s.custom_capacity ? s.custom_capacity : (s.event_type === 'small' ? 6 : 25); 
            });

            const totalActiveBookings = financeRow.total_registrations || 0;
            const utilizationRate = maxPossibleCapacity > 0 ? (totalActiveBookings / maxPossibleCapacity) * 100 : 0;

            res.json({
                success: true,
                total_bookings: totalActiveBookings,
                gross_earnings: financeRow.financeRow ? financeRow.gross_revenue : (financeRow.gross_revenue || 0),
                waitlist_count: financeRow.total_waitlisted || 0,
                utilization_rate: utilizationRate
            });
        });
    });
});

// 17. Admin Portal: Audit specific promo code coupon redemption revenue metrics
app.post('/api/admin/ledger/coupons-audit', verifyAdminToken, (req, res) => {
    const query = `
        SELECT 
            c.code, c.discount_type, c.discount_value,
            COUNT(b.id) as usage_count,
            SUM(
                CASE 
                    WHEN c.discount_type = 'fixed' THEN c.discount_value
                    WHEN c.discount_type = 'percent' THEN (s.price * (c.discount_value / 100))
                    ELSE 0 
                END
            ) as total_revenue_subtracted
        FROM coupons c
        LEFT JOIN bookings b ON b.paypal_order_id IS NOT NULL AND b.paypal_order_id != 'WAITLIST_FREE' AND b.status = 'active'
        LEFT JOIN sessions s ON b.session_id = s.id
        GROUP BY c.id ORDER BY usage_count DESC`;

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => ({
            code: r.code,
            discount_type: r.discount_type,
            discount_value: r.discount_value,
            usage_count: r.usage_count || 0,
            total_revenue_subtracted: r.total_revenue_subtracted || 0
        })));
    });
});

// 18. Public Telemetry: Capture client-side button runtime validation drops
app.post('/api/errors/report', (req, res) => {
    const { event_type, message, metadata } = req.body;
    const query = `INSERT INTO system_logs (event_type, message, metadata) VALUES (?, ?, ?)`;
    
    db.run(query, [event_type || 'GATEWAY_ERROR', message, JSON.stringify(metadata || {})], function(err) {
        if (err) return res.status(500).json({ error: "Failed to pipe log data." });
        res.json({ success: true, log_id: this.lastID });
    });
});

// 19. Admin Portal: Stream historical system incidents down to operations console
app.post('/api/admin/ledger/system-logs', verifyAdminToken, (req, res) => {
    db.all(`SELECT * FROM system_logs ORDER BY created_at DESC LIMIT 50`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

async function promoteNextWaitlistPlayer(sessionId, optionalResContext) {
    const nextUpQuery = `
        SELECT b.id, b.parent_email, b.parent_name, b.player_name, s.price, s.title
        FROM bookings b
        JOIN sessions s ON b.session_id = s.id
        WHERE b.session_id = ? AND b.status = 'waitlist'
        ORDER BY b.queue_position ASC, b.created_at ASC
        LIMIT 1`;

    db.get(nextUpQuery, [sessionId], async (err, nextPlayer) => {
        if (err) {
            if (optionalResContext) optionalResContext.status(500).json({ error: err.message });
            return;
        }

        if (!nextPlayer) {
            if (optionalResContext) optionalResContext.json({ success: true, message: "Roster position cleared safely. Waitlist bounds are completely empty." });
            return;
        }

        const timestampNow = new Date().toISOString();

        db.run(`UPDATE bookings SET status = 'pending_payment', invitation_sent_at = ? WHERE id = ?`, [timestampNow, nextPlayer.id], async (updateErr) => {
            if (updateErr) {
                if (optionalResContext) optionalResContext.status(500).json({ error: updateErr.message });
                return;
            }

            const baseClaimUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/claim-spot.html?booking_id=${nextPlayer.id}`;

            // Attempt to pre-create a PayPal order so the email contains a direct deep link
            // into PayPal checkout — the parent taps one link and lands straight in the payment flow.
            let deepLinkUrl = baseClaimUrl; // fallback if PayPal order creation fails

            if (nextPlayer.price > 0 && process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET) {
                try {
                    const accessToken = await getPayPalAccessToken();
                    const paypalHost = process.env.PAYPAL_MODE === 'live'
                        ? 'https://api-m.paypal.com'
                        : 'https://api-m.sandbox.paypal.com';

                    const orderRes = await fetch(`${paypalHost}/v2/checkout/orders`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            intent: 'CAPTURE',
                            purchase_units: [{
                                amount: { currency_code: 'USD', value: nextPlayer.price.toFixed(2) },
                                description: `Hockey Training: ${nextPlayer.title} — ${nextPlayer.player_name}`
                            }],
                            // Return URL carries the booking ID so claim-spot.html can finalize the booking
                            application_context: {
                                return_url: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/claim-spot.html?booking_id=${nextPlayer.id}&paypal_return=1`,
                                cancel_url: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/claim-spot.html?booking_id=${nextPlayer.id}&paypal_cancelled=1`,
                                brand_name: 'Ben Stadey Hockey Training',
                                user_action: 'PAY_NOW'
                            }
                        })
                    });

                    const orderData = await orderRes.json();

                    // Extract the payer-approval deep link from PayPal's HATEOAS links array
                    const approveLink = orderData?.links?.find(l => l.rel === 'approve');
                    if (approveLink?.href) {
                        // Append the booking ID as a fragment so claim-spot.html can read it on return
                        deepLinkUrl = `${approveLink.href}&booking_id=${nextPlayer.id}`;

                        // Store the pre-created PayPal order ID on the booking so claim-spot.html
                        // can capture it without creating a duplicate order on completion
                        db.run(`UPDATE bookings SET paypal_order_id = ? WHERE id = ?`, [orderData.id, nextPlayer.id]);
                    }
                } catch (paypalErr) {
                    // Non-fatal — fall back to the plain claim URL if PayPal order creation fails
                    console.warn("[WARN] Could not pre-create PayPal order for waitlist deep link:", paypalErr.message);
                }
            }

            const isDeepLink = deepLinkUrl !== baseClaimUrl;
            const linkLabel = isDeepLink
                ? `👉 Complete Payment & Claim Spot (Direct Checkout Link):\n${deepLinkUrl}`
                : `👉 Claim Your Spot Here:\n${baseClaimUrl}`;

            const mailOptions = {
                from: `"Ben Stadey Hockey Training" <${process.env.EMAIL_USER}>`,
                to: nextPlayer.parent_email,
                subject: `[ROSTER OPENING] Claim Your Training Spot for ${nextPlayer.player_name}`,
                text: `Hi ${nextPlayer.parent_name},\n\nGreat news — a roster spot has opened up for ${nextPlayer.player_name} in an upcoming training session!\n\n${linkLabel}\n\n${isDeepLink ? 'Tapping the link above will take you directly to PayPal checkout to complete your payment and secure the spot.' : 'Visit the link above to complete your registration and payment.'}\n\n⚠️ IMPORTANT: This invitation expires in 24 hours. If payment is not completed in time, the spot will automatically pass to the next player on the waitlist.\n\nBest regards,\nCoach Ben Stadey\nben@benstadeyhockey.com`
            };

            transporter.sendMail(mailOptions, (mailErr) => {
                if (mailErr) console.error("[ERROR] Failed sending waitlist promotion email:", mailErr.message);

                if (optionalResContext) {
                    optionalResContext.json({ success: true, message: "Roster vacancy updated. Checkout invite broadcasted to next waitlisted contact." });
                }
            });
        });
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Secure Server executing smoothly on network port ${PORT}`));