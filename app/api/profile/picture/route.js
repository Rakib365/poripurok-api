import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';

export async function PUT(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) {
      return error(auth.error, 401);
    }

    const { profile_picture } = await request.json();
    if (!profile_picture) {
      return error('profile_picture URL is required');
    }

    await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `USER#${auth.user.sid}`, SK: 'PROFILE' },
      UpdateExpression: 'SET profile_picture = :p',
      ExpressionAttributeValues: { ':p': profile_picture },
    }));

    logger.info('Profile picture updated', { userId: auth.user.sid });
    return success({ message: 'Profile picture updated', profile_picture });
  } catch (e) {
    logger.error('profile picture update failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
