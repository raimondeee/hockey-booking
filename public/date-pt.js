const PT_TIME_ZONE = 'America/Los_Angeles';

function parseDbUtcTimestamp(value) {
    if (!value) return null;
    const s = String(value).trim();
    if (!s) return null;
    if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s)) return new Date(s);
    const normalized = s.includes('T') ? s : s.replace(' ', 'T');
    return new Date(`${normalized}Z`);
}

function formatDateTimePT(value, options = {}) {
    const { includeSeconds = true, includeWeekday = false } = options;
    const d = value instanceof Date ? value : parseDbUtcTimestamp(value);
    if (!d || Number.isNaN(d.getTime())) return '—';

    const formatOptions = {
        timeZone: PT_TIME_ZONE,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short'
    };
    if (includeSeconds) formatOptions.second = '2-digit';
    if (includeWeekday) formatOptions.weekday = 'short';

    return d.toLocaleString('en-US', formatOptions);
}
