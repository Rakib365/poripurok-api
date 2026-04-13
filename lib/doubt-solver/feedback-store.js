/**
 * Feedback store — a student can submit multiple feedback items per message.
 *
 * Schema:
 *   PK: CONV#{convId}, SK: FEEDBACK#{msgId}#{ulid}
 *     { feedbackId, messageId, tags: [], text, voiceS3Key, voiceDurationMs,
 *       attachmentS3Keys: [], createdAt }
 *
 * Voice, images, and PDFs are pre-uploaded via /upload-url; we only store S3 keys.
 */

import { ulid } from 'ulid';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';

const VALID_TAGS = new Set([
  // Negative tags
  'wrong',          // answer is incorrect
  'incomplete',     // missing information
  'unclear',        // hard to understand
  // Positive tags
  'helpful',        // generally good
  'accurate',       // factually spot-on
  'well_explained', // clear and easy to follow
  // Meta
  'other',          // free-form, details in `text`
]);

export const FEEDBACK_TAGS = [...VALID_TAGS];
export function isPositiveTag(tag) {
  return ['helpful', 'accurate', 'well_explained'].includes(tag);
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.filter(t => VALID_TAGS.has(t)))];
}

export async function createFeedback({
  conversationId, messageId,
  tags = [], text = '',
  voiceS3Key = null, voiceDurationMs = null,
  attachmentS3Keys = [],
}) {
  if (!conversationId || !messageId) throw new Error('conversationId and messageId required');

  const feedbackId = ulid();
  const now = new Date().toISOString();

  const item = {
    PK: `CONV#${conversationId}`,
    SK: `FEEDBACK#${messageId}#${feedbackId}`,
    feedbackId,
    messageId,
    conversationId,
    tags: sanitizeTags(tags),
    text: (text || '').slice(0, 2000),
    voiceS3Key,
    voiceDurationMs,
    attachmentS3Keys: Array.isArray(attachmentS3Keys) ? attachmentS3Keys.slice(0, 10) : [],
    createdAt: now,
  };

  await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));
  return { feedbackId, createdAt: now };
}

/**
 * Load feedback rows for a message (or for the whole conversation if messageId is null).
 */
export async function listFeedback({ conversationId, messageId = null }) {
  const skPrefix = messageId ? `FEEDBACK#${messageId}#` : 'FEEDBACK#';
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `CONV#${conversationId}`,
      ':sk': skPrefix,
    },
  }));
  return res.Items || [];
}
