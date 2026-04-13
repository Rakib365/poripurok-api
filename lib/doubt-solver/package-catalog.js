/**
 * Package catalog — the list of purchasable Doubt Solver packages.
 *
 * Storage:
 *   PK: 'PACKAGE_CATALOG'
 *   SK: 'PACKAGE#{packageId}'
 *   Attributes: { packageId, name, emoji, price, originalPrice, credits,
 *                 durationDays, description, recommended, active, sortOrder }
 *
 * Querying with PK='PACKAGE_CATALOG' lets us list all packages in one Query.
 */

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';

const PK = 'PACKAGE_CATALOG';

export async function listPackages({ includeInactive = false } = {}) {
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': PK, ':sk': 'PACKAGE#' },
  }));
  const items = (res.Items || [])
    .filter(p => includeInactive || p.active !== false)
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
  return items.map(p => ({
    id: p.packageId,
    name: p.name,
    emoji: p.emoji || '',
    price: p.price ?? 0,
    originalPrice: p.originalPrice ?? p.price ?? 0,
    credits: p.credits ?? 0,          // -1 means unlimited
    durationDays: p.durationDays ?? 0,
    description: p.description || '',
    recommended: !!p.recommended,
  }));
}

export async function getPackage(packageId) {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE,
    Key: { PK, SK: `PACKAGE#${packageId}` },
  }));
  return res.Item || null;
}

export async function upsertPackage(pkg) {
  const item = {
    PK,
    SK: `PACKAGE#${pkg.packageId}`,
    packageId: pkg.packageId,
    name: pkg.name,
    emoji: pkg.emoji || '',
    price: pkg.price ?? 0,
    originalPrice: pkg.originalPrice ?? pkg.price ?? 0,
    credits: pkg.credits ?? 0,
    durationDays: pkg.durationDays ?? 0,
    description: pkg.description || '',
    recommended: !!pkg.recommended,
    active: pkg.active !== false,
    sortOrder: pkg.sortOrder ?? 999,
    updatedAt: new Date().toISOString(),
  };
  await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}
