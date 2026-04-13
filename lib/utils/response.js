import { NextResponse } from 'next/server';

/**
 * Build a JSON response with standard headers.
 */
export function jsonResponse(statusCode, body) {
  return NextResponse.json(body, {
    status: statusCode,
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
    },
  });
}

/**
 * Success response.
 */
export function success(data = {}, statusCode = 200) {
  return jsonResponse(statusCode, { success: true, ...data });
}

/**
 * Error response.
 */
export function error(message, statusCode = 400, code = null) {
  return jsonResponse(statusCode, {
    success: false,
    error: message,
    ...(code && { code }),
  });
}
