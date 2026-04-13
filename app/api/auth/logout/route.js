import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { validateClientKey } from '@/lib/auth/middleware';
import { decryptJWE } from '@/lib/auth/encryption';
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

    const payload = decryptJWE(access_token);
    if (payload?.sid) {
      await docClient.send(new DeleteCommand({
        TableName: TABLE,
        Key: {
          PK: `USER#${payload.sid}`,
          SK: `SESSION#${refresh_token}`,
        },
      }));
      logger.info('Logout', { userId: payload.sid });
    }

    return success({ message: 'Logged out successfully' });
  } catch (e) {
    logger.error('logout failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
