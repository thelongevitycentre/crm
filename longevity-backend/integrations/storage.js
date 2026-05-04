// integrations/storage.js
//
// Recording archival to S3 (or any S3-compatible store: AWS, R2, MinIO).
// Exotel-hosted recording URLs expire — archive promptly.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = process.env.S3_ACCESS_KEY ? new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
}) : null;

const BUCKET = process.env.S3_BUCKET;

/**
 * Save a recording buffer to S3. Returns the key.
 * In dev mode (no S3 creds), no-ops and returns a synthetic key.
 */
export async function archiveRecording({ buf, callId }) {
  const key = `recordings/${new Date().getFullYear()}/${callId}.mp3`;

  if (!s3) {
    console.log(`[storage:mock] would upload ${buf.length} bytes to s3://${BUCKET}/${key}`);
    return key;
  }

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buf,
    ContentType: 'audio/mpeg',
    ServerSideEncryption: 'AES256',
  }));

  return key;
}
