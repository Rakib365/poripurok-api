/**
 * Local ID Registry — Maps short conversation-scoped IDs (R1, R2, ...) to image UUIDs.
 *
 * Prevents Gemini from having to reference 36-char UUIDs in reference_sets.
 * Each conversation has its own sequential R1, R2, R3... mapping.
 *
 * Prefix:
 *   R = Reference image (R1, R2, ...)
 *
 * Storage: DynamoDB — PK: CONV#{conversationId}, SK: LOCAL_ID_MAP
 * Cache: in-memory per invocation.
 */

import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';

const registryCache = new Map();
const LOCAL_ID_RE = /^R(\d+)$/i;

/**
 * Load or initialize a registry for a conversation.
 */
export async function getRegistry(conversationId) {
  if (!conversationId) throw new Error('conversationId required for local ID registry');

  if (registryCache.has(conversationId)) {
    return registryCache.get(conversationId);
  }

  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { PK: `CONV#${conversationId}`, SK: 'LOCAL_ID_MAP' },
    }));

    if (result.Item) {
      const registry = {
        forward: result.Item.forward || {},  // { R1: "uuid-abc" }
        reverse: result.Item.reverse || {},  // { "uuid-abc": "R1" }
        counter: result.Item.counter || 0,
        dirty: false,
      };
      registryCache.set(conversationId, registry);
      return registry;
    }
  } catch (err) {
    console.error(`[LocalIdRegistry] Load failed for ${conversationId}:`, err.message);
  }

  const registry = { forward: {}, reverse: {}, counter: 0, dirty: false };
  registryCache.set(conversationId, registry);
  return registry;
}

/**
 * Assign a local ID (R1, R2, ...) to a UUID. Idempotent — returns existing ID if already mapped.
 */
export function assignLocalId(registry, uuid) {
  if (!uuid) return uuid;

  if (registry.reverse[uuid]) {
    return registry.reverse[uuid];
  }

  registry.counter += 1;
  const localId = `R${registry.counter}`;

  registry.forward[localId] = uuid;
  registry.reverse[uuid] = localId;
  registry.dirty = true;

  return localId;
}

/**
 * Resolve R1 → UUID.
 */
export function resolveLocalId(registry, localId) {
  if (!localId) return null;
  return registry.forward[localId.toUpperCase()] || null;
}

/**
 * Check if string is R<number> format.
 */
export function isLocalId(str) {
  return LOCAL_ID_RE.test(str);
}

/**
 * Persist registry to DynamoDB (only if dirty).
 */
export async function saveRegistry(conversationId) {
  const registry = registryCache.get(conversationId);
  if (!registry || !registry.dirty) return;

  try {
    await docClient.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `CONV#${conversationId}`,
        SK: 'LOCAL_ID_MAP',
        forward: registry.forward,
        reverse: registry.reverse,
        counter: registry.counter,
        updatedAt: new Date().toISOString(),
      },
    }));
    registry.dirty = false;
  } catch (err) {
    console.error(`[LocalIdRegistry] Save failed for ${conversationId}:`, err.message);
    throw err;
  }
}

/**
 * Convert UUID → local ID if it exists in the registry.
 */
export function toLocalId(registry, uuid) {
  if (!uuid) return uuid;
  return registry.reverse[uuid] || uuid;
}
