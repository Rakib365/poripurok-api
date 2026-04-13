/**
 * LLM Abstraction Layer Configuration
 */

export const config = {
  // Gemini API Configuration
  gemini: {
    enabled: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeys: [
      process.env.GEMINI_API_KEY,   // poripurok-api single-key mode
      process.env.GEMINI_API_KEY_1,
      process.env.GEMINI_API_KEY_2,
      process.env.GEMINI_API_KEY_3,
      process.env.GEMINI_API_KEY_4,
    ].filter(Boolean),
    maxRetriesPerKey: 1, // Each key gets 1 try

    // Model configurations
    models: {
      'gemini-3-flash': {
        id: 'gemini-3-flash-preview',
        thinkingType: 'level', // uses thinkingLevel
        supportedThinkingLevels: ['minimal', 'low', 'medium', 'high'],
        supportsUrlContext: true,
        supportsPdf: true
      },
      'gemini-3.1-flash-lite': {
        id: 'gemini-3.1-flash-lite-preview',
        thinkingType: 'level',
        supportedThinkingLevels: ['minimal', 'low', 'medium', 'high'],
        supportsUrlContext: true,
        supportsPdf: true
      },
      'gemini-3-pro': {
        id: 'gemini-3-pro-preview',
        thinkingType: 'level',
        supportedThinkingLevels: ['low', 'high'], // only low and high
        supportsUrlContext: true,
        supportsPdf: true
      },
      'gemini-3.1-pro': {
        id: 'gemini-3.1-pro-preview',
        thinkingType: 'level',
        supportedThinkingLevels: ['minimal', 'low', 'medium', 'high'],
        supportsUrlContext: true,
        supportsPdf: true
      },
      'gemini-2.5-flash': {
        id: 'gemini-2.5-flash',
        thinkingType: 'budget', // uses thinkingBudget
        supportsDynamic: true,
        supportsUrlContext: true,
        supportsPdf: true
      },
      'gemini-2.5-pro': {
        id: 'gemini-2.5-pro',
        thinkingType: 'budget',
        supportsDynamic: true,
        supportsUrlContext: true,
        supportsPdf: true
      }
    }
  },

  // OpenRouter Configuration
  openrouter: {
    enabled: false, // OpenRouter disabled — Gemini only
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    maxRetries: 5,

    // Model mappings (your model name → OpenRouter model ID)
    modelMappings: {
      // Gemini models (preview)
      'gemini-3-flash': 'google/gemini-3-flash-preview',
      'gemini-3-pro': 'google/gemini-3-pro-preview',
      'gemini-2.5-flash': 'google/gemini-2.5-flash',
      'gemini-2.5-pro': 'google/gemini-2.5-pro',
      // Other models
      'grok-4.1-fast': 'x-ai/grok-4.1-fast',
      'grok-code-fast-1': 'x-ai/grok-code-fast-1',
      'claude-haiku-4.5': 'anthropic/claude-haiku-4.5',
      'deepseek-v3.2': 'deepseek/deepseek-v3.2',
      'deepseek-v3.2-nitro': 'deepseek/deepseek-v3.2:nitro',
      'deepseek-v3.2-speciale': 'deepseek/deepseek-v3.2-speciale',
      'gpt-5-mini': 'openai/gpt-5-mini',
      'minimax-m2.5': 'minimax/minimax-m2.5',
      'minimax-m2.5-nitro': 'minimax/minimax-m2.5:nitro',
      'step-3.5-flash-nitro': 'stepfun/step-3.5-flash:nitro',
      'claude-sonnet-4.6-nitro': 'anthropic/claude-sonnet-4.6:nitro',
      'grok-4.20-beta': 'x-ai/grok-4.20-beta',
      'grok-4.20-multi-agent': 'x-ai/grok-4.20-multi-agent-beta'
    }
  },

  // Retry Configuration
  retry: {
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    retryableStatusCodes: [429, 500, 502, 503, 504]
  },

  // Default Generation Config
  defaults: {
    temperature: 1.0,
    maxTokens: 4096,
    thinking: {
      enabled: false,
      level: 'medium',
      includeThoughts: false
    }
  },

  // Pricing per 1M tokens (USD) — used for cost estimation when provider doesn't return cost
  pricing: {
    'gemini-3-flash': { input: 0.50, output: 3.00 },
    'gemini-3.1-flash-lite': { input: 0.25, output: 1.50 },
    'gemini-2.5-flash': { input: 0.30, output: 2.50 },
    'gemini-embedding-2-preview': { input: 0.20, output: 0 }, // embedding: input-only
    'claude-haiku-4.5': { input: 1.00, output: 5.00 },
    'grok-4.1-fast': { input: 0.20, output: 0.50 }
  }
};

/**
 * Check if a model is a Gemini model
 * Matches if "gemini" appears anywhere in model name (case-insensitive)
 * Examples: "gemini-3-flash", "google/gemini-3-flash-preview"
 */
export function isGeminiModel(model) {
  return model.toLowerCase().includes('gemini');
}

/**
 * Get Gemini model config
 */
export function getGeminiModelConfig(model) {
  return config.gemini.models[model] || null;
}

/**
 * Get OpenRouter model ID
 */
export function getOpenRouterModelId(model) {
  return config.openrouter.modelMappings[model] || model;
}

/**
 * Fallback cost calculation for direct Gemini API calls (which don't return cost).
 * OpenRouter provides usage.cost for all models — this is only needed when
 * the provider doesn't include cost in the response.
 *
 * Model matching is prefix-based: 'gemini-3-flash-preview-0415' matches 'gemini-3-flash'
 *
 * @param {string} model - Model name (e.g., 'gemini-3-flash', 'gemini-3-flash-preview')
 * @param {number} inputTokens - Total input tokens (includes cached)
 * @param {number} outputTokens
 * @param {number} [cachedTokens=0] - Cached input tokens (charged at 10% of input rate for Gemini — 90% discount)
 * @returns {number|null} Cost in USD, or null if model not in pricing table
 */
export function calculateFallbackCost(model, inputTokens, outputTokens, cachedTokens = 0, thinkingTokens = 0) {
  // Exact match first
  let rates = config.pricing[model];
  if (!rates) {
    // Prefix match: 'gemini-3-flash-preview' → matches 'gemini-3-flash'
    const key = Object.keys(config.pricing).find(k => model.startsWith(k));
    rates = key ? config.pricing[key] : null;
  }
  if (!rates) return null;
  const nonCachedInput = Math.max(0, inputTokens - cachedTokens);
  const cacheDiscount = rates.cacheDiscount ?? 0.10; // Gemini charges 10% for cached tokens (90% discount)
  // Thinking tokens are charged at the output rate (same as candidatesTokenCount)
  return (nonCachedInput * rates.input / 1_000_000)
       + (cachedTokens * rates.input * cacheDiscount / 1_000_000)
       + ((outputTokens + thinkingTokens) * rates.output / 1_000_000);
}

export default config;
