import { randomUUID } from 'crypto';
import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { PutCommand, QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { validateClientKey } from '@/lib/auth/middleware';
import { verifyPassword, isOldHashFormat, verifyAndMigrateOldHash } from '@/lib/auth/password';
import { createJWE, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from '@/lib/auth/encryption';
import { isValidPhone } from '@/lib/utils/validation';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';

export async function POST(request) {
  try {
    if (!validateClientKey(request)) {
      return error('Unauthorized', 401);
    }

    const { phone, password } = await request.json();
    if (!isValidPhone(phone)) return error('Invalid phone number');
    if (!password) return error('Password is required');

    // Lookup user by phone
    const { Items } = await docClient.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'PhoneIndex',
      KeyConditionExpression: 'phone = :phone',
      ExpressionAttributeValues: { ':phone': phone },
      Limit: 1,
    }));

    if (!Items || Items.length === 0) {
      return error('Invalid phone number or password', 401);
    }

    const user = Items[0];

    // Verify password (supports old and new hash formats for migration)
    let passwordValid = false;

    if (isOldHashFormat(user.password)) {
      const newHash = verifyAndMigrateOldHash(password, user.password);
      if (newHash) {
        passwordValid = true;
        // Migrate hash to new per-user salt format
        await docClient.send(new UpdateCommand({
          TableName: TABLE,
          Key: { PK: user.PK, SK: user.SK },
          UpdateExpression: 'SET password = :p',
          ExpressionAttributeValues: { ':p': newHash },
        }));
        logger.info('Password hash migrated', { userId: user.PK.slice(5) });
      }
    } else {
      passwordValid = verifyPassword(password, user.password);
    }

    if (!passwordValid) {
      return error('Invalid phone number or password', 401);
    }

    // Create tokens
    const userId = user.PK.slice(5); // Strip "USER#"
    const now = new Date();
    const nowUnix = Math.floor(now.getTime() / 1000);

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

    logger.info('Login successful', { userId, phone: phone.slice(-4) });

    return success({
      message: 'Login successful',
      access_token: accessToken,
      refresh_token: refreshToken,
      user: {
        id: userId,
        phone: user.phone,
        full_name: user.full_name,
        college_name: user.college_name,
        hsc_batch: user.hsc_batch,
        gender: user.gender,
        profile_picture: user.profile_picture,
      },
    });
  } catch (e) {
    logger.error('login failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
