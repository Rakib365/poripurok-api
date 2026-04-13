/**
 * Cost calculation helpers for the Doubt Solver.
 *
 * Reuses the canonical pricing table from lib/llm/config.js via
 * `calculateFallbackCost`. This thin layer just wraps it so the agent loop
 * has a clear, doubt-solver-scoped API.
 */

import { calculateFallbackCost } from '../llm/config.js';

/**
 * Compute USD cost for a generateContent call.
 * Gemini charges cached input tokens at 10% of the normal input rate.
 *
 * @param {object} args
 * @param {string} args.model
 * @param {number} args.inputTokens
 * @param {number} args.outputTokens
 * @param {number} [args.cachedTokens=0]
 * @param {number} [args.thinkingTokens=0]
 * @returns {number} USD cost (0 if model not in pricing table)
 */
export function calculateGenerationCost({ model, inputTokens = 0, outputTokens = 0, cachedTokens = 0, thinkingTokens = 0 }) {
  const cost = calculateFallbackCost(model, inputTokens, outputTokens, cachedTokens, thinkingTokens);
  return cost == null ? 0 : cost;
}

/**
 * Compute USD cost for a batch embedding call.
 *
 * @param {object} args
 * @param {string} [args.model='gemini-embedding-2-preview']
 * @param {number} args.inputTokens
 * @returns {number} USD cost
 */
export function calculateEmbeddingCost({ model = 'gemini-embedding-2-preview', inputTokens = 0 }) {
  const cost = calculateFallbackCost(model, inputTokens, 0, 0, 0);
  return cost == null ? 0 : cost;
}
