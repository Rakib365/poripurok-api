import { decryptJWE } from './encryption';
import { logger } from '@/lib/aws/cloudwatch';

/**
 * Validate the client key header.
 */
export function validateClientKey(request) {
  const clientKey = request.headers.get('x-poripurok-client-key');
  return clientKey === process.env.CLIENT_KEY;
}

/**
 * Extract and validate the access token from the Authorization header.
 * Returns the decrypted payload or null.
 */
export function getAuthPayload(request) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const payload = decryptJWE(token);
  if (!payload) return null;

  // Check expiry
  if (Math.floor(Date.now() / 1000) > payload.exp) return null;

  return payload;
}

/**
 * Auth middleware for protected routes.
 * Returns { authenticated: true, user: payload } or { authenticated: false, error: string }.
 */
export function authenticateRequest(request) {
  if (!validateClientKey(request)) {
    return { authenticated: false, error: 'Invalid client key' };
  }

  const payload = getAuthPayload(request);
  if (!payload) {
    return { authenticated: false, error: 'Invalid or expired token' };
  }

  return { authenticated: true, user: payload };
}
