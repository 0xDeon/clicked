/**
 * Background message-envelope GC service.
 *
 * `message_envelopes` holds one row per (message, recipient device) — it is
 * the actual delivery unit, and the only thing that keeps it around after
 * delivery is auditability of delivered/read timestamps. Left unbounded it
 * grows with every message * every recipient device, so this job deletes:
 *
 *   1. Envelopes that have been delivered and are older than the delivered-
 *      retention window (the common case: the recipient got it).
 *   2. Envelopes past the max-age ceiling regardless of delivery state (a
 *      device that never comes back to collect its envelope should not pin
 *      storage forever).
 *
 * A plain DELETE ... WHERE is naturally idempotent and safe to retry: a
 * crash mid-run just means the next tick deletes whatever is left.
 */
import { and, lt, or, isNotNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messageEnvelopes } from '../db/schema.js';

function getEnvelopeDeliveredRetentionMs(): number {
  const raw = process.env['ENVELOPE_DELIVERED_RETENTION_DAYS'];
  const parsed = raw !== undefined ? Number(raw) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
  return days * 24 * 60 * 60 * 1_000;
}

function getEnvelopeMaxAgeMs(): number {
  const raw = process.env['ENVELOPE_MAX_AGE_DAYS'];
  const parsed = raw !== undefined ? Number(raw) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  return days * 24 * 60 * 60 * 1_000;
}

function getGcIntervalMs(): number {
  const raw = process.env['ENVELOPE_GC_INTERVAL_MS'];
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1_000; // every 30 minutes
}

export async function runEnvelopeGcPass(): Promise<number> {
  const deliveredCutoff = new Date(Date.now() - getEnvelopeDeliveredRetentionMs());
  const maxAgeCutoff = new Date(Date.now() - getEnvelopeMaxAgeMs());

  const result = await db
    .delete(messageEnvelopes)
    .where(
      or(
        and(isNotNull(messageEnvelopes.deliveredAt), lt(messageEnvelopes.deliveredAt, deliveredCutoff)),
        lt(messageEnvelopes.createdAt, maxAgeCutoff),
      ),
    )
    .returning({ id: messageEnvelopes.id });

  return result.length;
}

let envelopeGcTimer: ReturnType<typeof setInterval> | null = null;

export function startEnvelopeGcJob(): void {
  if (envelopeGcTimer) return;
  envelopeGcTimer = setInterval(() => {
    void runEnvelopeGcPass()
      .then((count) => {
        if (count) console.log(`[envelope-gc] pruned ${count} envelope(s)`);
      })
      .catch((err) => console.error('[envelope-gc] job error:', err));
  }, getGcIntervalMs());
  envelopeGcTimer.unref();
}

export function stopEnvelopeGcJob(): void {
  if (envelopeGcTimer) {
    clearInterval(envelopeGcTimer);
    envelopeGcTimer = null;
  }
}
