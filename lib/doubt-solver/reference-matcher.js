/**
 * Reference Set Matcher
 *
 * After each AI turn, Gemini returns reference_sets like:
 *   [{ summary: "...", image_ids: ["R1", "R2"] }]
 *
 * We need to assign stable ref_set_IDs across turns:
 *   - If a new set's images + summary closely match an existing ref_set, reuse that ID
 *   - Otherwise, create a new ref_set_N
 *
 * Persistence (DynamoDB):
 *   PK: CONV#{convId}, SK: REFSET#{n}
 *     { summary: string, image_ids: string[], createdAt }
 *   PK: CONV#{convId}, SK: REFSET_COUNTER
 *     { value: number }
 */

import { QueryCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';

const IMAGE_OVERLAP_THRESHOLD = 0.6;   // >=60% of images shared → same set
const SUMMARY_SIMILARITY_THRESHOLD = 0.5;

/**
 * List all existing ref sets for a conversation.
 */
export async function listRefSets(convId) {
  const res = await docClient.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `CONV#${convId}`,
      ':sk': 'REFSET#',
    },
  }));

  return (res.Items || []).map(item => ({
    id: item.SK.replace('REFSET#', ''), // "1" → use as ref_set_1
    ref_set_id: `ref_set_${item.SK.replace('REFSET#', '')}`,
    summary: item.summary,
    image_ids: item.image_ids || [],
    createdAt: item.createdAt,
  }));
}

async function getCounter(convId) {
  const res = await docClient.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `CONV#${convId}`, SK: 'REFSET_COUNTER' },
  }));
  return res.Item?.value || 0;
}

async function setCounter(convId, value) {
  await docClient.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `CONV#${convId}`,
      SK: 'REFSET_COUNTER',
      value,
      updatedAt: new Date().toISOString(),
    },
  }));
}

/**
 * Jaccard similarity over image_ids sets.
 */
function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const x of setA) if (setB.has(x)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/**
 * Simple bag-of-words similarity for summaries (lowercased token overlap).
 */
function summarySimilarity(a, b) {
  const tokA = new Set((a || '').toLowerCase().split(/\s+/).filter(Boolean));
  const tokB = new Set((b || '').toLowerCase().split(/\s+/).filter(Boolean));
  return jaccard([...tokA], [...tokB]);
}

/**
 * Match new reference_sets from the AI against existing stored ones.
 * For each new set:
 *   - If it matches an existing (by image overlap OR summary similarity), reuse its ID
 *   - Else assign a new sequential ID
 * Returns an array parallel to input with assigned ref_set_ids.
 */
export async function matchAndStoreRefSets(convId, newSets) {
  if (!Array.isArray(newSets) || newSets.length === 0) return [];

  const existing = await listRefSets(convId);
  let counter = await getCounter(convId);
  const assignments = [];

  for (const newSet of newSets) {
    const summary = newSet.summary || '';
    const imageIds = Array.isArray(newSet.image_ids) ? newSet.image_ids : [];

    // Find best match among existing
    let bestMatch = null;
    let bestScore = 0;
    for (const ex of existing) {
      const imgOverlap = jaccard(imageIds, ex.image_ids);
      const sumSim = summarySimilarity(summary, ex.summary);
      // Match if EITHER strong image overlap OR strong summary similarity
      const score = Math.max(imgOverlap, sumSim);
      const isMatch = imgOverlap >= IMAGE_OVERLAP_THRESHOLD || sumSim >= SUMMARY_SIMILARITY_THRESHOLD;
      if (isMatch && score > bestScore) {
        bestMatch = ex;
        bestScore = score;
      }
    }

    let refSetId;
    let n;
    if (bestMatch) {
      refSetId = bestMatch.ref_set_id;
      n = bestMatch.id;
      // Update the existing set with merged image_ids + latest summary (if changed)
      const mergedImages = Array.from(new Set([...(bestMatch.image_ids || []), ...imageIds]));
      await docClient.send(new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `CONV#${convId}`,
          SK: `REFSET#${n}`,
          summary: summary || bestMatch.summary,
          image_ids: mergedImages,
          createdAt: bestMatch.createdAt,
          updatedAt: new Date().toISOString(),
        },
      }));
    } else {
      counter += 1;
      n = String(counter);
      refSetId = `ref_set_${n}`;
      await docClient.send(new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `CONV#${convId}`,
          SK: `REFSET#${n}`,
          summary,
          image_ids: imageIds,
          createdAt: new Date().toISOString(),
        },
      }));
      // Add to existing list so later iterations in this call see it
      existing.push({ id: n, ref_set_id: refSetId, summary, image_ids: imageIds });
    }

    assignments.push({
      ref_set_id: refSetId,
      summary,
      image_ids: imageIds,
      reused: Boolean(bestMatch),
      match_score: Number(bestScore.toFixed(3)),
    });
  }

  if (counter !== (await getCounter(convId))) {
    await setCounter(convId, counter);
  }

  return assignments;
}

/**
 * Fetch specific ref sets by their IDs (e.g., "ref_set_1", "ref_set_3").
 */
export async function fetchRefSets(convId, refSetIds) {
  if (!Array.isArray(refSetIds) || refSetIds.length === 0) return [];

  const out = [];
  for (const id of refSetIds) {
    const n = id.replace('ref_set_', '');
    const res = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { PK: `CONV#${convId}`, SK: `REFSET#${n}` },
    }));
    if (res.Item) {
      out.push({
        ref_set_id: id,
        summary: res.Item.summary,
        image_ids: res.Item.image_ids || [],
      });
    }
  }
  return out;
}
