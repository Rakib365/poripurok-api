/**
 * Validate Bangladeshi phone number (11 digits, starts with 01).
 */
export function isValidPhone(phone) {
  return typeof phone === 'string' && /^01\d{9}$/.test(phone);
}

/**
 * Validate password (min 6 characters).
 */
export function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 6;
}

/**
 * Validate gender.
 */
export function isValidGender(gender) {
  return ['male', 'female', 'other'].includes(gender?.toLowerCase());
}

/**
 * Validate OTP format (6 digits).
 */
export function isValidOTP(otp) {
  return typeof otp === 'string' && /^\d{6}$/.test(otp);
}

/**
 * Validate required string fields.
 */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
