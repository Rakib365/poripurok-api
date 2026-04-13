import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { docClient, TABLE } from '@/lib/aws/dynamodb';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * GET /api/doubt-solver/conversations?limit=20&cursor=...
 *
 * Returns the user's conversations (most recent first), excluding soft-deleted.
 * Cursor-based pagination (LastEvaluatedKey, URL-encoded JSON).
 */
export async function GET(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10), MAX_LIMIT);
    const cursorRaw = url.searchParams.get('cursor');
    let cursor = null;
    if (cursorRaw) {
      try { cursor = JSON.parse(decodeURIComponent(cursorRaw)); } catch { /* ignore */ }
    }

    // SK is CONV_META#{ulid} — ULIDs sort lexicographically by time,
    // so ScanIndexForward: false = newest first.
    const res = await docClient.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `USER#${auth.user.sid}`,
        ':sk': 'CONV_META#',
      },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: cursor || undefined,
    }));

    const conversations = (res.Items || [])
      .filter(c => !c.deletedAt)
      .map(c => ({
        id: c.conversationId,
        title: c.title || 'নতুন কথোপকথন',
        first_message_preview: c.first_message_preview || '',
        first_message_image_url: c.first_message_image_url || null,
        last_message_preview: c.last_message_preview || '',
        message_count: c.messageCount || 0,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
      }));

    return success({
      conversations,
      nextCursor: res.LastEvaluatedKey
        ? encodeURIComponent(JSON.stringify(res.LastEvaluatedKey))
        : null,
    });
  } catch (e) {
    logger.error('doubt-solver conversations list error', { error: e.message });
    return error('Internal server error', 500);
  }
}
