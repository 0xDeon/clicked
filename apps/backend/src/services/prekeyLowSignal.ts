/**
 * Low one-time-prekey signalling.
 *
 * A device's one-time prekeys are consumed one per X3DH bundle fetch and are
 * never regenerated server-side — once they run out, initiators fall back to a
 * 3-DH bundle with no forward-secrecy contribution from a one-time key. So the
 * device needs to be told to replenish *before* it hits zero.
 *
 * The signal fires on the bundle-fetch path (the only place the count drops),
 * and is latched so a device that stays below the threshold across many
 * fetches is told once, not once per fetch. The latch clears when the device
 * replenishes back to or above the threshold, so the next crossing signals
 * again.
 */

import type { Redis } from 'ioredis';
import { and, count, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { devicePrekeys } from '../db/schema.js';
import { getSocketServer } from '../lib/socket.js';
import { redis } from '../lib/redis.js';

/**
 * Signal when a device's unconsumed one-time prekey count drops below this.
 * Overridable via `PREKEY_LOW_THRESHOLD` for deployments that burn through
 * prekeys faster (large group fan-out) and want more headroom.
 */
export const PREKEY_LOW_THRESHOLD = (() => {
  const raw = Number(process.env['PREKEY_LOW_THRESHOLD']);
  return Number.isInteger(raw) && raw > 0 ? raw : 20;
})();

/**
 * Safety net so a latch for a device that never replenishes (and never gets
 * revoked) cannot linger in Redis forever. Expiry re-arms the signal, which is
 * the desired behaviour anyway for a device that has ignored it for this long.
 */
const LATCH_TTL_SECONDS = 30 * 24 * 60 * 60;

const latchKey = (deviceId: string): string => `prekeys:low:${deviceId}`;

/**
 * In-process fallback used when Redis is not configured (single-node dev, and
 * the unit test suite). Same latch semantics, just not shared across nodes.
 */
const localLatch = new Set<string>();

/**
 * Claim the right to emit for this device. Returns true exactly once per
 * threshold crossing — subsequent calls return false until the latch is
 * released by {@link releasePrekeysLowLatch}.
 *
 * On Redis this is a single atomic `SET NX`, so two gateways racing on
 * concurrent bundle fetches still produce only one emit.
 */
async function acquirePrekeysLowLatch(client: Redis | null, deviceId: string): Promise<boolean> {
  if (!client) {
    if (localLatch.has(deviceId)) return false;
    localLatch.add(deviceId);
    return true;
  }

  try {
    const result = await client.set(latchKey(deviceId), '1', 'EX', LATCH_TTL_SECONDS, 'NX');
    return result === 'OK';
  } catch {
    // Redis unavailable — fall back to the local latch rather than either
    // spamming the device or going silent.
    if (localLatch.has(deviceId)) return false;
    localLatch.add(deviceId);
    return true;
  }
}

/**
 * Re-arm the signal for a device. Called when the device replenishes back to
 * or above the threshold, and on revocation (where prekeys are deleted).
 */
export async function releasePrekeysLowLatch(deviceId: string): Promise<void> {
  localLatch.delete(deviceId);
  if (!redis) return;
  try {
    await redis.del(latchKey(deviceId));
  } catch {
    // Best effort — a stale latch only costs one missed signal, and expires.
  }
}

/** Count of a device's unconsumed one-time prekeys. */
export async function countAvailableOneTimePreKeys(deviceId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(devicePrekeys)
    .where(
      and(
        eq(devicePrekeys.deviceId, deviceId),
        eq(devicePrekeys.keyType, 'one_time'),
        eq(devicePrekeys.consumed, false),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Emit `prekeys_low` to the device's own sockets if `remaining` has crossed
 * below the threshold and the signal is not already latched.
 *
 * Targets the `device:{id}` room, so the event reaches that device on whichever
 * gateway holds its socket (via the Socket.IO Redis adapter) and reaches no
 * other device on the account — only the owner can replenish its own prekeys.
 *
 * Safe to call fire-and-forget: it never throws.
 */
export async function signalPrekeysLowIfNeeded(deviceId: string, remaining: number): Promise<void> {
  try {
    if (remaining >= PREKEY_LOW_THRESHOLD) {
      // Back in healthy territory — re-arm so the next crossing signals.
      await releasePrekeysLowLatch(deviceId);
      return;
    }

    if (!(await acquirePrekeysLowLatch(redis, deviceId))) return;

    const io = getSocketServer();
    if (!io) return;

    io.to(`device:${deviceId}`).emit('prekeys_low', {
      deviceId,
      oneTimePreKeysRemaining: remaining,
      threshold: PREKEY_LOW_THRESHOLD,
    });
  } catch (err) {
    console.warn('[prekeyLowSignal] failed for device', deviceId, (err as Error).message);
  }
}

/** Test-only: drop in-process latch state between cases. */
export function __resetPrekeyLowLatches(): void {
  localLatch.clear();
}
