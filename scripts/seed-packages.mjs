// Seed the Doubt Solver package catalog into DynamoDB.
// Usage: node scripts/seed-packages.mjs

import { upsertPackage } from '../lib/doubt-solver/package-catalog.js';

const PACKAGES = [
  { packageId: 'free', name: 'ফ্রি', emoji: '🎁', price: 0, originalPrice: 0, credits: 10, durationDays: 0,
    description: 'প্রতিদিন ১০টি ফ্রি ডাউট সলভ করো!', recommended: false, sortOrder: 1 },
  { packageId: 'super-gold', name: 'সুপার গোল্ড', emoji: '⭐', price: 99, originalPrice: 399, credits: 150, durationDays: 10,
    description: 'কম দামে বেশি ডাউট — শুরুর দিকের জন্য আদর্শ!', recommended: false, sortOrder: 2 },
  { packageId: 'ultimate-star', name: 'আল্টিমেট স্টার', emoji: '🏆', price: 199, originalPrice: 3999, credits: -1, durationDays: 30,
    description: 'এক মাস আনলিমিটেড ডাউট — সব সাবজেক্টে!', recommended: true, sortOrder: 3 },
  { packageId: 'master-mind', name: 'মাস্টার মাইন্ড', emoji: '🧠', price: 549, originalPrice: 9999, credits: -1, durationDays: 90,
    description: 'তিন মাসের সম্পূর্ণ স্বাধীনতা — পরীক্ষার প্রস্তুতির জন্য।', recommended: false, sortOrder: 4 },
  { packageId: 'grand-master', name: 'গ্র্যান্ড মাস্টার', emoji: '🔥', price: 999, originalPrice: 38000, credits: -1, durationDays: 180,
    description: 'ছয় মাসের জন্য সবকিছু আনলিমিটেড।', recommended: false, sortOrder: 5 },
  { packageId: 'das-king', name: 'ডাস কিং', emoji: '👑', price: 1799, originalPrice: 63000, credits: -1, durationDays: 365,
    description: 'পুরো বছরের আনলিমিটেড এক্সেস — সেরা ডিল!', recommended: false, sortOrder: 6 },
];

for (const p of PACKAGES) {
  await upsertPackage(p);
  console.log('seeded:', p.packageId);
}
console.log('\nDone — seeded', PACKAGES.length, 'packages.');
