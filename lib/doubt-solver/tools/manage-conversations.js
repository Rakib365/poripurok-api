/**
 * manage_conversations tool
 *
 * Browse and load past conversations. Actions: list | load
 *
 * Schema:
 *   Conversation meta:    PK: USER#{userId}, SK: CONV_META#{convId}
 *     { title, first_message_preview, createdAt, updatedAt, messageCount }
 *   Messages:             PK: CONV#{convId}, SK: MSG#{timestamp}#{msgId}
 *     { role: 'user'|'assistant', content: string, imageUrls?: string[], ts }
 *
 * Truncation: first 500 / middle 500 / last 500 chars per message, joined with "...".
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../../aws/dynamodb.js';

const DEFAULT_LIST_LIMIT = 5;
const TRUNC_HEAD = 500;
const TRUNC_MID = 500;
const TRUNC_TAIL = 500;

function truncateContent(text) {
  if (!text || typeof text !== 'string') return text;
  if (text.length <= TRUNC_HEAD + TRUNC_MID + TRUNC_TAIL) return text;

  const head = text.slice(0, TRUNC_HEAD);
  const midStart = Math.floor((text.length - TRUNC_MID) / 2);
  const mid = text.slice(midStart, midStart + TRUNC_MID);
  const tail = text.slice(-TRUNC_TAIL);

  return `${head}\n...[truncated]...\n${mid}\n...[truncated]...\n${tail}`;
}

async function listConversations(userId, limit) {
  // SK pattern: CONV_META#{convId} — clean prefix query
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}`,
      ':sk': 'CONV_META#',
    },
    ScanIndexForward: false, // newest first by SK
    Limit: limit,
  }));

  return (res.Items || []).map(item => ({
    id: item.SK.replace('CONV_META#', ''),
    title: item.title || '(untitled)',
    first_message_preview: item.first_message_preview || '',
    message_count: item.messageCount || 0,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  }));
}

async function loadConversation(convId, mode = 'truncated') {
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `CONV#${convId}`,
      ':sk': 'MSG#',
    },
    ScanIndexForward: true, // oldest first
  }));

  const messages = (res.Items || []).map(item => ({
    role: item.role,
    content: mode === 'full' ? item.content : truncateContent(item.content),
    imageUrls: item.imageUrls || null,
    ts: item.ts,
  }));

  return {
    conversation_id: convId,
    mode,
    message_count: messages.length,
    messages,
  };
}

export const manageConversations = {
  name: 'manage_conversations',
  description: 'List recent conversations or load a specific one. Use truncated mode by default.',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'load'] },
      limit: { type: 'integer', description: 'For list action (default 5)' },
      id: { type: 'string', description: 'Conversation ID, required for load' },
      mode: { type: 'string', enum: ['truncated', 'full'], description: 'Load mode (default truncated)' },
    },
    required: ['action'],
  },

  async handler({ action, limit = DEFAULT_LIST_LIMIT, id, mode = 'truncated' }, ctx) {
    if (action === 'list') {
      if (!ctx?.userId) return { error: 'userId required' };
      const conversations = await listConversations(ctx.userId, limit);
      return { conversations, count: conversations.length };
    }

    if (action === 'load') {
      if (!id) return { error: 'id required for load' };
      return await loadConversation(id, mode);
    }

    return { error: `unknown action: ${action}` };
  },
};
