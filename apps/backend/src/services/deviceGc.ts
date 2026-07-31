/**
 * Background device/key GC service.
 *
 * Three independent, idempotent passes, all safe to retry after a crash
 * because each only ever transitions rows forward (consumed -> pruned,
 * unflagged -> flagged) and re-running a pass against already-pruned/flagged
 * rows is a no-op:
 *
 *   1. Prune one-time prekeys (`device_prekeys`) that are either consumed or
 *      have aged past the "nobody claimed this" ceiling.
 *   2. Prune MLS KeyPackages (`mls_key_packages`) under the same policy.
 *   3. Flag devices that have been revoked longer than the stale window —
 *      flags only, never deletes, preserving revocation audit history.
 *
 * Retention windows are configurable via env so operators can tune them per
 * deployment without a code change.
 */
import { and, eq, lt, or, isNull, isNotNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { devicePrekeys, mlsKeyPackages, devices } from '../db/schema.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

function envDays(name: string, defaultDays: number): number {
  const raw = process.env[name];
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultDays;
}

/** How long a consumed one-time prekey/MLS key package is kept for audit before deletion. */
export function getConsumedKeyRetentionMs(): number {
  return envDays('PREKEY_CONSUMED_RETENTION_DAYS', 30) * DAY_MS;
}

/** How long an unconsumed one-time prekey/MLS key package may sit unclaimed before GC. */
export function getUnconsumedKeyMaxAgeMs(): number {
  return envDays('PREKEY_UNCONSUMED_MAX_AGE_DAYS', 90) * DAY_MS;
}

/** How long a device must stay revoked before the GC job flags it as stale. */
export function getDeviceStaleAfterMs(): number {
  return envDays('DEVICE_STALE_AFTER_DAYS', 180) * DAY_MS;
}

function getGcIntervalMs(): number {
  const raw = process.env['DEVICE_GC_INTERVAL_MS'];
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60 * 1_000; // hourly
}

/**
 * Prune one-time prekeys that are either consumed-and-aged-out or have gone
 * unconsumed past the max-age ceiling. Never touches signed prekeys — there
 * is exactly one live signed prekey per device and it is replaced in place
 * on upload, not GC'd.
 */
export async function runPrekeyGcPass(): Promise<number> {
  const consumedCutoff = new Date(Date.now() - getConsumedKeyRetentionMs());
  const unconsumedCutoff = new Date(Date.now() - getUnconsumedKeyMaxAgeMs());

  const result = await db
    .delete(devicePrekeys)
    .where(
      and(
        eq(devicePrekeys.keyType, 'one_time'),
        or(
          and(eq(devicePrekeys.consumed, true), lt(devicePrekeys.createdAt, consumedCutoff)),
          and(eq(devicePrekeys.consumed, false), lt(devicePrekeys.createdAt, unconsumedCutoff)),
        ),
      ),
    )
    .returning({ id: devicePrekeys.id });

  return result.length;
}

/** Same retention policy as `runPrekeyGcPass`, applied to MLS KeyPackages. */
export async function runMlsKeyPackageGcPass(): Promise<number> {
  const consumedCutoff = new Date(Date.now() - getConsumedKeyRetentionMs());
  const unconsumedCutoff = new Date(Date.now() - getUnconsumedKeyMaxAgeMs());

  const result = await db
    .delete(mlsKeyPackages)
    .where(
      or(
        and(eq(mlsKeyPackages.consumed, true), lt(mlsKeyPackages.createdAt, consumedCutoff)),
        and(eq(mlsKeyPackages.consumed, false), lt(mlsKeyPackages.createdAt, unconsumedCutoff)),
      ),
    )
    .returning({ id: mlsKeyPackages.id });

  return result.length;
}

/**
 * Flag (never delete) devices that have been revoked longer than the stale
 * window. Idempotent: only rows with `staleFlaggedAt IS NULL` are touched, so
 * re-running this pass against already-flagged devices is a no-op.
 */
export async function runDeviceStaleFlagPass(): Promise<number> {
  const cutoff = new Date(Date.now() - getDeviceStaleAfterMs());

  const result = await db
    .update(devices)
    .set({ staleFlaggedAt: new Date() })
    .where(
      and(isNotNull(devices.revokedAt), lt(devices.revokedAt, cutoff), isNull(devices.staleFlaggedAt)),
    )
    .returning({ id: devices.id });

  return result.length;
}

let gcTimer: ReturnType<typeof setInterval> | null = null;

export function startDeviceGcJob(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    void (async () => {
      try {
        const prekeys = await runPrekeyGcPass();
        const keyPackages = await runMlsKeyPackageGcPass();
        const flagged = await runDeviceStaleFlagPass();
        if (prekeys || keyPackages || flagged) {
          console.log(
            `[device-gc] pruned ${prekeys} prekey(s), ${keyPackages} MLS key package(s), flagged ${flagged} stale device(s)`,
          );
        }
      } catch (err) {
        console.error('[device-gc] job error:', err);
      }
    })();
  }, getGcIntervalMs());
  gcTimer.unref();
}

export function stopDeviceGcJob(): void {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
  }
}
