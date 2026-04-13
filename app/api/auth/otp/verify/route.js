import { createHash } from 'crypto';
import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { validateClientKey } from '@/lib/auth/middleware';
import { createVerificationToken } from '@/lib/auth/encryption';
import { isValidPhone, isValidOTP } from '@/lib/utils/validation';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';

const MAX_ATTEMPTS = 3;

function hashOTP(otp) {
  return createHash('sha256').update(otp).digest('hex');
}

export async function POST(request) {
  try {
    if (!validateClientKey(request)) {
      return error('Unauthorized', 401);
    }

    const { phone, otp } = await request.json();
    if (!isValidPhone(phone)) return error('Invalid phone number');
    if (!isValidOTP(otp)) return error('Invalid OTP format');

    const key = { PK: `OTP#${phone}`, SK: 'OTP' };

    const { Item: otpRecord } = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: key,
    }));

    if (!otpRecord) {
      return error('OTP not found. Please request a new one.', 404);
    }

    const now = Math.floor(Date.now() / 1000);

    if (now > otpRecord.ttl) {
      await docClient.send(new DeleteCommand({ TableName: TABLE, Key: key }));
      return error('OTP expired. Please request a new one.');
    }

    if (otpRecord.attempts >= MAX_ATTEMPTS) {
      await docClient.send(new DeleteCommand({ TableName: TABLE, Key: key }));
      return error('Too many attempts. Please request a new OTP.');
    }

    if (hashOTP(otp) !== otpRecord.otp_hash) {
      await docClient.send(new UpdateCommand({
        TableName: TABLE,
        Key: key,
        UpdateExpression: 'SET attempts = :a',
        ExpressionAttributeValues: { ':a': otpRecord.attempts + 1 },
      }));
      const remaining = MAX_ATTEMPTS - otpRecord.attempts - 1;
      return error(`Incorrect OTP. ${remaining} attempt(s) remaining.`);
    }

    // Success — delete OTP, issue signed verification token (10 min)
    await docClient.send(new DeleteCommand({ TableName: TABLE, Key: key }));

    const verificationToken = createVerificationToken(phone, 600);

    logger.info('OTP verified', { phone: phone.slice(-4) });
    return success({
      message: 'OTP verified successfully',
      verification_token: verificationToken,
    });
  } catch (e) {
    logger.error('verify-otp failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
