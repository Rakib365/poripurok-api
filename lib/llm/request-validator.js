/**
 * Request Validator
 * Validates unified requests before processing
 */

import { config, isGeminiModel, getGeminiModelConfig } from './config.js';

/**
 * Validate a unified request
 * @param {Object} request
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRequest(request) {
  const errors = [];

  // Check required fields
  if (!request.model) {
    errors.push('model is required');
  }

  if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
    errors.push('messages array is required and must not be empty');
  }

  // Validate messages structure
  if (request.messages) {
    for (let i = 0; i < request.messages.length; i++) {
      const msg = request.messages[i];

      if (!['system', 'user', 'assistant', 'model'].includes(msg.role)) {
        errors.push(`messages[${i}].role must be 'system', 'user', 'assistant', or 'model'`);
      }

      if (!msg.parts || !Array.isArray(msg.parts) || msg.parts.length === 0) {
        errors.push(`messages[${i}].parts must be a non-empty array`);
      } else {
        for (let j = 0; j < msg.parts.length; j++) {
          const part = msg.parts[j];
          if (!['text', 'image', 'pdf'].includes(part.type)) {
            errors.push(`messages[${i}].parts[${j}].type must be 'text', 'image', or 'pdf'`);
          }
          if (part.type === 'text' && !part.text) {
            errors.push(`messages[${i}].parts[${j}].text is required for text parts`);
          }
          if ((part.type === 'image' || part.type === 'pdf') && !part.url) {
            errors.push(`messages[${i}].parts[${j}].url is required for ${part.type} parts`);
          }
        }
      }
    }
  }

  // Validate mutual exclusivity: urlContext, tools, structuredOutput
  const enabledFeatures = [
    request.urlContext?.enabled ? 'urlContext' : null,
    request.tools && request.tools.length > 0 ? 'tools' : null,
    request.structuredOutput ? 'structuredOutput' : null
  ].filter(Boolean);

  if (enabledFeatures.length > 1) {
    errors.push(`Only one of urlContext, tools, or structuredOutput can be enabled at a time. Found: ${enabledFeatures.join(', ')}`);
  }

  // Validate thinking configuration
  if (request.thinking?.enabled && request.thinking?.level) {
    const validLevels = ['low', 'medium', 'high', 'dynamic'];
    if (!validLevels.includes(request.thinking.level)) {
      errors.push(`thinking.level must be one of: ${validLevels.join(', ')}`);
    }

    // Check if 'dynamic' is used with non-2.5 model
    if (request.thinking.level === 'dynamic' && isGeminiModel(request.model)) {
      const modelConfig = getGeminiModelConfig(request.model);
      if (modelConfig && !modelConfig.supportsDynamic) {
        errors.push(`thinking.level 'dynamic' is only supported for Gemini 2.5 models`);
      }
    }
  }

  // Validate URL context support
  if (request.urlContext?.enabled) {
    if (!isGeminiModel(request.model)) {
      errors.push('urlContext is only supported for Gemini models');
    }
  }

  // Validate tools structure
  if (request.tools) {
    for (let i = 0; i < request.tools.length; i++) {
      const tool = request.tools[i];
      if (!tool.name) {
        errors.push(`tools[${i}].name is required`);
      }
      if (!tool.description) {
        errors.push(`tools[${i}].description is required`);
      }
      if (!tool.parameters) {
        errors.push(`tools[${i}].parameters is required`);
      }
    }
  }

  // Validate structured output
  if (request.structuredOutput) {
    if (!request.structuredOutput.type) {
      errors.push('structuredOutput.type is required');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate and throw if invalid
 * @param {Object} request
 */
export function assertValidRequest(request) {
  const { valid, errors } = validateRequest(request);
  if (!valid) {
    throw new Error(`Invalid request: ${errors.join('; ')}`);
  }
}

export default { validateRequest, assertValidRequest };
