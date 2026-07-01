/**
 * Device routes — prekey management.
 *
 * Issue #159: POST /devices/:id/prekeys
 * Uploads a signed prekey + batch of one-time prekeys for a device.
 * Only the device owner may call this endpoint.
 */

import { Router, type Router as RouterType } from 'express';
import { eq, and, ne, count, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { devices, signedPreKeys, oneTimePreKeys } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { SignedPreKeyEntrySchema, PreKeyEntrySchema, verifyEd25519Signature } from '../lib/keys.js';

export const devicesRouter: RouterType = Router();

devicesRouter.use(requireAuth);

// ─── Schemas ──────────────────────────────────────────────────────────────────
// publicKey and signature fields are validated via the shared key validator
// (src/lib/keys.ts) enforcing correct base64 and exact byte lengths.

const UploadPreKeysSchema = z.object({
  signedPreKey: SignedPreKeyEntrySchema,
  oneTimePreKeys: z.array(PreKeyEntrySchema).min(1, 'At least one one-time prekey is required'),
});

/** Maximum number of stored one-time prekeys per device. */
const OTP_CAP = 200;

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Signature verification delegated to shared verifyEd25519Signature in src/lib/keys.ts.

// ─── GET /devices ─────────────────────────────────────────────────────────────

devicesRouter.get('/', async (req: AuthRequest, res) => {
  const { userId, deviceId: currentDeviceId } = req.auth!;

  try {
    const rows = await db.query.devices.findMany({
      where: eq(devices.userId, userId),
      orderBy: [
        sql`case when ${devices.isRevoked} = false then 0 else 1 end`,
        desc(devices.createdAt),
      ],
    });

    res.json(
      rows.map((device) => ({
        id: device.id,
        identityPublicKey: device.identityPublicKey,
        deviceName: device.deviceName,
        platform: device.platform,
        lastSeenAt: device.lastSeenAt,
        isRevoked: device.isRevoked,
        createdAt: device.createdAt,
        current: device.id === currentDeviceId,
      })),
    );
  } catch {
    res.status(500).json({ error: 'Failed to list devices' });
  }
});

// ─── DELETE /devices/:id ────────────────────────────────────────────────────
// Revoke a single device (issue #302). Idempotent — revoking an already
// revoked device just confirms the current state instead of erroring, since
// a client racing two revoke clicks shouldn't see a failure.

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

  await db
    .update(devices)
    .set({ isRevoked: true, updatedAt: new Date() })
    .where(eq(devices.id, deviceId));

  res.json({ id: deviceId, isRevoked: true });
});

// ─── POST /devices/logout-everywhere ───────────────────────────────────────
// Revokes every device on the account except the one making the request
// (issue #302). Mirrors a "log out everywhere" security action.

devicesRouter.post('/logout-everywhere', async (req: AuthRequest, res) => {
  const { userId, deviceId: currentDeviceId } = req.auth!;

  const revoked = await db
    .update(devices)
    .set({ isRevoked: true, updatedAt: new Date() })
    .where(
      and(
        eq(devices.userId, userId),
        ne(devices.id, currentDeviceId),
        eq(devices.isRevoked, false),
      ),
    )
    .returning({ id: devices.id });

  res.json({ revokedCount: revoked.length });
});

// ─── GET /devices/:id/bundle ────────────────────────────────────────────────
// X3DH prekey bundle (issue #305): identity key + signed prekey + one
// one-time prekey, atomically claimed so it is never handed out twice. Falls
// back to a signed-prekey-only bundle once one-time prekeys are exhausted —
// the initiator just runs 3-DH instead of 4-DH in that case.

devicesRouter.get('/:id/bundle', async (req: AuthRequest, res) => {
  const deviceId = req.params['id'] as string;

  const device = await db.query.devices.findFirst({
    where: eq(devices.id, deviceId),
  });

  if (!device || device.isRevoked) {
    res.status(404).json({ error: 'Device not found or has been revoked' });
    return;
  }

  const signedPreKey = await db.query.signedPreKeys.findFirst({
    where: eq(signedPreKeys.deviceId, deviceId),
  });

  if (!signedPreKey) {
    res.status(409).json({ error: 'Device has not uploaded a signed prekey yet' });
    return;
  }

  const claimedOneTimePreKey = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        id: oneTimePreKeys.id,
        keyId: oneTimePreKeys.keyId,
        publicKey: oneTimePreKeys.publicKey,
      })
      .from(oneTimePreKeys)
      .where(eq(oneTimePreKeys.deviceId, deviceId))
      .orderBy(oneTimePreKeys.createdAt)
      .limit(1)
      .for('update', { skipLocked: true });

    if (!candidate) return null;

    await tx.delete(oneTimePreKeys).where(eq(oneTimePreKeys.id, candidate.id));

    return { keyId: candidate.keyId, publicKey: candidate.publicKey };
  });

  res.json({
    deviceId: device.id,
    identityPublicKey: device.identityPublicKey,
    registrationId: device.registrationId,
    signedPreKey: {
      keyId: signedPreKey.keyId,
      publicKey: signedPreKey.publicKey,
      signature: signedPreKey.signature,
    },
    oneTimePreKey: claimedOneTimePreKey,
  });
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

  if (device.isRevoked) {
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
    .from(oneTimePreKeys)
    .where(eq(oneTimePreKeys.deviceId, deviceId));

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
    .insert(signedPreKeys)
    .values({
      deviceId,
      keyId: signedPreKey.keyId,
      publicKey: signedPreKey.publicKey,
      signature: signedPreKey.signature,
    })
    .onConflictDoUpdate({
      target: [signedPreKeys.deviceId],
      set: {
        keyId: signedPreKey.keyId,
        publicKey: signedPreKey.publicKey,
        signature: signedPreKey.signature,
        createdAt: new Date(),
      },
    });

  // Insert one-time prekeys, ignoring conflicts on (deviceId, keyId).
  if (trimmedBatch.length > 0) {
    await db
      .insert(oneTimePreKeys)
      .values(
        trimmedBatch.map((k) => ({
          deviceId,
          keyId: k.keyId,
          publicKey: k.publicKey,
        })),
      )
      .onConflictDoNothing({ target: [oneTimePreKeys.deviceId, oneTimePreKeys.keyId] });
  }

  res.status(200).json({
    uploadedSignedPreKey: true,
    uploadedOneTimePreKeys: trimmedBatch.length,
    capped: trimmedBatch.length < otpBatch.length,
  });
});
