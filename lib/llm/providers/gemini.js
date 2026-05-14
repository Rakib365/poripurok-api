/**
 * Gemini API Provider Adapter
 * Handles direct API calls to Google's Gemini API
 */

import { config, getGeminiModelConfig } from '../config.js';
import {
  setRawDebugRequest,
  setRawDebugResponse,
  isRawDebugCaptureActive
} from '../utils/raw-debug-capture.js';
import { logger } from '../../aws/cloudwatch.js';

/**
 * Transform unified messages to Gemini format
 * @param {Array} messages
 * @returns {{ contents: Object[], systemInstruction: Object | null }}
 */
export function transformMessages(messages) {
  let systemInstruction = null;
  const contents = [];

  for (const msg of messages) {
    // Extract system instruction separately
    if (msg.role === 'system') {
      systemInstruction = {
        parts: msg.parts.map(part => transformPart(part))
      };
      continue;
    }

    // Transform role: assistant → model (model stays as model)
    const role = (msg.role === 'assistant' || msg.role === 'model') ? 'model' : msg.role;

    contents.push({
      role,
      parts: msg.parts.map(part => transformPart(part))
    });
  }

  return { contents, systemInstruction };
}

/**
 * Transform a single part to Gemini format
 * @param {Object} part
 * @returns {Object}
 */
function transformPart(part) {
  switch (part.type) {
    case 'text':
      return { text: part.text };

    case 'image':
      return {
        file_data: {
          mime_type: part.mimeType || getMimeTypeFromUrl(part.url),
          file_uri: part.url
        }
      };

    case 'pdf':
      return {
        file_data: {
          mime_type: 'application/pdf',
          file_uri: part.url
        }
      };

    default:
      return { text: String(part) };
  }
}

/**
 * Guess MIME type from URL
 * @param {string} url
 * @returns {string}
 */
function getMimeTypeFromUrl(url) {
  const ext = url.split('.').pop()?.toLowerCase();
  const mimeTypes = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'pdf': 'application/pdf'
  };
  return mimeTypes[ext] || 'image/png';
}

/**
 * Transform thinking config to Gemini format
 * @param {Object} thinking
 * @param {string} model
 * @returns {Object | null}
 */
export function transformThinkingConfig(thinking, model) {
  if (!thinking?.enabled) {
    // Return minimal/off config
    const modelConfig = getGeminiModelConfig(model);
    if (modelConfig?.thinkingType === 'budget') {
      return { thinkingBudget: 0 };
    } else {
      return { thinkingLevel: 'minimal' };
    }
  }

  const modelConfig = getGeminiModelConfig(model);
  const level = thinking.level || 'medium';

  if (modelConfig?.thinkingType === 'budget') {
    // Gemini 2.5 series - use thinkingBudget
    const budgetMap = {
      'low': 2048,
      'medium': 4096,
      'high': 8192,
      'dynamic': -1
    };
    return {
      thinkingBudget: budgetMap[level] ?? 4096,
      includeThoughts: thinking.includeThoughts ?? false
    };
  } else {
    // Gemini 3 series - use thinkingLevel
    let thinkingLevel = level;

    // Handle level mapping for Gemini 3 Pro (only low and high)
    if (model === 'gemini-3-pro') {
      if (level === 'medium' || level === 'dynamic') {
        thinkingLevel = 'low';
      }
    }

    // Handle 'dynamic' for Gemini 3 Flash (fallback to medium)
    if (level === 'dynamic' && model === 'gemini-3-flash') {
      thinkingLevel = 'medium';
    }

    return {
      thinkingLevel,
      includeThoughts: thinking.includeThoughts ?? false
    };
  }
}

/**
 * Transform tools to Gemini format
 * @param {Array} tools
 * @returns {Object[]}
 */
export function transformTools(tools) {
  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }))
  }];
}

/**
 * Transform structured output to Gemini format
 * @param {Object} schema
 * @returns {{ responseMimeType: string, responseSchema: Object }}
 */
export function transformStructuredOutput(schema) {
  return {
    responseMimeType: 'application/json',
    responseSchema: schema
  };
}

/**
 * Build complete Gemini request
 * @param {Object} request
 * @param {boolean} [isMultiTurn=false] - Whether this is a multi-turn conversation
 * @returns {Object}
 */
export function buildRequest(request, isMultiTurn = false) {
  const { contents, systemInstruction } = transformMessages(request.messages);
  const modelConfig = getGeminiModelConfig(request.model);

  // Build generation config
  const generationConfig = {
    temperature: request.config?.temperature ?? config.defaults.temperature,
  };
  // Only set maxOutputTokens when explicitly requested — otherwise let
  // Gemini use the model's native default.
  if (request.config?.maxTokens != null) {
    generationConfig.maxOutputTokens = request.config.maxTokens;
  }

  // Add thinking config (skip when urlContext is enabled — thinkingBudget:0 breaks url_context)
  if (!request.urlContext?.enabled) {
    const thinkingConfig = transformThinkingConfig(request.thinking, request.model);
    if (thinkingConfig) {
      generationConfig.thinkingConfig = thinkingConfig;
    }
  }

  // Add structured output config
  if (request.structuredOutput) {
    const { responseMimeType, responseSchema } = transformStructuredOutput(request.structuredOutput);
    generationConfig.responseMimeType = responseMimeType;
    generationConfig.responseSchema = responseSchema;
  } else if (request.config?.responseMimeType) {
    // Allow setting responseMimeType without a full schema
    // (useful when the prompt describes the JSON format in detail and you
    // just want to force JSON output without constraining shape).
    generationConfig.responseMimeType = request.config.responseMimeType;
  }

  // Build request body
  const body = {
    contents,
    generationConfig
  };

  // Add system instruction if present
  if (systemInstruction) {
    body.systemInstruction = systemInstruction;
  }

  // Add thought signature bypass for stateless multi-turn
  if (isMultiTurn && request.thinking?.enabled) {
    // Add thought signature to the last model message to bypass validation
    const lastModelIndex = contents.findLastIndex(c => c.role === 'model');
    if (lastModelIndex >= 0) {
      contents[lastModelIndex].parts.push({
        thoughtSignature: 'skip_thought_signature_validator'
      });
    }
  }

  // Add tools (mutually exclusive)
  if (request.urlContext?.enabled) {
    body.tools = [{ url_context: {} }];
  } else if (request.tools && request.tools.length > 0) {
    body.tools = transformTools(request.tools);
  }

  return body;
}

/**
 * Parse Gemini response to unified format
 * @param {Object} response - Raw Gemini API response
 * @param {number} keyIndex - Which API key was used
 * @param {number} retryCount - Number of retries
 * @returns {Object}
 */
export function parseResponse(response, keyIndex, retryCount) {
  // Check for error
  if (response.error) {
    return {
      success: false,
      error: {
        code: String(response.error.code || 'UNKNOWN'),
        message: response.error.message || 'Unknown error',
        provider: 'gemini',
        retryable: false
      },
      metadata: {
        model: '',
        provider: 'gemini',
        apiKeyIndex: keyIndex,
        retryCount,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      }
    };
  }

  const candidate = response.candidates?.[0];
  if (!candidate) {
    return {
      success: false,
      error: {
        code: 'NO_CANDIDATE',
        message: 'No response candidate returned',
        provider: 'gemini',
        retryable: false
      },
      metadata: {
        model: response.modelVersion || '',
        provider: 'gemini',
        apiKeyIndex: keyIndex,
        retryCount,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      }
    };
  }

  // Extract content and reasoning
  let content = '';
  let reasoning = '';
  let thoughtSignature = '';
  const toolCalls = [];

  for (const part of candidate.content?.parts || []) {
    if (part.thought) {
      // This is thinking/reasoning content
      reasoning += part.text || '';
    } else if (part.text) {
      content += part.text;
    }

    if (part.thoughtSignature) {
      thoughtSignature = part.thoughtSignature;
    }

    if (part.functionCall) {
      toolCalls.push({
        id: `call_${Date.now()}_${toolCalls.length}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args || {}
      });
    }
  }

  // Parse structured output if response is JSON
  let object = null;
  if (content) {
    try {
      object = JSON.parse(content);
    } catch (e) {
      // Not JSON, that's fine
    }
  }

  // Build usage metadata
  const usageMetadata = response.usageMetadata || {};
  const usage = {
    inputTokens: usageMetadata.promptTokenCount || 0,
    outputTokens: usageMetadata.candidatesTokenCount || 0,
    totalTokens: usageMetadata.totalTokenCount || 0,
    thinkingTokens: usageMetadata.thoughtsTokenCount || undefined,
    cachedTokens: usageMetadata.cachedContentTokenCount || undefined
  };

  // Build URL context metadata if present
  let urlContextMetadata = undefined;
  if (response.urlContextMetadata) {
    urlContextMetadata = {
      urlsProcessed: response.urlContextMetadata.urlsProcessed || 0,
      retrievalStatus: response.urlContextMetadata.retrievalStatus || []
    };
  }

  return {
    success: true,
    content: content || undefined,
    reasoning: reasoning || undefined,
    object,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    metadata: {
      model: response.modelVersion || '',
      provider: 'gemini',
      apiKeyIndex: keyIndex,
      retryCount,
      thoughtSignature: thoughtSignature || undefined,
      usage,
      urlContextMetadata
    }
  };
}

/**
 * Make a request to Gemini API
 * @param {Object} request
 * @param {string} apiKey
 * @param {number} keyIndex
 * @param {number} retryCount
 * @returns {Promise<Object>}
 */
export async function makeRequest(request, apiKey, keyIndex, retryCount) {
  const modelConfig = getGeminiModelConfig(request.model);
  const modelId = modelConfig?.id || request.model;

  const url = `${config.gemini.baseUrl}/models/${modelId}:generateContent?key=${apiKey}`;
  logger.info('gemini request', { model: request.model, resolvedModelId: modelId });

  // Check if this is multi-turn (has previous assistant messages)
  const isMultiTurn = request.messages.some(m => m.role === 'assistant');

  const body = buildRequest(request, isMultiTurn);

  // Capture raw request if debug capture is active
  if (isRawDebugCaptureActive()) {
    setRawDebugRequest({
      url: url.replace(/key=[^&]+/, 'key=[REDACTED]'),  // Redact API key
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body  // EXACT JSON that will be sent
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    let errorData;
    try {
      errorData = JSON.parse(errorText);
    } catch {
      errorData = { message: errorText };
    }

    // Capture error response
    if (isRawDebugCaptureActive()) {
      setRawDebugResponse({
        status: response.status,
        body: errorData
      });
    }

    throw {
      status: response.status,
      message: errorData.error?.message || errorData.message || `HTTP ${response.status}`,
      code: errorData.error?.code || response.status,
      retryable: [429, 500, 502, 503, 504].includes(response.status),
      rawBody: errorData,
    };
  }

  const data = await response.json();

  // Capture raw response if debug capture is active
  if (isRawDebugCaptureActive()) {
    setRawDebugResponse({
      status: response.status,
      body: data  // EXACT JSON received
    });
  }

  return parseResponse(data, keyIndex, retryCount);
}

export default {
  transformMessages,
  transformThinkingConfig,
  transformTools,
  transformStructuredOutput,
  buildRequest,
  parseResponse,
  makeRequest
};
