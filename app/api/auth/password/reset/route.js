import { randomInt, createHash } from 'crypto';
import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { GetCommand, PutCommand, DeleteCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { validateClientKey } from '@/lib/auth/middleware';
import { hashPassword } from '@/lib/auth/password';
import { createVerificationToken, verifyVerificationToken } from '@/lib/auth/encryption';
import { isValidPhone, isValidOTP, isValidPassword } from '@/lib/utils/validation';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';

const OTP_EXPIRY_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 3;

function generateOTP() {
  return randomInt(100000, 999999).toString();
}

function hashOTP(otp) {
  return createHash('sha256').update(otp).digest('hex');
}

async function sendSMS(phone, otp) {
  const params = new URLSearchParams({
    token: process.env.GREENWEB_SMS_TOKEN,
    to: `+88${phone}`,
    message: `(Poripurok) Reset your password using this OTP: ${otp}`,
  });

  await fetch('https://api.greenweb.com.bd/api.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

export async function POST(request) {
  try {
    if (!validateClientKey(request)) {
      return error('Unauthorized', 401);
    }

    const body = await request.json();
    const { stage } = body;

    // ===== STAGE 1: Send OTP =====
    if (stage === 'initiate') {
      const { phone } = body;
      if (!isValidPhone(phone)) return error('Invalid phone number');

      // Check user exists
      const { Items } = await docClient.send(new QueryCommand({
        TableName: TABLE,
        IndexName: 'PhoneIndex',
        KeyConditionExpression: 'phone = :phone',
        ExpressionAttributeValues: { ':phone': phone },
        Limit: 1,
        ProjectionExpression: 'PK',
      }));

      if (!Items || Items.length === 0) {
        return error('No account found with this phone number', 404);
      }

      const otp = generateOTP();
      const now = Math.floor(Date.now() / 1000);

      await docClient.send(new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `OTP#${phone}`,
          SK: 'OTP',
          otp_hash: hashOTP(otp),
          attempts: 0,
          created_at: new Date().toISOString(),
          ttl: now + OTP_EXPIRY_SECONDS,
        },
      }));

      await sendSMS(phone, otp);
      logger.info('Password reset OTP sent', { phone: phone.slice(-4) });
      return success({ message: 'OTP sent successfully' });
    }

    // ===== STAGE 2: Verify OTP =====
    if (stage === 'verify') {
      const { phone, otp } = body;
      if (!isValidPhone(phone)) return error('Invalid phone number');
      if (!isValidOTP(otp)) return error('Invalid OTP format');

      const key = { PK: `OTP#${phone}`, SK: 'OTP' };
      const { Item: otpRecord } = await docClient.send(new GetCommand({ TableName: TABLE, Key: key }));

      if (!otpRecord) return error('OTP not found', 404);

      const now = Math.floor(Date.now() / 1000);
      if (now > otpRecord.ttl) {
        await docClient.send(new DeleteCommand({ TableName: TABLE, Key: key }));
        return error('OTP expired');
      }

      if (otpRecord.attempts >= MAX_ATTEMPTS) {
        await docClient.send(new DeleteCommand({ TableName: TABLE, Key: key }));
        return error('Too many attempts');
      }

      if (hashOTP(otp) !== otpRecord.otp_hash) {
        await docClient.send(new UpdateCommand({
          TableName: TABLE,
          Key: key,
          UpdateExpression: 'SET attempts = :a',
          ExpressionAttributeValues: { ':a': otpRecord.attempts + 1 },
        }));
        return error(`Incorrect OTP. ${MAX_ATTEMPTS - otpRecord.attempts - 1} attempt(s) remaining.`);
      }

      await docClient.send(new DeleteCommand({ TableName: TABLE, Key: key }));
      const verificationToken = createVerificationToken(phone, 600);
      logger.info('Password reset OTP verified', { phone: phone.slice(-4) });
      return success({ message: 'OTP verified', verification_token: verificationToken });
    }

    // ===== STAGE 3: Set new password =====
    if (stage === 'reset') {
      const { phone, new_password, verification_token } = body;
      if (!isValidPhone(phone)) return error('Invalid phone number');
      if (!isValidPassword(new_password)) return error('Password must be at least 6 characters');

      if (!verification_token || !verifyVerificationToken(verification_token, phone)) {
        return error('Invalid or expired verification. Please start over.');
      }

      const { Items } = await docClient.send(new QueryCommand({
        TableName: TABLE,
        IndexName: 'PhoneIndex',
        KeyConditionExpression: 'phone = :phone',
        ExpressionAttributeValues: { ':phone': phone },
        Limit: 1,
      }));

      if (!Items || Items.length === 0) return error('User not found', 404);

      await docClient.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: Items[0].PK, SK: Items[0].SK },
        UpdateExpression: 'SET password = :p',
        ExpressionAttributeValues: { ':p': hashPassword(new_password) },
      }));

      logger.info('Password reset successful', { phone: phone.slice(-4) });
      return success({ message: 'Password reset successful. Please login with your new password.' });
    }

    return error('Invalid stage. Use: initiate, verify, or reset.');
  } catch (e) {
    logger.error('reset-password failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
