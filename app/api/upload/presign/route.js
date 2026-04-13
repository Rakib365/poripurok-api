import { randomUUID } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client, BUCKET, CDN_BASE } from '@/lib/aws/s3';
import { validateClientKey } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';

const ALLOWED_TYPES = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

const MAX_SIZE = 2 * 1024 * 1024; // 2MB
const PRESIGN_EXPIRES = 5 * 60; // 5 minutes

export async function POST(request) {
  try {
    if (!validateClientKey(request)) {
      return error('Unauthorized', 401);
    }

    const { content_type, folder = 'profiles' } = await request.json();

    if (!content_type || !ALLOWED_TYPES[content_type]) {
      return error('Invalid content type. Allowed: webp, jpeg, png');
    }

    const ext = ALLOWED_TYPES[content_type];
    const key = `${folder}/${randomUUID()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: content_type,
    });

    const upload_url = await getSignedUrl(s3Client, command, {
      expiresIn: PRESIGN_EXPIRES,
    });

    logger.info('Presigned URL generated', { key });

    return success({
      upload_url,
      key,
      public_url: `${CDN_BASE}/${key}`,
      expires_in: PRESIGN_EXPIRES,
    });
  } catch (e) {
    logger.error('presign failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
