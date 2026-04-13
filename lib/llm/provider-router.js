/**
 * Provider Router
 * Routes requests to appropriate provider with retry and fallback logic
 *
 * Retry Strategy (optimized for cache hits):
 * 1. Always start with API key #1 (cache locality)
 * 2. On non-500 errors (400, 429, etc.) → retry SAME key with backoff
 * 3. On 500-series errors → rotate to next key
 * 4. If all keys exhausted → fallback to OpenRouter (for non-urlContext requests)
 * 5. Max 3 retries per key for non-500 errors
 */

import { config, isGeminiModel, getOpenRouterModelId } from './config.js';
import { assertValidRequest } from './request-validator.js';
import { sleep, calculateBackoff } from './utils/retry.js';
import { getApiKeys, markKeyFailed, markKeySuccess, getKeyCount } from './utils/api-key-rotator.js';
import * as geminiProvider from './providers/gemini.js';
import * as openrouterProvider from './providers/openrouter.js';

const MAX_RETRIES_PER_KEY = 5;

/**
 * Route a request to the appropriate provider with retry logic
 */
export async function routeRequest(request) {
  assertValidRequest(request);

  const isGemini = isGeminiModel(request.model);
  let totalRetries = 0;

  // Try Gemini first if it's a Gemini model
  if (isGemini && config.gemini.enabled && getKeyCount() > 0) {
    const geminiResult = await tryGeminiWithCacheOptimizedRetry(request);
    totalRetries += geminiResult.retryCount;

    if (geminiResult.success) {
      return {
        provider: 'gemini',
        response: geminiResult.response,
        totalRetries,
      };
    }

    // urlContext requires native Gemini — can't fallback to OpenRouter
    if (request.urlContext?.enabled) {
      console.log(`[Router] All Gemini keys failed — urlContext requires native Gemini, no fallback`);
      return { provider: 'gemini', response: geminiResult.response, totalRetries };
    }

    console.log(`[Router] All ${getKeyCount()} Gemini keys failed, falling back to OpenRouter`);
  }

  // Fallback to OpenRouter
  if (config.openrouter.enabled) {
    const openrouterResult = await tryOpenRouterWithRetries(request);
    totalRetries += openrouterResult.retryCount;

    return {
      provider: 'openrouter',
      response: openrouterResult.response,
      totalRetries,
    };
  }

  return {
    provider: isGemini ? 'gemini' : 'openrouter',
    response: {
      success: false,
      error: { code: 'NO_PROVIDER', message: 'No providers available or all failed', provider: 'router', retryable: false },
      metadata: { model: request.model, provider: 'router', retryCount: totalRetries, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    },
    totalRetries,
  };
}

/**
 * Cache-optimized Gemini retry:
 * - Always start with key #1 for cache hits
 * - Non-500 errors → retry same key (up to MAX_RETRIES_PER_KEY)
 * - 500-series → rotate to next key immediately
 */
async function tryGeminiWithCacheOptimizedRetry(request) {
  const keys = getApiKeys();
  let lastError = null;
  let totalRetryCount = 0;

  for (let keyIdx = 0; keyIdx < keys.length; keyIdx++) {
    const key = keys[keyIdx];
    let sameKeyRetries = 0;

    while (sameKeyRetries < MAX_RETRIES_PER_KEY) {
      try {
        console.log(`[Router] Trying Gemini API key #${keyIdx + 1}${sameKeyRetries > 0 ? ` (retry ${sameKeyRetries})` : ''}`);

        const t0 = Date.now();
        const response = await geminiProvider.makeRequest(request, key, keyIdx, totalRetryCount);
        if (response.metadata) response.metadata.latency_ms = Date.now() - t0;

        if (response.success) {
          markKeySuccess(keyIdx);
          return { success: true, response, retryCount: totalRetryCount };
        }

        // Non-success response (structured error from Gemini)
        lastError = response.error;
        const statusCode = response.error?.status || response.error?.code;
        // 429 (rate limit) → keep same key with backoff; 5xx → rotate to a fresh key.
        const shouldRotateKey = statusCode >= 500 && statusCode < 600;

        if (shouldRotateKey) {
          // 500-series or 429 (quota exceeded) → rotate to next key
          markKeyFailed(keyIdx);
          totalRetryCount++;
          console.log(`[Router] Gemini key #${keyIdx + 1} — ${statusCode} error, rotating key`);
          break; // break inner loop → try next key
        } else {
          // Other errors (400, etc.) → retry same key with backoff
          sameKeyRetries++;
          totalRetryCount++;
          console.log(`[Router] Gemini key #${keyIdx + 1} — ${statusCode} error, retrying same key (${sameKeyRetries}/${MAX_RETRIES_PER_KEY})`);

          if (sameKeyRetries < MAX_RETRIES_PER_KEY) {
            const delay = calculateBackoff(sameKeyRetries - 1);
            console.log(`[Router] Waiting ${delay}ms before retry`);
            await sleep(delay);
          }
        }

      } catch (error) {
        lastError = error;
        const statusCode = error.status || error.code;
        // 429 (rate limit) → keep same key with backoff; 5xx → rotate to a fresh key.
        const shouldRotate = typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600;

        if (shouldRotate) {
          markKeyFailed(keyIdx);
          totalRetryCount++;
          console.log(`[Router] Gemini key #${keyIdx + 1} threw ${statusCode}, rotating key`);
          break;
        } else {
          sameKeyRetries++;
          totalRetryCount++;
          console.log(`[Router] Gemini key #${keyIdx + 1} threw ${statusCode || error.message}, retrying same key (${sameKeyRetries}/${MAX_RETRIES_PER_KEY})`);
          console.log(`[Router]   Gemini error detail: ${error.message || JSON.stringify(error).slice(0, 500)}`);

          if (sameKeyRetries < MAX_RETRIES_PER_KEY) {
            const delay = calculateBackoff(sameKeyRetries - 1);
            console.log(`[Router] Waiting ${delay}ms before retry`);
            await sleep(delay);
          }
        }
      }
    }
  }

  // All keys exhausted
  return {
    success: false,
    response: {
      success: false,
      error: {
        code: lastError?.code || 'ALL_KEYS_FAILED',
        message: lastError?.message || 'All Gemini API keys failed',
        provider: 'gemini',
      },
      metadata: {
        model: request.model,
        provider: 'gemini',
        retryCount: totalRetryCount,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    },
    retryCount: totalRetryCount,
  };
}

/**
 * Try OpenRouter with retries
 */
async function tryOpenRouterWithRetries(request, maxRetries = 5) {
  let lastResponse = null;
  let retryCount = 0;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Router] Trying OpenRouter (attempt ${attempt + 1}/${maxRetries})`);

      const t0 = Date.now();
      const response = await openrouterProvider.makeRequest(request, retryCount);
      if (response.metadata) response.metadata.latency_ms = Date.now() - t0;

      if (response.success) {
        return { success: true, response, retryCount };
      }

      lastResponse = response;
      retryCount++;
      console.log(`[Router] OpenRouter attempt ${attempt + 1} failed: ${response.error?.message}`);

    } catch (error) {
      retryCount++;
      console.log(`[Router] OpenRouter attempt ${attempt + 1} threw: ${error.message || error.name}`);

      lastResponse = {
        success: false,
        error: { code: String(error.code || error.status || 'UNKNOWN'), message: error.message || 'Unknown error', provider: 'openrouter' },
        metadata: { model: request.model, provider: 'openrouter', retryCount, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      };
    }

    if (attempt < maxRetries - 1) {
      const delay = calculateBackoff(attempt);
      console.log(`[Router] Waiting ${delay}ms before retry`);
      await sleep(delay);
    }
  }

  return {
    success: false,
    response: lastResponse || {
      success: false,
      error: { code: 'MAX_RETRIES', message: 'All OpenRouter retries exhausted', provider: 'openrouter' },
      metadata: { model: request.model, provider: 'openrouter', retryCount, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    },
    retryCount,
  };
}

/**
 * Get provider status
 */
export function getProviderStatus() {
  return {
    gemini: { enabled: config.gemini.enabled, keyCount: getKeyCount() },
    openrouter: { enabled: config.openrouter.enabled },
  };
}

export default { routeRequest, getProviderStatus };
