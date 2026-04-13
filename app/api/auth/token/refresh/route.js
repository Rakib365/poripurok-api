import { randomUUID } from 'crypto';
import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { GetCommand, DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { validateClientKey } from '@/lib/auth/middleware';
import { decryptJWE, createJWE, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from '@/lib/auth/encryption';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';

export async function POST(request) {
  try {
    if (!validateClientKey(request)) {
      return error('Unauthorized', 401);
    }

    const { access_token, refresh_token } = await request.json();
    if (!access_token || !refresh_token) {
      return error('Both access_token and refresh_token are required');
    }

    // Decrypt access token (don't check expiry — it's expected to be expired)
    const payload = decryptJWE(access_token);
    if (!payload || !payload.sid) {
      return error('Invalid access token', 401);
    }

    // Validate session exists
    const sessionKey = {
      PK: `USER#${payload.sid}`,
      SK: `SESSION#${refresh_token}`,
    };

    const { Item: session } = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: sessionKey,
    }));

    if (!session) {
      return error('Invalid session. Please login again.', 401);
    }

    // Check session not expired (ttl)
    const now = Math.floor(Date.now() / 1000);
    if (session.ttl && now > session.ttl) {
      await docClient.send(new DeleteCommand({ TableName: TABLE, Key: sessionKey }));
      return error('Session expired. Please login again.', 401);
    }

    // Verify access token matches stored one
    if (session.access_token !== access_token) {
      return error('Token mismatch. Please login again.', 401);
    }

    // === REFRESH TOKEN ROTATION ===
    // Delete old session
    await docClient.send(new DeleteCommand({ TableName: TABLE, Key: sessionKey }));

    // Issue new tokens
    const newAccessToken = createJWE({ sid: payload.sid, phone: payload.phone }, ACCESS_TOKEN_TTL);
    const newRefreshToken = randomUUID();

    await docClient.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `USER#${payload.sid}`,
        SK: `SESSION#${newRefreshToken}`,
        access_token: newAccessToken,
        created_at: session.created_at,
        ttl: now + REFRESH_TOKEN_TTL,
      },
    }));

    logger.info('Token refreshed', { userId: payload.sid });

    return success({
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
    });
  } catch (e) {
    logger.error('refresh-token failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
