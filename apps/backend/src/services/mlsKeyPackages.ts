/**
 * MLS key package inventory (#365).
 *
 * Devices publish a stock of public MLS KeyPackages up front so any group
 * member can add them to a group while they are offline. Because a KeyPackage
 * is single-use by spec, every hand-out has to be atomic: two concurrent group
 * adds must never receive the same package, or the joining device loses forward
 * secrecy for one of the two groups.
 *
 * The claim below therefore runs `SELECT ... FOR UPDATE SKIP LOCKED` inside a
 * transaction and flips `consumed` before returning — the same technique the
 * X3DH one-time prekey claim uses in `GET /users/:id/devices/:id/key-bundle`.
 */

import { createHash } from 'node:crypto';
import { and, asc, count, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { mlsKeyPackages } from '../db/schema.js';
import { getSocketServer } from '../lib/socket.js';
import { deviceRoom } from './deliveryPipeline.js';
import { userRoom } from './roomManager.js';

/** Maximum number of unconsumed key packages a device may hold at once. */
export const MLS_KEY_PACKAGE_CAP = 100;

/**
 * Emit a replenishment signal once a device's unconsumed stock drops to this
 * many packages or fewer. Mirrors the one-time prekey low-water behaviour: the
 * device should upload a fresh batch before it hits zero, since a device with
 * no packages left cannot be added to a new group until it comes online.
 */
export const MLS_KEY_PACKAGE_LOW_WATERMARK = 10;

/** Largest batch accepted in a single upload request. */
export const MLS_KEY_PACKAGE_MAX_BATCH = 100;

export interface ClaimedKeyPackage {
  id: string;
  cipherSuite: number;
  keyPackage: string;
  expiresAt: Date | null;
}

/** SHA-256 (hex) of the base64 package — the dedupe key for re-uploads. */
export function hashKeyPackage(keyPackageB64: string): string {
  return createHash('sha256').update(keyPackageB64, 'utf8').digest('hex');
}

/**
 * Matches rows that are still handable out: not consumed, and either
 * non-expiring or not yet past `expiresAt`.
 */
function availableFilter(deviceId: string, cipherSuite?: number) {
  return and(
    eq(mlsKeyPackages.deviceId, deviceId),
    eq(mlsKeyPackages.consumed, false),
    or(isNull(mlsKeyPackages.expiresAt), gt(mlsKeyPackages.expiresAt, sql`now()`)),
    ...(cipherSuite === undefined ? [] : [eq(mlsKeyPackages.cipherSuite, cipherSuite)]),
  );
}

/** Number of key packages currently available for a device. */
export async function countAvailableKeyPackages(
  deviceId: string,
  cipherSuite?: number,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(mlsKeyPackages)
    .where(availableFilter(deviceId, cipherSuite));

  return row?.total ?? 0;
}

/**
 * Atomically claims the oldest available key package for a device, marking it
 * consumed in the same transaction. Returns `null` when the device's stock is
 * exhausted (or holds nothing for the requested cipher suite).
 *
 * Oldest-first keeps the inventory FIFO so packages are used before they
 * expire rather than aging out unused.
 */
export async function claimKeyPackage(
  deviceId: string,
  cipherSuite?: number,
): Promise<ClaimedKeyPackage | null> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        id: mlsKeyPackages.id,
        cipherSuite: mlsKeyPackages.cipherSuite,
        keyPackage: mlsKeyPackages.keyPackage,
        expiresAt: mlsKeyPackages.expiresAt,
      })
      .from(mlsKeyPackages)
      .where(availableFilter(deviceId, cipherSuite))
      .orderBy(asc(mlsKeyPackages.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });

    if (!candidate) return null;

    await tx
      .update(mlsKeyPackages)
      .set({ consumed: true, consumedAt: new Date() })
      .where(eq(mlsKeyPackages.id, candidate.id));

    return candidate;
  });
}

/**
 * Tells a device to upload more key packages when its stock runs low.
 *
 * Emitted to both the device room (so the owning device acts on it immediately)
 * and the user room (so a sibling device can surface the prompt if the low
 * device is offline). Best-effort: never blocks or fails the claim that
 * triggered it.
 */
export function signalReplenishmentIfLow(
  deviceId: string,
  userId: string,
  remaining: number,
): boolean {
  if (remaining > MLS_KEY_PACKAGE_LOW_WATERMARK) return false;

  const io = getSocketServer();
  if (!io) return false;

  const payload = {
    deviceId,
    remaining,
    threshold: MLS_KEY_PACKAGE_LOW_WATERMARK,
    cap: MLS_KEY_PACKAGE_CAP,
  };

  io.to(deviceRoom(deviceId)).emit('mls_key_packages_low', payload);
  io.to(userRoom(userId)).emit('mls_key_packages_low', payload);

  return true;
}
