const CALENDAR_TZ = 'America/Los_Angeles';
const CALENDAR_DOMAIN = 'benstadeyhockey.com';

/** Session times in the DB are Pacific wall-clock strings (no offset). */
function parseWallClockParts(isoString) {
    const m = String(isoString || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return {
        year: m[1],
        month: m[2],
        day: m[3],
        hour: m[4],
        minute: m[5],
        second: m[6] || '00'
    };
}

function formatGoogleCalDatePT(isoString) {
    const parts = parseWallClockParts(isoString);
    if (!parts) return '';
    return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
}

/** Convert a Pacific wall-clock session time to the correct UTC instant. */
function wallClockPtToUtcDate(isoString) {
    const parts = parseWallClockParts(isoString);
    if (!parts) return null;

    const year = parseInt(parts.year, 10);
    const month = parseInt(parts.month, 10);
    const day = parseInt(parts.day, 10);
    const hour = parseInt(parts.hour, 10);
    const minute = parseInt(parts.minute, 10);
    const second = parseInt(parts.second, 10);

    let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);

    for (let i = 0; i < 6; i++) {
        const formatted = new Intl.DateTimeFormat('en-US', {
            timeZone: CALENDAR_TZ,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23'
        }).formatToParts(new Date(utcMs));
        const get = (type) => parseInt(formatted.find((p) => p.type === type)?.value || '0', 10);

        const py = get('year');
        const pm = get('month');
        const pd = get('day');
        const ph = get('hour');
        const pmin = get('minute');
        const ps = get('second');

        if (py === year && pm === month && pd === day && ph === hour && pmin === minute && ps === second) {
            return new Date(utcMs);
        }

        const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
        const ptDisplayedAsUtc = Date.UTC(py, pm - 1, pd, ph, pmin, ps);
        utcMs += desiredAsUtc - ptDisplayedAsUtc;
    }

    return new Date(utcMs);
}

function formatIcsUtcZFromWallClockPT(isoString) {
    const d = wallClockPtToUtcDate(isoString);
    if (!d || Number.isNaN(d.getTime())) return null;
    return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function escapeIcsText(value) {
    if (value == null) return '';
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/,/g, '\\,')
        .replace(/;/g, '\\;');
}

function toGoogleCalUtc(isoString) {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function buildSessionLocation(session, locationAddressMap = {}) {
    const name = session.location || '';
    const address = name && locationAddressMap[name] ? locationAddressMap[name] : '';
    if (name && address) return `${name}, ${address}`;
    return name || address || '';
}

function buildSessionDescription(session, extras = {}) {
    const lines = [
        'Ben Stadey Hockey Training',
        session.event_type === 'small' ? 'Small group session' : 'Large group clinic'
    ];
    if (extras.playerName) lines.push(`Player: ${extras.playerName}`);
    if (session.price != null && session.price > 0) {
        lines.push(`Session cost: $${parseFloat(session.price).toFixed(2)}`);
    }
    lines.push(`Questions: ${extras.contactEmail || 'ben@benstadeyhockey.com'}`);
    return lines.join('\n');
}

function sessionToVevent(session, options = {}) {
    const start = formatIcsUtcZFromWallClockPT(session.start_time);
    const end = formatIcsUtcZFromWallClockPT(session.end_time);
    if (!start || !end) return '';

    const location = buildSessionLocation(session, options.locationAddressMap);
    const summary = escapeIcsText(session.title);
    const description = escapeIcsText(buildSessionDescription(session, options));
    const uid = `session-${session.id}@${CALENDAR_DOMAIN}`;
    const dtstamp = toGoogleCalUtc(new Date().toISOString());
    const url = options.baseUrl
        ? `${options.baseUrl.replace(/\/+$/, '')}/calendar.html?session_id=${session.id}`
        : '';

    let event = [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART:${start}`,
        `DTEND:${end}`,
        `SUMMARY:${summary}`
    ];

    if (description) event.push(`DESCRIPTION:${description}`);
    if (location) event.push(`LOCATION:${escapeIcsText(location)}`);
    if (url) event.push(`URL:${escapeIcsText(url)}`);
    event.push('END:VEVENT');
    return event.join('\r\n');
}

function buildIcsCalendar(sessions, options = {}) {
    const calendarName = options.calendarName || 'Ben Stadey Hockey Training';
    const events = sessions
        .map((s) => sessionToVevent(s, options))
        .filter(Boolean)
        .join('\r\n');

    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Ben Stadey Hockey//Training Schedule//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
        `X-WR-TIMEZONE:${CALENDAR_TZ}`,
        events,
        'END:VCALENDAR',
        ''
    ].join('\r\n');
}

function buildGoogleCalendarUrl(session, options = {}) {
    const start = formatGoogleCalDatePT(session.start_time);
    const end = formatGoogleCalDatePT(session.end_time);
    if (!start || !end) return '';

    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: session.title,
        dates: `${start}/${end}`,
        ctz: CALENDAR_TZ,
        details: buildSessionDescription(session, options),
        location: buildSessionLocation(session, options.locationAddressMap || {})
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function buildSessionCalendarLinks(session, baseUrl, options = {}) {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const icsPath = `/api/sessions/${session.id}/calendar.ics`;
    const icsUrl = `${cleanBase}${icsPath}`;
    const webcalUrl = icsUrl.replace(/^https?:/, 'webcal:');

    return {
        session_id: session.id,
        google: buildGoogleCalendarUrl(session, options),
        ics: icsUrl,
        webcal: webcalUrl
    };
}

function buildSubscribeLinks(baseUrl) {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const feedUrl = `${cleanBase}/calendar/sessions.ics`;
    const webcalUrl = feedUrl.replace(/^https?:/, 'webcal:');
    // Google’s cid= deep link often rejects https:// feeds but accepts webcal:// (manual “From URL” still uses https).
    return {
        feed: feedUrl,
        webcal: webcalUrl,
        googleSubscribe: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`,
        googleManualUrl: feedUrl
    };
}

function formatCalendarLinksText(links, extras = {}) {
    const lines = ['Add to your calendar:'];
    if (extras.sessionPageUrl) {
        lines.push(`View session: ${extras.sessionPageUrl}`);
    }
    lines.push(
        `Google Calendar: ${links.google}`,
        `Download .ics (Apple / Outlook): ${links.ics}`
    );
    return lines.join('\n');
}

function isPublicSession(session) {
    return !session.access_code || String(session.access_code).trim() === '';
}

function isUpcomingSession(session, now = new Date()) {
    const end = new Date(session.end_time);
    return !Number.isNaN(end.getTime()) && end >= now;
}

module.exports = {
    buildIcsCalendar,
    buildSessionCalendarLinks,
    buildSubscribeLinks,
    formatCalendarLinksText,
    isPublicSession,
    isUpcomingSession,
    sessionToVevent
};
