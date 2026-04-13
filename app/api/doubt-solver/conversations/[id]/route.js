import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { loadMessages, softDeleteConversation, updateConversationTitle } from '@/lib/doubt-solver/message-store';
import { listRefSets } from '@/lib/doubt-solver/reference-matcher';
import { listReactionsForConversation } from '@/lib/doubt-solver/reaction-store';
import { listFeedback } from '@/lib/doubt-solver/feedback-store';

/**
 * GET /api/doubt-solver/conversations/{id}
 *
 * Returns the full conversation with messages (active versions only),
 * reactions + feedback per message, and available reference sets.
 */
export async function GET(request, { params }) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);
    const { id } = await params;
    if (!id) return error('conversation id required');

    // Verify ownership
    const meta = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { PK: `USER#${auth.user.sid}`, SK: `CONV_META#${id}` },
    }));
    if (!meta.Item || meta.Item.deletedAt) {
      return error('not_found', 404);
    }

    const [messages, refSets, reactions] = await Promise.all([
      loadMessages(id),
      listRefSets(id),
      listReactionsForConversation(id),
    ]);

    const reactionByMsg = new Map(reactions.map(r => [r.messageId, r.emoji]));

    // Also attach feedback (many per msg)
    const feedbackItems = await listFeedback({ conversationId: id });
    const feedbackByMsg = new Map();
    for (const f of feedbackItems) {
      if (!feedbackByMsg.has(f.messageId)) feedbackByMsg.set(f.messageId, []);
      feedbackByMsg.get(f.messageId).push({
        feedbackId: f.feedbackId,
        tags: f.tags || [],
        text: f.text || '',
        hasVoice: Boolean(f.voiceS3Key),
        hasAttachments: (f.attachmentS3Keys || []).length > 0,
        createdAt: f.createdAt,
      });
    }

    const msgs = messages.map(m => ({
      id: m.messageId,
      role: m.role,
      content: m.content || '',
      imageUrls: m.imageUrls || null,
      ts: m.ts,
      editedAt: m.editedAt || null,
      reaction: reactionByMsg.get(m.messageId) || null,
      feedback: feedbackByMsg.get(m.messageId) || [],
    }));

    return success({
      conversation: {
        id: meta.Item.conversationId,
        title: meta.Item.title,
        first_message_preview: meta.Item.first_message_preview || '',
        first_message_image_url: meta.Item.first_message_image_url || null,
        created_at: meta.Item.createdAt,
        updated_at: meta.Item.updatedAt,
        message_count: meta.Item.messageCount || 0,
      },
      messages: msgs,
      reference_sets: refSets.map(rs => ({
        ref_set_id: rs.ref_set_id,
        summary: rs.summary,
        image_ids: rs.image_ids || [],
      })),
    });
  } catch (e) {
    logger.error('doubt-solver conversation detail error', { error: e.message });
    return error('Internal server error', 500);
  }
}

/**
 * PATCH /api/doubt-solver/conversations/{id}
 * Body: { title?: string }
 */
export async function PATCH(request, { params }) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);
    const { id } = await params;
    const body = await request.json();

    if (typeof body.title === 'string' && body.title.trim().length > 0) {
      await updateConversationTitle({
        userId: auth.user.sid,
        conversationId: id,
        newTitle: body.title,
      });
    }
    return success({ ok: true });
  } catch (e) {
    logger.error('doubt-solver conversation patch error', { error: e.message });
    return error('Internal server error', 500);
  }
}

/**
 * DELETE /api/doubt-solver/conversations/{id}
 * Soft delete.
 */
export async function DELETE(request, { params }) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);
    const { id } = await params;
    await softDeleteConversation({ userId: auth.user.sid, conversationId: id });
    return success({ ok: true });
  } catch (e) {
    logger.error('doubt-solver conversation delete error', { error: e.message });
    return error('Internal server error', 500);
  }
}
