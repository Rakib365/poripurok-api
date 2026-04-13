/**
 * Transaction records — one row per payment attempt.
 *
 * Schema:
 *   PK: TXN#{merInvoiceNumber}
 *   SK: TXN#{merInvoiceNumber}
 *   { userId, packageId, packageName, amount, status, paymentID, trxID, ... }
 *
 * For per-student queries we duplicate onto a secondary pattern:
 *   PK: USER#{userId}   SK: TXN#{ts}#{merInvoiceNumber}
 *
 * A daily-aggregate row is also atomically bumped on each successful txn:
 *   PK: AGG#REVENUE     SK: DAY#{YYYY-MM-DD}    { total, count }
 */

import { PutCommand, UpdateCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';

const STATUS = {
  INITIATED: 'initiated',
  SUCCESSFUL: 'successful',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export { STATUS as TXN_STATUS };

export function buildInvoiceNumber(userId, packageId) {
  return `INV_${Date.now()}_${userId}_${packageId}`;
}

/**
 * Record an initiated payment (before user confirms on bKash).
 */
export async function recordInitiatedTransaction({
  merInvoiceNumber, userId, packageId, packageName, amount, paymentID, processor = 'bKash',
}) {
  const now = new Date().toISOString();
  const txn = {
    PK: `TXN#${merInvoiceNumber}`,
    SK: `TXN#${merInvoiceNumber}`,
    merInvoiceNumber,
    userId,
    packageId,
    packageName,
    amount: Number(amount),
    paymentID,
    processor,
    status: STATUS.INITIATED,
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLE, Item: txn }));
  return txn;
}

/**
 * Mark a transaction successful. Idempotent — if it's already successful,
 * this is a no-op (protects against double-callback stacking credits twice).
 *
 * @returns { ok: true, alreadyProcessed: bool, txn }
 */
export async function markTransactionSuccessful({
  merInvoiceNumber, trxID, executedAmount,
}) {
  const now = new Date().toISOString();
  try {
    const res = await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `TXN#${merInvoiceNumber}`, SK: `TXN#${merInvoiceNumber}` },
      UpdateExpression:
        'SET #s = :succ, trxID = :t, executedAmount = :a, updatedAt = :now',
      ConditionExpression:
        '#s <> :succ',   // refuse if already successful
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':succ': STATUS.SUCCESSFUL,
        ':t': trxID || null,
        ':a': Number(executedAmount || 0),
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    }));

    // Write user-indexed copy for per-student listing.
    // IMPORTANT: spread `attrs` FIRST then override PK/SK — otherwise the
    // spread's own PK/SK (TXN#...) would clobber our USER# key.
    const attrs = res.Attributes;
    const { PK: _pk, SK: _sk, ...rest } = attrs;
    await docClient.send(new PutCommand({
      TableName: TABLE,
      Item: {
        ...rest,
        PK: `USER#${attrs.userId}`,
        SK: `TXN#${attrs.createdAt}#${merInvoiceNumber}`,
      },
    }));

    // Bump daily revenue aggregate.
    const day = now.slice(0, 10); // YYYY-MM-DD
    await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: 'AGG#REVENUE', SK: `DAY#${day}` },
      UpdateExpression: 'ADD #t :a, #c :one SET updatedAt = :now',
      ExpressionAttributeNames: { '#t': 'total', '#c': 'count' },
      ExpressionAttributeValues: {
        ':a': Number(attrs.executedAmount || attrs.amount || 0),
        ':one': 1,
        ':now': now,
      },
    }));

    return { ok: true, alreadyProcessed: false, txn: attrs };
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      const cur = await docClient.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `TXN#${merInvoiceNumber}`, SK: `TXN#${merInvoiceNumber}` },
      }));
      return { ok: true, alreadyProcessed: true, txn: cur.Item };
    }
    throw err;
  }
}

export async function markTransactionFailed({ merInvoiceNumber, reason }) {
  const now = new Date().toISOString();
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `TXN#${merInvoiceNumber}`, SK: `TXN#${merInvoiceNumber}` },
      UpdateExpression: 'SET #s = :f, failureReason = :r, updatedAt = :now',
      ConditionExpression: '#s <> :succ',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':f': STATUS.FAILED,
        ':succ': STATUS.SUCCESSFUL,
        ':r': String(reason || '').slice(0, 300),
        ':now': now,
      },
    }));
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
  }
}

export async function getTransaction(merInvoiceNumber) {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `TXN#${merInvoiceNumber}`, SK: `TXN#${merInvoiceNumber}` },
  }));
  return res.Item || null;
}

export async function listUserTransactions(userId, { limit = 50 } = {}) {
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'TXN#' },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return res.Items || [];
}
