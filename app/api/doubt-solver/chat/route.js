import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { runAgentTurn } from '@/lib/doubt-solver/agent-loop';

/**
 * POST /api/doubt-solver/chat
 *
 * Body:
 *   {
 *     message: string,        // text from user (may be empty if image-only)
 *     imageUrls: string[],    // optional — public URLs (from /upload-url)
 *     conversationId: string, // optional — omit for new conversation
 *   }
 *
 * Response (success):
 *   {
 *     success: true,
 *     data: {
 *       conversationId, isNewConversation,
 *       messageId, response,
 *       reference_sets: [{ ref_set_id, summary, image_ids, reused }],
 *       iterations, tool_calls_made, latencyMs,
 *       quotaRemaining, costUsd, suggestedTitle
 *     }
 *   }
 *
 * Response (quota exhausted):
 *   { success: false, error: 'quota_exhausted', code: 'ERROR_402', data: { quotaRemaining: 0 } }
 *
 * Response (agent failure):
 *   { success: false, error: 'agent_failed', code: 'ERROR_500', data: { conversationId, iterations } }
 */
export async function POST(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const body = await request.json();
    const { message = '', imageUrls = null, conversationId = null } = body;

    if (!message && (!imageUrls || imageUrls.length === 0)) {
      return error('message or imageUrls required');
    }

    const result = await runAgentTurn({
      userId: auth.user.sid,
      conversationId,
      message: { text: message, imageUrls },
    });

    // Business errors from the agent loop (not thrown)
    if (result.error) {
      if (result.error === 'quota_exhausted') {
        logger.info('doubt-solver quota exhausted', { userId: auth.user.sid });
        return error('quota_exhausted', 402);
      }
      if (result.error === 'subscription_expired') {
        logger.info('doubt-solver subscription expired', { userId: auth.user.sid });
        return error('subscription_expired', 402);
      }
      if (result.error === 'no_subscription') {
        logger.warn('doubt-solver no subscription', { userId: auth.user.sid });
        return error('no_subscription', 402);
      }
      logger.error('doubt-solver agent failure', {
        userId: auth.user.sid, error: result.error, conversationId: result.conversationId,
      });
      return error(result.error, 500);
    }

    return success({
      conversationId: result.conversationId,
      isNewConversation: result.isNewConversation,
      messageId: result.message_id,
      response: result.response,
      reference_sets: result.reference_sets,
      iterations: result.iterations,
      tool_calls_made: result.tool_calls_made,
      latencyMs: result.latencyMs,
      quotaRemaining: result.quotaRemaining,
      costUsd: result.costUsd,
      suggestedTitle: result.suggestedTitle,
    });
  } catch (e) {
    logger.error('doubt-solver chat error', { error: e.message, stack: e.stack });
    return error('Internal server error', 500);
  }
}
