/**
 * Raw Debug Capture
 *
 * Shared module for capturing exact LLM request/response payloads.
 * Used by both OpenRouter and Gemini providers.
 */

// Raw debug capture state
let rawDebugCapture = null;

/**
 * Initialize raw debug capture
 * @param {string} stage - 'resolver', 'composer', 'judge'
 * @param {number} iterationNum - For resolver iterations
 */
export function startRawDebugCapture(stage, iterationNum = null) {
  rawDebugCapture = {
    stage,
    iteration: iterationNum,
    timestamp: new Date().toISOString(),
    request: null,
    response: null
  };
}

/**
 * Get and clear the captured raw debug data
 * @returns {Object|null}
 */
export function getRawDebugCapture() {
  const data = rawDebugCapture;
  rawDebugCapture = null;
  return data;
}

/**
 * Set the request data in capture
 * @param {Object} requestData - { url, method, headers, body }
 */
export function setRawDebugRequest(requestData) {
  if (rawDebugCapture) {
    rawDebugCapture.request = requestData;
  }
}

/**
 * Set the response data in capture
 * @param {Object} responseData - { status, body }
 */
export function setRawDebugResponse(responseData) {
  if (rawDebugCapture) {
    rawDebugCapture.response = responseData;
  }
}

/**
 * Check if capture is active
 * @returns {boolean}
 */
export function isRawDebugCaptureActive() {
  return rawDebugCapture !== null;
}

export default {
  startRawDebugCapture,
  getRawDebugCapture,
  setRawDebugRequest,
  setRawDebugResponse,
  isRawDebugCaptureActive
};
