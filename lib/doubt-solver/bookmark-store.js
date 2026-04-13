/**
 * Bookmark store — multi-type with redirect metadata.
 *
 * Types (extensible):
 *   - doubt_message: target = { convId, msgId }
 *   - question:      target = { questionId, projectId }
 *   - exam:          target = { examId }
 *   - study_book:    target = { bookId, pageId? }
 *
 * Schema:
 *   PK: USER#{sid}, SK: BOOKMARK#{ulid}
 *     { bookmarkId, type, target, metadata, createdAt, updatedAt,
 *       GSI2PK: USER#{sid}#TYPE#{type}, GSI2SK: createdAt }
 *
 * We also write a reverse lookup so clients/agents can detect "is this
 * thing bookmarked?" cheaply without scanning every bookmark.
 *
 *   PK: CONV#{convId}, SK: BOOKMARK_MSG#{msgId}  (for doubt_message)
 *     { bookmarkId, userId, createdAt }
 */

import { ulid } from 'ulid';
import { PutCommand, DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';

const VALID_TYPES = new Set(['doubt_message', 'question', 'exam', 'study_book']);

function reverseKey(type, target) {
  switch (type) {
    case 'doubt_message':
      return { PK: `CONV#${target.convId}`, SK: `BOOKMARK_MSG#${target.msgId}` };
    case 'question':
      return { PK: `QUESTION#${target.questionId}`, SK: 'BOOKMARK_REVERSE' };
    case 'exam':
      return { PK: `EXAM#${target.examId}`, SK: 'BOOKMARK_REVERSE' };
    case 'study_book':
      return { PK: `STUDYBOOK#${target.bookId}`, SK: `BOOKMARK_PAGE#${target.pageId || 'ROOT'}` };
    default:
      return null;
  }
}

/**
 * Create a new bookmark.
 */
export async function createBookmark({ userId, type, target, metadata = {} }) {
  if (!userId) throw new Error('userId required');
  if (!VALID_TYPES.has(type)) return { ok: false, reason: 'invalid_type' };
  if (!target || typeof target !== 'object') return { ok: false, reason: 'invalid_target' };

  const bookmarkId = ulid();
  const now = new Date().toISOString();

  const item = {
    PK: `USER#${userId}`,
    SK: `BOOKMARK#${bookmarkId}`,
    bookmarkId,
    userId,
    type,
    target,
    metadata: {
      title: (metadata.title || '').slice(0, 200),
      preview: (metadata.preview || '').slice(0, 400),
      subject: metadata.subject || null,
      thumbnailUrl: metadata.thumbnailUrl || null,
      sourceLabel: metadata.sourceLabel || null,
      extra: metadata.extra || null,
    },
    createdAt: now,
    updatedAt: now,
    GSI2PK: `USER#${userId}#TYPE#${type}`,
    GSI2SK: now,
  };

  // Put main + reverse lookup atomically-ish (best effort)
  await docClient.send(new PutCommand({ TableName: TABLE, Item: item }));

  const revKey = reverseKey(type, target);
  if (revKey) {
    try {
      await docClient.send(new PutCommand({
        TableName: TABLE,
        Item: { ...revKey, bookmarkId, userId, createdAt: now },
      }));
    } catch (e) {
      console.warn('[BookmarkStore] reverse write failed:', e.message);
    }
  }

  return { ok: true, bookmarkId, createdAt: now };
}

/**
 * Delete a bookmark by ID (or by target for idempotent toggles).
 */
export async function deleteBookmark({ userId, bookmarkId = null, type = null, target = null }) {
  if (!userId) throw new Error('userId required');

  let id = bookmarkId;

  // Fallback: find via reverse lookup
  if (!id && type && target) {
    const revKey = reverseKey(type, target);
    if (revKey) {
      const res = await docClient.send(new GetCommand({ TableName: TABLE, Key: revKey }));
      id = res.Item?.bookmarkId;
    }
  }

  if (!id) return { ok: false, reason: 'bookmark_not_found' };

  // Delete main row — also need type+target for reverse key; fetch main row first
  const main = await docClient.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `USER#${userId}`, SK: `BOOKMARK#${id}` },
  }));
  if (!main.Item) return { ok: false, reason: 'bookmark_not_found' };

  await docClient.send(new DeleteCommand({
    TableName: TABLE,
    Key: { PK: `USER#${userId}`, SK: `BOOKMARK#${id}` },
  }));

  const revKey = reverseKey(main.Item.type, main.Item.target);
  if (revKey) {
    try {
      await docClient.send(new DeleteCommand({ TableName: TABLE, Key: revKey }));
    } catch (e) { /* already gone */ }
  }

  return { ok: true };
}

/**
 * Is a specific target bookmarked by this user?
 * (via reverse lookup — O(1))
 */
export async function isBookmarked({ userId, type, target }) {
  const revKey = reverseKey(type, target);
  if (!revKey) return null;
  const res = await docClient.send(new GetCommand({ TableName: TABLE, Key: revKey }));
  if (!res.Item || res.Item.userId !== userId) return null;
  return res.Item.bookmarkId;
}

/**
 * List a user's bookmarks (optionally filtered by type).
 *
 * Note: type-filtered queries use the GSI (UserBookmarkTypeIndex).
 * If the GSI doesn't exist yet, falls back to main table + client filter.
 */
export async function listBookmarks({ userId, type = null, limit = 20, cursor = null }) {
  if (type) {
    try {
      const res = await docClient.send(new QueryCommand({
        TableName: TABLE,
        IndexName: 'UserBookmarkTypeIndex',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': `USER#${userId}#TYPE#${type}` },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: cursor || undefined,
      }));
      return {
        items: res.Items || [],
        cursor: res.LastEvaluatedKey || null,
      };
    } catch (e) {
      // GSI may not exist yet — fall back
      console.warn('[BookmarkStore] GSI query failed, falling back to main table:', e.message);
    }
  }

  const res = await docClient.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}`,
      ':sk': 'BOOKMARK#',
    },
    ScanIndexForward: false,
    Limit: limit,
    ExclusiveStartKey: cursor || undefined,
  }));

  let items = res.Items || [];
  if (type) items = items.filter(i => i.type === type);
  return { items, cursor: res.LastEvaluatedKey || null };
}
