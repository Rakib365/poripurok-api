import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { docClient, TABLE } from '@/lib/aws/dynamodb';

const VALID_TYPES = ['answer_selected', 'solution_viewed'];

export async function POST(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const { type, questionId, selectedOption, isCorrect, timeSpentMs, subject, difficulty } = await request.json();

    if (!VALID_TYPES.includes(type)) return error('Invalid interaction type');
    if (!questionId) return error('questionId is required');

    const userId = auth.user.sid;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    // 1. Write individual interaction record
    await docClient.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `USER#${userId}`,
        SK: `INTERACT#${questionId}#${now.toISOString()}`,
        type,
        questionId,
        selectedOption: selectedOption ?? null,
        isCorrect: isCorrect ?? null,
        timeSpentMs: timeSpentMs ?? null,
        subject: subject ?? null,
        difficulty: difficulty ?? null,
        createdAt: now.toISOString(),
      },
    }));

    // 2. Update stats only for answer_selected
    if (type === 'answer_selected') {
      // Overall stats
      await docClient.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `USER#${userId}`, SK: 'STATS#overall' },
        UpdateExpression: 'ADD totalAttempted :one, totalCorrect :c, totalWrong :w SET updatedAt = :now, lastActivityDate = :today',
        ExpressionAttributeValues: {
          ':one': 1,
          ':c': isCorrect ? 1 : 0,
          ':w': isCorrect ? 0 : 1,
          ':now': now.toISOString(),
          ':today': today,
        },
      }));

      // Per-subject stats
      if (subject) {
        await docClient.send(new UpdateCommand({
          TableName: TABLE,
          Key: { PK: `USER#${userId}`, SK: `STATS#subject#${subject}` },
          UpdateExpression: 'ADD attempted :one, correct :c, wrong :w',
          ExpressionAttributeValues: {
            ':one': 1,
            ':c': isCorrect ? 1 : 0,
            ':w': isCorrect ? 0 : 1,
          },
        }));
      }

      // Daily activity
      await docClient.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `USER#${userId}`, SK: `ACTIVITY#${today}` },
        UpdateExpression: 'SET #d = :today ADD questionsAttempted :one, questionsCorrect :c',
        ExpressionAttributeValues: {
          ':today': today,
          ':one': 1,
          ':c': isCorrect ? 1 : 0,
        },
        ExpressionAttributeNames: { '#d': 'date' },
      }));
    }

    return success({ tracked: true });
  } catch (e) {
    logger.error('interaction track error', { error: e.message });
    return error('Internal server error', 500);
  }
}
