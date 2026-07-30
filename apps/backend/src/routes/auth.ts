import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, IRouter } from 'express';
import type { RequestHandler } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { db } from '../db/index.js';
import { users, wallets, devices } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { createNonce, consumeNonce } from '../lib/nonce.js';
import { signToken } from '../lib/jwt.js';
import { normalizeCapabilities } from '../lib/capabilities.js';
import { validate } from '../middleware/validate.js';
import { recordAuditEvent, requestContext } from '../services/auditLog.js';
import { ipIdentifier, rateLimit } from '../middleware/rateLimit.js';
import {
  ChallengeSchema,
  VerifySchema,
  type ChallengeBody,
  type VerifyBody,
} from '../schemas/auth.schemas.js';

export const authRouter: IRouter = Router();

// Both limiters are keyed on the client IP — there is no authenticated
// identity yet — and are counted in Redis so the budget is shared across
// every gateway node instead of being multiplied by the node count (#375).
export const challengeLimiter: RequestHandler = rateLimit('auth_challenge', {
  identifier: ipIdentifier,
});

export const verifyLimiter: RequestHandler = rateLimit('auth_verify', {
  identifier: ipIdentifier,
});

// Step 1: client requests a challenge nonce for a wallet address
authRouter.post(
  '/challenge',
  challengeLimiter,
  validate(ChallengeSchema),
  (req: Request, res: Response) => {
    const { walletAddress } = req.body as ChallengeBody;

    const nonce = createNonce(walletAddress);
    const message = `Sign in to Clicked\nWallet: ${walletAddress}\nNonce: ${nonce}`;

    res.json({ message, nonce });
  },
);

// Step 2: client signs the message and submits the signature
authRouter.post(
  '/verify',
  verifyLimiter,
  validate(VerifySchema),
  async (req: Request, res: Response) => {
    const { walletAddress, signature, nonce, identityPublicKey, device } = req.body as VerifyBody;
    const deviceName = device?.deviceName;
    const platform = device?.platform;
    const registrationId = device?.registrationId;
    const capabilities = device?.capabilities;

    // Every failed sign-in is audited (#376). The wallet address is the only
    // identity available before verification succeeds, and it is a public
    // value, so it is safe to record as the target.
    const auditFailure = (reason: string) =>
      recordAuditEvent({
        action: 'auth_failed',
        ...requestContext(req),
        targetType: 'wallet',
        targetId: walletAddress,
        metadata: { reason },
      });

    // Validate and consume nonce
    const valid = consumeNonce(walletAddress, nonce);
    if (!valid) {
      void auditFailure('invalid_or_expired_nonce');
      res.status(401).json({ error: 'Invalid or expired nonce' });
      return;
    }

    // Verify Stellar keypair signature
    try {
      const message = `Sign in to Clicked\nWallet: ${walletAddress}\nNonce: ${nonce}`;
      const rawMessageBytes = Buffer.from(message);
      const freighterMessageBytes = createHash('sha256')
        .update(`Stellar Signed Message:\n${message}`)
        .digest();
      const keypair = Keypair.fromPublicKey(walletAddress);
      const hexSignatureBytes = Buffer.from(signature, 'hex');
      const base64SignatureBytes = Buffer.from(signature, 'base64');

      const isValidSignature =
        keypair.verify(rawMessageBytes, hexSignatureBytes) ||
        keypair.verify(freighterMessageBytes, base64SignatureBytes);

      if (!isValidSignature) {
        void auditFailure('signature_verification_failed');
        res.status(401).json({ error: 'Signature verification failed' });
        return;
      }
    } catch {
      void auditFailure('malformed_signature_or_wallet');
      res.status(401).json({ error: 'Invalid signature or wallet address' });
      return;
    }

    // Upsert user + wallet
    let userId: string;

    const existingWallet = await db.query.wallets.findFirst({
      where: eq(wallets.address, walletAddress),
      with: { user: true },
    });

    if (existingWallet) {
      userId = existingWallet.userId;
    } else {
      const [newUser] = await db.insert(users).values({}).returning({ id: users.id });
      if (!newUser) {
        res.status(500).json({ error: 'Failed to create user' });
        return;
      }
      userId = newUser.id;
      await db.insert(wallets).values({ userId, address: walletAddress, isPrimary: true });
    }

    // Resolve the device for this (userId, identityPublicKey) pair.
    // If the device is revoked, refuse sign-in immediately.
    let deviceId: string;
    const existingDevice = await db.query.devices.findFirst({
      where: and(eq(devices.userId, userId), eq(devices.identityPublicKey, identityPublicKey)),
    });

    if (existingDevice) {
      if (existingDevice.revokedAt) {
        // A revoked device still holding valid wallet credentials is the
        // single most interesting failed sign-in there is.
        void recordAuditEvent({
          action: 'auth_failed',
          ...requestContext(req),
          subjectUserId: userId,
          actorDeviceId: existingDevice.id,
          targetType: 'device',
          targetId: existingDevice.id,
          metadata: { reason: 'device_revoked' },
        });
        res.status(401).json({ error: 'Device has been revoked' });
        return;
      }
      deviceId = existingDevice.id;
      await db
        .update(devices)
        .set({
          lastSeenAt: new Date(),
          ...(deviceName ? { deviceName } : {}),
          ...(platform ? { platform } : {}),
          ...(registrationId !== undefined ? { registrationId } : {}),
          // A client re-verifying with a newer `capabilities` set is the
          // "upgrade" path (#180-follow-on) — no re-registration needed.
          ...(capabilities !== undefined ? { capabilities: normalizeCapabilities(capabilities) } : {}),
        })
        .where(eq(devices.id, deviceId));
    } else {
      const [newDevice] = await db
        .insert(devices)
        .values({
          userId,
          identityPublicKey,
          deviceName: deviceName ?? null,
          platform: platform ?? null,
          registrationId: registrationId ?? null,
          lastSeenAt: new Date(),
          ...(capabilities !== undefined ? { capabilities: normalizeCapabilities(capabilities) } : {}),
        })
        .returning({ id: devices.id });
      if (!newDevice) {
        res.status(500).json({ error: 'Failed to register device' });
        return;
      }
      deviceId = newDevice.id;
    }

    const token = signToken({ userId, walletAddress, deviceId });
    res.json({ token, deviceId });
  },
);
