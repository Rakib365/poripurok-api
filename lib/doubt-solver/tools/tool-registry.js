/**
 * Tool Registry for the Doubt Solver agent loop.
 *
 * Each tool is a module exporting:
 *   - name: string
 *   - description: string
 *   - handler: async (args, ctx) => result
 *   - schema: { properties, required } — for Gemini function calling (optional)
 */

import { searchKb } from './search-kb.js';
import { managePreferences } from './manage-preferences.js';
import { manageConversations } from './manage-conversations.js';
import { manageReferencedKb } from './manage-referenced-kb.js';

const TOOLS = {
  search_kb: searchKb,
  manage_preferences: managePreferences,
  manage_conversations: manageConversations,
  manage_referenced_kb: manageReferencedKb,
};

export function listTools() {
  return Object.keys(TOOLS);
}

export function getTool(name) {
  return TOOLS[name] || null;
}

/**
 * Execute a tool call.
 *
 * @param {string} name - tool name
 * @param {object} args - arguments from the LLM
 * @param {object} ctx - execution context: { conversationId, userId, registry }
 * @returns {Promise<object>} tool result (will be JSON-stringified back to the LLM)
 */
export async function executeTool(name, args, ctx) {
  const tool = getTool(name);
  if (!tool) {
    return { error: `Unknown tool: ${name}` };
  }

  try {
    const result = await tool.handler(args, ctx);
    return result;
  } catch (err) {
    console.error(`[Tool:${name}] Execution failed:`, err);
    return { error: err.message };
  }
}
