/**
 * Import doubt-solving packages from the old Poripurok DynamoDB table.
 *
 * Prerequisite: run this AWS CLI command first to dump the raw data:
 *   aws dynamodb scan --table-name Packages --profile poripurok-old \
 *     --region ap-south-1 \
 *     --filter-expression "packageType = :t" \
 *     --expression-attribute-values '{":t":{"S":"doubt-solving"}}' \
 *     --output json > /tmp/old_packages_raw.json
 *
 * This script reads the cleaned JSON and writes to our new DynamoDB.
 */

import fs from 'node:fs';
import { PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../lib/aws/dynamodb.js';
import { listPackages } from '../lib/doubt-solver/package-catalog.js';

const CLEAN_FILE = '/tmp/old_packages_clean.json';

function normalizeName(raw) {
  const m = /^(.*?)\s+([\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]+)\s*$/u.exec(raw || '');
  if (m) return { name: m[1].trim(), emoji: m[2].trim() };
  return { name: raw || '', emoji: '' };
}

async function clearCurrent() {
  const current = await listPackages({ includeInactive: true });
  for (const p of current) {
    await docClient.send(new DeleteCommand({
      TableName: TABLE,
      Key: { PK: 'PACKAGE_CATALOG', SK: `PACKAGE#${p.id}` },
    }));
  }
  return current.length;
}

async function writeFree(sortOrder) {
  const item = {
    PK: 'PACKAGE_CATALOG',
    SK: 'PACKAGE#free',
    packageId: 'free',
    name: 'ফ্রি ট্রায়াল',
    emoji: '🎁',
    price: 0,
    originalPrice: 0,
    credits: 10,
    durationDays: 0,
    description: 'শুরুতে ১০টি ফ্রি ডাউট সলভ করো! পছন্দ হলে পেইড প্যাকে যাও।',
    recommended: false,
    active: true,
    sortOrder,
    updatedAt: new Date().toISOString(),
  };
  await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

async function writeOne(old, sortOrder) {
  const id = String(old.PK || '').replace(/^PKG#/, '');
  const { name, emoji } = normalizeName(old.packageName);
  const item = {
    PK: 'PACKAGE_CATALOG',
    SK: `PACKAGE#${id}`,
    packageId: id,
    name,
    emoji,
    price: Number(old.price || 0),
    originalPrice: Number(old.cutPrice || old.price || 0),
    credits: Number(old.numberOfDoubts || 0),
    durationDays: Number(old.validityInDays || 0),
    description: String(old.description || ''),
    recommended: Number(old.index || 0) === 5,
    active: true,
    sortOrder,
    sourcePackageType: String(old.packageType || ''),
    migratedFrom: 'poripurok-old/Packages',
    updatedAt: new Date().toISOString(),
  };
  await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

const oldPackages = JSON.parse(fs.readFileSync(CLEAN_FILE, 'utf8'));

const cleared = await clearCurrent();
console.log(`Cleared ${cleared} existing catalog entries.`);

await writeFree(0);
console.log('Wrote free tier.');

let so = 1;
for (const p of oldPackages) {
  const w = await writeOne(p, so++);
  console.log(`Imported [${w.packageId.slice(0, 8)}…] ${w.name} ${w.emoji} — ৳${w.price} / ${w.durationDays}d / ${w.credits} credits`);
}

console.log(`\nDone — ${oldPackages.length + 1} packages now in catalog.`);
