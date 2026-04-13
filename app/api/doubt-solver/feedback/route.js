import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { createFeedback, listFeedback } from '@/lib/doubt-solver/feedback-store';
import { CDN_BASE } from '@/lib/aws/s3';

function toUrl(key) {
  if (!key) return null;
  if (key.startsWith('http://') || key.startsWith('https://')) return key;
  return `${CDN_BASE}/${key}`;
}

/**
 * GET /api/doubt-solver/feedback?conversationId=X&messageId=Y
 *
 * Returns prior feedback for this message, with voice & attachment S3 keys
 * converted to CDN URLs so the client can play/view them.
 */
export async function GET(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const url = new URL(request.url);
    const conversationId = url.searchParams.get('conversationId');
    const messageId = url.searchParams.get('messageId');
    if (!conversationId || !messageId) {
      return error('conversationId and messageId are required');
    }

    const rows = await listFeedback({ conversationId, messageId });
    const items = rows.map(r => ({
      feedbackId: r.feedbackId,
      tags: r.tags || [],
      text: r.text || '',
      voiceUrl: toUrl(r.voiceS3Key),
      voiceDurationMs: r.voiceDurationMs ?? null,
      attachmentUrls: (r.attachmentS3Keys || []).map(toUrl),
      createdAt: r.createdAt,
    }));
    items.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

    return success({ feedback: items });
  } catch (e) {
    logger.error('doubt-solver feedback GET error', { error: e.message });
    return error('Internal server error', 500);
  }
}

/**
 * POST /api/doubt-solver/feedback
 *
 * Body:
 *   {
 *     conversationId, messageId,
 *     tags: ['wrong','incomplete','unclear','other'],
 *     text?: string,
 *     voiceS3Key?: string,        // from upload-url
 *     voiceDurationMs?: number,
 *     attachmentS3Keys?: string[] // image/PDF S3 keys from upload-url
 *   }
 */
export async function POST(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const {
      conversationId, messageId,
      tags = [], text = '',
      voiceS3Key = null, voiceDurationMs = null,
      attachmentS3Keys = [],
    } = await request.json();

    if (!conversationId || !messageId) {
      return error('conversationId and messageId are required');
    }

    const hasSignal = (Array.isArray(tags) && tags.length > 0)
      || (text && text.trim().length > 0)
      || voiceS3Key
      || (Array.isArray(attachmentS3Keys) && attachmentS3Keys.length > 0);
    if (!hasSignal) {
      return error('At least one of tags, text, voiceS3Key, or attachmentS3Keys is required');
    }

    const res = await createFeedback({
      conversationId, messageId,
      tags, text, voiceS3Key, voiceDurationMs, attachmentS3Keys,
    });

    return success({ feedbackId: res.feedbackId, createdAt: res.createdAt });
  } catch (e) {
    logger.error('doubt-solver feedback error', { error: e.message });
    return error('Internal server error', 500);
  }
}
