/**
 * manage_preferences tool
 *
 * CRUD on student preferences. Stored one item per preference:
 *   PK: USER#{userId}, SK: PREF#{key}, value: string, updatedAt: ISO
 *
 * Actions: add | update | delete
 * (No `get` — preferences are pre-loaded in context every turn.)
 */

import { PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../../aws/dynamodb.js';

function normalizeKey(key) {
  if (!key || typeof key !== 'string') return null;
  return key.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 64);
}

export const managePreferences = {
  name: 'manage_preferences',
  description: 'Save, update, or delete a student preference. Preferences are pre-loaded every turn so no get action is needed.',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'update', 'delete'] },
      key: { type: 'string', description: 'snake_case preference key' },
      value: { type: 'string', description: 'free-form value (required for add/update)' },
    },
    required: ['action', 'key'],
  },

  async handler({ action, key, value }, ctx) {
    if (!ctx?.userId) return { error: 'userId required in context' };
    const normKey = normalizeKey(key);
    if (!normKey) return { error: 'invalid key' };

    const pk = `USER#${ctx.userId}`;
    const sk = `PREF#${normKey}`;

    if (action === 'add' || action === 'update') {
      if (!value || typeof value !== 'string') {
        return { error: 'value required for add/update' };
      }
      await docClient.send(new PutCommand({
        TableName: TABLE,
        Item: {
          PK: pk,
          SK: sk,
          key: normKey,
          value: value.trim().slice(0, 1000),
          updatedAt: new Date().toISOString(),
        },
      }));
      return { ok: true, action, key: normKey, value };
    }

    if (action === 'delete') {
      await docClient.send(new DeleteCommand({
        TableName: TABLE,
        Key: { PK: pk, SK: sk },
      }));
      return { ok: true, action: 'delete', key: normKey };
    }

    return { error: `unknown action: ${action}` };
  },
};
