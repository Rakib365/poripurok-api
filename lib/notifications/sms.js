/**
 * SMS sending via GreenWeb BD.
 * API docs: https://api.greenweb.com.bd/
 *
 * Send a Bengali receipt to the student's phone after a successful purchase.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';
import { logger } from '../aws/cloudwatch.js';

const GREENWEB_URL = 'https://api.greenweb.com.bd/api.php';

const BN_DIGITS = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
const toBn = (s) => String(s).split('').map(c => /[0-9]/.test(c) ? BN_DIGITS[+c] : c).join('');

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const months = ['জানু', 'ফেব্রু', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্ট', 'অক্টো', 'নভে', 'ডিসে'];
  return `${toBn(d.getDate())} ${months[d.getMonth()]}`;
}

/**
 * Raw SMS send. Returns { ok: bool, body: string }.
 */
export async function sendSms({ to, message }) {
  const token = process.env.GREENWEB_SMS_TOKEN;
  if (!token) {
    logger.warn('sms: GREENWEB_SMS_TOKEN not set — skipping send');
    return { ok: false, body: 'no_token' };
  }
  if (!to) return { ok: false, body: 'no_recipient' };

  // GreenWeb expects form-encoded params.
  const params = new URLSearchParams({
    token,
    to: String(to),
    message: String(message),
  });

  try {
    const res = await fetch(GREENWEB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const body = await res.text();
    const ok = res.ok && /ok|success|200/i.test(body);
    if (!ok) logger.warn('sms: send returned non-ok', { body: body.slice(0, 200) });
    return { ok, body };
  } catch (e) {
    logger.warn('sms: send failed', { error: e.message });
    return { ok: false, body: e.message };
  }
}

/**
 * Send a Bengali purchase receipt.
 */
export async function sendPurchaseSms({
  userId, packageName, amount, trxID, validityEnd,
}) {
  // Look up the student's phone.
  const res = await docClient.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `USER#${userId}`, SK: 'PROFILE' },
    ProjectionExpression: 'phone, full_name',
  }));
  const phone = res.Item?.phone;
  if (!phone) {
    logger.warn('sms: no phone on profile — skipping', { userId });
    return { ok: false, body: 'no_phone' };
  }

  const lines = [
    `পরিপূরক AI - পেমেন্ট সম্পন্ন!`,
    `প্যাকেজ: ${packageName}`,
    `পরিমাণ: ৳${toBn(amount)}`,
  ];
  if (validityEnd) lines.push(`মেয়াদ: ${formatDate(validityEnd)} পর্যন্ত`);
  if (trxID) lines.push(`TrxID: ${trxID}`);
  lines.push(`ধন্যবাদ! - poripurok.com`);

  const message = lines.join('\n');
  return sendSms({ to: phone, message });
}
