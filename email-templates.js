const CALENDAR_TZ = 'America/Los_Angeles';
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_CONTACT_EMAIL = 'ben@benstadeyhockey.com';
const GREETING_MARGIN_BOTTOM = '16px';
const MESSAGE_BEFORE_SESSION_MARGIN_BOTTOM = '32px';

function buildGreetingHtml(name) {
    const parent = name || 'there';
    return `<p style="margin:0 0 ${GREETING_MARGIN_BOTTOM} 0;">Hi <strong>${escapeHtml(parent)}</strong>,</p>`;
}

function buildIntroMessageHtml(contentHtml) {
    return `<p style="margin:0 0 ${MESSAGE_BEFORE_SESSION_MARGIN_BOTTOM} 0;">${contentHtml}</p>`;
}

function buildDraftMessageHtml(message) {
    return `<div style="margin:0 0 ${MESSAGE_BEFORE_SESSION_MARGIN_BOTTOM} 0;line-height:1.6;">${formatPlainTextAsHtml(message)}</div>`;
}

function messageBeforeSessionDetailsText() {
    return '\n\n';
}

function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatPlainTextAsHtml(text) {
    if (text == null) return '';
    const escaped = escapeHtml(String(text));
    return escaped
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0070ba;">$1</a>')
        .replace(/\n/g, '<br>');
}

function parseWallClockParts(isoString) {
    const m = String(isoString || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) return null;
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    const hour24 = parseInt(m[4], 10);
    const minute = m[5];
    const weekday = WEEKDAYS_SHORT[new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay()];
    const hour12 = hour24 % 12 || 12;
    const ampm = hour24 >= 12 ? 'PM' : 'AM';
    return {
        dateLabel: `${weekday}, ${MONTHS_SHORT[month - 1]} ${day}`,
        timeLabel: `${hour12}:${minute} ${ampm}`
    };
}

function formatTimePT(isoString) {
    const wall = parseWallClockParts(isoString);
    if (wall) return wall.timeLabel;
    if (!isoString) return '';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', {
        timeZone: CALENDAR_TZ,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

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
    if (!d || Number.isNaN(d.getTime())) return '';

    const formatOptions = {
        timeZone: CALENDAR_TZ,
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

function formatSessionWhenPT(startTime, endTime) {
    const startWall = parseWallClockParts(startTime);
    if (startWall) {
        const endWall = endTime ? parseWallClockParts(endTime) : null;
        if (endWall) {
            return `${startWall.dateLabel}, ${startWall.timeLabel} – ${endWall.timeLabel} PT`;
        }
        return `${startWall.dateLabel}, ${startWall.timeLabel} PT`;
    }

    if (!startTime) return 'TBD';
    const start = new Date(startTime);
    if (Number.isNaN(start.getTime())) return 'TBD';

    const datePart = start.toLocaleString('en-US', {
        timeZone: CALENDAR_TZ,
        weekday: 'short',
        month: 'short',
        day: 'numeric'
    });
    const startClock = formatTimePT(startTime);
    const endClock = endTime ? formatTimePT(endTime) : '';
    if (startClock && endClock) {
        return `${datePart}, ${startClock} – ${endClock} PT`;
    }
    if (startClock) {
        return `${datePart}, ${startClock} PT`;
    }
    return datePart;
}

function buildBrandedEmailHtml({
    preheader = '',
    headerTitle,
    bodyHtml,
    footerNote = 'Questions? Reply to this email or contact us below.',
    contactEmail = DEFAULT_CONTACT_EMAIL
}) {
    const preheaderBlock = preheader
        ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>`
        : '';

    return `${preheaderBlock}
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;color:#333333;">
  <div style="background-color:#003366;color:#ffffff;padding:24px 20px;text-align:center;">
    <p style="margin:0 0 6px 0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.9;">Ben Stadey Hockey Training</p>
    <h1 style="margin:0;font-size:22px;font-weight:bold;">${escapeHtml(headerTitle)}</h1>
  </div>
  <div style="padding:24px 20px;line-height:1.6;font-size:15px;">
    ${bodyHtml}
    <p style="margin:20px 0 0 0;">Best regards,<br><strong>Coach Ben Stadey</strong><br><span style="font-size:13px;color:#666;">Ben Stadey Hockey Training</span></p>
  </div>
  <div style="background-color:#f4f4f4;padding:16px;text-align:center;font-size:12px;color:#777777;line-height:1.5;">
    <p style="margin:0 0 6px 0;">${escapeHtml(footerNote)}</p>
    <p style="margin:0;">Contact <a href="mailto:${escapeHtml(contactEmail)}" style="color:#003366;">${escapeHtml(contactEmail)}</a></p>
  </div>
</div>`;
}

function buildBrandedEmailText(bodyText, footerNote, contactEmail = DEFAULT_CONTACT_EMAIL) {
    return `${bodyText}

Best regards,
Coach Ben Stadey
Ben Stadey Hockey Training

${footerNote}
Contact ${contactEmail}`;
}

function buildSessionDetailsBoxHtml({
    sessionTitle,
    sessionWhen,
    locationName,
    locationAddress,
    extraLinesHtml = ''
}) {
    const whenLine = sessionWhen
        ? `<p style="margin:0 0 8px 0;"><strong>Date &amp; time:</strong> ${escapeHtml(sessionWhen)}</p>`
        : '';
    const rinkLine = locationName
        ? `<p style="margin:0 0 8px 0;"><strong>Rink:</strong> ${escapeHtml(locationName)}</p>`
        : '';
    const addressLine = locationAddress
        ? `<p style="margin:0 0 8px 0;"><strong>Address:</strong> ${escapeHtml(locationAddress)}</p>`
        : '';

    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9f9f9;border-left:4px solid #003366;margin:0 0 20px 0;">
      <tr>
        <td style="padding:16px;">
          <h2 style="margin:0 0 12px 0;font-size:16px;color:#003366;">Session details</h2>
          <p style="margin:0 0 8px 0;"><strong>Session:</strong> ${escapeHtml(sessionTitle)}</p>
          ${whenLine}
          ${rinkLine}
          ${addressLine}
          ${extraLinesHtml}
        </td>
      </tr>
    </table>`;
}

function buildSessionDetailsText(sessionTitle, sessionWhen, locationName, locationAddress) {
    const lines = [`Session: ${sessionTitle}`];
    if (sessionWhen) lines.push(`Date & time: ${sessionWhen}`);
    if (locationName) lines.push(`Rink: ${locationName}`);
    if (locationAddress) lines.push(`Address: ${locationAddress}`);
    return lines.join('\n');
}

function buildPrimaryButtonHtml(label, url) {
    if (!url) return '';
    return `<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto 16px auto;">
      <tr>
        <td style="background-color:#0070ba;border-radius:6px;">
          <a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>`;
}

function buildWarningBoxHtml(text) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff8e6;border:1px solid #ffc107;border-radius:6px;margin:0 0 16px 0;">
      <tr>
        <td style="padding:12px 14px;font-size:14px;color:#856404;line-height:1.5;">${formatPlainTextAsHtml(text)}</td>
      </tr>
    </table>`;
}

function buildCalendarSectionHtml(calendarLinks, sessionPageUrl) {
    if (!calendarLinks && !sessionPageUrl) return '';

    const googleBtn = calendarLinks?.google
        ? buildPrimaryButtonHtml('Add to Google Calendar', calendarLinks.google)
        : '';

    const icsBtn = calendarLinks?.ics
        ? `<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto 12px auto;">
            <tr>
              <td style="background-color:#ffffff;border:1px solid #0070ba;border-radius:6px;">
                <a href="${escapeHtml(calendarLinks.ics)}" target="_blank" style="display:inline-block;padding:11px 20px;color:#0070ba;text-decoration:none;font-weight:bold;font-size:14px;">Download .ics (Apple / Outlook)</a>
              </td>
            </tr>
          </table>`
        : '';

    const sessionLink = sessionPageUrl
        ? `<p style="margin:0;font-size:13px;text-align:center;"><a href="${escapeHtml(sessionPageUrl)}" style="color:#0070ba;">View session on benstadeyhockey.com</a></p>`
        : '';

    if (!googleBtn && !icsBtn && !sessionLink) return '';

    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef4fa;border:1px solid #c5d9eb;border-radius:6px;margin:0 0 20px 0;">
      <tr>
        <td style="padding:16px;text-align:center;">
          <p style="margin:0 0 12px 0;font-size:14px;font-weight:bold;color:#003366;">Add to your calendar</p>
          ${googleBtn}
          ${icsBtn}
          ${sessionLink}
        </td>
      </tr>
    </table>`;
}

function buildCalendarLinksText(links, sessionPageUrl) {
    const lines = ['Add to your calendar:'];
    if (sessionPageUrl) lines.push(`View session: ${sessionPageUrl}`);
    if (links?.google) lines.push(`Google Calendar: ${links.google}`);
    if (links?.ics) lines.push(`Download .ics (Apple / Outlook): ${links.ics}`);
    return lines.join('\n');
}

function buildAmountDisplay(amountPaid, isWaitlist, sessionPrice) {
    const paid = amountPaid != null ? parseFloat(amountPaid) : null;
    const formatted = paid != null ? `$${paid.toFixed(2)}` : 'N/A';
    let note = '';
    if (paid === 0) {
        if (isWaitlist) note = 'waitlist — no charge';
        else if (sessionPrice != null && parseFloat(sessionPrice) === 0) note = 'complimentary session';
        else note = 'no payment processed';
    }
    return { formatted, note };
}

function buildBookingEmailContext({
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
    contactEmail
}) {
    const parent = parentName || 'there';
    const locationName = location || 'Location TBD';
    const sessionWhen = formatSessionWhenPT(startTime, endTime);
    const statusLabel = isWaitlist ? 'Waitlist' : 'Active roster';
    const { formatted: amountFormatted, note: amountNote } = buildAmountDisplay(amountPaid, isWaitlist, price);
    const headerTitle = isWaitlist ? 'Waitlist Registration' : 'Registration Confirmed';
    const introHtml = isWaitlist
        ? `<strong>${escapeHtml(playerName)}</strong> has been added to the <strong>waitlist</strong> for the session below. You&rsquo;ll be contacted if a spot opens.`
        : `Great news &mdash; <strong>${escapeHtml(playerName)}</strong> is confirmed on the <strong>active roster</strong> for your upcoming session.`;
    const introText = isWaitlist
        ? `${playerName} has been added to the waitlist for "${sessionTitle}". You'll be contacted if a spot opens.`
        : `${playerName} is now registered for "${sessionTitle}".`;

    return {
        parent,
        playerName,
        sessionTitle,
        sessionWhen,
        locationName,
        locationAddress,
        statusLabel,
        amountFormatted,
        amountNote,
        headerTitle,
        introHtml,
        introText,
        isWaitlist,
        calendarLinks,
        sessionPageUrl,
        contactEmail: contactEmail || DEFAULT_CONTACT_EMAIL
    };
}

function buildBookingConfirmationHtml(ctx, locationAddress) {
    const amountNoteHtml = ctx.amountNote
        ? ` <span style="color:#666;">(${escapeHtml(ctx.amountNote)})</span>`
        : '';
    const extraLinesHtml = `
          <p style="margin:0 0 8px 0;"><strong>Status:</strong> ${escapeHtml(ctx.statusLabel)}</p>
          <p style="margin:0;"><strong>Amount processed:</strong> ${escapeHtml(ctx.amountFormatted)}${amountNoteHtml}</p>`;

    const bodyHtml = `
    ${buildGreetingHtml(ctx.parent)}
    ${buildIntroMessageHtml(ctx.introHtml)}
    ${buildSessionDetailsBoxHtml({
        sessionTitle: ctx.sessionTitle,
        sessionWhen: ctx.sessionWhen,
        locationName: ctx.locationName,
        locationAddress,
        extraLinesHtml
    })}
    ${buildCalendarSectionHtml(ctx.calendarLinks, ctx.sessionPageUrl)}
    <p style="margin:0 0 12px 0;font-size:14px;color:#555;"><strong>Before you arrive:</strong> Please arrive a few minutes early with full hockey equipment (helmet, skates, stick, gloves, etc.) unless Coach Ben has told you otherwise.</p>
    <p style="margin:0;">If you need to reschedule or have questions, reply to this email &mdash; we&rsquo;re happy to help.</p>`;

    return buildBrandedEmailHtml({
        preheader: `${ctx.playerName} — ${ctx.sessionTitle} on ${ctx.sessionWhen}`,
        headerTitle: ctx.headerTitle,
        bodyHtml,
        footerNote: 'This is your automated registration confirmation.',
        contactEmail: ctx.contactEmail
    });
}

function buildBookingConfirmationText(ctx, locationAddress, calendarBlock) {
    const rinkLines = [];
    if (ctx.locationName && ctx.locationName !== 'Location TBD') {
        rinkLines.push(`Rink: ${ctx.locationName}`);
        if (locationAddress) rinkLines.push(`Address: ${locationAddress}`);
    }
    const rinkBlock = rinkLines.length ? `\n${rinkLines.join('\n')}` : '';
    const amountLine = ctx.amountNote
        ? `Amount processed: ${ctx.amountFormatted} (${ctx.amountNote})`
        : `Amount processed: ${ctx.amountFormatted}`;

    const bodyText = `Hi ${ctx.parent},

${ctx.introText}${messageBeforeSessionDetailsText()}Status: ${ctx.statusLabel}
${amountLine}
Session time: ${ctx.sessionWhen}${rinkBlock}

This is your automated confirmation/receipt email.${calendarBlock}

Before you arrive: Please arrive a few minutes early with full hockey equipment unless Coach Ben has told you otherwise.

If you have questions, reply to this email or contact ${ctx.contactEmail}.`;

    return buildBrandedEmailText(bodyText, 'This is your automated registration confirmation.', ctx.contactEmail);
}

function buildBookingConfirmationSubject(playerName, sessionTitle, isWaitlist) {
    const tag = isWaitlist ? 'WAITLIST' : 'CONFIRMED';
    return `[${tag}] ${playerName} — ${sessionTitle}`;
}

function buildBatchRegistrationEmail({
    parentName,
    lineItems,
    totalPaid,
    checkoutPaused,
    contactEmail
}) {
    const parent = parentName || 'there';
    const hasWaitlist = lineItems.some((item) => item.status === 'waitlist');
    const headerTitle = hasWaitlist ? 'Registration Received' : 'Registration Confirmed';
    const totalFormatted = `$${parseFloat(totalPaid || 0).toFixed(2)}`;
    const totalNote = checkoutPaused || totalPaid <= 0 ? 'payment pending / waitlist' : 'paid via PayPal';

    const lineItemsHtml = lineItems.map((item) => {
        const playersHtml = item.players.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
        const statusLabel = item.status === 'waitlist' ? 'Waitlist' : 'Active roster';
        const amountLine = item.lineTotal != null
            ? `<p style="margin:0 0 6px 0;font-size:13px;color:#555;"><strong>Line total:</strong> $${parseFloat(item.lineTotal).toFixed(2)}</p>`
            : '';
        return `
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin-bottom:12px;">
            <p style="margin:0 0 6px 0;font-size:15px;font-weight:bold;color:#1e293b;">${escapeHtml(item.sessionTitle)}</p>
            <p style="margin:0 0 6px 0;font-size:13px;color:#555;">${escapeHtml(item.sessionWhen)}</p>
            <p style="margin:0 0 8px 0;font-size:13px;color:#555;"><strong>Rink:</strong> ${escapeHtml(item.locationName || 'Location TBD')}</p>
            <p style="margin:0 0 4px 0;font-size:13px;color:#555;"><strong>Players:</strong></p>
            <ul style="margin:0 0 8px 18px;padding:0;font-size:13px;color:#333;">${playersHtml}</ul>
            <p style="margin:0 0 6px 0;font-size:13px;color:#555;"><strong>Status:</strong> ${escapeHtml(statusLabel)}</p>
            ${amountLine}
        </div>`;
    }).join('');

    const lineItemsText = lineItems.map((item) => {
        const players = item.players.join(', ');
        const statusLabel = item.status === 'waitlist' ? 'Waitlist' : 'Active roster';
        return `- ${item.sessionTitle} (${item.sessionWhen})\n  Players: ${players}\n  Status: ${statusLabel}`;
    }).join('\n\n');

    const introHtml = hasWaitlist
        ? 'Thank you for registering. One or more entries below are on the <strong>waitlist</strong>. Coach Ben will contact you if a spot opens or to arrange payment.'
        : 'Thank you — your registration is confirmed for the session(s) below.';

    const bodyHtml = `
    ${buildGreetingHtml(parent)}
    ${buildIntroMessageHtml(introHtml)}
    ${lineItemsHtml}
    <p style="margin:0 0 8px 0;font-size:14px;color:#333;"><strong>Order total processed:</strong> ${escapeHtml(totalFormatted)} <span style="color:#666;">(${escapeHtml(totalNote)})</span></p>
    <p style="margin:0;">If you have questions, reply to this email — we&rsquo;re happy to help.</p>`;

    const bodyText = `Hi ${parent},

${hasWaitlist
        ? 'Thank you for registering. One or more entries are on the waitlist.'
        : 'Thank you — your registration is confirmed.'}

${lineItemsText}

Order total processed: ${totalFormatted} (${totalNote})

If you have questions, reply to this email.`;

    return {
        subject: hasWaitlist
            ? `[WAITLIST] Registration — ${lineItems.length} session(s)`
            : `[CONFIRMED] Registration — ${lineItems.length} session(s)`,
        html: buildBrandedEmailHtml({
            preheader: `Registration for ${lineItems.length} session(s)`,
            headerTitle,
            bodyHtml,
            footerNote: 'This is your automated registration confirmation.',
            contactEmail: contactEmail || DEFAULT_CONTACT_EMAIL
        }),
        text: buildBrandedEmailText(bodyText, 'This is your automated registration confirmation.', contactEmail || DEFAULT_CONTACT_EMAIL)
    };
}

function buildBroadcastEmail({
    message,
    sessionTitle,
    sessionWhen,
    locationName,
    locationAddress,
    calendarLinks,
    sessionPageUrl,
    contactEmail
}) {
    const sessionDetails = buildSessionDetailsText(sessionTitle, sessionWhen, locationName, locationAddress);
    const calendarBlock = calendarLinks || sessionPageUrl
        ? `\n\n${buildCalendarLinksText(calendarLinks, sessionPageUrl)}`
        : '';

    const bodyText = `${message}${messageBeforeSessionDetailsText()}---
${sessionDetails}${calendarBlock}

Replies go to ${contactEmail}. For coordination questions, contact Ben at ${contactEmail}.`;

    const bodyHtml = `
    ${buildDraftMessageHtml(message)}
    ${buildSessionDetailsBoxHtml({ sessionTitle, sessionWhen, locationName, locationAddress })}
    ${buildCalendarSectionHtml(calendarLinks, sessionPageUrl)}
    <p style="margin:0;font-size:14px;color:#555;">Replies go to ${escapeHtml(contactEmail)}. For coordination questions, contact Coach Ben at <a href="mailto:${escapeHtml(contactEmail)}" style="color:#0070ba;">${escapeHtml(contactEmail)}</a>.</p>`;

    return {
        text: buildBrandedEmailText(bodyText, 'Schedule update from Ben Stadey Hockey Training.', contactEmail),
        html: buildBrandedEmailHtml({
            preheader: `${sessionTitle} — schedule update`,
            headerTitle: 'Schedule Update',
            bodyHtml,
            footerNote: 'Schedule update from Ben Stadey Hockey Training.',
            contactEmail
        })
    };
}

function buildMovedToWaitlistEmail({
    parentName,
    playerName,
    sessionTitle,
    sessionWhen,
    locationName,
    locationAddress,
    calendarLinks,
    sessionPageUrl,
    contactEmail
}) {
    const parent = parentName || 'there';
    const sessionDetails = buildSessionDetailsText(sessionTitle, sessionWhen, locationName, locationAddress);
    const calendarBlock = calendarLinks || sessionPageUrl
        ? `\n\n${buildCalendarLinksText(calendarLinks, sessionPageUrl)}`
        : '';

    const bodyText = `Hi ${parent},

${playerName} has been moved from the active roster to the waitlist for "${sessionTitle}".${messageBeforeSessionDetailsText()}${sessionDetails}${calendarBlock}

If a roster spot opens, you'll automatically receive an email with next steps.

If you have questions, reply to this email or contact ${contactEmail}.`;

    const bodyHtml = `
    ${buildGreetingHtml(parent)}
    ${buildIntroMessageHtml(`<strong>${escapeHtml(playerName)}</strong> has been moved from the active roster to the <strong>waitlist</strong> for the session below.`)}
    ${buildSessionDetailsBoxHtml({ sessionTitle, sessionWhen, locationName, locationAddress })}
    ${buildCalendarSectionHtml(calendarLinks, sessionPageUrl)}
    <p style="margin:0;">If a roster spot opens, you&rsquo;ll automatically receive an email with next steps. If you have questions, reply to this email.</p>`;

    return {
        text: buildBrandedEmailText(bodyText, 'Automated roster update from Ben Stadey Hockey Training.', contactEmail),
        html: buildBrandedEmailHtml({
            preheader: `${playerName} moved to waitlist — ${sessionTitle}`,
            headerTitle: 'Roster Update',
            bodyHtml,
            footerNote: 'Automated roster update from Ben Stadey Hockey Training.',
            contactEmail
        })
    };
}

function buildRemovedFromSessionEmail({
    parentName,
    playerName,
    sessionTitle,
    sessionWhen,
    locationName,
    locationAddress,
    contactEmail
}) {
    const parent = parentName || 'there';
    const sessionDetails = buildSessionDetailsText(sessionTitle, sessionWhen, locationName, locationAddress);

    const bodyText = `Hi ${parent},

${playerName} has been removed from "${sessionTitle}".${messageBeforeSessionDetailsText()}${sessionDetails}

If this was unexpected, please reply or contact ${contactEmail}.`;

    const bodyHtml = `
    ${buildGreetingHtml(parent)}
    ${buildIntroMessageHtml(`<strong>${escapeHtml(playerName)}</strong> has been removed from the session below.`)}
    ${buildSessionDetailsBoxHtml({ sessionTitle, sessionWhen, locationName, locationAddress })}
    <p style="margin:0;">If this was unexpected, please reply to this email or contact Coach Ben.</p>`;

    return {
        text: buildBrandedEmailText(bodyText, 'Automated registration update from Ben Stadey Hockey Training.', contactEmail),
        html: buildBrandedEmailHtml({
            preheader: `${playerName} removed from ${sessionTitle}`,
            headerTitle: 'Registration Update',
            bodyHtml,
            footerNote: 'Automated registration update from Ben Stadey Hockey Training.',
            contactEmail
        })
    };
}

function buildRosterOpeningEmail({
    parentName,
    playerName,
    sessionTitle,
    sessionWhen,
    locationName,
    locationAddress,
    claimUrl,
    paymentInstructions,
    checkoutPaused,
    calendarLinks,
    sessionPageUrl,
    contactEmail
}) {
    const parent = parentName || 'there';
    const sessionDetails = buildSessionDetailsText(sessionTitle, sessionWhen, locationName, locationAddress);
    const calendarBlock = calendarLinks || sessionPageUrl
        ? `\n\n${buildCalendarLinksText(calendarLinks, sessionPageUrl)}`
        : '';
    const linkLabel = checkoutPaused
        ? `Contact Coach Ben: ${contactEmail}`
        : `Claim your spot: ${claimUrl}`;

    const bodyText = `Hi ${parent},

Great news — a roster spot has opened up for ${playerName} in an upcoming training session!${messageBeforeSessionDetailsText()}${sessionDetails}
${calendarBlock}

${linkLabel}

${paymentInstructions}

IMPORTANT: This invitation expires in 24 hours. If payment is not completed in time, the spot will automatically pass to the next player on the waitlist.`;

    const ctaLabel = checkoutPaused ? `Email Coach Ben` : 'Claim Your Spot';
    const ctaUrl = checkoutPaused ? `mailto:${contactEmail}` : claimUrl;

    const bodyHtml = `
    ${buildGreetingHtml(parent)}
    ${buildIntroMessageHtml(`Great news &mdash; a roster spot has opened up for <strong>${escapeHtml(playerName)}</strong>!`)}
    ${buildSessionDetailsBoxHtml({ sessionTitle, sessionWhen, locationName, locationAddress })}
    ${buildCalendarSectionHtml(calendarLinks, sessionPageUrl)}
    ${buildPrimaryButtonHtml(ctaLabel, ctaUrl)}
    <p style="margin:0 0 16px 0;font-size:14px;color:#555;">${formatPlainTextAsHtml(paymentInstructions)}</p>
    ${buildWarningBoxHtml('IMPORTANT: This invitation expires in 24 hours. If payment is not completed in time, the spot will automatically pass to the next player on the waitlist.')}`;

    return {
        text: buildBrandedEmailText(bodyText, 'Automated waitlist invitation from Ben Stadey Hockey Training.', contactEmail),
        html: buildBrandedEmailHtml({
            preheader: `Roster spot available for ${playerName}`,
            headerTitle: 'Roster Spot Available',
            bodyHtml,
            footerNote: 'Automated waitlist invitation from Ben Stadey Hockey Training.',
            contactEmail
        })
    };
}

function buildPaymentErrorAlertEmail({
    playerName,
    parentName,
    parentEmail,
    sessionTitle,
    sessionWhen,
    locationName,
    locationAddress,
    sessionPrice,
    errorString,
    flow,
    sessionPageUrl,
    reportedAt
}) {
    const player = playerName || 'Unknown player';
    const parent = parentName || 'Unknown parent';
    const email = parentEmail || 'Not provided';
    const title = sessionTitle || 'Unknown session';
    const priceLine = sessionPrice != null && sessionPrice !== ''
        ? `<p style="margin:0 0 8px 0;"><strong>Amount due:</strong> $${escapeHtml(Number(sessionPrice).toFixed(2))}</p>`
        : '';
    const priceText = sessionPrice != null && sessionPrice !== ''
        ? `\nAmount due: $${Number(sessionPrice).toFixed(2)}`
        : '';

    const isClaimSpot = flow === 'claim_spot';
    const nextStepsText = isClaimSpot
        ? `This player was invited from the waitlist but PayPal checkout failed before payment went through.

1. Contact ${parent} at ${email} to arrange payment (Venmo, check, cash, etc.).
2. Log in to Coach Portal and open this session on the calendar.
3. Find ${player} on the waitlist (they should show as pending payment).
4. Once payment is received, click "Confirm paid → Active" to move them to the roster.`
        : `This registration did not complete — no roster spot was created yet.

1. Contact ${parent} at ${email} to arrange payment (Venmo, check, cash, etc.).
2. Ask them to register for the session via the waitlist if online checkout is still down.
3. Log in to Coach Portal and open this session on the calendar.
4. Once payment is received, find ${player} on the waitlist and click "Confirm paid → Active" to confirm their spot.`;

    const sessionBox = buildSessionDetailsBoxHtml({
        sessionTitle: title,
        sessionWhen,
        locationName,
        locationAddress,
        extraLinesHtml: priceLine
    });

    const errorBox = errorString
        ? buildWarningBoxHtml(`Technical error: ${errorString}`)
        : '';

    const sessionLink = sessionPageUrl
        ? buildPrimaryButtonHtml('Open session in Coach Portal', sessionPageUrl)
        : '';

    const reportedLine = reportedAt
        ? `<p style="margin:0 0 16px 0;font-size:13px;color:#666;"><strong>Reported:</strong> ${escapeHtml(reportedAt)}</p>`
        : '';
    const reportedText = reportedAt ? `Reported: ${reportedAt}\n\n` : '';

    const bodyHtml = [
        buildIntroMessageHtml('A parent tried to complete payment on <strong>benstadeyhockey.com</strong> but checkout failed.'),
        reportedLine,
        sessionBox,
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9f9f9;border-left:4px solid #dc3545;margin:0 0 20px 0;">
          <tr>
            <td style="padding:16px;">
              <h2 style="margin:0 0 12px 0;font-size:16px;color:#dc3545;">Registration attempt</h2>
              <p style="margin:0 0 8px 0;"><strong>Player:</strong> ${escapeHtml(player)}</p>
              <p style="margin:0 0 8px 0;"><strong>Parent:</strong> ${escapeHtml(parent)}</p>
              <p style="margin:0;"><strong>Parent email:</strong> <a href="mailto:${escapeHtml(email)}" style="color:#0070ba;">${escapeHtml(email)}</a></p>
            </td>
          </tr>
        </table>`,
        errorBox,
        buildWarningBoxHtml(`What to do next:\n\n${nextStepsText}`),
        sessionLink
    ].join('');

    const bodyText = [
        'A parent tried to complete payment on benstadeyhockey.com but checkout failed.',
        '',
        reportedText,
        buildSessionDetailsText(title, sessionWhen, locationName, locationAddress) + priceText,
        '',
        'Registration attempt:',
        `Player: ${player}`,
        `Parent: ${parent}`,
        `Parent email: ${email}`,
        errorString ? `\nTechnical error: ${errorString}` : '',
        '',
        'What to do next:',
        nextStepsText,
        sessionPageUrl ? `\nOpen session: ${sessionPageUrl}` : ''
    ].join('\n');

    return {
        subject: `Payment checkout failed — ${player} / ${title}`,
        text: buildBrandedEmailText(bodyText, 'Automated payment error alert from Ben Stadey Hockey Training.', DEFAULT_CONTACT_EMAIL),
        html: buildBrandedEmailHtml({
            preheader: `Checkout failed for ${player} — ${title}`,
            headerTitle: 'Payment Checkout Failed',
            bodyHtml,
            footerNote: 'Automated payment error alert from Ben Stadey Hockey Training.',
            contactEmail: DEFAULT_CONTACT_EMAIL
        })
    };
}

module.exports = {
    buildBookingConfirmationHtml,
    buildBookingConfirmationText,
    buildBookingEmailContext,
    buildBookingConfirmationSubject,
    buildBatchRegistrationEmail,
    buildBroadcastEmail,
    buildMovedToWaitlistEmail,
    buildRemovedFromSessionEmail,
    buildRosterOpeningEmail,
    buildPaymentErrorAlertEmail,
    formatSessionWhenPT,
    formatDateTimePT
};
