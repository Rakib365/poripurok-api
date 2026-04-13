import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'crypto';

const SCRYPT_KEYLEN = 64;

/**
 * Hash a password with a random per-user salt.
 * Returns "salt:hash" format (both hex-encoded).
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a stored "salt:hash" string.
 * Uses timing-safe comparison.
 */
export function verifyPassword(password, stored) {
  const [salt, storedHash] = stored.split(':');
  if (!salt || !storedHash) return false;

  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  try {
    return timingSafeEqual(Buffer.from(hash), Buffer.from(storedHash));
  } catch {
    return false;
  }
}

/**
 * Check if a hash is in the old format (no colon separator = deterministic salt).
 */
export function isOldHashFormat(stored) {
  return !stored.includes(':');
}

/**
 * Verify against old-format hash (deterministic salt from ENCRYPTION_KEY).
 * If valid, returns the new-format hash for migration. Otherwise null.
 */
export function verifyAndMigrateOldHash(password, oldHash) {
  const encKey = process.env.ENCRYPTION_KEY;
  const oldSalt = createHash('sha256').update(encKey).digest('hex').slice(0, 16);
  const testHash = scryptSync(password, oldSalt, SCRYPT_KEYLEN).toString('hex');

  if (testHash === oldHash) {
    return hashPassword(password);
  }
  return null;
}
