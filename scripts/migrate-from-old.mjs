/**
 * Migrate students + active paid subscriptions from old Poripurok AWS to new.
 *
 * Source  : poripurok-old / ap-south-1
 *   Student           → PROFILE rows
 *   Doubts + Enrollments → PKG_SUBSCRIPTION#active rows (only if expireTime > now)
 *
 * Target  : new account (default profile), table `poripurok`
 *
 * Usage:
 *   node scripts/migrate-from-old.mjs --dry-run      (default)
 *   node scripts/migrate-from-old.mjs --commit       (actually write)
 *   node scripts/migrate-from-old.mjs --commit --students-only
 *   node scripts/migrate-from-old.mjs --commit --subs-only
 */

import fs from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { fromIni } from '@aws-sdk/credential-providers';

const argv = process.argv.slice(2);
const DRY_RUN = !argv.includes('--commit');
const STUDENTS_ONLY = argv.includes('--students-only');
const SUBS_ONLY = argv.includes('--subs-only');
const LIMIT = (() => { const i = argv.indexOf('--limit'); return i >= 0 ? parseInt(argv[i + 1], 10) : Infinity; })();

const OLD_TABLE_STUDENT = 'Student';
const OLD_TABLE_DOUBTS = 'Doubts';
const OLD_TABLE_ENROLL = 'Enrollments';
const NEW_TABLE = 'poripurok';

const REGION = 'ap-south-1';

const oldDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION, credentials: fromIni({ profile: 'poripurok-old' }) })
);
const newDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION, credentials: fromIni({ profile: 'default' }) })
);

// Package mapping — keep 3, upgrade everything else to Ultimate Star
const KEEP_PKGS = new Set([
  '1e6159f1-27f4-46cb-a687-114b37e5a5a7', // সুপার লেজেন্ড
  'a2a4da2e-cfce-42a5-bbff-d639e543a63f', // মাস্টার মাইন্ড
  '85effc63-59cb-421e-a12b-27e5a726b64e', // আল্টিমেট স্টার
]);
const HIGHEST_PKG_ID = '85effc63-59cb-421e-a12b-27e5a726b64e';
const HIGHEST_PKG_NAME = 'আল্টিমেট স্টার';

const PKG_NAMES = {
  '1e6159f1-27f4-46cb-a687-114b37e5a5a7': 'সুপার লেজেন্ড',
  'a2a4da2e-cfce-42a5-bbff-d639e543a63f': 'মাস্টার মাইন্ড',
  '85effc63-59cb-421e-a12b-27e5a726b64e': 'আল্টিমেট স্টার',
};

const report = {
  startedAt: new Date().toISOString(),
  dryRun: DRY_RUN,
  students: { scanned: 0, imported: 0, skippedNoPhone: 0, skippedPhoneExists: 0, skippedIdExists: 0, errors: 0 },
  subscriptions: { doubtsScanned: 0, withActiveExpiry: 0, expiredOrBuggy: 0, imported: 0, mapped: {}, errors: 0 },
  csvRows: [],
};

function stamp(label, obj = {}) {
  const parts = Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${label}${parts ? ' | ' + parts : ''}`);
}

// ─── Phase 1: students ─────────────────────────────────────────────

async function buildNewPhoneSet() {
  stamp('Scanning new PROFILE rows to build phone set…');
  const phones = new Set();
  const ids = new Set();
  let lastKey;
  do {
    const res = await newDoc.send(new ScanCommand({
      TableName: NEW_TABLE,
      FilterExpression: 'SK = :sk AND begins_with(PK, :pk)',
      ExpressionAttributeValues: { ':sk': 'PROFILE', ':pk': 'USER#' },
      ProjectionExpression: 'PK, phone',
      ExclusiveStartKey: lastKey,
    }));
    for (const it of res.Items || []) {
      if (it.phone) phones.add(String(it.phone));
      if (it.PK) ids.add(it.PK.replace('USER#', ''));
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  stamp(`  already in new system: phones=${phones.size} ids=${ids.size}`);
  return { phones, ids };
}

function toNewProfile(stu) {
  const sid = String(stu.PK || '').replace(/^SID#/, '');
  return {
    PK: `USER#${sid}`,
    SK: 'PROFILE',
    phone: stu.phone || null,
    full_name: stu.full_name || null,
    college_name: stu.college_name || null,
    hsc_batch: stu.hsc_batch || null,
    gender: stu.gender || null,
    profile_picture: stu.profile_picture || null,
    password: stu.password || null,
    passwordFormat: 'legacy',
    created_at: stu.created_at || new Date().toISOString(),
    migratedFrom: 'poripurok-old/Student',
    migratedAt: new Date().toISOString(),
  };
}

async function migrateStudents(existing) {
  stamp('Phase 1: migrating Student rows');
  let lastKey;
  do {
    const res = await oldDoc.send(new ScanCommand({
      TableName: OLD_TABLE_STUDENT,
      ExclusiveStartKey: lastKey,
    }));
    for (const stu of res.Items || []) {
      if (report.students.scanned >= LIMIT) break;
      report.students.scanned++;
      const sid = String(stu.PK || '').replace(/^SID#/, '');
      if (!sid) { report.students.errors++; continue; }

      // Dedupe: phone already in new wins
      if (stu.phone && existing.phones.has(String(stu.phone))) {
        report.students.skippedPhoneExists++;
        continue;
      }
      if (existing.ids.has(sid)) {
        report.students.skippedIdExists++;
        continue;
      }
      if (!stu.phone) {
        report.students.skippedNoPhone++;
        continue;
      }

      const profile = toNewProfile(stu);
      if (!DRY_RUN) {
        try {
          await newDoc.send(new PutCommand({
            TableName: NEW_TABLE,
            Item: profile,
            ConditionExpression: 'attribute_not_exists(PK)',
          }));
          report.students.imported++;
        } catch (e) {
          if (e.name === 'ConditionalCheckFailedException') {
            report.students.skippedIdExists++;
          } else {
            report.students.errors++;
            console.warn(`  put failed sid=${sid}: ${e.message}`);
          }
        }
      } else {
        report.students.imported++; // counted as "would import"
      }

      if (report.students.scanned % 500 === 0) {
        stamp('  progress', { scanned: report.students.scanned, imported: report.students.imported });
      }
    }
    lastKey = res.LastEvaluatedKey;
    if (report.students.scanned >= LIMIT) break;
  } while (lastKey);

  stamp('Phase 1 done', report.students);
}

// ─── Phase 2: subscriptions ────────────────────────────────────────

async function buildLatestEnrollmentMap() {
  // Enrollments scan — small table (~1273 rows). Build { student_id: latestEnrollment }
  stamp('Scanning Enrollments (latest per student)…');
  const map = new Map();
  let lastKey;
  do {
    const res = await oldDoc.send(new ScanCommand({
      TableName: OLD_TABLE_ENROLL,
      ExclusiveStartKey: lastKey,
    }));
    for (const en of res.Items || []) {
      const sid = en.student_id;
      if (!sid || !en.package_id) continue;
      const ts = Number(en.SK || 0);
      const prev = map.get(sid);
      if (!prev || ts > prev.ts) {
        map.set(sid, { ts, packageId: en.package_id, packageName: en.package_name });
      }
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  stamp(`  enrolled students (unique): ${map.size}`);
  return map;
}

function mapPackage(oldPkgId) {
  if (!oldPkgId) return { packageId: HIGHEST_PKG_ID, packageName: HIGHEST_PKG_NAME, reason: 'no_enrollment_found' };
  if (KEEP_PKGS.has(oldPkgId)) {
    return { packageId: oldPkgId, packageName: PKG_NAMES[oldPkgId], reason: 'kept' };
  }
  return { packageId: HIGHEST_PKG_ID, packageName: HIGHEST_PKG_NAME, reason: 'upgraded_to_highest' };
}

async function migrateSubscriptions(latestEnroll) {
  stamp('Phase 2: scanning Doubts for active expireTime');
  const nowMs = Date.now();
  let lastKey;
  do {
    const res = await oldDoc.send(new ScanCommand({
      TableName: OLD_TABLE_DOUBTS,
      ExclusiveStartKey: lastKey,
    }));
    for (const d of res.Items || []) {
      report.subscriptions.doubtsScanned++;
      const sid = String(d.PK || '').replace(/^SID#/, '');
      if (!sid) continue;

      const expireTime = Number(d.expireTime || 0);
      if (!expireTime || expireTime <= nowMs) {
        report.subscriptions.expiredOrBuggy++;
        continue;
      }
      report.subscriptions.withActiveExpiry++;

      const limits = Number(d.limits || 0);
      const en = latestEnroll.get(sid);
      const mapped = mapPackage(en?.packageId);
      report.subscriptions.mapped[mapped.reason] = (report.subscriptions.mapped[mapped.reason] || 0) + 1;

      const validityEndIso = new Date(expireTime).toISOString();
      const item = {
        PK: `USER#${sid}`,
        SK: 'PKG_SUBSCRIPTION#active',
        packageId: mapped.packageId,
        packageName: mapped.packageName,
        quotaRemaining: limits,
        quotaTotal: limits,
        validityStart: en ? new Date(en.ts).toISOString() : new Date().toISOString(),
        validityEnd: validityEndIso,
        lastUpdated: new Date().toISOString(),
        isFree: false,
        migratedFrom: 'poripurok-old/Doubts+Enrollments',
      };

      report.csvRows.push([sid, en?.packageId || '', en?.packageName || '', mapped.packageId, mapped.packageName, mapped.reason, limits, validityEndIso].join(','));

      if (!DRY_RUN) {
        try {
          await newDoc.send(new PutCommand({ TableName: NEW_TABLE, Item: item }));
          report.subscriptions.imported++;
        } catch (e) {
          report.subscriptions.errors++;
          console.warn(`  sub put failed sid=${sid}: ${e.message}`);
        }
      } else {
        report.subscriptions.imported++;
      }
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  stamp('Phase 2 done', report.subscriptions);
}

// ─── Main ──────────────────────────────────────────────────────────

const t0 = Date.now();
console.log(`\n════════════════ MIGRATION ════════════════`);
console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'COMMIT'}`);
console.log(`Limit: ${LIMIT === Infinity ? 'none' : LIMIT}`);
console.log('═══════════════════════════════════════════\n');

if (!SUBS_ONLY) {
  const existing = await buildNewPhoneSet();
  await migrateStudents(existing);
}

if (!STUDENTS_ONLY) {
  const latestEnroll = await buildLatestEnrollmentMap();
  await migrateSubscriptions(latestEnroll);
}

// Write CSV
const csvPath = `/tmp/migration-report-${DRY_RUN ? 'dryrun' : 'commit'}-${Date.now()}.csv`;
const csvHeader = 'new_sid,old_package_id,old_package_name,new_package_id,new_package_name,mapping_reason,quota,validity_end';
fs.writeFileSync(csvPath, [csvHeader, ...report.csvRows].join('\n'));

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n════════════════ DONE (${elapsed}s) ════════════════`);
console.log(JSON.stringify({ students: report.students, subscriptions: report.subscriptions }, null, 2));
console.log(`\nCSV: ${csvPath}  (${report.csvRows.length} subscription rows)`);
