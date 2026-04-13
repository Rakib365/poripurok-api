import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ulid } from 'ulid';
import { s3Client, BUCKET, CDN_BASE } from '@/lib/aws/s3';
import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';

/**
 * Content types allowed per upload purpose.
 * Keeps an attacker from uploading arbitrary binaries.
 */
const PURPOSE_CONFIG = {
  doubt_image: {
    folder: 'user-uploads/doubt-images',
    allowed: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' },
    maxSizeMb: 10,
  },
  feedback_image: {
    folder: 'user-uploads/feedback-images',
    allowed: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' },
    maxSizeMb: 10,
  },
  feedback_voice: {
    folder: 'user-uploads/feedback-voice',
    allowed: { 'audio/m4a': 'm4a', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/webm': 'webm' },
    maxSizeMb: 25,
  },
  feedback_pdf: {
    folder: 'user-uploads/feedback-pdfs',
    allowed: { 'application/pdf': 'pdf' },
    maxSizeMb: 20,
  },
};

const PRESIGN_EXPIRES = 5 * 60; // 5 min

function ymSegment() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * POST /api/doubt-solver/upload-url
 * Body: { purpose, content_type }
 *
 * Returns: { upload_url, key, public_url, expires_in, max_size_mb }
 */
export async function POST(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const { purpose, content_type } = await request.json();

    const cfg = PURPOSE_CONFIG[purpose];
    if (!cfg) {
      return error(`Invalid purpose. Allowed: ${Object.keys(PURPOSE_CONFIG).join(', ')}`);
    }

    if (!content_type || !cfg.allowed[content_type]) {
      return error(`Invalid content_type for purpose "${purpose}". Allowed: ${Object.keys(cfg.allowed).join(', ')}`);
    }

    const ext = cfg.allowed[content_type];
    const key = `${cfg.folder}/${auth.user.sid}/${ymSegment()}/${ulid()}.${ext}`;

    const upload_url = await getSignedUrl(
      s3Client,
      new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: content_type }),
      { expiresIn: PRESIGN_EXPIRES },
    );

    return success({
      upload_url,
      key,
      public_url: `${CDN_BASE}/${key}`,
      expires_in: PRESIGN_EXPIRES,
      max_size_mb: cfg.maxSizeMb,
    });
  } catch (e) {
    logger.error('doubt-solver upload-url failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
