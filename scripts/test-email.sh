#!/usr/bin/env bash
# Send a test email through the configured SMTP transport.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env.local ]]; then
  echo "Missing .env.local — copy .env.local.example and set EMAIL_USER / EMAIL_PASS."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.local
set +a

TO="${1:-}"
if [[ -z "$TO" ]]; then
  echo "Usage: ./scripts/test-email.sh recipient@example.com"
  exit 1
fi

if [[ -z "${EMAIL_USER:-}" || -z "${EMAIL_PASS:-}" ]]; then
  echo "EMAIL_USER and EMAIL_PASS must be set in .env.local"
  exit 1
fi

export TEST_EMAIL_TO="$TO"
node <<'NODE'
const nodemailer = require('nodemailer');

const emailUser = (process.env.EMAIL_USER || '').trim();
const emailPass = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');
const contactEmail = (process.env.CONTACT_EMAIL || 'ben@benstadeyhockey.com').trim();
const fromName = (process.env.EMAIL_FROM_NAME || 'Ben Stadey Hockey Training').trim();
const host = process.env.EMAIL_HOST || 'smtp.gmail.com';
const port = parseInt(process.env.EMAIL_PORT || '465', 10);
const secure = process.env.EMAIL_SECURE
  ? process.env.EMAIL_SECURE === 'true'
  : port === 465;

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  requireTLS: !secure,
  auth: { user: emailUser, pass: emailPass }
});

transporter.verify((err) => {
  if (err) {
    console.error('SMTP verification failed:', err.message);
    process.exit(1);
  }

  transporter.sendMail({
    from: `"${fromName}" <${emailUser}>`,
    replyTo: contactEmail,
    to: process.env.TEST_EMAIL_TO,
    subject: '[TEST] Ben Stadey Hockey — email configuration',
    text: `This is a test message from the hockey-booking server.\n\nIf you reply, it should go to ${contactEmail}.\n\nAutomated receipts and waitlist emails use the same setup.`
  }, (sendErr, info) => {
    if (sendErr) {
      console.error('Send failed:', sendErr.message);
      process.exit(1);
    }
    console.log('Test email sent:', info.messageId);
    console.log('From:', emailUser, '| Reply-To:', contactEmail, '| To:', process.env.TEST_EMAIL_TO);
  });
});
NODE
