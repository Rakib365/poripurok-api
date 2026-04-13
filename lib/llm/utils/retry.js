/**
 * Retry Utilities with Exponential Backoff
 */

import { config } from '../config.js';

/**
 * Sleep for a given number of milliseconds
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {Object} [options]
 * @param {number} [options.initialDelayMs]
 * @param {number} [options.maxDelayMs]
 * @param {number} [options.multiplier]
 * @returns {number}
 */
export function calculateBackoff(attempt, options = {}) {
  const initialDelay = options.initialDelayMs ?? config.retry.initialDelayMs;
  const maxDelay = options.maxDelayMs ?? config.retry.maxDelayMs;
  const multiplier = options.multiplier ?? config.retry.backoffMultiplier;

  const delay = initialDelay * Math.pow(multiplier, attempt);
  return Math.min(delay, maxDelay);
}

/**
 * Check if an error/status code is retryable
 * @param {number} statusCode
 * @returns {boolean}
 */
export function isRetryableStatus(statusCode) {
  return config.retry.retryableStatusCodes.includes(statusCode);
}

/**
 * Execute a function with retry logic
 * @template T
 * @param {() => Promise<T>} fn - Function to execute
 * @param {Object} [options]
 * @param {number} [options.maxRetries] - Maximum number of retries
 * @param {Function} [options.shouldRetry] - Custom retry condition (receives error)
 * @param {Function} [options.onRetry] - Callback on each retry
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const shouldRetry = options.shouldRetry ?? (() => true);
  const onRetry = options.onRetry ?? (() => {});

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (attempt < maxRetries && shouldRetry(error, attempt)) {
        const delay = calculateBackoff(attempt);
        onRetry(error, attempt, delay);
        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

/**
 * Parse error status from various error formats
 * @param {Error} error
 * @returns {number | null}
 */
export function getErrorStatus(error) {
  // Check if it's a fetch Response error
  if (error.status) return error.status;

  // Check if status is in message
  const match = error.message?.match(/(\d{3})/);
  if (match) return parseInt(match[1], 10);

  // Check for common error properties
  if (error.statusCode) return error.statusCode;
  if (error.code && typeof error.code === 'number') return error.code;

  return null;
}

export default {
  sleep,
  calculateBackoff,
  isRetryableStatus,
  withRetry,
  getErrorStatus
};
