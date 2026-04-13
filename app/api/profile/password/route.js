import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { authenticateRequest } from '@/lib/auth/middleware';
import { hashPassword, verifyPassword, isOldHashFormat, verifyAndMigrateOldHash } from '@/lib/auth/password';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';

/**
 * POST /api/profile/password
 * Body: { current_password, new_password }
 * Authenticated password change for the logged-in user.
 */
export async function POST(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const { current_password, new_password } = await request.json();
    if (!current_password || !new_password) {
      return error('current_password and new_password required');
    }
    if (new_password.length < 6) {
      return error('new_password must be at least 6 characters');
    }

    const key = { PK: `USER#${auth.user.sid}`, SK: 'PROFILE' };
    const existing = await docClient.send(new GetCommand({ TableName: TABLE, Key: key }));
    if (!existing.Item) return error('user not found', 404);

    const stored = existing.Item.password;
    if (!stored) return error('no password set', 400);

    let valid = false;
    let migratedHash = null;
    if (isOldHashFormat(stored)) {
      migratedHash = verifyAndMigrateOldHash(current_password, stored);
      valid = migratedHash !== null;
    } else {
      valid = verifyPassword(current_password, stored);
    }

    if (!valid) return error('current password is incorrect', 401);

    const newHash = hashPassword(new_password);

    await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: key,
      UpdateExpression: 'SET password = :p, updatedAt = :now',
      ExpressionAttributeValues: {
        ':p': newHash,
        ':now': new Date().toISOString(),
      },
    }));

    logger.info('Password changed', { userId: auth.user.sid });
    return success({ message: 'Password updated' });
  } catch (e) {
    logger.error('password change failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
