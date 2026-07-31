/**
 * Background file cleanup service.
 *
 * Implements #231 – soft-delete (files.deletedAt) is set immediately when a
 * message is retracted. This job hard-deletes the S3 object once every
 * referencing message is also soft-deleted (ref-counting across envelopes)
 * and, if configured, a grace period has elapsed since the soft-delete.
 *
 * The job is idempotent: it sets hardDeletedAt only after a successful S3
 * delete, so a crash between steps is safe to retry.
 *
 * Retention windows are configurable via env so operators can tune them per
 * deployment without a code change.
 */
import { isNotNull, isNull, sql, and, eq, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { files } from '../db/schema.js';
import { getObjectStore } from '../lib/objectStore.js';
import { reenableExpiredBackoffs } from './pushNotification.js';

function getCleanupIntervalMs(): number {
  const raw = process.env['FILE_GC_INTERVAL_MS'];
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1_000; // every 5 minutes
}

/** Grace period after soft-delete before a fully-unreferenced file is hard-deleted. */
function getHardDeleteGraceMs(): number {
  const raw = process.env['FILE_HARD_DELETE_GRACE_MS'];
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** How long an unconfirmed (`pending`) upload may sit before its slot is reclaimed. */
function getPendingUploadTtlMs(): number {
  const raw = process.env['PENDING_UPLOAD_TTL_MS'];
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24 * 60 * 60 * 1_000; // 24 hours
}

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
  const graceCutoff = new Date(Date.now() - getHardDeleteGraceMs());
  const candidates = await db.query.files.findMany({
    where: (f) => and(isNotNull(f.deletedAt), isNull(f.hardDeletedAt), lt(f.deletedAt, graceCutoff)),
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
      await getObjectStore().deleteObject(file.storageKey);
      await db
        .update(files)
        .set({ hardDeletedAt: new Date() })
        .where(sql`${files.id} = ${file.id}`);
      console.log(`[file-cleanup] hard-deleted ${file.storageKey}`);
    } catch (err) {
      console.error(`[file-cleanup] failed to delete ${file.storageKey}:`, err);
    }
  }

  // Garbage-collect unconfirmed pending files past the configured TTL.
  const stalePendingDate = new Date(Date.now() - getPendingUploadTtlMs());
  const pendingCandidates = await db.query.files.findMany({
    where: (f) => and(eq(f.status, 'pending'), lt(f.createdAt, stalePendingDate)),
    columns: { id: true, storageKey: true },
  });

  for (const file of pendingCandidates) {
    try {
      await getObjectStore().deleteObject(file.storageKey);
      await db.delete(files).where(eq(files.id, file.id));
      console.log(`[file-cleanup] deleted pending file ${file.storageKey}`);
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
  }, getCleanupIntervalMs());
  cleanupTimer.unref();
}

export function stopFileCleanupJob(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
