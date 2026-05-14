/**
 * Context Loader
 *
 * Fetches everything that should be pre-loaded into Gemini's context
 * at the start of every turn:
 *
 *   - Student profile (name, college, class)
 *   - Current package + quota + validity
 *   - Available packages (for upgrade suggestions)
 *   - Preferences (free-form key-value)
 *   - Conversation metadata (total conversations, messages in this one)
 *   - Available reference sets from earlier turns of this conversation
 *
 * Outputs an XML-shaped string ready to inject as the session context message.
 */

import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';
import { logger } from '../aws/cloudwatch.js';
import { listRefSets } from './reference-matcher.js';
import { getReaction } from './reaction-store.js';
import { listFeedback } from './feedback-store.js';
import { listPackages } from './package-catalog.js';

// ---------------------- Individual loaders ----------------------

async function loadStudent(userId) {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `USER#${userId}`, SK: 'PROFILE' },
    ProjectionExpression: 'full_name, college_name, hsc_batch, profile_picture',
  }));
  return res.Item || null;
}

async function loadPackage(userId) {
  // User's active doubt-solver package subscription.
  // Schema guess: PK: USER#{userId}, SK: PKG_SUBSCRIPTION#active
  //   { packageId, packageName, quotaRemaining, quotaTotal, validityEnd }
  const res = await docClient.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `USER#${userId}`, SK: 'PKG_SUBSCRIPTION#active' },
  }));
  return res.Item || null;
}

async function loadAvailablePackages() {
  // Reads from PACKAGE_CATALOG via listPackages() — authoritative catalog.
  // Returns the normalized shape the XML builder consumes.
  const pkgs = await listPackages();
  return pkgs.map(p => ({
    id: p.id,
    name: p.name,
    emoji: p.emoji,
    price: p.price,
    original_price: p.originalPrice,
    credits: p.credits,
    validity_days: p.durationDays,
    description: p.description,
    recommended: p.recommended,
  }));
}

async function loadPreferences(userId) {
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}`,
      ':sk': 'PREF#',
    },
  }));

  const prefs = {};
  for (const item of res.Items || []) {
    prefs[item.key] = item.value;
  }
  return prefs;
}

async function loadConversationMeta(userId, convId) {
  let totalConversations = 0;
  let messagesInThisConv = 0;
  let currentTitle = null;

  // Count total conversations for this user
  try {
    const res = await docClient.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `USER#${userId}`,
        ':sk': 'CONV_META#',
      },
      Select: 'COUNT',
    }));
    totalConversations = res.Count || 0;
  } catch (e) {
    logger.warn('context-loader failed to count conversations', { error: e.message });
  }

  if (convId) {
    // Count messages in the current conversation
    try {
      const res = await docClient.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `CONV#${convId}`,
          ':sk': 'MSG#',
        },
        Select: 'COUNT',
      }));
      messagesInThisConv = res.Count || 0;
    } catch (e) {
      logger.warn('context-loader failed to count messages', { error: e.message });
    }

    // Fetch current title of this conversation
    try {
      const res = await docClient.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${userId}`, SK: `CONV_META#${convId}` },
        ProjectionExpression: 'title',
      }));
      currentTitle = res.Item?.title || null;
    } catch (e) {
      logger.warn('context-loader failed to load conversation title', { error: e.message });
    }
  }

  return { totalConversations, messagesInThisConv, currentTitle };
}

/**
 * Find the most recent assistant message in a conversation and any
 * reaction/feedback the user left on it. Used to prime the AI on the
 * next turn.
 */
async function loadLatestMessageFeedback(conversationId) {
  if (!conversationId) return null;

  // Fetch last few messages, find the latest assistant one
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `CONV#${conversationId}`, ':sk': 'MSG#' },
    ScanIndexForward: false,
    Limit: 5,
  }));

  const asstMsg = (res.Items || []).find(m => m.role === 'assistant' && !m.deletedAt);
  if (!asstMsg) return null;

  const [reaction, feedback] = await Promise.all([
    getReaction({ conversationId, messageId: asstMsg.messageId }),
    listFeedback({ conversationId, messageId: asstMsg.messageId }),
  ]);

  const hasAny = reaction || (feedback && feedback.length > 0);
  if (!hasAny) return null;

  return {
    messageId: asstMsg.messageId,
    reaction: reaction?.emoji || null,
    feedback: (feedback || []).map(f => ({
      tags: f.tags || [],
      text: f.text || '',
      hasVoice: Boolean(f.voiceS3Key),
      hasAttachments: (f.attachmentS3Keys || []).length > 0,
    })),
  };
}

// ---------------------- XML builder ----------------------

function xmlEscape(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildContextXml({ student, pkg, availablePackages, preferences, convMeta, refSets, latestFeedback }) {
  const parts = ['<session_context>'];

  parts.push('  <student>');
  parts.push(`    <name>${xmlEscape(student?.full_name) || 'Unknown'}</name>`);
  parts.push(`    <institution>${xmlEscape(student?.college_name) || 'Unknown'}</institution>`);
  parts.push(`    <class>${xmlEscape(student?.hsc_batch) || 'Unknown'}</class>`);
  parts.push('  </student>');

  if (pkg) {
    parts.push('  <package>');
    parts.push(`    <name>${xmlEscape(pkg.packageName || pkg.name)}</name>`);
    parts.push(`    <quota_remaining>${pkg.quotaRemaining ?? pkg.quota_remaining ?? 0}</quota_remaining>`);
    parts.push(`    <quota_total>${pkg.quotaTotal ?? pkg.quota_total ?? 0}</quota_total>`);
    if (pkg.validityEnd) {
      const daysLeft = Math.max(0, Math.ceil((new Date(pkg.validityEnd) - Date.now()) / (1000 * 60 * 60 * 24)));
      parts.push(`    <validity_days_left>${daysLeft}</validity_days_left>`);
    }
    parts.push('  </package>');
  } else {
    parts.push('  <package>');
    parts.push('    <name>Free Trial</name>');
    parts.push('    <quota_remaining>0</quota_remaining>');
    parts.push('  </package>');
  }

  if (availablePackages.length > 0) {
    parts.push('  <available_packages>');
    for (const p of availablePackages) {
      const creditsAttr = p.credits === -1 ? 'unlimited' : String(p.credits);
      const origPriceAttr = p.original_price && p.original_price !== p.price ? ` original_price="${p.original_price}"` : '';
      const recAttr = p.recommended ? ' recommended="true"' : '';
      parts.push(`    <pkg id="${xmlEscape(p.id)}" name="${xmlEscape(p.name)}" emoji="${xmlEscape(p.emoji || '')}" price="${p.price}"${origPriceAttr} credits="${creditsAttr}" validity_days="${p.validity_days}"${recAttr}>${xmlEscape(p.description)}</pkg>`);
    }
    parts.push('  </available_packages>');
  }

  if (Object.keys(preferences).length > 0) {
    parts.push('  <preferences>');
    for (const [key, value] of Object.entries(preferences)) {
      parts.push(`    <pref key="${xmlEscape(key)}">${xmlEscape(value)}</pref>`);
    }
    parts.push('  </preferences>');
  } else {
    parts.push('  <preferences />');
  }

  parts.push('  <conversation_metadata>');
  parts.push(`    <total_previous_conversations>${convMeta.totalConversations}</total_previous_conversations>`);
  parts.push(`    <messages_in_this_conversation>${convMeta.messagesInThisConv}</messages_in_this_conversation>`);
  if (convMeta.currentTitle) {
    parts.push(`    <current_title>${xmlEscape(convMeta.currentTitle)}</current_title>`);
  } else {
    parts.push('    <current_title />');
  }
  parts.push('  </conversation_metadata>');

  if (refSets.length > 0) {
    parts.push('  <available_reference_sets>');
    for (const rs of refSets) {
      parts.push(`    <ref_set id="${rs.ref_set_id}" summary="${xmlEscape(rs.summary)}" />`);
    }
    parts.push('  </available_reference_sets>');
  } else {
    parts.push('  <available_reference_sets />');
  }

  // Feedback the student left on your previous response (adjust the next response accordingly)
  if (latestFeedback) {
    parts.push('  <latest_message_feedback>');
    if (latestFeedback.reaction) {
      parts.push(`    <reaction>${xmlEscape(latestFeedback.reaction)}</reaction>`);
    }
    for (const f of latestFeedback.feedback || []) {
      const tagsAttr = (f.tags || []).length > 0 ? ` tags="${xmlEscape(f.tags.join(','))}"` : '';
      const voiceAttr = f.hasVoice ? ' has_voice="true"' : '';
      const attachAttr = f.hasAttachments ? ' has_attachments="true"' : '';
      parts.push(`    <feedback_item${tagsAttr}${voiceAttr}${attachAttr}>${xmlEscape(f.text || '')}</feedback_item>`);
    }
    parts.push('  </latest_message_feedback>');
  }

  parts.push('</session_context>');
  return parts.join('\n');
}

// ---------------------- Public API ----------------------

/**
 * Load the full session context for a turn.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.conversationId
 * @returns {Promise<{ xml: string, raw: object }>}
 */
export async function loadSessionContext({ userId, conversationId }) {
  if (!userId) throw new Error('userId required');

  // Fetch in parallel
  const [student, pkg, availablePackages, preferences, convMeta, refSets, latestFeedback] = await Promise.all([
    loadStudent(userId),
    loadPackage(userId),
    loadAvailablePackages(),
    loadPreferences(userId),
    loadConversationMeta(userId, conversationId),
    conversationId ? listRefSets(conversationId) : Promise.resolve([]),
    conversationId ? loadLatestMessageFeedback(conversationId) : Promise.resolve(null),
  ]);

  const xml = buildContextXml({ student, pkg, availablePackages, preferences, convMeta, refSets, latestFeedback });

  return {
    xml,
    latestFeedback,
    raw: { student, pkg, availablePackages, preferences, convMeta, refSets },
  };
}
