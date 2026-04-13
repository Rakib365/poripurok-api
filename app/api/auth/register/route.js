import { randomUUID } from 'crypto';
import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { validateClientKey } from '@/lib/auth/middleware';
import { hashPassword } from '@/lib/auth/password';
import { createJWE, verifyVerificationToken, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from '@/lib/auth/encryption';
import { isValidPhone, isValidPassword, isValidGender, isNonEmptyString } from '@/lib/utils/validation';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';

export async function POST(request) {
  try {
    if (!validateClientKey(request)) {
      return error('Unauthorized', 401);
    }

    const body = await request.json();
    const { phone, password, full_name, college_name, hsc_batch, gender, profile_picture, verification_token } = body;

    if (!isValidPhone(phone)) return error('Invalid phone number');
    if (!isValidPassword(password)) return error('Password must be at least 6 characters');
    if (!isNonEmptyString(full_name)) return error('Full name is required');
    if (!isNonEmptyString(college_name)) return error('College name is required');
    if (!isNonEmptyString(hsc_batch)) return error('HSC batch is required');
    if (!isValidGender(gender)) return error('Gender must be male, female, or other');

    // Verify OTP was completed (signed token from verify-otp)
    if (!verification_token || !verifyVerificationToken(verification_token, phone)) {
      return error('Phone number not verified. Please complete OTP verification first.');
    }

    // Check phone uniqueness
    const { Items } = await docClient.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'PhoneIndex',
      KeyConditionExpression: 'phone = :phone',
      ExpressionAttributeValues: { ':phone': phone },
      Limit: 1,
      ProjectionExpression: 'PK',
    }));

    if (Items.length > 0) {
      return error('Phone number already registered', 409);
    }

    const userId = randomUUID();
    const now = new Date();
    const nowUnix = Math.floor(now.getTime() / 1000);

    // Create user profile
    await docClient.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `USER#${userId}`,
        SK: 'PROFILE',
        phone,
        full_name: full_name.trim(),
        college_name: college_name.trim(),
        hsc_batch: hsc_batch.trim(),
        gender: gender.toLowerCase(),
        profile_picture: profile_picture || null,
        password: hashPassword(password),
        created_at: now.toISOString(),
      },
    }));

    // Create session
    const accessToken = createJWE({ sid: userId, phone }, ACCESS_TOKEN_TTL);
    const refreshToken = randomUUID();

    await docClient.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `USER#${userId}`,
        SK: `SESSION#${refreshToken}`,
        access_token: accessToken,
        created_at: now.toISOString(),
        ttl: nowUnix + REFRESH_TOKEN_TTL,
      },
    }));

    logger.info('User registered', { userId, phone: phone.slice(-4) });

    return success({
      message: 'Registration successful',
      access_token: accessToken,
      refresh_token: refreshToken,
      user: {
        id: userId,
        phone,
        full_name: full_name.trim(),
        college_name: college_name.trim(),
        hsc_batch: hsc_batch.trim(),
        gender: gender.toLowerCase(),
        profile_picture: profile_picture || null,
      },
    }, 201);
  } catch (e) {
    logger.error('signup failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
