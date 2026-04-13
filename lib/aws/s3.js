import { S3Client } from '@aws-sdk/client-s3';

export const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
});

export const BUCKET = process.env.S3_BUCKET || 'poripurok-static-assets';
export const CDN_BASE = process.env.CDN_BASE || 'https://files.poripurok.com';
