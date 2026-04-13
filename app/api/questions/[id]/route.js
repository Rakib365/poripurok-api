import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { validateClientKey } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { docClient } from '@/lib/aws/dynamodb';

const QB_TABLE = 'questionbank-projects';

/**
 * GET /api/questions/[id]
 * Get full question details by ID from DynamoDB.
 * Searches across all projects since we only have the questionId.
 */
export async function GET(request, { params }) {
  try {
    if (!validateClientKey(request)) {
      return error('Unauthorized', 401);
    }

    const { id } = await params;

    if (!id) {
      return error('Question ID is required');
    }

    // We need projectId to query efficiently. Check query params first.
    const url = new URL(request.url);
    const projectId = url.searchParams.get('projectId');

    let question;

    if (projectId) {
      // Direct query with project ID
      const result = await docClient.send(new QueryCommand({
        TableName: QB_TABLE,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: {
          ':pk': `PROJECT#${projectId}`,
          ':sk': `QUESTION#${id}`,
        },
      }));
      question = result.Items?.[0];
    } else {
      // Scan with filter (less efficient but works without projectId)
      const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
      const result = await docClient.send(new ScanCommand({
        TableName: QB_TABLE,
        FilterExpression: 'SK = :sk',
        ExpressionAttributeValues: {
          ':sk': `QUESTION#${id}`,
        },
        Limit: 1,
      }));
      question = result.Items?.[0];
    }

    if (!question) {
      return error('Question not found', 404);
    }

    const content = question.content || {};

    return success({
      question: {
        id: question.questionId || id,
        projectId: question.projectId,
        questionType: question.questionType,
        pageNumber: question.pageNumber,
        status: question.status,
        stem_text: content.stem_text || content.question,
        options: content.options,
        mcqType: content.mcqType,
        mcqQuestions: content.mcqQuestions,
        correctOptionIndices: content.correctOptionIndices,
        solution: content.solution,
        taxonomy: content.taxonomy,
        difficulty: content.difficulty,
        cognitiveLevel: content.cognitiveLevel,
        tags: content.tags,
        hasImage: content.hasImage,
        images: {
          original: question.imageS3Key,
          cropped: question.croppedImageS3Keys,
          compressed: question.croppedImageCompressedS3Keys,
          generated: question.generatedImages,
        },
        source: content.source,
      },
    });
  } catch (e) {
    logger.error('question detail error', { error: e.message });
    return error('Internal server error', 500);
  }
}
