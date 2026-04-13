import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { setReaction } from '@/lib/doubt-solver/reaction-store';

/**
 * POST /api/doubt-solver/react
 * Body: { conversationId, messageId, emoji: 'like'|'dislike'|'love'|'haha'|'wow'|'sad'|null }
 * Passing null removes the reaction.
 */
export async function POST(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const { conversationId, messageId, emoji } = await request.json();
    if (!conversationId || !messageId) {
      return error('conversationId and messageId are required');
    }

    const res = await setReaction({ conversationId, messageId, emoji: emoji ?? null });
    if (!res.ok) return error(res.reason || 'invalid_request');

    return success({ emoji: res.emoji });
  } catch (e) {
    logger.error('doubt-solver react error', { error: e.message });
    return error('Internal server error', 500);
  }
}
