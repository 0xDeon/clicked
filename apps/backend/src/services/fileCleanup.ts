/**
 * Background file cleanup service.
 *
 * Implements #231 – soft-delete (files.deletedAt) is set immediately when a
 * message is retracted. This job hard-deletes the S3 object once every
 * referencing message is also soft-deleted (ref-counting across envelopes).
 *
 * The job is idempotent: it sets hardDeletedAt only after a successful S3
 * delete, so a crash between steps is safe to retry.
 */
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { isNotNull, isNull, sql, and, eq, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { files } from '../db/schema.js';
import { reenableExpiredBackoffs } from './pushNotification.js';

const s3 = new S3Client({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const BUCKET = process.env['AWS_BUCKET'] ?? 'clicked-files';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1_000; // every 5 minutes

/**
 * Soft-delete a file record when its owning message is retracted.
 * Call this when setting message.deletedAt.
 */
export async function softDeleteFile(fileId: string): Promise<void> {
  await db.update(files).set({ deletedAt: new Date() }).where(sql`
    ${files.id} = ${fileId}
    AND ${files.hardDeletedAt} IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM messages
      WHERE file_id = ${fileId}
        AND deleted_at IS NULL
    )
  `);
}

/**
 * Hard-delete all S3 objects whose files rows are soft-deleted and have no
 * remaining live message references. Idempotent and safe to retry.
 */
export async function runHardDeletePass(): Promise<void> {
  const candidates = await db.query.files.findMany({
    where: (f) => isNotNull(f.deletedAt) && isNull(f.hardDeletedAt),
    columns: { id: true, storageKey: true },
  });

  for (const file of candidates) {
    // Re-check: skip if any non-deleted message still references this file
    const liveRef = await db.execute(sql`
      SELECT 1 FROM messages
      WHERE file_id = ${file.id}
        AND deleted_at IS NULL
      LIMIT 1
    `);

    if ((liveRef as unknown[]).length > 0) continue;

    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: file.storageKey }));
      await db
        .update(files)
        .set({ hardDeletedAt: new Date() })
        .where(sql`${files.id} = ${file.id}`);
      console.log(`[file-cleanup] hard-deleted s3://${BUCKET}/${file.storageKey}`);
    } catch (err) {
      console.error(`[file-cleanup] failed to delete ${file.storageKey}:`, err);
    }
  }

  // Garbage-collect unconfirmed pending files older than 24 hours
  const stalePendingDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const pendingCandidates = await db.query.files.findMany({
    where: (f) => and(eq(f.status, 'pending'), lt(f.createdAt, stalePendingDate)),
    columns: { id: true, storageKey: true },
  });

  for (const file of pendingCandidates) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: file.storageKey }));
      await db.delete(files).where(eq(files.id, file.id));
      console.log(`[file-cleanup] deleted pending file s3://${BUCKET}/${file.storageKey}`);
    } catch (err) {
      console.error(`[file-cleanup] failed to delete pending file ${file.storageKey}:`, err);
    }
  }
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startFileCleanupJob(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    try {
      await runHardDeletePass();
      await reenableExpiredBackoffs();
    } catch (err) {
      console.error('[file-cleanup] job error:', err);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function stopFileCleanupJob(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
