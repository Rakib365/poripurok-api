/**
 * Usage + cost aggregation. Writes to USAGE_DAY and USAGE_MONTH rows
 * atomically using `ADD` so concurrent turns don't overwrite each other.
 *
 * Storage:
 *   PK: USER#{sid}, SK: USAGE_DAY#{YYYY-MM-DD}
 *   PK: USER#{sid}, SK: USAGE_MONTH#{YYYY-MM}
 *   PK: GLOBAL,     SK: USAGE_DAY#{YYYY-MM-DD}
 *
 * Also maintains a simple daily streak: if today's USAGE_DAY is created
 * fresh, we extend the streak on USER#{sid}/STREAK.
 */

import { UpdateCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';

function today() {
  return new Date().toISOString().slice(0, 10);     // YYYY-MM-DD
}
function thisMonth() {
  return new Date().toISOString().slice(0, 7);      // YYYY-MM
}
function yesterday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Atomically increment counters on a single usage row.
 */
async function addToUsageRow(pk, sk, delta) {
  const now = new Date().toISOString();

  const setParts = ['lastUpdated = :now'];
  const addParts = [];
  const values = { ':now': now };

  for (const [field, val] of Object.entries(delta)) {
    if (val == null || val === 0) continue;
    addParts.push(`${field} :v_${field}`);
    values[`:v_${field}`] = val;
  }
  if (addParts.length === 0) return;

  await docClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk, SK: sk },
    UpdateExpression: `ADD ${addParts.join(', ')} SET ${setParts.join(', ')}`,
    ExpressionAttributeValues: values,
  }));
}

/**
 * Record one agent turn's usage. Called after both successful and failed turns.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {number} [args.messages=1]
 * @param {number} [args.retries=0]
 * @param {number} [args.tokensInput=0]
 * @param {number} [args.tokensOutput=0]
 * @param {number} [args.tokensCached=0]
 * @param {number} [args.embeddingTokens=0]
 * @param {number} [args.costUsd=0]
 * @param {number} [args.latencyMs=0]
 * @param {number} [args.iterations=0]
 */
export async function recordTurnUsage({
  userId,
  messages = 1,
  retries = 0,
  tokensInput = 0,
  tokensOutput = 0,
  tokensCached = 0,
  embeddingTokens = 0,
  costUsd = 0,
  latencyMs = 0,
  iterations = 0,
}) {
  if (!userId) return;

  const delta = {
    messages,
    retries,
    tokensInput,
    tokensOutput,
    tokensCached,
    embeddingTokens,
    costUsd,
    latencyMsSum: latencyMs,
    iterationsSum: iterations,
  };

  const d = today();
  const m = thisMonth();

  await Promise.all([
    addToUsageRow(`USER#${userId}`, `USAGE_DAY#${d}`, delta),
    addToUsageRow(`USER#${userId}`, `USAGE_MONTH#${m}`, delta),
    addToUsageRow('GLOBAL', `USAGE_DAY#${d}`, delta),
  ]);
}

/**
 * Bump the user's streak if today is a new activity day.
 * Idempotent — only increments the first time today.
 *
 * Schema: PK: USER#{sid}, SK: STREAK
 *   { current, best, lastActiveDate, updatedAt }
 */
export async function updateStreak(userId) {
  if (!userId) return;
  const tdy = today();
  const yd = yesterday();

  const key = { PK: `USER#${userId}`, SK: 'STREAK' };
  const existing = await docClient.send(new GetCommand({ TableName: TABLE, Key: key }));
  const cur = existing.Item || { current: 0, best: 0, lastActiveDate: null };

  if (cur.lastActiveDate === tdy) return cur; // already counted today

  const next = {
    current: cur.lastActiveDate === yd ? (cur.current || 0) + 1 : 1,
    best: Math.max(cur.best || 0, (cur.lastActiveDate === yd ? (cur.current || 0) + 1 : 1)),
    lastActiveDate: tdy,
    updatedAt: new Date().toISOString(),
  };

  await docClient.send(new PutCommand({
    TableName: TABLE,
    Item: { ...key, ...next },
  }));
  return next;
}

/**
 * Read usage for a date range (simple sum of daily rows).
 */
export async function getUserUsageSummary(userId) {
  // For now, just read today + this month
  const d = today();
  const m = thisMonth();
  const [day, month, streak] = await Promise.all([
    docClient.send(new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `USAGE_DAY#${d}` } })),
    docClient.send(new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: `USAGE_MONTH#${m}` } })),
    docClient.send(new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: 'STREAK' } })),
  ]);
  return {
    today: day.Item || {},
    month: month.Item || {},
    streak: streak.Item || { current: 0, best: 0 },
  };
}
