/**
 * API Key Rotator for Gemini
 * Manages rotation through multiple API keys
 */

import { config } from '../config.js';

/**
 * @typedef {Object} KeyRotatorState
 * @property {number} currentIndex - Current key index
 * @property {Map<number, number>} failureCounts - Failure count per key
 * @property {Map<number, number>} lastFailureTime - Last failure timestamp per key
 */

/** @type {KeyRotatorState} */
const state = {
  currentIndex: 0,
  failureCounts: new Map(),
  lastFailureTime: new Map()
};

// Reset failure count after this duration (5 minutes)
const FAILURE_RESET_MS = 5 * 60 * 1000;

/**
 * Get all available Gemini API keys
 * @returns {string[]}
 */
export function getApiKeys() {
  return config.gemini.apiKeys;
}

/**
 * Get the total number of API keys
 * @returns {number}
 */
export function getKeyCount() {
  return config.gemini.apiKeys.length;
}

/**
 * Get the next available API key
 * @returns {{ key: string, index: number } | null}
 */
export function getNextKey() {
  const keys = getApiKeys();
  if (keys.length === 0) return null;

  const now = Date.now();

  // Try each key starting from current index
  for (let i = 0; i < keys.length; i++) {
    const index = (state.currentIndex + i) % keys.length;
    const key = keys[index];

    // Reset failure count if enough time has passed
    const lastFailure = state.lastFailureTime.get(index);
    if (lastFailure && now - lastFailure > FAILURE_RESET_MS) {
      state.failureCounts.set(index, 0);
    }

    // Update current index for next call
    state.currentIndex = (index + 1) % keys.length;

    return { key, index };
  }

  return null;
}

/**
 * Get a specific key by index
 * @param {number} index
 * @returns {string | null}
 */
export function getKeyByIndex(index) {
  const keys = getApiKeys();
  return keys[index] || null;
}

/**
 * Mark a key as failed
 * @param {number} index
 */
export function markKeyFailed(index) {
  const currentCount = state.failureCounts.get(index) || 0;
  state.failureCounts.set(index, currentCount + 1);
  state.lastFailureTime.set(index, Date.now());
}

/**
 * Mark a key as successful (reset failure count)
 * @param {number} index
 */
export function markKeySuccess(index) {
  state.failureCounts.set(index, 0);
}

/**
 * Get failure count for a key
 * @param {number} index
 * @returns {number}
 */
export function getFailureCount(index) {
  return state.failureCounts.get(index) || 0;
}

/**
 * Reset all state (useful for testing)
 */
export function resetState() {
  state.currentIndex = 0;
  state.failureCounts.clear();
  state.lastFailureTime.clear();
}

/**
 * Get iterator for all keys (for retry loop)
 * @returns {Generator<{ key: string, index: number }, void, unknown>}
 */
export function* keyIterator() {
  const keys = getApiKeys();
  for (let i = 0; i < keys.length; i++) {
    yield { key: keys[i], index: i };
  }
}

export default {
  getApiKeys,
  getKeyCount,
  getNextKey,
  getKeyByIndex,
  markKeyFailed,
  markKeySuccess,
  getFailureCount,
  resetState,
  keyIterator
};
