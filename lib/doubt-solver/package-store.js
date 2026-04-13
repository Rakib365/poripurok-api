/**
 * Package subscription + quota management.
 *
 * Storage:
 *   PK: USER#{sid}, SK: PKG_SUBSCRIPTION#active
 *     { packageId, packageName, quotaTotal, quotaRemaining,
 *       validityStart, validityEnd, lastUpdated }
 *   PK: USER#{sid}, SK: PKG_ORDER#{ts}#{orderId}   (billing audit — future)
 *
 * New user free tier: seeded with 10 one-time credits. No reset, no renewal.
 */

import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';

const FREE_QUOTA = 10;

/**
 * Fetch the active subscription for a user. Returns null if none.
 */
export async function getActiveSubscription(userId) {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `USER#${userId}`, SK: 'PKG_SUBSCRIPTION#active' },
  }));
  return res.Item || null;
}

/**
 * Seed a free-tier subscription if the user doesn't have one yet (idempotent).
 * Safe to call on every chat request.
 */
export async function ensureFreeTier(userId) {
  const existing = await getActiveSubscription(userId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const item = {
    PK: `USER#${userId}`,
    SK: 'PKG_SUBSCRIPTION#active',
    packageId: 'free',
    packageName: 'ফ্রি ট্রায়াল',
    quotaTotal: FREE_QUOTA,
    quotaRemaining: FREE_QUOTA,
    validityStart: now,
    validityEnd: null,       // never expires (one-time quota)
    lastUpdated: now,
    isFree: true,
  };

  // Atomic create-if-not-exists
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return item;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return await getActiveSubscription(userId);
    }
    throw err;
  }
}

/**
 * Atomically deduct `n` credits from the active subscription.
 * Fails with ConditionalCheckFailedException if quota would go negative.
 *
 * @returns { ok: true, remaining } on success, { ok: false, reason } on failure
 */
export async function deductQuota(userId, n = 1) {
  const now = new Date().toISOString();
  try {
    const res = await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `USER#${userId}`, SK: 'PKG_SUBSCRIPTION#active' },
      UpdateExpression: 'SET quotaRemaining = quotaRemaining - :n, lastUpdated = :now',
      // Reject if quota is empty OR the subscription has expired.
      // Free tier has validityEnd = NULL which passes attribute_type/not_exists.
      ConditionExpression:
        'quotaRemaining >= :n AND (attribute_not_exists(validityEnd) OR validityEnd = :null OR validityEnd > :now)',
      ExpressionAttributeValues: {
        ':n': n,
        ':now': now,
        ':null': null,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return { ok: true, remaining: res.Attributes?.quotaRemaining ?? 0 };
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Disambiguate: is the quota gone, or has the subscription expired?
      const cur = await getActiveSubscription(userId);
      if (!cur) return { ok: false, reason: 'no_subscription' };
      if (cur.validityEnd && cur.validityEnd <= now) {
        return { ok: false, reason: 'subscription_expired' };
      }
      return { ok: false, reason: 'quota_exhausted' };
    }
    if (err.name === 'ValidationException' && /attribute|document/i.test(err.message || '')) {
      return { ok: false, reason: 'no_subscription' };
    }
    throw err;
  }
}

/**
 * Apply a package purchase to the user's subscription using telecom-style
 * stacking (Option A):
 *   quotaRemaining  += package.credits
 *   validityEnd      = max(current validityEnd, now) + package.durationDays
 *   packageId/Name   = latest purchased package
 *
 * Also writes an order row for audit: SK = PKG_ORDER#{iso}#{orderId}
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {object} args.pkg       Normalized package record from package-catalog
 * @param {number} [args.paidAmount]  Final paid amount for audit (may be promo-discounted)
 * @returns {{ ok: true, subscription, orderId }}
 */
export async function purchasePackage({ userId, pkg, paidAmount }) {
  if (!userId) throw new Error('userId required');
  if (!pkg || !pkg.packageId) throw new Error('pkg required');

  const now = new Date();
  const nowIso = now.toISOString();
  const orderId = `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;

  const credits = Number(pkg.credits || 0);
  const durationDays = Number(pkg.durationDays || pkg.duration || 0);
  const newValidityCandidate = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();

  // 1. Ensure a subscription row exists so we can UpdateCommand cleanly.
  await ensureFreeTier(userId);

  // 2. Stack credits; set validity to max(existing, newCandidate).
  //    Using `if_not_exists` keeps the update idempotent even if validityEnd
  //    was previously NULL (free tier).
  const res = await docClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `USER#${userId}`, SK: 'PKG_SUBSCRIPTION#active' },
    UpdateExpression: [
      'SET packageId = :pid',
      'packageName = :pname',
      'lastUpdated = :now',
      'isFree = :f',
      'quotaTotal = quotaTotal + :c',
      'validityEnd = if_not_exists(validityEnd, :newVal)',
    ].join(', ') + ' ADD quotaRemaining :c',
    ExpressionAttributeValues: {
      ':pid': pkg.packageId,
      ':pname': pkg.name || pkg.packageName || pkg.packageId,
      ':now': nowIso,
      ':f': false,
      ':c': credits,
      ':newVal': newValidityCandidate,
    },
    ReturnValues: 'ALL_NEW',
  }));

  // 3. Second update to set validityEnd = max(existing, newCandidate).
  //    DynamoDB doesn't have a MAX() in UpdateExpression so we compute in app
  //    and conditionally overwrite only if the new candidate is later.
  const currentEnd = res.Attributes?.validityEnd;
  const currentEndTime = currentEnd ? new Date(currentEnd).getTime() : 0;
  const newEndTime = new Date(newValidityCandidate).getTime();
  if (newEndTime > currentEndTime) {
    await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `USER#${userId}`, SK: 'PKG_SUBSCRIPTION#active' },
      UpdateExpression: 'SET validityEnd = :v',
      ExpressionAttributeValues: { ':v': newValidityCandidate },
    }));
    res.Attributes.validityEnd = newValidityCandidate;
  }

  // 4. Write an order audit row.
  await docClient.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `USER#${userId}`,
      SK: `PKG_ORDER#${nowIso}#${orderId}`,
      orderId,
      userId,
      packageId: pkg.packageId,
      packageName: pkg.name || pkg.packageName || pkg.packageId,
      credits,
      durationDays,
      price: Number(pkg.price || 0),
      paidAmount: Number(paidAmount ?? pkg.price ?? 0),
      createdAt: nowIso,
    },
  }));

  return {
    ok: true,
    orderId,
    subscription: res.Attributes,
  };
}

/**
 * Refund credits (used when an agent turn fails after deduction).
 */
export async function refundQuota(userId, n = 1) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `USER#${userId}`, SK: 'PKG_SUBSCRIPTION#active' },
      UpdateExpression: 'SET quotaRemaining = quotaRemaining + :n, lastUpdated = :now',
      ExpressionAttributeValues: {
        ':n': n,
        ':now': new Date().toISOString(),
      },
    }));
  } catch (err) {
    console.warn('[PackageStore] refundQuota failed:', err.message);
  }
}
