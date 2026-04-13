import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE } from '../aws/dynamodb.js';

/**
 * Returns true iff the user's PROFILE row has isAdmin === true.
 */
export async function isAdmin(userId) {
  if (!userId) return false;
  const res = await docClient.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `USER#${userId}`, SK: 'PROFILE' },
    ProjectionExpression: 'isAdmin',
  }));
  return res.Item?.isAdmin === true;
}
