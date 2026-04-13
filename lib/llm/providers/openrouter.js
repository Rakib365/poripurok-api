/**
 * OpenRouter API Provider Adapter
 * Handles API calls to OpenRouter
 */

import { config, getOpenRouterModelId } from '../config.js';
import {
  startRawDebugCapture,
  getRawDebugCapture,
  setRawDebugRequest,
  setRawDebugResponse,
  isRawDebugCaptureActive
} from '../utils/raw-debug-capture.js';

// Re-export for backwards compatibility
export { startRawDebugCapture, getRawDebugCapture };

/**
 * Transform unified messages to OpenRouter format
 * @param {Array} messages
 * @returns {Object[]}
 */
export function transformMessages(messages) {
  return messages.map(msg => {
    // Transform role: model → assistant (OpenAI format)
    const role = msg.role === 'model' ? 'assistant' : msg.role;

    // Check if parts contain only text
    const hasOnlyText = msg.parts.every(p => p.type === 'text');

    if (hasOnlyText && msg.parts.length === 1) {
      // Simple text message
      return {
        role,
        content: msg.parts[0].text
      };
    }

    // Multi-part or image message
    return {
      role,
      content: msg.parts.map(part => transformPart(part))
    };
  });
}

/**
 * Extract filename from URL
 * @param {string} url
 * @returns {string}
 */
function getFilenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split('/').pop();
    return filename || 'document.pdf';
  } catch {
    return 'document.pdf';
  }
}

/**
 * Transform a single part to OpenRouter format
 * @param {Object} part
 * @returns {Object}
 */
function transformPart(part) {
  switch (part.type) {
    case 'text':
      return {
        type: 'text',
        text: part.text
      };

    case 'image':
      return {
        type: 'image_url',
        image_url: {
          url: part.url
        }
      };

    case 'pdf':
      // OpenRouter supports PDF via file type
      return {
        type: 'file',
        file: {
          filename: getFilenameFromUrl(part.url) || 'document.pdf',
          file_data: part.url
        }
      };

    default:
      return {
        type: 'text',
        text: String(part)
      };
  }
}

/**
 * Transform thinking config to OpenRouter format
 * @param {Object} thinking
 * @returns {Object}
 */
export function transformThinkingConfig(thinking) {
  // If reasoning is explicitly disabled, return effort: "none"
  // This is important because some models (like Grok) have reasoning ON by default
  if (!thinking?.enabled) {
    return { effort: 'none' };
  }

  const level = thinking.level || 'medium';

  // Map to OpenRouter reasoning effort
  const effortMap = {
    'low': 'low',
    'medium': 'medium',
    'high': 'high',
    'dynamic': 'medium' // Fallback for dynamic
  };

  return {
    effort: effortMap[level] || 'medium'
  };
}

/**
 * Transform tools to OpenRouter format
 * @param {Array} tools
 * @returns {Object[]}
 */
export function transformTools(tools) {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

/**
 * Transform structured output to OpenRouter format
 * @param {Object} schema
 * @returns {Object}
 */
export function transformStructuredOutput(schema) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'response',
      schema: schema
    }
  };
}

/**
 * Build complete OpenRouter request
 * @param {Object} request
 * @returns {Object}
 */
export function buildRequest(request) {
  const modelId = getOpenRouterModelId(request.model);
  const messages = transformMessages(request.messages);

  const body = {
    model: modelId,
    messages,
    temperature: request.config?.temperature ?? config.defaults.temperature,
    max_tokens: request.config?.maxTokens ?? config.defaults.maxTokens
  };

  // Add reasoning/thinking config
  // Always include reasoning field - some models (like Grok) have reasoning ON by default
  body.reasoning = transformThinkingConfig(request.thinking);

  // Add tools (mutually exclusive with structured output)
  if (request.tools && request.tools.length > 0) {
    body.tools = transformTools(request.tools);
  }

  // Add structured output
  if (request.structuredOutput) {
    body.response_format = transformStructuredOutput(request.structuredOutput);
  }

  return body;
}

/**
 * Parse OpenRouter response to unified format
 * @param {Object} response - Raw OpenRouter API response
 * @param {number} retryCount - Number of retries
 * @returns {Object}
 */
export function parseResponse(response, retryCount) {
  // Check for error
  if (response.error) {
    return {
      success: false,
      error: {
        code: String(response.error.code || 'UNKNOWN'),
        message: response.error.message || 'Unknown error',
        provider: 'openrouter',
        retryable: false
      },
      metadata: {
        model: response.model || '',
        provider: 'openrouter',
        retryCount,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      }
    };
  }

  const choice = response.choices?.[0];
  if (!choice) {
    return {
      success: false,
      error: {
        code: 'NO_CHOICE',
        message: 'No response choice returned',
        provider: 'openrouter',
        retryable: false
      },
      metadata: {
        model: response.model || '',
        provider: 'openrouter',
        retryCount,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      }
    };
  }

  // Extract content
  const content = choice.message?.content || '';

  // Extract tool calls
  const toolCalls = (choice.message?.tool_calls || []).map(tc => {
    let args = {};
    if (tc.function?.arguments) {
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
    }
    return { id: tc.id, name: tc.function?.name, arguments: args };
  });

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
  const usage = response.usage || {};
  const details = usage.prompt_tokens_details || {};
  const usageData = {
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    cachedTokens: details.cached_tokens || usage.cached_tokens || undefined,
    cost: usage.cost || undefined
  };

  return {
    success: true,
    content: content || undefined,
    object,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    metadata: {
      model: response.model || '',
      provider: 'openrouter',
      retryCount,
      usage: usageData
    }
  };
}

/**
 * Make a request to OpenRouter API
 * @param {Object} request
 * @param {number} retryCount
 * @returns {Promise<Object>}
 */
export async function makeRequest(request, retryCount) {
  const url = `${config.openrouter.baseUrl}/chat/completions`;
  const body = buildRequest(request);
  const referer = request.providerMeta?.referer || 'https://hosting.com';
  const title = request.providerMeta?.title || 'Resolver Agent';

  // Capture raw request if debug capture is active
  if (isRawDebugCaptureActive()) {
    setRawDebugRequest({
      url,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer [REDACTED]',
        'Content-Type': 'application/json',
        'HTTP-Referer': referer,
        'X-Title': title
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
        'Authorization': `Bearer ${config.openrouter.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': referer,
        'X-Title': title
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
      retryable: [429, 500, 502, 503, 504].includes(response.status)
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

  return parseResponse(data, retryCount);
}

export default {
  transformMessages,
  transformThinkingConfig,
  transformTools,
  transformStructuredOutput,
  buildRequest,
  parseResponse,
  makeRequest,
  startRawDebugCapture,
  getRawDebugCapture
};
