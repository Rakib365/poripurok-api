import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { isAdmin } from '@/lib/admin/auth';

/**
 * GET /api/admin/transactions?status=successful&limit=50
 *
 * Lists TXN# rows. For production scale we'd want a GSI on status + timestamp;
 * this scan works fine for the first few thousand transactions.
 */
export async function GET(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);
    if (!(await isAdmin(auth.user.sid))) return error('forbidden', 403);

    const url = new URL(request.url);
    const status = url.searchParams.get('status'); // null → all
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

    const filterParts = ['begins_with(PK, :pk)'];
    const values = { ':pk': 'TXN#' };
    if (status) { filterParts.push('#s = :s'); values[':s'] = status; }

    const res = await docClient.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: filterParts.join(' AND '),
      ...(status ? { ExpressionAttributeNames: { '#s': 'status' } } : {}),
      ExpressionAttributeValues: values,
      Limit: limit * 3, // over-fetch; filter before returning
    }));

    const items = (res.Items || [])
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, limit)
      .map(t => ({
        merInvoiceNumber: t.merInvoiceNumber,
        userId: t.userId,
        packageId: t.packageId,
        packageName: t.packageName,
        amount: t.amount,
        executedAmount: t.executedAmount,
        status: t.status,
        trxID: t.trxID,
        processor: t.processor,
        createdAt: t.createdAt,
      }));

    return success({ transactions: items });
  } catch (e) {
    logger.error('admin txns list error', { error: e.message });
    return error('Internal server error', 500);
  }
}
