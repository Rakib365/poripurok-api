import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { isAdmin } from '@/lib/admin/auth';

/**
 * GET /api/admin/students
 *   → list all students with { id, name, phone, package, quotaRemaining, totalSpent }
 *
 * First pass — scan PROFILE rows, pair with their active subscription.
 * For thousands of students this is fine; past that we'd add a GSI.
 */
export async function GET(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);
    if (!(await isAdmin(auth.user.sid))) return error('forbidden', 403);

    // 1. Scan PROFILE rows.
    const profiles = await docClient.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'SK = :sk AND begins_with(PK, :pk)',
      ExpressionAttributeValues: { ':sk': 'PROFILE', ':pk': 'USER#' },
      ProjectionExpression: 'PK, full_name, phone, college_name, hsc_batch, created_at, isAdmin',
    }));

    // 2. For each student, query subscription + sum of successful TXN amounts.
    const students = [];
    for (const p of (profiles.Items || [])) {
      const userId = p.PK.replace(/^USER#/, '');

      const [subRes, txnRes] = await Promise.all([
        docClient.send(new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'PK = :pk AND SK = :sk',
          ExpressionAttributeValues: {
            ':pk': `USER#${userId}`,
            ':sk': 'PKG_SUBSCRIPTION#active',
          },
        })),
        docClient.send(new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          FilterExpression: '#s = :succ',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':pk': `USER#${userId}`,
            ':sk': 'TXN#',
            ':succ': 'successful',
          },
        })),
      ]);

      const sub = subRes.Items?.[0] || null;
      const totalSpent = (txnRes.Items || [])
        .filter(t => t.status === 'successful')
        .reduce((s, t) => s + Number(t.executedAmount || t.amount || 0), 0);

      students.push({
        id: userId,
        name: p.full_name || null,
        phone: p.phone || null,
        college: p.college_name || null,
        batch: p.hsc_batch || null,
        isAdmin: !!p.isAdmin,
        packageId: sub?.packageId || null,
        packageName: sub?.packageName || null,
        quotaRemaining: sub?.quotaRemaining ?? 0,
        quotaTotal: sub?.quotaTotal ?? 0,
        validityEnd: sub?.validityEnd || null,
        totalSpent,
        createdAt: p.created_at || null,
      });
    }

    students.sort((a, b) => b.totalSpent - a.totalSpent);
    return success({ students, count: students.length });
  } catch (e) {
    logger.error('admin students list error', { error: e.message, stack: e.stack });
    return error('Internal server error', 500);
  }
}
