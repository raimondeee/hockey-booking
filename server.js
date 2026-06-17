const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken'); 
const nodemailer = require('nodemailer'); 
const db = require('./database');
const {
    buildIcsCalendar,
    buildSessionCalendarLinks,
    buildSubscribeLinks,
    formatCalendarLinksText,
    isPublicSession,
    isUpcomingSession
} = require('./calendar-ics');
const {
    buildBookingConfirmationHtml,
    buildBookingConfirmationText,
    buildBookingEmailContext,
    buildBookingConfirmationSubject,
    buildBroadcastEmail,
    buildMovedToWaitlistEmail,
    buildRemovedFromSessionEmail,
    buildRosterOpeningEmail,
    formatSessionWhenPT
} = require('./email-templates');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public')); 

const LOCATION_ADDRESS_MAP = {
    "Sherwood Ice Arena": "20407 SW Borchers Dr, Sherwood, OR 97140",
    "Winterhawks Skating Center - Beaverton": "9250 SW Beaverton Hillsdale Hwy, Beaverton, OR 97005",
    "The Veterans Memorial Coliseum (VMC)": "300 N Winning Way, Portland, OR 97227"
};

// Secure Production Profile Configurations
const ADMIN_USERNAME = process.env.ADMIN_USER || "coach";
const ADMIN_PASSWORD = process.env.ADMIN_PASS; 
const JWT_SECRET = process.env.JWT_SECRET;

// Initialize email transporter (env-configurable; defaults to Gmail SMTP)
const EMAIL_HOST = process.env.EMAIL_HOST || 'smtp.gmail.com';
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || '465', 10);
const EMAIL_SECURE = process.env.EMAIL_SECURE
    ? process.env.EMAIL_SECURE === 'true'
    : EMAIL_PORT === 465;
const EMAIL_USER = (process.env.EMAIL_USER || '').trim();
const EMAIL_PASS = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');
const CONTACT_EMAIL = (process.env.CONTACT_EMAIL || 'ben@benstadeyhockey.com').trim().toLowerCase();
const EMAIL_FROM_NAME = (process.env.EMAIL_FROM_NAME || 'Ben Stadey Hockey Training').trim();

const transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_SECURE,
    requireTLS: !EMAIL_SECURE,
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
    }
});

function buildMailOptions({ to, subject, text, html, bcc }) {
    const options = {
        from: `"${EMAIL_FROM_NAME}" <${EMAIL_USER}>`,
        replyTo: CONTACT_EMAIL,
        to,
        subject,
        text
    };
    if (html) options.html = html;
    if (bcc) options.bcc = bcc;
    return options;
}

function getPublicBaseUrl() {
    const base = process.env.PUBLIC_URL || 'http://localhost:3000';
    return base.replace(/\/+$/, '');
}

// Fail-Safe Boot Checks to shield Ben's server on the open internet
if (!ADMIN_PASSWORD || !JWT_SECRET) {
    console.error("\n[CRITICAL ERROR] Missing vital environment parameters (ADMIN_PASS or JWT_SECRET)!");
    console.error("Please configure these fields immediately in your Render Environment tab Dashboard.\n");
}

if (EMAIL_USER && EMAIL_PASS) {
    console.log(`Email transport configured: host=${EMAIL_HOST} port=${EMAIL_PORT} secure=${EMAIL_SECURE} user=${EMAIL_USER} replyTo=${CONTACT_EMAIL}`);
    transporter.verify((error) => {
        if (error) console.warn("[WARN] Email broadcast engine configuration failed verification:", error.message);
        else console.log("Email broadcast engine successfully connected and authenticated to SMTP host.");
    });
} else {
    console.warn("[WARN] EMAIL_USER or EMAIL_PASS not set — automated emails are disabled.");
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
                maybePromoteNextWaitlistPlayer(booking.session_id);
                
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

const OFFLINE_PAYMENT_WAITLIST_CAP = 40;

const DEFAULT_SITE_SETTINGS = {
    paypal_checkout_enabled: '1',
    banner_enabled: '0',
    banner_message: `Online checkout is temporarily unavailable while our payment provider completes a brief account review. You may still register — all signups are placed on the waitlist until Coach Ben confirms your spot after offline payment. Contact ${CONTACT_EMAIL} with questions.`
};

function seedSiteSettingsIfEmpty() {
    db.get(`SELECT COUNT(*) AS count FROM site_settings`, [], (err, row) => {
        if (err || !row || row.count > 0) return;
        Object.entries(DEFAULT_SITE_SETTINGS).forEach(([key, value]) => {
            db.run(`INSERT INTO site_settings (key, value) VALUES (?, ?)`, [key, value]);
        });
    });
}

seedSiteSettingsIfEmpty();

function getSiteSettings() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT key, value FROM site_settings`, [], (err, rows) => {
            if (err) return reject(err);
            const raw = { ...DEFAULT_SITE_SETTINGS };
            (rows || []).forEach((r) => { raw[r.key] = r.value; });
            resolve({
                paypal_checkout_enabled: raw.paypal_checkout_enabled !== '0',
                banner_enabled: raw.banner_enabled === '1',
                banner_message: raw.banner_message || DEFAULT_SITE_SETTINGS.banner_message,
                offline_waitlist_cap: OFFLINE_PAYMENT_WAITLIST_CAP
            });
        });
    });
}

function upsertSiteSetting(key, value) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO site_settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [key, value],
            (err) => (err ? reject(err) : resolve())
        );
    });
}

function buildPayPalExperienceContext(bookingId) {
    const base = getPublicBaseUrl();
    const claimUrl = `${base}/claim-spot.html?booking_id=${bookingId}`;
    return {
        shipping_preference: 'NO_SHIPPING',
        brand_name: 'Ben Stadey Hockey Training',
        user_action: 'PAY_NOW',
        return_url: `${claimUrl}&paypal_return=1`,
        cancel_url: `${claimUrl}&paypal_cancelled=1`
    };
}

function isRefundablePayPalOrder(paypalOrderId) {
    if (!paypalOrderId) return false;
    if (paypalOrderId === 'WAITLIST_FREE' || paypalOrderId === 'WAIVED_FREE' || paypalOrderId === 'OFFLINE_PAID') return false;
    if (paypalOrderId.startsWith('REFUNDED:')) return false;
    return true;
}

function evaluateSessionArchiveEligibility(session, bookings) {
    if (!session) {
        return { can_archive: false, already_archived: false, reason: 'Session not found.' };
    }
    if (session.archived_at) {
        return { can_archive: false, already_archived: true, reason: 'Session is already archived.' };
    }
    if (!session.cancelled_at) {
        return { can_archive: false, already_archived: false, reason: 'Cancel the session before archiving.' };
    }

    const blockers = [];
    let refundable_remaining = 0;
    let pending_payment_count = 0;
    let active_paid_count = 0;
    let refunded_count = 0;
    let waitlist_count = 0;

    (bookings || []).forEach((booking) => {
        if (booking.status === 'waitlist') waitlist_count += 1;
        if (booking.status === 'pending_payment') {
            pending_payment_count += 1;
            blockers.push(`${booking.player_name}: pending payment invite still open`);
        }
        if (booking.status === 'refunded') refunded_count += 1;
        if (booking.status === 'active' && isRefundablePayPalOrder(booking.paypal_order_id)) {
            active_paid_count += 1;
            refundable_remaining += 1;
            blockers.push(`${booking.player_name}: paid registration not refunded`);
        }
    });

    return {
        can_archive: blockers.length === 0,
        already_archived: false,
        blockers,
        refundable_remaining,
        pending_payment_count,
        active_paid_count,
        refunded_count,
        waitlist_count,
        total_registrations: (bookings || []).length
    };
}

function fetchSessionArchiveEligibility(sessionId, callback) {
    db.get(`SELECT * FROM sessions WHERE id = ?`, [sessionId], (sessionErr, session) => {
        if (sessionErr) return callback(sessionErr);
        if (!session) return callback(null, evaluateSessionArchiveEligibility(null, []));

        db.all(`SELECT * FROM bookings WHERE session_id = ? ORDER BY id ASC`, [sessionId], (bookingsErr, bookings) => {
            if (bookingsErr) return callback(bookingsErr);
            callback(null, {
                session,
                ...evaluateSessionArchiveEligibility(session, bookings),
                bookings: bookings || []
            });
        });
    });
}

async function maybePromoteNextWaitlistPlayer(sessionId, optionalResContext, options = {}) {
    try {
        const siteSettings = await getSiteSettings();
        if (!siteSettings.paypal_checkout_enabled) {
            if (optionalResContext) {
                optionalResContext.json({
                    success: true,
                    message: 'Online checkout is paused — move players from the waitlist manually after offline payment.'
                });
            }
            return;
        }
    } catch (err) {
        if (optionalResContext) optionalResContext.status(500).json({ error: err.message });
        return;
    }
    promoteNextWaitlistPlayer(sessionId, optionalResContext, options);
}

function resolvePayPalOrderId(paypalOrderId) {
    if (paypalOrderId && paypalOrderId.startsWith('REFUNDED:')) {
        return paypalOrderId.slice('REFUNDED:'.length);
    }
    return paypalOrderId;
}

function logSystemEvent(eventType, message, metadata = {}) {
    db.run(
        `INSERT INTO system_logs (event_type, message, metadata) VALUES (?, ?, ?)`,
        [eventType, message, JSON.stringify(metadata)],
        () => {}
    );
}

function isEmailConfigured() {
    return !!(EMAIL_USER && EMAIL_PASS);
}

function resolveLocationAddress(location) {
    return location ? LOCATION_ADDRESS_MAP[location] || '' : '';
}

function buildSessionCalendarExtras(session, playerName) {
    const sessionId = session.id ?? session.session_id;
    const startTime = session.start_time;
    const endTime = session.end_time;
    const sessionPageUrl = sessionId
        ? `${getPublicBaseUrl()}/calendar.html?session_id=${sessionId}`
        : null;

    if (!sessionId || !startTime || !endTime) {
        return { calendarLinks: null, sessionPageUrl };
    }

    const calendarLinks = buildSessionCalendarLinks(
        {
            id: sessionId,
            title: session.title,
            start_time: startTime,
            end_time: endTime,
            location: session.location,
            event_type: session.event_type,
            price: session.price
        },
        getPublicBaseUrl(),
        {
            locationAddressMap: LOCATION_ADDRESS_MAP,
            contactEmail: CONTACT_EMAIL,
            playerName
        }
    );

    return { calendarLinks, sessionPageUrl };
}

function sendBookingConfirmationEmail({
    parentEmail,
    parentName,
    playerName,
    status,
    sessionId,
    sessionTitle,
    startTime,
    endTime,
    location,
    eventType,
    price,
    amountPaid,
    isWaitlist
}) {
    if (!parentEmail) {
        logSystemEvent('EMAIL_SKIPPED', 'Booking confirmation email skipped: missing parent email.', { playerName, sessionTitle });
        return;
    }
    if (!isEmailConfigured()) {
        logSystemEvent('EMAIL_SKIPPED', 'Booking confirmation email skipped: EMAIL_USER/EMAIL_PASS missing.', { parentEmail, playerName, sessionTitle });
        return;
    }

    const locationAddress = location ? LOCATION_ADDRESS_MAP[location] || '' : '';

    const sessionForCal = {
        id: sessionId,
        title: sessionTitle,
        start_time: startTime,
        end_time: endTime,
        location,
        event_type: eventType,
        price
    };
    const calendarLinks = sessionId && startTime && endTime
        ? buildSessionCalendarLinks(sessionForCal, getPublicBaseUrl(), {
            locationAddressMap: LOCATION_ADDRESS_MAP,
            contactEmail: CONTACT_EMAIL,
            playerName
        })
        : null;
    const sessionPageUrl = sessionId
        ? `${getPublicBaseUrl()}/calendar.html?session_id=${sessionId}`
        : null;
    const calendarBlock = calendarLinks
        ? `\n\n${formatCalendarLinksText(calendarLinks, { sessionPageUrl })}`
        : sessionPageUrl
            ? `\n\nView session: ${sessionPageUrl}`
            : '';

    const ctx = buildBookingEmailContext({
        parentName,
        playerName,
        sessionTitle,
        startTime,
        endTime,
        location,
        locationAddress,
        amountPaid,
        isWaitlist,
        price,
        calendarLinks,
        sessionPageUrl,
        contactEmail: CONTACT_EMAIL
    });

    const mailOptions = buildMailOptions({
        to: parentEmail,
        subject: buildBookingConfirmationSubject(playerName, sessionTitle, isWaitlist),
        text: buildBookingConfirmationText(ctx, locationAddress, calendarBlock),
        html: buildBookingConfirmationHtml(ctx, locationAddress)
    });

    transporter.sendMail(mailOptions, (mailErr) => {
        if (mailErr) {
            console.error("[ERROR] Failed sending booking confirmation email:", mailErr.message);
            logSystemEvent('EMAIL_FAILED', 'Booking confirmation email failed.', { parentEmail, playerName, sessionTitle, error: mailErr.message });
            return;
        }
        logSystemEvent('EMAIL_SENT', 'Booking confirmation email sent.', { parentEmail, playerName, sessionTitle, isWaitlist });
    });
}

function sendMovedToWaitlistEmail({
    parentEmail,
    parentName,
    playerName,
    sessionTitle,
    sessionStart,
    sessionEnd,
    location,
    sessionId,
    eventType,
    price
}) {
    if (!parentEmail) {
        logSystemEvent('EMAIL_SKIPPED', 'Moved-to-waitlist email skipped: missing parent email.', { playerName, sessionTitle });
        return;
    }
    if (!isEmailConfigured()) {
        logSystemEvent('EMAIL_SKIPPED', 'Moved-to-waitlist email skipped: EMAIL_USER/EMAIL_PASS missing.', { parentEmail, playerName, sessionTitle });
        return;
    }

    const locationAddress = resolveLocationAddress(location);
    const sessionWhen = formatSessionWhenPT(sessionStart, sessionEnd);
    const { calendarLinks, sessionPageUrl } = buildSessionCalendarExtras(
        { id: sessionId, title: sessionTitle, start_time: sessionStart, end_time: sessionEnd, location, event_type: eventType, price },
        playerName
    );
    const email = buildMovedToWaitlistEmail({
        parentName,
        playerName,
        sessionTitle,
        sessionWhen,
        locationName: location,
        locationAddress,
        calendarLinks,
        sessionPageUrl,
        contactEmail: CONTACT_EMAIL
    });

    const mailOptions = buildMailOptions({
        to: parentEmail,
        subject: `[UPDATE] ${playerName} moved to waitlist — ${sessionTitle}`,
        text: email.text,
        html: email.html
    });

    transporter.sendMail(mailOptions, (mailErr) => {
        if (mailErr) {
            console.error("[ERROR] Failed sending waitlist status email:", mailErr.message);
            logSystemEvent('EMAIL_FAILED', 'Moved-to-waitlist email failed.', { parentEmail, playerName, sessionTitle, error: mailErr.message });
            return;
        }
        logSystemEvent('EMAIL_SENT', 'Moved-to-waitlist email sent.', { parentEmail, playerName, sessionTitle });
    });
}

function sendRemovedFromSessionEmail({
    parentEmail,
    parentName,
    playerName,
    sessionTitle,
    sessionStart,
    sessionEnd,
    location
}) {
    if (!parentEmail) {
        logSystemEvent('EMAIL_SKIPPED', 'Removed-from-session email skipped: missing parent email.', { playerName, sessionTitle });
        return;
    }
    if (!isEmailConfigured()) {
        logSystemEvent('EMAIL_SKIPPED', 'Removed-from-session email skipped: EMAIL_USER/EMAIL_PASS missing.', { parentEmail, playerName, sessionTitle });
        return;
    }

    const locationAddress = resolveLocationAddress(location);
    const sessionWhen = formatSessionWhenPT(sessionStart, sessionEnd);
    const email = buildRemovedFromSessionEmail({
        parentName,
        playerName,
        sessionTitle,
        sessionWhen,
        locationName: location,
        locationAddress,
        contactEmail: CONTACT_EMAIL
    });

    const mailOptions = buildMailOptions({
        to: parentEmail,
        subject: `[UPDATE] ${playerName} removed from session — ${sessionTitle}`,
        text: email.text,
        html: email.html
    });

    transporter.sendMail(mailOptions, (mailErr) => {
        if (mailErr) {
            console.error("[ERROR] Failed sending removed-from-session email:", mailErr.message);
            logSystemEvent('EMAIL_FAILED', 'Removed-from-session email failed.', { parentEmail, playerName, sessionTitle, error: mailErr.message });
            return;
        }
        logSystemEvent('EMAIL_SENT', 'Removed-from-session email sent.', { parentEmail, playerName, sessionTitle });
    });
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
        maybePromoteNextWaitlistPlayer(booking.session_id);
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
        const coachView = tryVerifyCoachToken(req.query.token);
        const visibilityClause = coachView
            ? 'WHERE s.archived_at IS NULL'
            : 'WHERE s.cancelled_at IS NULL AND s.archived_at IS NULL';
        const query = `
            SELECT s.*, 
            SUM(CASE WHEN b.status = 'active' THEN 1 ELSE 0 END) as active_count,
            SUM(CASE WHEN b.status = 'waitlist' OR b.status = 'pending_payment' THEN 1 ELSE 0 END) as waitlist_count
            FROM sessions s
            LEFT JOIN bookings b ON s.id = b.session_id
            ${visibilityClause}
            GROUP BY s.id`;
        
        db.all(query, [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        });
    });
});

// Public iCal feed — subscribe in Google / Apple / Outlook (public sessions only)
app.get('/calendar/sessions.ics', (req, res) => {
    const typeFilter = (req.query.type || '').toLowerCase();
    const nowIso = new Date().toISOString();

    db.all(
        `SELECT id, title, start_time, end_time, price, event_type, access_code, location
         FROM sessions
         WHERE end_time >= ? AND cancelled_at IS NULL AND archived_at IS NULL
         ORDER BY start_time ASC`,
        [nowIso],
        (err, rows) => {
            if (err) return res.status(500).send('Could not build calendar feed.');

            let sessions = (rows || []).filter(isPublicSession).filter(isUpcomingSession);
            if (typeFilter === 'large' || typeFilter === 'small') {
                sessions = sessions.filter((s) => s.event_type === typeFilter);
            }

            const body = buildIcsCalendar(sessions, {
                baseUrl: getPublicBaseUrl(),
                locationAddressMap: LOCATION_ADDRESS_MAP,
                contactEmail: CONTACT_EMAIL,
                calendarName: 'Ben Stadey Hockey - Public Schedule'
            });

            res.set('Content-Type', 'text/calendar; charset=utf-8');
            res.set('Content-Disposition', 'inline; filename="ben-stadey-hockey.ics"');
            res.set('Cache-Control', 'public, max-age=300');
            res.send(body);
        }
    );
});

// Subscribe URLs for the public schedule feed
app.get('/api/calendar/subscribe', (req, res) => {
    res.json({
        success: true,
        ...buildSubscribeLinks(getPublicBaseUrl())
    });
});

// Single session .ics download + calendar link helpers
app.get('/api/sessions/:id/calendar.ics', (req, res) => {
    db.get(
        `SELECT id, title, start_time, end_time, price, event_type, access_code, location, cancelled_at, archived_at
         FROM sessions WHERE id = ?`,
        [req.params.id],
        (err, session) => {
            if (err) return res.status(500).send('Could not build calendar file.');
            if (!session || session.cancelled_at || session.archived_at) return res.status(404).send('Session not found.');

            const body = buildIcsCalendar([session], {
                baseUrl: getPublicBaseUrl(),
                locationAddressMap: LOCATION_ADDRESS_MAP,
                contactEmail: CONTACT_EMAIL,
                calendarName: session.title
            });

            res.set('Content-Type', 'text/calendar; charset=utf-8');
            res.set('Content-Disposition', `attachment; filename="session-${session.id}.ics"`);
            res.send(body);
        }
    );
});

app.get('/api/sessions/:id/calendar-links', (req, res) => {
    db.get(
        `SELECT id, title, start_time, end_time, price, event_type, access_code, location, cancelled_at, archived_at
         FROM sessions WHERE id = ?`,
        [req.params.id],
        (err, session) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!session || session.cancelled_at || session.archived_at) return res.status(404).json({ error: 'Session not found.' });

            res.json({
                success: true,
                links: buildSessionCalendarLinks(session, getPublicBaseUrl(), {
                    locationAddressMap: LOCATION_ADDRESS_MAP,
                    contactEmail: CONTACT_EMAIL
                })
            });
        }
    );
});

// Public site configuration (payment toggle, parent notice banner)
app.get('/api/config/site', async (req, res) => {
    try {
        const settings = await getSiteSettings();
        res.json({
            paypal_checkout_enabled: settings.paypal_checkout_enabled,
            banner_enabled: settings.banner_enabled,
            banner_message: settings.banner_message,
            offline_waitlist_cap: settings.offline_waitlist_cap
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// New Public Endpoint to let frontend pages safely request the active Client ID configuration
app.get('/api/config/paypal-client-id', async (req, res) => {
    try {
        const settings = await getSiteSettings();
        if (!settings.paypal_checkout_enabled) {
            return res.json({ clientId: null, paypal_checkout_enabled: false });
        }
        if (!process.env.PAYPAL_CLIENT_ID) {
            return res.status(500).json({ error: "Merchant client token signature is unassigned on server profiles." });
        }
        res.json({ clientId: process.env.PAYPAL_CLIENT_ID, paypal_checkout_enabled: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/site-settings', verifyAdminToken, async (req, res) => {
    const { paypal_checkout_enabled, banner_enabled, banner_message } = req.body;
    try {
        if (paypal_checkout_enabled !== undefined) {
            await upsertSiteSetting('paypal_checkout_enabled', paypal_checkout_enabled ? '1' : '0');
        }
        if (banner_enabled !== undefined) {
            await upsertSiteSetting('banner_enabled', banner_enabled ? '1' : '0');
        }
        if (banner_message !== undefined) {
            const trimmed = String(banner_message).trim();
            if (!trimmed) return res.status(400).json({ error: 'Banner message cannot be empty.' });
            await upsertSiteSetting('banner_message', trimmed);
        }
        const settings = await getSiteSettings();
        res.json({ success: true, settings });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
    const { session_id, player_name, parent_email, parent_name, paypal_order_id, existing_booking_id, coupon_code } = req.body;
    if (!parent_email) return res.status(400).json({ error: "Parent email pattern is required for mapping." });

    const cleanEmail = parent_email.toLowerCase().trim();

    db.get(`SELECT email FROM banned_emails WHERE email = ?`, [cleanEmail], async (err, banRecord) => {
        if (err) return res.status(500).json({ error: "Internal security handshake check fault." });
        if (banRecord) return res.status(403).json({ error: "Registration denied. Please contact Coach Ben directly for scheduling alternatives." });

        let siteSettings;
        try {
            siteSettings = await getSiteSettings();
        } catch (settingsErr) {
            return res.status(500).json({ error: "Unable to load site configuration." });
        }

        const checkoutPausedMessage = "Online checkout is temporarily unavailable. You have been added to the waitlist — Coach Ben will confirm your spot after payment is arranged offline.";

        const normalizedCouponCode = coupon_code ? String(coupon_code).toUpperCase().trim() : null;

        const resolveCouponForBooking = (callback) => {
            if (!normalizedCouponCode) return callback(null, null);
            db.get(`SELECT * FROM coupons WHERE code = ? AND active = 1`, [normalizedCouponCode], (couponErr, couponRow) => {
                if (couponErr) return callback(couponErr);
                if (!couponRow) return callback(new Error('INVALID_COUPON'));
                callback(null, couponRow);
            });
        };

        resolveCouponForBooking(async (couponErr, couponRow) => {
            if (couponErr) {
                if (couponErr.message === 'INVALID_COUPON') {
                    return res.status(400).json({ error: 'Invalid or expired coupon code.' });
                }
                return res.status(500).json({ error: couponErr.message });
            }

        if (!siteSettings.paypal_checkout_enabled) {
            const isPaidPayPalOrder = paypal_order_id
                && paypal_order_id !== 'WAITLIST_FREE'
                && paypal_order_id !== 'WAIVED_FREE';
            if (isPaidPayPalOrder) {
                return res.status(503).json({ error: checkoutPausedMessage });
            }
        }

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

        db.get(`SELECT title, start_time, end_time, location, event_type, custom_capacity, price, cancelled_at, archived_at FROM sessions WHERE id = ?`, [session_id], (err, session) => {
            if (err || !session) return res.status(400).json({ error: "Target training event session matrix not found." });
            if (session.cancelled_at || session.archived_at) {
                return res.status(400).json({ error: "This session is no longer available for registration." });
            }

            // Honor custom_capacity override if configured, otherwise drop back to template standards
            let maxActive = session.custom_capacity ? session.custom_capacity : (session.event_type === 'small' ? 5 : 25);
            let maxWaitlist = session.event_type === 'small' ? 3 : 15;
            if (!siteSettings.paypal_checkout_enabled) {
                maxWaitlist = OFFLINE_PAYMENT_WAITLIST_CAP;
            }

            // Handle the unique checkout flow for a waitlist player claiming an active position hold
            if (existing_booking_id) {
                if (!siteSettings.paypal_checkout_enabled && session.price > 0) {
                    const hasVerifiedPayment = paypal_order_id
                        && paypal_order_id !== 'WAITLIST_FREE'
                        && paypal_order_id !== 'WAIVED_FREE';
                    if (!hasVerifiedPayment) {
                        return res.status(503).json({ error: checkoutPausedMessage });
                    }
                }

                db.get(`SELECT id, status FROM bookings WHERE id = ? AND session_id = ?`, [existing_booking_id, session_id], (err, bRecord) => {
                    if (err || !bRecord) return res.status(400).json({ error: "Claim token footprint match missing." });
                    
                    db.run(`UPDATE bookings SET status = 'active', paypal_order_id = ?, invitation_sent_at = NULL WHERE id = ?`, [paypal_order_id, existing_booking_id], function(err) {
                        if (err) return res.status(500).json({ error: err.message });
                        db.get(`SELECT player_name, parent_name, parent_email, status FROM bookings WHERE id = ?`, [existing_booking_id], (fetchErr, updatedBooking) => {
                            if (!fetchErr && updatedBooking) {
                                const amountPaid = (paypal_order_id === 'WAIVED_FREE' || paypal_order_id === 'WAITLIST_FREE') ? 0 : session.price;
                                sendBookingConfirmationEmail({
                                    parentEmail: updatedBooking.parent_email,
                                    parentName: updatedBooking.parent_name,
                                    playerName: updatedBooking.player_name,
                                    status: updatedBooking.status,
                                    sessionId: session_id,
                                    sessionTitle: session.title,
                                    startTime: session.start_time,
                                    endTime: session.end_time,
                                    location: session.location,
                                    eventType: session.event_type,
                                    price: session.price,
                                    amountPaid,
                                    isWaitlist: updatedBooking.status === 'waitlist'
                                });
                            }
                        });
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
                let storedOrderId = paypal_order_id || 'WAITLIST_FREE';

                if (!siteSettings.paypal_checkout_enabled) {
                    if (counts.waitlist >= maxWaitlist) {
                        return res.status(400).json({
                            error: `This training session waitlist is completely full (${maxWaitlist} players while online checkout is paused).`
                        });
                    }
                    status = 'waitlist';
                    storedOrderId = 'WAITLIST_FREE';
                } else if (counts.active >= maxActive) {
                    if (counts.waitlist >= maxWaitlist) return res.status(400).json({ error: `This training session and its waitlist bounds are completely full.` });
                    status = 'waitlist';
                }

                const finalizeInsert = (queuePosition) => {
                    const waiverTimestamp = new Date().toISOString();
                    const waiverAcceptedFlag = 1;

                    const insertQuery = `
                        INSERT INTO bookings (
                            session_id, player_name, parent_name, parent_email,
                            status, paypal_order_id, waiver_accepted, waiver_timestamp, queue_position, coupon_code
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

                    const storedCouponCode = couponRow ? couponRow.code : null;

                    db.run(insertQuery, [
                        session_id, player_name, parent_name, cleanEmail, status,
                        storedOrderId, waiverAcceptedFlag, waiverTimestamp, queuePosition, storedCouponCode
                    ], function(insertErr) {
                        if (insertErr) return res.status(500).json({ error: insertErr.message });
                        const amountPaid = (!paypal_order_id || paypal_order_id === 'WAIVED_FREE' || paypal_order_id === 'WAITLIST_FREE') ? 0 : session.price;
                        sendBookingConfirmationEmail({
                            parentEmail: cleanEmail,
                            parentName: parent_name,
                            playerName: player_name,
                            status,
                            sessionId: session_id,
                            sessionTitle: session.title,
                            startTime: session.start_time,
                            endTime: session.end_time,
                            location: session.location,
                            eventType: session.event_type,
                            price: session.price,
                            amountPaid,
                            isWaitlist: status === 'waitlist'
                        });
                        res.json({ success: true, status: status, booking_id: this.lastID });
                    });
                };

                if (status === 'waitlist') {
                    db.get(
                        `SELECT COALESCE(MAX(queue_position), 0) AS max_queue
                         FROM bookings
                         WHERE session_id = ? AND status IN ('waitlist', 'pending_payment')`,
                        [session_id],
                        (queueErr, queueRow) => {
                            if (queueErr) return res.status(500).json({ error: queueErr.message });
                            finalizeInsert((queueRow?.max_queue || 0) + 1);
                        }
                    );
                } else {
                    finalizeInsert(null);
                }
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
               s.id as session_id, s.title, s.start_time, s.price, s.location, s.cancelled_at
        FROM bookings b
        JOIN sessions s ON b.session_id = s.id
        WHERE b.id = ? AND b.status = 'pending_payment'`;

    db.get(query, [booking_id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(400).json({ error: "Invitation record is either invalid, expired, or completed." });
        if (row.cancelled_at || row.archived_at) {
            return res.status(400).json({ error: "This session is no longer available. Please contact Coach Ben for assistance." });
        }
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

function tryVerifyCoachToken(token) {
    if (!token) return false;
    try {
        jwt.verify(token, JWT_SECRET);
        return true;
    } catch (err) {
        return false;
    }
}

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

// 5a. Admin Portal: Update an existing session (time, location, price, etc.)
app.put('/api/admin/sessions/:id', verifyAdminToken, (req, res) => {
    const sessionId = req.params.id;
    const { title, start_time, end_time, price, event_type, access_code, location } = req.body;

    if (!title || !start_time || !end_time) {
        return res.status(400).json({ error: 'Title, start time, and end time are required.' });
    }
    if (new Date(end_time) <= new Date(start_time)) {
        return res.status(400).json({ error: 'End time must be after start time.' });
    }
    if (price == null || isNaN(parseFloat(price)) || parseFloat(price) < 0) {
        return res.status(400).json({ error: 'A valid session price is required.' });
    }

    const type = event_type || 'large';
    const cleanAccessCode = access_code && access_code.trim() ? access_code.trim() : null;

    db.get(
        `SELECT s.custom_capacity,
            (SELECT COUNT(*) FROM bookings WHERE session_id = s.id AND status = 'active') AS active_count
         FROM sessions s WHERE s.id = ?`,
        [sessionId],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Session not found.' });

            const maxActive = row.custom_capacity ? row.custom_capacity : (type === 'small' ? 5 : 25);
            if (row.active_count > maxActive) {
                return res.status(400).json({
                    error: `This session has ${row.active_count} active skaters, which exceeds the ${maxActive}-player limit for the selected format. Increase max roster or remove skaters first.`
                });
            }

            db.run(
                `UPDATE sessions
                 SET title = ?, start_time = ?, end_time = ?, price = ?, event_type = ?, access_code = ?, location = ?
                 WHERE id = ?`,
                [title.trim(), start_time, end_time, parseFloat(price), type, cleanAccessCode, location || null, sessionId],
                function(updateErr) {
                    if (updateErr) return res.status(500).json({ error: updateErr.message });
                    if (this.changes === 0) return res.status(404).json({ error: 'Session not found.' });
                    maybePromoteNextWaitlistPlayer(sessionId);
                    res.json({ success: true, message: 'Session updated successfully.' });
                }
            );
        }
    );
});

// 5b. Admin Portal: Override capacity settings on an individual session block level
app.post('/api/admin/sessions/:id/capacity', verifyAdminToken, (req, res) => {
    const sessionId = req.params.id;
    const capacityVal = req.body.custom_capacity ? parseInt(req.body.custom_capacity) : null;
    
    db.run(`UPDATE sessions SET custom_capacity = ? WHERE id = ?`, [capacityVal, sessionId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        // Immediately run the promotion engine logic to sweep queues for newfound openings!
        maybePromoteNextWaitlistPlayer(sessionId);
        
        res.json({ success: true, message: "Capacity updated and waitlist queue checked dynamically." });
    });
});

// 6. Admin Portal: Cancel a session (soft delete — keeps roster for refunds and email)
app.delete('/api/admin/sessions/:id', verifyAdminToken, (req, res) => {
    const cancelledAt = new Date().toISOString();
    db.run(
        `UPDATE sessions SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL AND archived_at IS NULL`,
        [cancelledAt, req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) {
                return res.status(400).json({ error: 'Session not found, already cancelled, or archived.' });
            }
            logSystemEvent('SESSION_CANCELLED', 'Training session cancelled by coach.', {
                sessionId: req.params.id,
                cancelledAt
            });
            res.json({
                success: true,
                message: 'Session cancelled. It is hidden from parents; roster preserved for refunds and email.'
            });
        }
    );
});

// 6b. Admin Portal: Archive a cancelled session (hidden from Ben's UI, kept for audit)
app.post('/api/admin/sessions/:id/archive-status', verifyAdminToken, (req, res) => {
    fetchSessionArchiveEligibility(req.params.id, (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!result.session) return res.status(404).json({ error: 'Session not found.' });
        res.json({
            success: true,
            session_id: result.session.id,
            title: result.session.title,
            cancelled_at: result.session.cancelled_at,
            archived_at: result.session.archived_at,
            can_archive: result.can_archive,
            already_archived: result.already_archived,
            reason: result.reason || null,
            blockers: result.blockers || [],
            refundable_remaining: result.refundable_remaining || 0,
            pending_payment_count: result.pending_payment_count || 0,
            active_paid_count: result.active_paid_count || 0,
            refunded_count: result.refunded_count || 0,
            waitlist_count: result.waitlist_count || 0,
            total_registrations: result.total_registrations || 0
        });
    });
});

app.post('/api/admin/sessions/:id/archive', verifyAdminToken, (req, res) => {
    fetchSessionArchiveEligibility(req.params.id, (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!result.session) return res.status(404).json({ error: 'Session not found.' });
        if (!result.can_archive) {
            return res.status(400).json({
                error: result.reason || 'Session cannot be archived yet.',
                blockers: result.blockers || []
            });
        }

        const archivedAt = new Date().toISOString();
        db.run(
            `UPDATE sessions SET archived_at = ? WHERE id = ? AND cancelled_at IS NOT NULL AND archived_at IS NULL`,
            [archivedAt, req.params.id],
            function(updateErr) {
                if (updateErr) return res.status(500).json({ error: updateErr.message });
                if (this.changes === 0) {
                    return res.status(400).json({ error: 'Session could not be archived.' });
                }

                logSystemEvent('SESSION_ARCHIVED', `Archived cancelled session "${result.session.title}".`, {
                    sessionId: result.session.id,
                    archivedAt,
                    cancelledAt: result.session.cancelled_at,
                    totalRegistrations: result.total_registrations,
                    refundedCount: result.refunded_count,
                    waitlistCount: result.waitlist_count
                });

                res.json({
                    success: true,
                    message: 'Session archived and removed from your active lists. Records are kept in the Operations audit trail.'
                });
            }
        );
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
    db.get(
        `SELECT b.session_id, b.status, b.parent_email, b.parent_name, b.player_name, s.title, s.start_time, s.end_time, s.location, s.event_type, s.price
         FROM bookings b
         JOIN sessions s ON b.session_id = s.id
         WHERE b.id = ?`,
        [req.params.id],
        (err, booking) => {
        if (err || !booking) return res.status(500).json({ error: "Booking record not found." });
        db.run(`DELETE FROM bookings WHERE id = ?`, [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            sendRemovedFromSessionEmail({
                parentEmail: booking.parent_email,
                parentName: booking.parent_name,
                playerName: booking.player_name,
                sessionTitle: booking.title,
                sessionStart: booking.start_time,
                sessionEnd: booking.end_time,
                location: booking.location
            });
            if (booking.status === 'active') maybePromoteNextWaitlistPlayer(booking.session_id, res);
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
            s.cancelled_at,
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
          AND s.archived_at IS NULL
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
                    cancelled_at: row.cancelled_at,
                    temporal,
                    bookings: []
                });
            }

            const refundable = row.status !== 'refunded' && isRefundablePayPalOrder(row.paypal_order_id);
            const sessionEntry = sessionsMap.get(row.session_id);
            sessionEntry.bookings.push({
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

        const sessions = Array.from(sessionsMap.values()).map((session) => {
            const refundableRemaining = session.bookings.filter((b) => b.refundable).length;
            const pendingPaymentCount = session.bookings.filter((b) => b.status === 'pending_payment').length;
            return {
                ...session,
                refundable_remaining: refundableRemaining,
                pending_payment_count: pendingPaymentCount,
                can_archive: !!session.cancelled_at && refundableRemaining === 0 && pendingPaymentCount === 0
            };
        });
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

// 11a. Admin Portal: Confirm offline payment and move a waitlisted player to the active roster
app.post('/api/admin/bookings/:id/promote', verifyAdminToken, (req, res) => {
    db.get(
        `SELECT b.id, b.session_id, b.status, b.player_name, b.parent_name, b.parent_email,
                s.title, s.start_time, s.end_time, s.location, s.price, s.event_type, s.custom_capacity
         FROM bookings b
         JOIN sessions s ON b.session_id = s.id
         WHERE b.id = ?`,
        [req.params.id],
        (err, booking) => {
            if (err || !booking) return res.status(404).json({ error: 'Booking record not found.' });
            if (!['waitlist', 'pending_payment'].includes(booking.status)) {
                return res.status(400).json({ error: 'Only waitlisted players can be moved to the active roster.' });
            }

            const maxActive = booking.custom_capacity
                ? booking.custom_capacity
                : (booking.event_type === 'small' ? 5 : 25);

            db.get(
                `SELECT COUNT(*) AS active_count FROM bookings WHERE session_id = ? AND status = 'active'`,
                [booking.session_id],
                (countErr, countRow) => {
                    if (countErr) return res.status(500).json({ error: countErr.message });
                    if ((countRow?.active_count || 0) >= maxActive) {
                        return res.status(400).json({ error: `Active roster is full (${maxActive} players). Increase capacity or remove a player first.` });
                    }

                    db.run(
                        `UPDATE bookings
                         SET status = 'active', paypal_order_id = 'OFFLINE_PAID', invitation_sent_at = NULL, queue_position = NULL
                         WHERE id = ?`,
                        [booking.id],
                        function(updateErr) {
                            if (updateErr) return res.status(500).json({ error: updateErr.message });

                            sendBookingConfirmationEmail({
                                parentEmail: booking.parent_email,
                                parentName: booking.parent_name,
                                playerName: booking.player_name,
                                status: 'active',
                                sessionId: booking.session_id,
                                sessionTitle: booking.title,
                                startTime: booking.start_time,
                                endTime: booking.end_time,
                                location: booking.location,
                                eventType: booking.event_type,
                                price: booking.price,
                                amountPaid: booking.price,
                                isWaitlist: false
                            });

                            res.json({
                                success: true,
                                message: `${booking.player_name} moved to the active roster (offline payment recorded).`
                            });
                        }
                    );
                }
            );
        }
    );
});

// 12. Admin Portal: Push active player down to waitlist and pull next player up
app.post('/api/admin/bookings/:id/demote', verifyAdminToken, (req, res) => {
    db.get(
        `SELECT b.session_id, b.parent_email, b.parent_name, b.player_name, s.title, s.start_time, s.end_time, s.location, s.event_type, s.price
         FROM bookings b
         JOIN sessions s ON b.session_id = s.id
         WHERE b.id = ?`,
        [req.params.id],
        (err, booking) => {
        if (err || !booking) return res.status(500).json({ error: "Booking record not found." });
        db.get(
            `SELECT COALESCE(MAX(queue_position), 0) AS max_queue
             FROM bookings
             WHERE session_id = ? AND status IN ('waitlist', 'pending_payment') AND id != ?`,
            [booking.session_id, req.params.id],
            (queueErr, queueRow) => {
                if (queueErr) return res.status(500).json({ error: queueErr.message });
                const nextQueuePos = (queueRow?.max_queue || 0) + 1;

                db.run(
                    `UPDATE bookings
                     SET status = 'waitlist', invitation_sent_at = NULL, queue_position = ?
                     WHERE id = ?`,
                    [nextQueuePos, req.params.id],
                    function(err) {
                        if (err) return res.status(500).json({ error: err.message });
                        sendMovedToWaitlistEmail({
                            parentEmail: booking.parent_email,
                            parentName: booking.parent_name,
                            playerName: booking.player_name,
                            sessionTitle: booking.title,
                            sessionStart: booking.start_time,
                            sessionEnd: booking.end_time,
                            location: booking.location,
                            sessionId: booking.session_id,
                            eventType: booking.event_type,
                            price: booking.price
                        });

                        maybePromoteNextWaitlistPlayer(booking.session_id, res, { excludeBookingId: Number(req.params.id) });
                    }
                );
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

    db.get(`SELECT id, title, start_time, end_time, location, event_type, price, cancelled_at FROM sessions WHERE id = ?`, [sessionId], (err, session) => {
        if (err || !session) return res.status(400).json({ error: "Target training session not found." });

        db.all(`SELECT DISTINCT parent_email FROM bookings WHERE session_id = ?`, [sessionId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            if (rows.length === 0) return res.json({ success: true, message: "Broadcast skipped. Roster empty." });

            const emailList = rows.map(r => r.parent_email);
            const locationAddress = resolveLocationAddress(session.location);
            const sessionWhen = formatSessionWhenPT(session.start_time, session.end_time);
            const { calendarLinks, sessionPageUrl } = buildSessionCalendarExtras(session, null);
            const email = buildBroadcastEmail({
                message,
                sessionTitle: session.title,
                sessionWhen,
                locationName: session.location,
                locationAddress,
                calendarLinks,
                sessionPageUrl,
                contactEmail: CONTACT_EMAIL
            });

            const mailOptions = buildMailOptions({
                to: EMAIL_USER,
                bcc: emailList,
                subject: `[SCHEDULE UPDATE] ${session.title} - ${subject}`,
                text: email.text,
                html: email.html
            });

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
        WHERE b.status = 'active' AND s.archived_at IS NULL`;

    db.get(financeQuery, [], (err, financeRow) => {
        if (err) return res.status(500).json({ error: err.message });

        db.all(`SELECT id, event_type, custom_capacity FROM sessions WHERE archived_at IS NULL`, [], (err, sessions) => {
            if (err) return res.status(500).json({ error: err.message });

            let maxPossibleCapacity = 0;
            sessions.forEach(s => { 
                maxPossibleCapacity += s.custom_capacity ? s.custom_capacity : (s.event_type === 'small' ? 5 : 25); 
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
                    WHEN c.discount_type = 'fixed' THEN MIN(c.discount_value, s.price)
                    WHEN c.discount_type = 'percent' THEN (s.price * (c.discount_value / 100.0))
                    ELSE 0 
                END
            ) as total_revenue_subtracted
        FROM coupons c
        LEFT JOIN bookings b ON UPPER(b.coupon_code) = c.code
            AND b.status IN ('active', 'refunded')
        LEFT JOIN sessions s ON b.session_id = s.id AND s.archived_at IS NULL
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

// 20. Admin Portal: Archived cancelled sessions audit trail
app.post('/api/admin/ledger/archived-sessions', verifyAdminToken, (req, res) => {
    const query = `
        SELECT
            s.id AS session_id,
            s.title,
            s.start_time,
            s.end_time,
            s.price,
            s.location,
            s.event_type,
            s.cancelled_at,
            s.archived_at,
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
        LEFT JOIN bookings b ON b.session_id = s.id
        WHERE s.archived_at IS NOT NULL
        ORDER BY s.archived_at DESC, b.id ASC`;

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const sessionsMap = new Map();
        (rows || []).forEach((row) => {
            if (!sessionsMap.has(row.session_id)) {
                sessionsMap.set(row.session_id, {
                    session_id: row.session_id,
                    title: row.title,
                    start_time: row.start_time,
                    end_time: row.end_time,
                    price: row.price,
                    location: row.location,
                    event_type: row.event_type,
                    cancelled_at: row.cancelled_at,
                    archived_at: row.archived_at,
                    bookings: []
                });
            }
            if (row.booking_id) {
                sessionsMap.get(row.session_id).bookings.push({
                    booking_id: row.booking_id,
                    player_name: row.player_name,
                    parent_name: row.parent_name,
                    parent_email: row.parent_email,
                    status: row.status,
                    paypal_order_id: row.paypal_order_id,
                    refund_amount: row.refund_amount,
                    refunded_at: row.refunded_at,
                    paypal_refund_id: row.paypal_refund_id,
                    booked_at: row.booked_at
                });
            }
        });

        const sessions = Array.from(sessionsMap.values()).map((session) => {
            const refundedCount = session.bookings.filter((b) => b.status === 'refunded').length;
            const activeCount = session.bookings.filter((b) => b.status === 'active').length;
            const waitlistCount = session.bookings.filter((b) => b.status === 'waitlist' || b.status === 'pending_payment').length;
            return {
                ...session,
                total_registrations: session.bookings.length,
                refunded_count: refundedCount,
                active_count: activeCount,
                waitlist_count: waitlistCount
            };
        });

        res.json({
            success: true,
            count: sessions.length,
            sessions
        });
    });
});

async function promoteNextWaitlistPlayer(sessionId, optionalResContext, options = {}) {
    const { excludeBookingId = null } = options;

    db.get(`SELECT cancelled_at, archived_at FROM sessions WHERE id = ?`, [sessionId], (cancelErr, sessionRow) => {
        if (cancelErr) {
            if (optionalResContext) optionalResContext.status(500).json({ error: cancelErr.message });
            return;
        }
        if (sessionRow?.cancelled_at || sessionRow?.archived_at) {
            if (optionalResContext) {
                optionalResContext.json({ success: true, message: 'Session is cancelled — waitlist promotion skipped.' });
            }
            return;
        }

    const nextUpQuery = `
        SELECT b.id, b.parent_email, b.parent_name, b.player_name, s.id as session_id, s.price, s.title, s.location, s.start_time, s.end_time, s.event_type
        FROM bookings b
        JOIN sessions s ON b.session_id = s.id
        WHERE b.session_id = ? AND b.status = 'waitlist' AND (? IS NULL OR b.id != ?)
        ORDER BY b.queue_position ASC, b.created_at ASC
        LIMIT 1`;

    db.get(nextUpQuery, [sessionId, excludeBookingId, excludeBookingId], async (err, nextPlayer) => {
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

            const baseClaimUrl = `${getPublicBaseUrl()}/claim-spot.html?booking_id=${nextPlayer.id}`;

            // Attempt to pre-create a PayPal order so the email contains a direct deep link
            // into PayPal checkout — the parent taps one link and lands straight in the payment flow.
            let deepLinkUrl = baseClaimUrl; // fallback if PayPal order creation fails

            const siteSettings = await getSiteSettings();
            const canPrebuildPayPalOrder = siteSettings.paypal_checkout_enabled
                && nextPlayer.price > 0
                && process.env.PAYPAL_CLIENT_ID
                && process.env.PAYPAL_SECRET;

            if (canPrebuildPayPalOrder) {
                try {
                    const accessToken = await getPayPalAccessToken();
                    const paypalHost = getPayPalHost();

                    const orderRes = await fetch(`${paypalHost}/v2/checkout/orders`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            intent: 'CAPTURE',
                            purchase_units: [{
                                amount: { currency_code: 'USD', value: nextPlayer.price.toFixed(2) },
                                description: `Hockey Training: ${nextPlayer.title} — ${nextPlayer.player_name}`
                            }],
                            payment_source: {
                                paypal: {
                                    experience_context: buildPayPalExperienceContext(nextPlayer.id)
                                }
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
            const checkoutPaused = !siteSettings.paypal_checkout_enabled;
            const paymentInstructions = checkoutPaused
                ? `Online checkout is temporarily unavailable. Please contact Ben at ${CONTACT_EMAIL} to arrange payment and confirm your spot.`
                : (isDeepLink
                    ? 'Tapping the button above will take you directly to PayPal checkout to complete your payment and secure the spot.'
                    : 'Visit the link above to complete your registration and payment.');

            const locationAddress = resolveLocationAddress(nextPlayer.location);
            const sessionWhen = formatSessionWhenPT(nextPlayer.start_time, nextPlayer.end_time);
            const { calendarLinks, sessionPageUrl } = buildSessionCalendarExtras(
                {
                    id: nextPlayer.session_id,
                    title: nextPlayer.title,
                    start_time: nextPlayer.start_time,
                    end_time: nextPlayer.end_time,
                    location: nextPlayer.location,
                    event_type: nextPlayer.event_type,
                    price: nextPlayer.price
                },
                nextPlayer.player_name
            );
            const email = buildRosterOpeningEmail({
                parentName: nextPlayer.parent_name,
                playerName: nextPlayer.player_name,
                sessionTitle: nextPlayer.title,
                sessionWhen,
                locationName: nextPlayer.location,
                locationAddress,
                claimUrl: deepLinkUrl,
                paymentInstructions,
                checkoutPaused,
                calendarLinks,
                sessionPageUrl,
                contactEmail: CONTACT_EMAIL
            });

            const mailOptions = buildMailOptions({
                to: nextPlayer.parent_email,
                subject: `[ROSTER OPENING] Claim Your Training Spot for ${nextPlayer.player_name}`,
                text: email.text,
                html: email.html
            });

            transporter.sendMail(mailOptions, (mailErr) => {
                if (mailErr) console.error("[ERROR] Failed sending waitlist promotion email:", mailErr.message);

                if (optionalResContext) {
                    optionalResContext.json({ success: true, message: "Roster vacancy updated. Checkout invite broadcasted to next waitlisted contact." });
                }
            });
        });
    });
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Secure Server executing smoothly on network port ${PORT}`));