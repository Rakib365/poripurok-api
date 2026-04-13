/**
 * Message Store — conversations, messages, and assistant-message versions.
 *
 * Schema:
 *   PK: USER#{sid}, SK: CONV_META#{ulid}
 *     { convId, title, firstMessagePreview, lastMessagePreview,
 *       messageCount, createdAt, updatedAt, deletedAt?,
 *       preferredApiKeyIndex? }
 *
 *   PK: CONV#{convId}, SK: MSG#{ulid}
 *     { msgId, role: 'user'|'assistant', content, imageUrls, ts,
 *       activeVersionId?, contentHistory?, deletedAt? }
 *
 *   PK: CONV#{convId}, SK: MSG_VER#{msgId}#{ulid}   (assistant only — versions of responses)
 *     { versionId, content, reference_sets, iterations, toolCalls,
 *       tokensInput, tokensOutput, tokensCached, costUsd, latencyMs,
 *       modelUsed, apiKeyIndex, isActive, createdAt }
 */

import { ulid } from 'ulid';
import {
  PutCommand, UpdateCommand, GetCommand, QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';

export function newConversationId() {
  return ulid();
}
export function newMessageId() {
  return ulid();
}
export function newVersionId() {
  return ulid();
}

/**
 * Ensure conversation meta exists. Creates on first message.
 */
export async function ensureConversation({
  userId, conversationId,
  firstMessagePreview, firstMessageImageUrl = null,
  title,
}) {
  const key = { PK: `USER#${userId}`, SK: `CONV_META#${conversationId}` };
  const existing = await docClient.send(new GetCommand({ TableName: TABLE, Key: key }));
  if (existing.Item) return existing.Item;

  const now = new Date().toISOString();
  const item = {
    ...key,
    conversationId,
    userId,
    title: title || firstMessagePreview?.slice(0, 80) || 'নতুন কথোপকথন',
    first_message_preview: firstMessagePreview?.slice(0, 200) || '',
    first_message_image_url: firstMessageImageUrl || null,
    last_message_preview: firstMessagePreview?.slice(0, 200) || '',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };
  await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

/**
 * Append a MSG row. For assistant messages, also creates a MSG_VER row
 * and points MSG.activeVersionId to it.
 *
 * @param {object} args
 * @param {string} args.conversationId
 * @param {string} args.userId
 * @param {'user'|'assistant'} args.role
 * @param {string} [args.content]
 * @param {string[]} [args.imageUrls]
 * @param {object} [args.versionData] — for assistant messages
 * @returns {{ messageId, versionId?, ts }}
 */
export async function appendMessage({
  conversationId, userId, role,
  content = '', imageUrls = null,
  versionData = null,
}) {
  const ts = new Date().toISOString();
  const messageId = newMessageId();
  const versionId = role === 'assistant' ? newVersionId() : null;

  // Base MSG row
  const msgItem = {
    PK: `CONV#${conversationId}`,
    SK: `MSG#${messageId}`,
    messageId,
    conversationId,
    role,
    content,
    imageUrls: imageUrls || null,
    ts,
    ...(versionId ? { activeVersionId: versionId } : {}),
  };
  await docClient.send(new PutCommand({ TableName: TABLE, Item: msgItem }));

  // MSG_VER row for assistant messages
  if (role === 'assistant' && versionData) {
    const verItem = {
      PK: `CONV#${conversationId}`,
      SK: `MSG_VER#${messageId}#${versionId}`,
      versionId,
      messageId,
      conversationId,
      content,
      reference_sets: versionData.reference_sets || [],
      iterations: versionData.iterations || 0,
      toolCalls: versionData.toolCalls || 0,
      tokensInput: versionData.tokensInput || 0,
      tokensOutput: versionData.tokensOutput || 0,
      tokensCached: versionData.tokensCached || 0,
      embeddingTokens: versionData.embeddingTokens || 0,
      costUsd: versionData.costUsd || 0,
      latencyMs: versionData.latencyMs || 0,
      modelUsed: versionData.modelUsed || null,
      apiKeyIndex: versionData.apiKeyIndex ?? null,
      isActive: true,
      createdAt: ts,
    };
    await docClient.send(new PutCommand({ TableName: TABLE, Item: verItem }));
  }

  // Update conversation meta counters + last preview
  if (userId) {
    try {
      await docClient.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `USER#${userId}`, SK: `CONV_META#${conversationId}` },
        UpdateExpression: 'ADD messageCount :one SET updatedAt = :now, last_message_preview = :preview',
        ExpressionAttributeValues: {
          ':one': 1,
          ':now': ts,
          ':preview': (content || '').slice(0, 200),
        },
      }));
    } catch (e) {
      console.warn('[MessageStore] Failed to update conv meta:', e.message);
    }
  }

  return { messageId, versionId, ts };
}

/**
 * Load all non-deleted messages for a conversation, oldest first.
 * For assistant messages, returns the ACTIVE version's content.
 */
export async function loadMessages(conversationId) {
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `CONV#${conversationId}`,
      ':sk': 'MSG#',
    },
    ScanIndexForward: true,
  }));
  return (res.Items || []).filter(m => !m.deletedAt);
}

/**
 * Replace MSG content (edit) — snapshot old content, bump updatedAt.
 */
export async function editMessageContent({ conversationId, messageId, newContent }) {
  const now = new Date().toISOString();
  await docClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `CONV#${conversationId}`, SK: `MSG#${messageId}` },
    UpdateExpression: 'SET content = :c, editedAt = :now, contentHistory = list_append(if_not_exists(contentHistory, :empty), :snapshot)',
    ExpressionAttributeValues: {
      ':c': newContent,
      ':now': now,
      ':empty': [],
      ':snapshot': [{ content: newContent, editedAt: now }],
    },
  }));
}

/**
 * Mark the active version of an assistant message as inactive
 * (used before a retry).
 */
export async function deactivateActiveVersion({ conversationId, messageId }) {
  const msg = await docClient.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `CONV#${conversationId}`, SK: `MSG#${messageId}` },
  }));
  const activeId = msg.Item?.activeVersionId;
  if (!activeId) return null;

  await docClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `CONV#${conversationId}`, SK: `MSG_VER#${messageId}#${activeId}` },
    UpdateExpression: 'SET isActive = :f',
    ExpressionAttributeValues: { ':f': false },
  }));
  return activeId;
}

/**
 * Save a new version as active for a given message (retry path).
 */
export async function addNewActiveVersion({ conversationId, messageId, content, versionData }) {
  const versionId = newVersionId();
  const now = new Date().toISOString();

  const verItem = {
    PK: `CONV#${conversationId}`,
    SK: `MSG_VER#${messageId}#${versionId}`,
    versionId,
    messageId,
    conversationId,
    content,
    reference_sets: versionData.reference_sets || [],
    iterations: versionData.iterations || 0,
    toolCalls: versionData.toolCalls || 0,
    tokensInput: versionData.tokensInput || 0,
    tokensOutput: versionData.tokensOutput || 0,
    tokensCached: versionData.tokensCached || 0,
    embeddingTokens: versionData.embeddingTokens || 0,
    costUsd: versionData.costUsd || 0,
    latencyMs: versionData.latencyMs || 0,
    modelUsed: versionData.modelUsed || null,
    apiKeyIndex: versionData.apiKeyIndex ?? null,
    isActive: true,
    createdAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLE, Item: verItem }));

  await docClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `CONV#${conversationId}`, SK: `MSG#${messageId}` },
    UpdateExpression: 'SET activeVersionId = :v, content = :c, updatedAt = :now',
    ExpressionAttributeValues: { ':v': versionId, ':c': content, ':now': now },
  }));
  return { versionId, ts: now };
}

/**
 * Soft-delete a conversation (and hide from lists).
 */
export async function softDeleteConversation({ userId, conversationId }) {
  const now = new Date().toISOString();
  await docClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `USER#${userId}`, SK: `CONV_META#${conversationId}` },
    UpdateExpression: 'SET deletedAt = :now',
    ExpressionAttributeValues: { ':now': now },
  }));
}

/**
 * Update conversation title. If `newTitle` differs from current, persist it.
 */
export async function updateConversationTitle({ userId, conversationId, newTitle }) {
  if (!newTitle) return;
  const now = new Date().toISOString();
  await docClient.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `USER#${userId}`, SK: `CONV_META#${conversationId}` },
    UpdateExpression: 'SET title = :t, updatedAt = :now',
    ExpressionAttributeValues: { ':t': newTitle.slice(0, 120), ':now': now },
  }));
}

/**
 * Set preferredApiKeyIndex for cache affinity on this conversation.
 */
export async function setPreferredApiKey({ userId, conversationId, apiKeyIndex }) {
  if (apiKeyIndex == null) return;
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `USER#${userId}`, SK: `CONV_META#${conversationId}` },
      UpdateExpression: 'SET preferredApiKeyIndex = if_not_exists(preferredApiKeyIndex, :idx)',
      ExpressionAttributeValues: { ':idx': apiKeyIndex },
    }));
  } catch (e) {
    console.warn('[MessageStore] setPreferredApiKey failed:', e.message);
  }
}
