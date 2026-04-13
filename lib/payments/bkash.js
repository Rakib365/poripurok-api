/**
 * bKash Tokenized Checkout integration.
 *
 * Flow:
 *   1. grant token (cached 55 min in DynamoDB)
 *   2. create payment → returns bkashURL + paymentID
 *   3. user confirms on bKash side, returns to callback URL
 *   4. execute payment → credits the merchant account
 *   5. write TXN row, fulfill package
 */

import { GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';
import { logger } from '../aws/cloudwatch.js';

const TOKEN_TTL_MINUTES = 55;

const CONFIG = () => ({
  baseURL: process.env.BKASH_BASE_URL,
  appKey: process.env.BKASH_APP_KEY,
  appSecret: process.env.BKASH_APP_SECRET,
  username: process.env.BKASH_USERNAME,
  password: process.env.BKASH_PASSWORD,
});

// ─── Token cache ───────────────────────────────────────────────

async function getStoredToken() {
  try {
    const res = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { PK: 'BKASH_TOKEN', SK: 'BKASH_TOKEN' },
    }));
    if (!res.Item) return null;
    const ageMin = (Date.now() - res.Item.createdAt) / 60_000;
    return ageMin < TOKEN_TTL_MINUTES ? res.Item.token : null;
  } catch (e) {
    logger.warn('bkash: getStoredToken failed', { error: e.message });
    return null;
  }
}

async function storeToken(token) {
  await docClient.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: 'BKASH_TOKEN',
      SK: 'BKASH_TOKEN',
      token,
      createdAt: Date.now(),
    },
  }));
}

async function requestNewToken() {
  const cfg = CONFIG();
  const res = await fetch(`${cfg.baseURL}/tokenized/checkout/token/grant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      username: cfg.username,
      password: cfg.password,
    },
    body: JSON.stringify({ app_key: cfg.appKey, app_secret: cfg.appSecret }),
  });
  const data = await res.json();
  if (!data?.id_token) {
    throw new Error(`bkash token grant failed: ${JSON.stringify(data)}`);
  }
  return data.id_token;
}

export async function getBkashToken({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await getStoredToken();
    if (cached) return cached;
  }
  const fresh = await requestNewToken();
  await storeToken(fresh);
  return fresh;
}

async function invalidateToken() {
  try {
    await docClient.send(new DeleteCommand({
      TableName: TABLE,
      Key: { PK: 'BKASH_TOKEN', SK: 'BKASH_TOKEN' },
    }));
  } catch (e) { /* ignore */ }
}

// ─── Payment operations ──────────────────────────────────────

/**
 * Create a new bKash tokenized checkout payment.
 * Returns { paymentID, bkashURL, ...rest }.
 */
async function doCreate({ amount, phone, merchantInvoiceNumber, callbackURL, token }) {
  const cfg = CONFIG();
  const res = await fetch(`${cfg.baseURL}/tokenized/checkout/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: token,
      'X-APP-Key': cfg.appKey,
    },
    body: JSON.stringify({
      mode: '0011',
      payerReference: String(phone || 'NA'),
      callbackURL,
      amount: String(amount),
      currency: 'BDT',
      intent: 'sale',
      merchantInvoiceNumber,
    }),
  });
  return { status: res.status, data: await res.json() };
}

export async function createBkashPayment({
  amount, phone, merchantInvoiceNumber, callbackURL,
}) {
  let token = await getBkashToken();
  let { status, data } = await doCreate({ amount, phone, merchantInvoiceNumber, callbackURL, token });

  // If bKash rejects with Forbidden / Unauthorized, the cached token may be
  // stale (e.g. creds changed). Bust the cache and retry once with a fresh one.
  const authFailure = status === 401 || status === 403
    || /forbidden|unauthorized|invalid\s*token/i.test(JSON.stringify(data || {}));
  if (authFailure) {
    logger.warn('bkash create auth failure — refreshing token', { status, resp: data });
    await invalidateToken();
    token = await getBkashToken({ forceRefresh: true });
    ({ status, data } = await doCreate({ amount, phone, merchantInvoiceNumber, callbackURL, token }));
  }

  if (!data?.paymentID || !data?.bkashURL) {
    throw new Error(`bkash create failed: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Execute a previously-created payment (captures the amount).
 * Returns { transactionStatus: 'Completed' | ..., trxID, amount, ... }.
 */
export async function executeBkashPayment(paymentID) {
  const cfg = CONFIG();
  const token = await getBkashToken();

  const res = await fetch(`${cfg.baseURL}/tokenized/checkout/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: token,
      'X-APP-Key': cfg.appKey,
    },
    body: JSON.stringify({ paymentID }),
  });
  return res.json();
}

/**
 * Query current status of a payment.
 */
export async function queryBkashPayment(paymentID) {
  const cfg = CONFIG();
  const token = await getBkashToken();

  const res = await fetch(`${cfg.baseURL}/tokenized/checkout/payment/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: token,
      'X-APP-Key': cfg.appKey,
    },
    body: JSON.stringify({ paymentID }),
  });
  return res.json();
}
