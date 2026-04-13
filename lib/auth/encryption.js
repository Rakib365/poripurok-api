import {
  createCipheriv, createDecipheriv, createHmac,
  randomBytes, scryptSync,
} from 'crypto';

const getEncryptionKey = () => process.env.ENCRYPTION_KEY;

function deriveKey(salt) {
  return scryptSync(getEncryptionKey(), salt, 32);
}

/**
 * Create an encrypted JWE token.
 * Format: base64url(header).base64url(encryptedPayload).base64url(iv).base64url(authTag).hex(salt)
 */
export function createJWE(payload, expiresInSeconds) {
  const header = { alg: 'A256GCM', enc: 'A256GCM' };
  const now = Math.floor(Date.now() / 1000);
  payload.iat = now;
  payload.exp = now + expiresInSeconds;

  const salt = randomBytes(16).toString('hex');
  const derivedKey = deriveKey(salt);
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

  const encrypted = Buffer.concat([
    cipher.update(encodedPayload, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${encodedHeader}.${encrypted.toString('base64url')}.${iv.toString('base64url')}.${authTag.toString('base64url')}.${salt}`;
}

/**
 * Decrypt a JWE token. Returns the payload object or null on failure.
 */
export function decryptJWE(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 5) return null;

    const [encodedHeader, encryptedData, ivStr, authTagStr, salt] = parts;

    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString());
    if (header.alg !== 'A256GCM' || header.enc !== 'A256GCM') return null;

    const derivedKey = deriveKey(salt);
    const iv = Buffer.from(ivStr, 'base64url');
    const authTag = Buffer.from(authTagStr, 'base64url');

    const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedData, 'base64url')),
      decipher.final(),
    ]);

    const payloadStr = Buffer.from(decrypted.toString(), 'base64url').toString();
    return JSON.parse(payloadStr);
  } catch {
    return null;
  }
}

// Token TTLs
export const ACCESS_TOKEN_TTL = 60 * 60;          // 1 hour
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days

/**
 * Create a short-lived HMAC-signed verification token (links OTP verification to signup).
 * Format: base64url(payload).base64url(signature)
 */
export function createVerificationToken(phone, expiresInSeconds = 600) {
  const payload = {
    phone,
    purpose: 'otp_verified',
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', getEncryptionKey()).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

/**
 * Verify a verification token. Checks HMAC, purpose, phone, and expiry.
 */
export function verifyVerificationToken(token, expectedPhone) {
  try {
    const [encoded, sig] = token.split('.');
    const expectedSig = createHmac('sha256', getEncryptionKey()).update(encoded).digest('base64url');
    if (sig !== expectedSig) return false;

    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (payload.purpose !== 'otp_verified') return false;
    if (payload.phone !== expectedPhone) return false;
    if (Math.floor(Date.now() / 1000) > payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}
