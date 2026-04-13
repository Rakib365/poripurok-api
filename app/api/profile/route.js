import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';

const EDITABLE_FIELDS = ['full_name', 'college_name', 'hsc_batch', 'gender', 'profile_picture'];

const MAX_LEN = {
  full_name: 120,
  college_name: 200,
  hsc_batch: 50,
  gender: 20,
  profile_picture: 500,
};

/**
 * PATCH /api/profile
 * Body: { full_name?, college_name?, hsc_batch?, gender?, profile_picture? }
 * Only the fields present in the body are updated.
 */
export async function PATCH(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const body = await request.json();

    const setExpr = [];
    const attrValues = { ':now': new Date().toISOString() };
    const attrNames = {};

    for (const field of EDITABLE_FIELDS) {
      if (body[field] !== undefined && body[field] !== null) {
        const v = String(body[field]).slice(0, MAX_LEN[field] || 500);
        setExpr.push(`#${field} = :${field}`);
        attrValues[`:${field}`] = v;
        attrNames[`#${field}`] = field;
      }
    }

    if (setExpr.length === 0) {
      return error('no editable fields provided');
    }

    setExpr.push('updatedAt = :now');

    const res = await docClient.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `USER#${auth.user.sid}`, SK: 'PROFILE' },
      UpdateExpression: `SET ${setExpr.join(', ')}`,
      ExpressionAttributeValues: attrValues,
      ExpressionAttributeNames: attrNames,
      ReturnValues: 'ALL_NEW',
    }));

    const { password, PK, SK, ...profile } = res.Attributes || {};

    logger.info('Profile updated', { userId: auth.user.sid, fields: Object.keys(attrNames) });
    return success({ profile });
  } catch (e) {
    logger.error('profile update failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
