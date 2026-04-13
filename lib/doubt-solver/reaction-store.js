/**
 * Reaction store — one reaction per (conversation, message).
 *
 * Schema:
 *   PK: CONV#{convId}, SK: REACT#{msgId}
 *     { emoji, createdAt, updatedAt }
 *
 * `emoji` values: 'like' | 'dislike' | 'love' | 'haha' | 'wow' | 'sad' | null
 * Passing null removes the reaction.
 */

import { PutCommand, DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';

const VALID_EMOJIS = new Set(['like', 'dislike', 'love', 'haha', 'wow', 'sad']);

export async function setReaction({ conversationId, messageId, emoji }) {
  if (!conversationId || !messageId) throw new Error('conversationId and messageId required');

  const key = { PK: `CONV#${conversationId}`, SK: `REACT#${messageId}` };

  if (emoji == null || emoji === '') {
    await docClient.send(new DeleteCommand({ TableName: TABLE, Key: key }));
    return { ok: true, emoji: null };
  }

  if (!VALID_EMOJIS.has(emoji)) {
    return { ok: false, reason: 'invalid_emoji' };
  }

  const now = new Date().toISOString();
  await docClient.send(new PutCommand({
    TableName: TABLE,
    Item: {
      ...key,
      emoji,
      messageId,
      conversationId,
      createdAt: now,
      updatedAt: now,
    },
  }));
  return { ok: true, emoji };
}

export async function getReaction({ conversationId, messageId }) {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `CONV#${conversationId}`, SK: `REACT#${messageId}` },
  }));
  return res.Item || null;
}

/**
 * List all reactions in a conversation. Used by the context loader
 * to check if the latest assistant message has a reaction.
 */
export async function listReactionsForConversation(conversationId) {
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `CONV#${conversationId}`,
      ':sk': 'REACT#',
    },
  }));
  return res.Items || [];
}
