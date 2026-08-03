/**
 * Device routes — registration, listing, revocation, and prekey management.
 *
 * `devices` is the single canonical device registry (see #103/#107 — a
 * previously-separate `user_devices` table was merged into this one so the
 * realtime/messaging/push layers and the auth/prekey layer share one source
 * of truth instead of two tables that could silently diverge).
 */

import { createHash } from 'node:crypto';
import { Router, type Router as RouterType } from 'express';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { Keypair } from '@stellar/stellar-sdk';
import { eq, and, ne, count, desc, isNull, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  devices,
  devicePrekeys,
  mlsKeyPackages,
  conversationMembers,
  messages,
  wallets,
} from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { DeviceLinkVerifySchema, type DeviceLinkVerifyBody } from '../schemas/auth.schemas.js';
import { createDeviceLinkNonce, consumeDeviceLinkNonce } from '../lib/nonce.js';
import { getSocketServer } from '../lib/socket.js';
import { invalidateConversationCaches } from '../lib/conversationCache.js';
import {
  SignedPreKeyEntrySchema,
  PreKeyEntrySchema,
  MlsKeyPackageSchema,
  verifyEd25519Signature,
} from '../lib/keys.js';
import { conversationRoom } from '../services/roomManager.js';
import { redis } from '../lib/redis.js';
import { markDeviceRevoked } from '../services/deviceRevocation.js';
import {
  MLS_KEY_PACKAGE_CAP,
  MLS_KEY_PACKAGE_MAX_BATCH,
  countAvailableKeyPackages,
  hashKeyPackage,
} from '../services/mlsKeyPackages.js';
import {
  PREKEY_LOW_THRESHOLD,
  countAvailableOneTimePreKeys,
  releasePrekeysLowLatch,
} from '../services/prekeyLowSignal.js';
import { actorFromRequest, recordAuditEvent } from '../services/auditLog.js';

export const devicesRouter: RouterType = Router();

devicesRouter.use(requireAuth);

// ─── Schemas ──────────────────────────────────────────────────────────────────
// publicKey and signature fields are validated via the shared key validator
// (src/lib/keys.ts) enforcing correct base64 and exact byte lengths.

const UploadPreKeysSchema = z
  .object({
    signedPreKey: SignedPreKeyEntrySchema,
    oneTimePreKeys: z.array(PreKeyEntrySchema).min(1, 'At least one one-time prekey is required'),
  })
  .strict();

const RegisterDeviceSchema = DeviceSchema;

/**
 * MLS key package batch upload. `keyPackage` is validated as base64 of a
 * 32–4096 byte TLS-serialised KeyPackage by the shared key validator; the
 * handler additionally rejects already-expired packages.
 */
const UploadMlsKeyPackagesSchema = z.object({
  cipherSuite: z.number().int().positive(),
  keyPackages: z
    .array(
      z.object({
        keyPackage: MlsKeyPackageSchema,
        expiresAt: z.iso.datetime().optional(),
      }),
    )
    .min(1, 'At least one key package is required')
    .max(
      MLS_KEY_PACKAGE_MAX_BATCH,
      `At most ${MLS_KEY_PACKAGE_MAX_BATCH} key packages per request`,
    ),
});

/** Maximum number of stored one-time prekeys per device. */
const OTP_CAP = 200;

// ─── Device-link rate limiters ────────────────────────────────────────────────
// Mirrors the auth challenge/verify limiters (src/routes/auth.ts). Kept as
// separate instances so hammering the link flow cannot lock out sign-in.

const rateLimitedResponse = { error: 'Too many requests' };

export const deviceLinkChallengeLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: rateLimitedResponse,
});

export const deviceLinkVerifyLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: rateLimitedResponse,
});

// ─── GET /devices ─────────────────────────────────────────────────────────────

devicesRouter.get('/', async (req: AuthRequest, res) => {
  const { userId, deviceId: currentDeviceId } = req.auth!;

  try {
    const rows = await db.query.devices.findMany({
      where: eq(devices.userId, userId),
      orderBy: [
        sql`case when ${devices.revokedAt} is null then 0 else 1 end`,
        desc(devices.createdAt),
      ],
    });

    const otpCounts =
      rows.length === 0
        ? []
        : await db
            .select({ deviceId: devicePrekeys.deviceId, remaining: count() })
            .from(devicePrekeys)
            .where(
              and(
                eq(devicePrekeys.keyType, 'one_time'),
                eq(devicePrekeys.consumed, false),
                inArray(
                  devicePrekeys.deviceId,
                  rows.map((d) => d.id),
                ),
              ),
            )
            .groupBy(devicePrekeys.deviceId);
    const remainingByDevice = new Map(otpCounts.map((r) => [r.deviceId, r.remaining]));

    res.json(
      rows.map((device) => ({
        id: device.id,
        identityPublicKey: device.identityPublicKey,
        deviceName: device.deviceName,
        platform: device.platform,
        lastSeenAt: device.lastSeenAt,
        revokedAt: device.revokedAt,
        capabilities: normalizeCapabilities(device.capabilities),
        oneTimePreKeysRemaining: remainingByDevice.get(device.id) ?? 0,
        createdAt: device.createdAt,
        current: device.id === currentDeviceId,
      })),
    );
  } catch {
    res.status(500).json({ error: 'Failed to list devices' });
  }
});

// ─── Revocation helpers ─────────────────────────────────────────────────────
// Shared by DELETE /:id and POST /logout-everywhere so both revocation paths
// get identical side effects: prekeys cleared, live sockets disconnected via
// the device_revoked:* pub/sub channel (#146), and a key-change system event.

async function revokeDeviceRow(deviceId: string): Promise<Date> {
  const revokedAt = new Date();

  await db.update(devices).set({ revokedAt, updatedAt: revokedAt }).where(eq(devices.id, deviceId));
  await db.delete(devicePrekeys).where(eq(devicePrekeys.deviceId, deviceId));

  // The device's prekeys are gone; leaving a latch behind would suppress the
  // first low signal if this identity key is later re-registered.
  await releasePrekeysLowLatch(deviceId);

  // Force-disconnect any live socket for this device, on this node or any
  // other (cross-node via Redis pub/sub — see services/deviceRevocation.ts).
  markDeviceRevoked(deviceId);
  if (redis) {
    await redis.publish(`device_revoked:${deviceId}`, '1').catch(() => {});
  }

  return revokedAt;
}

/** Count of the caller's currently-active (non-revoked) devices. */
async function countActiveDevices(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(devices)
    .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
  return row?.total ?? 0;
}

// ─── DELETE /devices/:id ────────────────────────────────────────────────────
// Revoke a single device. Idempotent — revoking an already revoked device
// just confirms the current state instead of erroring. Refuses to revoke a
// caller's last remaining active device (there would be no way back in).

devicesRouter.delete('/:id', async (req: AuthRequest, res) => {
  const deviceId = req.params['id'] as string;
  const callerId = req.auth!.userId;

  const device = await db.query.devices.findFirst({
    where: eq(devices.id, deviceId),
  });

  if (!device || device.userId !== callerId) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  if (device.revokedAt) {
    res.json({ id: deviceId, revokedAt: device.revokedAt.toISOString() });
    return;
  }

  const activeCount = await countActiveDevices(callerId);
  if (activeCount <= 1) {
    res.status(409).json({ error: 'Cannot revoke your only active device' });
    return;
  }

  const revokedAt = await revokeDeviceRow(deviceId);
  void emitDeviceChangeEvent(callerId, 'device_revoked');

  void recordAuditEvent({
    action: 'device_revoked',
    ...actorFromRequest(req),
    targetType: 'device',
    targetId: deviceId,
    metadata: {
      deviceName: device.deviceName,
      platform: device.platform,
      // Revoking from the device being revoked reads very differently from
      // revoking a device you no longer hold.
      selfRevocation: deviceId === req.auth!.deviceId,
      remainingActiveDevices: activeCount - 1,
    },
  });

  res.json({ id: deviceId, revokedAt: revokedAt.toISOString() });
});

// ─── POST /devices/logout-everywhere ───────────────────────────────────────
// Revokes every device on the account except the one making the request.
// Mirrors a "log out everywhere" security action — same side effects as a
// single DELETE, applied to every other active device.

devicesRouter.post('/logout-everywhere', async (req: AuthRequest, res) => {
  const { userId, deviceId: currentDeviceId } = req.auth!;

  const toRevoke = await db.query.devices.findMany({
    where: and(
      eq(devices.userId, userId),
      ne(devices.id, currentDeviceId),
      isNull(devices.revokedAt),
    ),
    columns: { id: true },
  });

  for (const { id } of toRevoke) {
    await revokeDeviceRow(id);
    void recordAuditEvent({
      action: 'device_revoked',
      ...actorFromRequest(req),
      targetType: 'device',
      targetId: id,
      metadata: { viaLogoutEverywhere: true },
    });
  }

  if (toRevoke.length > 0) {
    void emitDeviceChangeEvent(userId, 'device_revoked');
  }

  // Recorded even when nothing was revoked: an account-wide security action
  // was still invoked, and a responder wants to see the attempt.
  void recordAuditEvent({
    action: 'logout_everywhere',
    ...actorFromRequest(req),
    targetType: 'user',
    targetId: userId,
    metadata: { revokedCount: toRevoke.length, retainedDeviceId: currentDeviceId },
  });

  res.json({ revokedCount: toRevoke.length });
});

// ─── POST /devices/:id/prekeys ─────────────────────────────────────────────────

devicesRouter.post('/:id/prekeys', validate(UploadPreKeysSchema), async (req: AuthRequest, res) => {
  const deviceId = req.params['id'] as string;
  const callerId = req.auth!.userId;

  // Fetch the device and verify ownership.
  const device = await db.query.devices.findFirst({
    where: eq(devices.id, deviceId),
  });

  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  if (device.userId !== callerId) {
    res.status(403).json({ error: 'Only the device owner may upload prekeys' });
    return;
  }

  if (device.revokedAt) {
    res.status(403).json({ error: 'Device is revoked' });
    return;
  }

  const { signedPreKey, oneTimePreKeys: otpBatch } = req.body as z.infer<
    typeof UploadPreKeysSchema
  >;

  // Validate the signed prekey signature against the device identity key.
  const sigValid = verifyEd25519Signature(
    device.identityPublicKey,
    signedPreKey.publicKey,
    signedPreKey.signature,
  );

  if (!sigValid) {
    res.status(400).json({ error: 'Signed prekey signature is invalid' });
    return;
  }

  // Enforce the one-time prekey cap before inserting.
  const [otpCountRow] = await db
    .select({ total: count() })
    .from(devicePrekeys)
    .where(
      and(
        eq(devicePrekeys.deviceId, deviceId),
        eq(devicePrekeys.keyType, 'one_time'),
        eq(devicePrekeys.consumed, false),
      ),
    );

  const currentCount = otpCountRow?.total ?? 0;
  const available = OTP_CAP - currentCount;

  if (available <= 0) {
    res.status(422).json({
      error: `One-time prekey cap of ${OTP_CAP} reached. Consume existing prekeys before uploading more.`,
    });
    return;
  }

  // Trim the incoming batch to stay within the cap.
  const trimmedBatch = otpBatch.slice(0, available);

  // Upsert the signed prekey (one per device — replace on keyId conflict).
  await db
    .insert(devicePrekeys)
    .values({
      deviceId,
      keyType: 'signed',
      keyId: signedPreKey.keyId,
      publicKey: signedPreKey.publicKey,
      signature: signedPreKey.signature,
    })
    .onConflictDoUpdate({
      target: devicePrekeys.deviceId,
      targetWhere: sql`${devicePrekeys.keyType} = 'signed'`,
      set: {
        keyId: signedPreKey.keyId,
        publicKey: signedPreKey.publicKey,
        signature: signedPreKey.signature,
        createdAt: new Date(),
      },
    });

  // Insert one-time prekeys, ignoring conflicts on (deviceId, keyType, keyId).
  if (trimmedBatch.length > 0) {
    await db
      .insert(devicePrekeys)
      .values(
        trimmedBatch.map((k) => ({
          deviceId,
          keyType: 'one_time' as const,
          keyId: k.keyId,
          publicKey: k.publicKey,
        })),
      )
      .onConflictDoNothing({
        target: [devicePrekeys.deviceId, devicePrekeys.keyType, devicePrekeys.keyId],
      });
  }

  // Re-arm the low-prekey signal once the device is back at or above the
  // threshold, so a future crossing fires again. Recounted rather than derived
  // from `currentCount + trimmedBatch.length` because duplicate keyIds are
  // dropped by ON CONFLICT DO NOTHING and would inflate the derived figure.
  const replenishedCount = await countAvailableOneTimePreKeys(deviceId);
  if (replenishedCount >= PREKEY_LOW_THRESHOLD) {
    await releasePrekeysLowLatch(deviceId);
  }

  res.status(200).json({
    uploadedSignedPreKey: true,
    uploadedOneTimePreKeys: trimmedBatch.length,
    capped: trimmedBatch.length < otpBatch.length,
    oneTimePreKeysRemaining: replenishedCount,
  });
});

// ─── POST /devices/:id/mls-key-packages ────────────────────────────────────────
//
// Publishes a batch of public MLS KeyPackages for a device (#365). Only the
// owning device's user may upload, and only public material is accepted — the
// HPKE init private key stays on the device.
//
// Uploads are idempotent: re-sending a package the device already published is
// counted as a duplicate rather than stored twice, so a client that retries a
// timed-out request does not inflate its inventory.

devicesRouter.post(
  '/:id/mls-key-packages',
  validate(UploadMlsKeyPackagesSchema),
  async (req: AuthRequest, res) => {
    const deviceId = req.params['id'] as string;
    const callerId = req.auth!.userId;

    const device = await db.query.devices.findFirst({
      where: eq(devices.id, deviceId),
    });

    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }

    if (device.userId !== callerId) {
      res.status(403).json({ error: 'Only the device owner may upload MLS key packages' });
      return;
    }

    if (device.revokedAt) {
      res.status(403).json({ error: 'Device is revoked' });
      return;
    }

    const { cipherSuite, keyPackages } = req.body as z.infer<typeof UploadMlsKeyPackagesSchema>;

    // Reject packages that are already past their expiry — storing them would
    // only produce inventory that can never be claimed.
    const now = Date.now();
    const expired = keyPackages.filter(
      (k) => k.expiresAt !== undefined && Date.parse(k.expiresAt) <= now,
    );

    if (expired.length > 0) {
      res.status(400).json({ error: 'expiresAt must be in the future' });
      return;
    }

    // Enforce the per-device cap on *available* packages before inserting.
    const currentCount = await countAvailableKeyPackages(deviceId);
    const available = MLS_KEY_PACKAGE_CAP - currentCount;

    if (available <= 0) {
      res.status(422).json({
        error: `MLS key package cap of ${MLS_KEY_PACKAGE_CAP} reached. Wait for existing packages to be consumed before uploading more.`,
      });
      return;
    }

    // Drop duplicates inside the batch itself so the row count we report back
    // reflects distinct packages, then trim to the remaining cap space.
    const seen = new Set<string>();
    const distinct = keyPackages.filter((k) => {
      const hash = hashKeyPackage(k.keyPackage);
      if (seen.has(hash)) return false;
      seen.add(hash);
      return true;
    });

    const trimmed = distinct.slice(0, available);

    const inserted = await db
      .insert(mlsKeyPackages)
      .values(
        trimmed.map((k) => ({
          deviceId,
          cipherSuite,
          keyPackage: k.keyPackage,
          packageHash: hashKeyPackage(k.keyPackage),
          expiresAt: k.expiresAt ? new Date(k.expiresAt) : null,
        })),
      )
      .onConflictDoNothing({ target: [mlsKeyPackages.deviceId, mlsKeyPackages.packageHash] })
      .returning({ id: mlsKeyPackages.id });

    res.status(200).json({
      uploaded: inserted.length,
      duplicates: trimmed.length - inserted.length,
      capped: trimmed.length < distinct.length,
      remaining: currentCount + inserted.length,
    });
  },
);

// ─── POST /devices — register a new device for an existing user --------------
// ─── Device linking / re-authentication challenge (#333) ─────────────────────
//
// Adding a device to an account used to require nothing more than a valid JWT
// (the old bare `POST /devices`). A stolen token was therefore enough to
// silently attach an attacker-controlled device. Linking now needs a *fresh*
// wallet signature on top of the JWT: the server issues a single-use,
// short-lived nonce and the caller must sign it with the account's wallet key.
//
// The signed message is deliberately distinct from the login message in
// routes/auth.ts, so a captured sign-in signature can never be replayed as a
// device-link proof (and vice versa).

function deviceLinkMessage(userId: string, nonce: string): string {
  return `Link device to Clicked\nUser: ${userId}\nNonce: ${nonce}`;
}

/** The wallet a device-link signature must come from: primary if present. */
async function resolveAccountWallet(userId: string): Promise<string | null> {
  const rows = await db.query.wallets.findMany({
    where: eq(wallets.userId, userId),
  });
  if (rows.length === 0) return null;
  const primary = rows.find((w) => w.isPrimary);
  return (primary ?? rows[0])!.address;
}

/**
 * Verifies a Stellar/Ed25519 signature over `message`.
 *
 * Two wallet client libraries are in use and they sign differently, so both
 * encodings are accepted (identical to the check in routes/auth.ts):
 *   - raw message bytes, hex-encoded signature
 *   - sha256("Stellar Signed Message:\n" + message), base64-encoded signature
 */
function verifyWalletSignature(walletAddress: string, message: string, signature: string): boolean {
  try {
    const rawMessageBytes = Buffer.from(message);
    const freighterMessageBytes = createHash('sha256')
      .update(`Stellar Signed Message:\n${message}`)
      .digest();
    const keypair = Keypair.fromPublicKey(walletAddress);
    const hexSignatureBytes = Buffer.from(signature, 'hex');
    const base64SignatureBytes = Buffer.from(signature, 'base64');

    return (
      keypair.verify(rawMessageBytes, hexSignatureBytes) ||
      keypair.verify(freighterMessageBytes, base64SignatureBytes)
    );
  } catch {
    return false;
  }
}

// ─── POST /devices/link/challenge ────────────────────────────────────────────
// Step 1: issue a nonce the caller must sign with the account wallet.

devicesRouter.post('/link/challenge', deviceLinkChallengeLimiter, async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;

  let walletAddress: string | null;
  try {
    walletAddress = await resolveAccountWallet(userId);
  } catch {
    res.status(500).json({ error: 'Failed to issue device link challenge' });
    return;
  }

  if (!walletAddress) {
    res.status(400).json({ error: 'No wallet is associated with this account' });
    return;
  }

  const nonce = createDeviceLinkNonce(userId);

  res.json({ message: deviceLinkMessage(userId, nonce), nonce, walletAddress });
});

// ─── POST /devices/link/verify ───────────────────────────────────────────────
// Step 2: burn the nonce, check the fresh wallet signature, then register the
// device. This is the *only* way to add a new device to an account.

devicesRouter.post(
  '/link/verify',
  deviceLinkVerifyLimiter,
  validate(DeviceLinkVerifySchema),
  async (req: AuthRequest, res) => {
    const body = req.body as DeviceLinkVerifyBody;
    const userId = req.auth!.userId;

    // Single-use: consumed before any signature work, so a nonce cannot be
    // reused to brute-force signatures and a replayed request always fails.
    if (!consumeDeviceLinkNonce(userId, body.nonce)) {
      res.status(401).json({ error: 'Invalid or expired device link nonce' });
      return;
    }

    let walletAddress: string | null;
    try {
      walletAddress = await resolveAccountWallet(userId);
    } catch {
      res.status(500).json({ error: 'Failed to register device' });
      return;
    }

    if (!walletAddress) {
      res.status(400).json({ error: 'No wallet is associated with this account' });
      return;
    }

    if (
      !verifyWalletSignature(walletAddress, deviceLinkMessage(userId, body.nonce), body.signature)
    ) {
      res.status(401).json({ error: 'Signature verification failed' });
      return;
    }

    const existing = await db.query.devices.findFirst({
      where: and(eq(devices.userId, userId), eq(devices.identityPublicKey, body.identityPublicKey)),
    });

    if (existing && !existing.revokedAt) {
      res.status(409).json({ error: 'Device already registered for this user' });
      return;
    }

    try {
      let row: { id: string; createdAt: Date } | undefined;

      if (existing) {
        // Re-registering a previously-revoked identity key re-activates it
        // rather than creating a duplicate row for the same crypto identity.
        [row] = await db
          .update(devices)
          .set({
            deviceName: body.deviceName,
            platform: body.platform,
            registrationId: body.registrationId ?? null,
            revokedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(devices.id, existing.id))
          .returning({ id: devices.id, createdAt: devices.createdAt });
      } else {
        [row] = await db
          .insert(devices)
          .values({
            userId,
            identityPublicKey: body.identityPublicKey,
            deviceName: body.deviceName,
            platform: body.platform,
            registrationId: body.registrationId ?? null,
          })
          .returning({ id: devices.id, createdAt: devices.createdAt });
      }

      if (!row) {
        res.status(500).json({ error: 'Failed to register device' });
        return;
      }

      void emitDeviceChangeEvent(userId, 'device_added');

      void recordAuditEvent({
        action: 'device_linked',
        ...actorFromRequest(req),
        targetType: 'device',
        targetId: row.id,
        metadata: {
          deviceName: body.deviceName ?? null,
          platform: body.platform ?? null,
          // Re-activating a revoked identity key is not the same event as
          // linking a brand-new device, and the difference matters after a
          // revocation that was meant to lock someone out.
          reactivatedRevokedDevice: Boolean(existing),
        },
      });

      res.status(201).json({ id: row.id, createdAt: row.createdAt });
    } catch (err) {
      console.error('Failed to register device:', err);
      res.status(500).json({ error: 'Failed to register device' });
    }
  },
);

// ─── POST /devices — retired (#333) ──────────────────────────────────────────
// Kept only to return an explicit, actionable error: bare JWT-only device
// registration is gone. Clients must complete the link challenge instead.

devicesRouter.post('/', (_req: AuthRequest, res) => {
  res.status(403).json({
    error:
      'Device registration requires a fresh wallet signature. Use POST /devices/link/challenge then POST /devices/link/verify.',
  });
});

async function emitDeviceChangeEvent(userId: string, change: 'device_added' | 'device_revoked') {
  try {
    const memberships = await db.query.conversationMembers.findMany({
      where: eq(conversationMembers.userId, userId),
      columns: { conversationId: true },
    });

    if (memberships.length === 0) return;

    for (const m of memberships) {
      const msg = await db.transaction(async (tx) => {
        const [insertedMessage] = await tx
          .insert(messages)
          .values({
            conversationId: m.conversationId,
            senderId: userId,
            contentType: 'system',
            // System metadata is plaintext and structured — it belongs in
            // `systemPayload`, not in the E2EE `ciphertext` column.
            ciphertext: null,
            systemPayload: { userId, change },
          })
          .returning();
        return insertedMessage;
      });

      const io = getSocketServer();
      if (io) {
        io.to(conversationRoom(m.conversationId)).emit('new_message', msg);
        // Also emit to direct conversation room for backward compatibility
        io.to(m.conversationId).emit('new_message', msg);
      }

      // invalidate caches for conversation members
      const members = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.conversationId, m.conversationId),
        columns: { userId: true },
      });
      await invalidateConversationCaches(members.map((mm) => mm.userId));
    }
  } catch (err) {
    console.error('emitDeviceChangeEvent error:', err);
  }
}
