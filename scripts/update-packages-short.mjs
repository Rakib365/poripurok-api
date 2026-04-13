/**
 * Update package catalog — 7 / 15 / 30-day lineup with credits roughly
 * ~1 : (price×1.2 to 1.4) so ratio scales a bit with tier.
 *
 *   সুপার লেজেন্ড 🔥  ৳99  / 7d  / 120 doubts (~1.21 per taka)
 *   মাস্টার মাইন্ড 🚀  ৳149 / 15d / 200 doubts (~1.34 per taka)
 *   আল্টিমেট স্টার 😎  ৳199 / 30d / 280 doubts (~1.41 per taka)
 */

import { PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../lib/aws/dynamodb.js';
import { listPackages } from '../lib/doubt-solver/package-catalog.js';

const SUPER_LEGEND_ID  = '1e6159f1-27f4-46cb-a687-114b37e5a5a7';
const MASTER_MIND_ID   = 'a2a4da2e-cfce-42a5-bbff-d639e543a63f';
const ULTIMATE_STAR_ID = '85effc63-59cb-421e-a12b-27e5a726b64e';

const NEW_LINEUP = [
  {
    packageId: 'free',
    name: 'ফ্রি ট্রায়াল',
    emoji: '🎁',
    price: 0,
    originalPrice: 0,
    credits: 10,
    durationDays: 0,
    description: 'শুরুতে ১০টি ফ্রি ডাউট সলভ করো! পছন্দ হলে পেইড প্যাকে যাও।',
    recommended: false,
    sortOrder: 0,
  },
  {
    packageId: SUPER_LEGEND_ID,
    name: 'সুপার লেজেন্ড',
    emoji: '🔥',
    price: 99,
    originalPrice: 199,
    credits: 120,
    durationDays: 7,
    description: 'প্রো প্লেয়ার হতে চাও? এই প্যাকটি নাও!',
    recommended: false,
    sortOrder: 1,
  },
  {
    packageId: MASTER_MIND_ID,
    name: 'মাস্টার মাইন্ড',
    emoji: '🚀',
    price: 149,
    originalPrice: 299,
    credits: 200,
    durationDays: 15,
    description: 'এক্সাম-রেডি প্যাকে প্রস্তুতি নাও লিমিটলেস এর দুনিয়ায়!',
    recommended: true,
    sortOrder: 2,
  },
  {
    packageId: ULTIMATE_STAR_ID,
    name: 'আল্টিমেট স্টার',
    emoji: '😎',
    price: 199,
    originalPrice: 349,
    credits: 280,
    durationDays: 30,
    description: 'সিনেমার স্টার নয়, আসল খিলাড়ি হয়ে জয় করো সবকিছু!',
    recommended: false,
    sortOrder: 3,
  },
];

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

async function writeOne(pkg) {
  const item = {
    PK: 'PACKAGE_CATALOG',
    SK: `PACKAGE#${pkg.packageId}`,
    ...pkg,
    active: true,
    updatedAt: new Date().toISOString(),
  };
  await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

const cleared = await clearCurrent();
console.log(`Cleared ${cleared} existing packages.`);

for (const p of NEW_LINEUP) {
  const w = await writeOne(p);
  console.log(`Wrote [${String(w.packageId).slice(0, 12)}…] ${w.name} ${w.emoji} — ৳${w.price} / ${w.durationDays}d / ${w.credits} credits`);
}

console.log(`\nDone — ${NEW_LINEUP.length} packages in catalog.`);
