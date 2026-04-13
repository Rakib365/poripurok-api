/**
 * LLM Abstraction Layer
 * Unified interface for multiple LLM providers (Gemini API, OpenRouter)
 *
 * Features:
 * - Unified request/response format
 * - Automatic provider routing
 * - API key rotation for Gemini (up to 5 keys)
 * - Fallback from Gemini to OpenRouter
 * - Exponential backoff retry
 * - Thinking/reasoning configuration per model
 * - Tool calling support
 * - Structured output support
 */

import { config, isGeminiModel, getGeminiModelConfig, getOpenRouterModelId } from './config.js';
import { validateRequest, assertValidRequest } from './request-validator.js';
import { routeRequest, getProviderStatus } from './provider-router.js';

/**
 * Generate text using the unified LLM interface
 *
 * @param {Object} request - The unified request
 * @returns {Promise<Object>} Unified response
 *
 * @example
 * // Simple text generation
 * const response = await generateText({
 *   model: 'gemini-3-flash',
 *   messages: [
 *     { role: 'user', parts: [{ type: 'text', text: 'Hello!' }] }
 *   ]
 * });
 *
 * @example
 * // With thinking enabled
 * const response = await generateText({
 *   model: 'gemini-2.5-flash',
 *   messages: [
 *     { role: 'user', parts: [{ type: 'text', text: 'Solve this problem...' }] }
 *   ],
 *   thinking: {
 *     enabled: true,
 *     level: 'high',
 *     includeThoughts: true
 *   }
 * });
 */
export async function generateText(request) {
  try {
    const result = await routeRequest(request);
    return result.response;
  } catch (error) {
    // Catch any unexpected errors
    return {
      success: false,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message || 'An unexpected error occurred',
        provider: 'router',
        retryable: false
      },
      metadata: {
        model: request.model || '',
        provider: 'router',
        retryCount: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      }
    };
  }
}

/**
 * Generate text with detailed routing information
 *
 * @param {Object} request
 * @returns {Promise<{ response: Object, routing: { provider: string, totalRetries: number } }>}
 */
export async function generateTextWithRouting(request) {
  try {
    const result = await routeRequest(request);
    return {
      response: result.response,
      routing: {
        provider: result.provider,
        totalRetries: result.totalRetries
      }
    };
  } catch (error) {
    return {
      response: {
        success: false,
        error: {
          code: 'UNEXPECTED_ERROR',
          message: error.message || 'An unexpected error occurred',
          provider: 'router',
          retryable: false
        },
        metadata: {
          model: request.model || '',
          provider: 'router',
          retryCount: 0,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
        }
      },
      routing: {
        provider: 'unknown',
        totalRetries: 0
      }
    };
  }
}

/**
 * Helper: Create a simple text message
 * @param {string} role - 'system', 'user', or 'assistant'
 * @param {string} text - The message text
 * @returns {Object}
 */
export function createTextMessage(role, text) {
  return {
    role,
    parts: [{ type: 'text', text }]
  };
}

/**
 * Helper: Create a message with an image
 * @param {string} role - 'user' (images typically in user messages)
 * @param {string} text - The text prompt
 * @param {string} imageUrl - URL to the image
 * @param {string} [mimeType] - Optional MIME type
 * @returns {Object}
 */
export function createImageMessage(role, text, imageUrl, mimeType) {
  return {
    role,
    parts: [
      { type: 'text', text },
      { type: 'image', url: imageUrl, mimeType }
    ]
  };
}

/**
 * Helper: Create a message with a PDF
 * @param {string} role - 'user'
 * @param {string} text - The text prompt
 * @param {string} pdfUrl - URL to the PDF
 * @returns {Object}
 */
export function createPdfMessage(role, text, pdfUrl) {
  return {
    role,
    parts: [
      { type: 'text', text },
      { type: 'pdf', url: pdfUrl }
    ]
  };
}

/**
 * Helper: Create thinking configuration
 * @param {'low' | 'medium' | 'high' | 'dynamic'} level
 * @param {boolean} [includeThoughts=false]
 * @returns {Object}
 */
export function createThinkingConfig(level, includeThoughts = false) {
  return {
    enabled: true,
    level,
    includeThoughts
  };
}

/**
 * Helper: Create a tool definition
 * @param {string} name - Tool name
 * @param {string} description - Tool description
 * @param {Object} parameters - JSON Schema for parameters
 * @returns {Object}
 */
export function createTool(name, description, parameters) {
  return { name, description, parameters };
}

// Re-export utilities
export { validateRequest, assertValidRequest } from './request-validator.js';
export { getProviderStatus } from './provider-router.js';
export { config, isGeminiModel, getGeminiModelConfig, getOpenRouterModelId } from './config.js';
export { resetState as resetKeyRotator } from './utils/api-key-rotator.js';

// Raw debug capture (for exact payload logging)
export { startRawDebugCapture, getRawDebugCapture } from './utils/raw-debug-capture.js';

// Default export
export default {
  generateText,
  generateTextWithRouting,
  createTextMessage,
  createImageMessage,
  createPdfMessage,
  createThinkingConfig,
  createTool,
  validateRequest,
  getProviderStatus,
  config
};
