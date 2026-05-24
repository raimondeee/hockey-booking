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
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: 465,
    secure: true, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
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
    const paypalHost = process.env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.sandbox.paypal.com';
    
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
               s.id as session_id, s.title, s.start_time, s.price
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
    const { title, start_time, end_time, price, event_type, access_code } = req.body; 
    const insertQuery = `INSERT INTO sessions (title, start_time, end_time, price, event_type, access_code) VALUES (?, ?, ?, ?, ?, ?)`;
    db.run(insertQuery, [title, start_time, end_time, price, event_type || 'large', access_code ? access_code.trim() : null], function(err) {
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
    db.all(`SELECT id, player_name, parent_name, parent_email, status, invitation_sent_at FROM bookings WHERE session_id = ? ORDER BY status ASC, queue_position ASC, created_at ASC`, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ 
            active: rows.filter(r => r.status === 'active'), 
            waitlist: rows.filter(r => r.status === 'waitlist' || r.status === 'pending_payment') 
        });
    });
});

// 10b. Admin Portal: Reorder structural waitlist queue indexes manually
app.post('/api/admin/sessions/:id/reorder-waitlist', verifyAdminToken, (req, res) => {
    const { ordered_ids } = req.body; // Expects array of row IDs in matching array sequence
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

    db.get(`SELECT title FROM sessions WHERE id = ?`, [sessionId], (err, session) => {
        if (err || !session) return res.status(400).json({ error: "Target training session not found." });

        db.all(`SELECT DISTINCT parent_email FROM bookings WHERE session_id = ?`, [sessionId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            if (rows.length === 0) return res.json({ success: true, message: "Broadcast skipped. Roster empty." });

            const emailList = rows.map(r => r.parent_email);
            const mailOptions = {
                from: `"Ben Stadey Hockey Training" <${process.env.EMAIL_USER}>`,
                to: process.env.EMAIL_USER, 
                bcc: emailList, 
                subject: `[SCHEDULE UPDATE] ${session.title} - ${subject}`,
                text: `${message}\n\n---\nDo not reply directly to this automated blast. For any further coordination inquiries, reach out to Ben directly at ben@benstadeyhockey.com.`
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

        // Calculate Capacity Utilization Rate percentages cleanly across active sessions
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

function promoteNextWaitlistPlayer(sessionId, optionalResContext) {
    // Select the player with top sorting priority (lowest queue position, breaking ties with historical creation times)
    const nextUpQuery = `SELECT id, parent_email, parent_name, player_name FROM bookings WHERE session_id = ? AND status = 'waitlist' ORDER BY queue_position ASC, created_at ASC LIMIT 1`;
    
    db.get(nextUpQuery, [sessionId], (err, nextPlayer) => {
        if (err) {
            if (optionalResContext) optionalResContext.status(500).json({ error: err.message });
            return;
        }
        
        if (nextPlayer) {
            const timestampNow = new Date().toISOString();
            
            // Switch status footprint to 'pending_payment' to reserve the open ice slot
            db.run(`UPDATE bookings SET status = 'pending_payment', invitation_sent_at = ? WHERE id = ?`, [timestampNow, nextPlayer.id], (updateErr) => {
                if (updateErr) {
                    if (optionalResContext) optionalResContext.status(500).json({ error: updateErr.message });
                    return;
                }

                // Compile and broadcast the 24-hour checkout claim token notification email link
                const claimUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/claim-spot.html?booking_id=${nextPlayer.id}`;
                const mailOptions = {
                    from: `"Ben Stadey Hockey Training" <${process.env.EMAIL_USER}>`,
                    to: nextPlayer.parent_email,
                    subject: `[ROSTER OPENING] Claim Your Training Spot for ${nextPlayer.player_name}`,
                    text: `Hi ${nextPlayer.parent_name},\n\nA roster opening is available for ${nextPlayer.player_name} in our upcoming training session!\n\nTo lock down this spot, please visit the link below to complete your checkout and secure payment registration parameters:\n\n${claimUrl}\n\n⚠️ IMPORTANT: This link holds your slot for exactly 24 hours. If registration payment is not completed before then, this position will automatically expire and forfeit to the next alternate player in line.\n\nBest regards,\nCoach Ben Stadey`
                };

                transporter.sendMail(mailOptions, (mailErr) => {
                    if (mailErr) console.error("[ERROR] Failed sending waitlist notification email invite:", mailErr.message);
                    
                    if (optionalResContext) {
                        optionalResContext.json({ success: true, message: "Roster vacancy updated. Checkout invite broadcasted to next waitlisted contact." });
                    }
                });
            });
        } else {
            if (optionalResContext) optionalResContext.json({ success: true, message: "Roster position cleared safely. Waitlist bounds are completely empty." });
        }
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Secure Server executing smoothly on network port ${PORT}`));