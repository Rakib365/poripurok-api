import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { docClient, TABLE } from '@/lib/aws/dynamodb';

export async function GET(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const userId = auth.user.sid;

    // 1. Get overall stats
    const overallResult = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { PK: `USER#${userId}`, SK: 'STATS#overall' },
    }));

    // 2. Get per-subject stats
    const subjectResult = await docClient.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `USER#${userId}`,
        ':prefix': 'STATS#subject#',
      },
    }));

    // 3. Get last 30 days activity
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startDate = thirtyDaysAgo.toISOString().slice(0, 10);

    const activityResult = await docClient.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :start AND :end',
      ExpressionAttributeValues: {
        ':pk': `USER#${userId}`,
        ':start': `ACTIVITY#${startDate}`,
        ':end': 'ACTIVITY#9999-99-99',
      },
    }));

    // Build response
    const overall = overallResult.Item || {};
    const totalAttempted = overall.totalAttempted || 0;
    const totalCorrect = overall.totalCorrect || 0;
    const totalWrong = overall.totalWrong || 0;

    const subjectStats = {};
    for (const item of (subjectResult.Items || [])) {
      const subject = item.SK.replace('STATS#subject#', '');
      subjectStats[subject] = {
        attempted: item.attempted || 0,
        correct: item.correct || 0,
        wrong: item.wrong || 0,
      };
    }

    // Calculate streak from activity records
    const activityDates = (activityResult.Items || [])
      .map(item => item.date)
      .sort()
      .reverse();

    let streak = 0;
    const today = new Date();
    // Use Bangladesh timezone offset (UTC+6)
    const bdOffset = 6 * 60 * 60 * 1000;
    const bdNow = new Date(today.getTime() + bdOffset);
    let checkDate = new Date(bdNow);

    for (const date of activityDates) {
      const expected = checkDate.toISOString().slice(0, 10);
      if (date === expected) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else if (streak === 0) {
        // Allow yesterday as start if today has no activity yet
        checkDate.setDate(checkDate.getDate() - 1);
        if (date === checkDate.toISOString().slice(0, 10)) {
          streak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      } else {
        break;
      }
    }

    return success({
      overall: {
        totalAttempted,
        totalCorrect,
        totalWrong,
        accuracy: totalAttempted > 0 ? Math.round((totalCorrect / totalAttempted) * 100) : 0,
        lastActivityDate: overall.lastActivityDate || null,
      },
      subjectStats,
      streak,
      recentActivity: (activityResult.Items || []).map(item => ({
        date: item.date,
        attempted: item.questionsAttempted || 0,
        correct: item.questionsCorrect || 0,
      })),
    });
  } catch (e) {
    logger.error('stats error', { error: e.message });
    return error('Internal server error', 500);
  }
}
