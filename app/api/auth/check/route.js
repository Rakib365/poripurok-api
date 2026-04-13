import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { validateClientKey } from '@/lib/auth/middleware';
import { isValidPhone, isNonEmptyString } from '@/lib/utils/validation';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';

export async function POST(request) {
  try {
    if (!validateClientKey(request)) {
      return error('Unauthorized', 401);
    }

    const body = await request.json();
    const { phone, sid } = body;

    if ((!phone && !sid) || (phone && sid)) {
      return error('Provide either phone or sid, not both');
    }

    let exists = false;

    if (sid) {
      if (!isNonEmptyString(sid)) return error('Invalid sid');
      const { Item } = await docClient.send(new GetCommand({
        TableName: TABLE,
        Key: { PK: `USER#${sid}`, SK: 'PROFILE' },
        ProjectionExpression: 'PK',
      }));
      exists = !!Item;
    } else {
      if (!isValidPhone(phone)) return error('Invalid phone number');
      const { Items } = await docClient.send(new QueryCommand({
        TableName: TABLE,
        IndexName: 'PhoneIndex',
        KeyConditionExpression: 'phone = :phone',
        ExpressionAttributeValues: { ':phone': phone },
        Limit: 1,
        ProjectionExpression: 'PK',
      }));
      exists = Items.length > 0;
    }

    return success({ exists });
  } catch (e) {
    logger.error('check-student failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
