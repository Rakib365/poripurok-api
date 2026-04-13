import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { runAgentRetry } from '@/lib/doubt-solver/agent-loop';

/**
 * POST /api/doubt-solver/retry
 *
 * Regenerates an assistant response. Previous active version is marked inactive;
 * new version becomes active. Deducts 1 credit.
 *
 * Body: { conversationId, messageId }
 */
export async function POST(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const { conversationId, messageId } = await request.json();
    if (!conversationId || !messageId) {
      return error('conversationId and messageId are required');
    }

    const result = await runAgentRetry({
      userId: auth.user.sid,
      conversationId,
      messageId,
    });

    if (result.error) {
      if (result.error === 'quota_exhausted') return error('quota_exhausted', 402);
      if (result.error === 'no_subscription') return error('no_subscription', 402);
      if (result.error === 'message_not_found') return error('message_not_found', 404);
      return error(result.error, 500);
    }

    return success({
      conversationId: result.conversationId,
      messageId: result.message_id,
      versionId: result.version_id,
      response: result.response,
      reference_sets: result.reference_sets,
      iterations: result.iterations,
      latencyMs: result.latencyMs,
      quotaRemaining: result.quotaRemaining,
      costUsd: result.costUsd,
    });
  } catch (e) {
    logger.error('doubt-solver retry error', { error: e.message });
    return error('Internal server error', 500);
  }
}
