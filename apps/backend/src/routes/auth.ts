import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, IRouter } from 'express';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { Keypair } from '@stellar/stellar-sdk';
import { db } from '../db/index.js';
import { users, wallets, devices } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { createNonce, consumeNonce } from '../lib/nonce.js';
import { signToken } from '../lib/jwt.js';
import { validate } from '../middleware/validate.js';
import {
  ChallengeSchema,
  VerifySchema,
  type ChallengeBody,
  type VerifyBody,
} from '../schemas/auth.schemas.js';

export const authRouter: IRouter = Router();

const rateLimitedResponse = { error: 'Too many requests' };

export const challengeLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: rateLimitedResponse,
});

export const verifyLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: rateLimitedResponse,
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
    // Signal capability is monotonic (#364): sign-in can raise it but never
    // clear it, so a downgraded client cannot walk the conversation back onto
    // the Phase-1 sealed box.
    const supportsSignal = device?.supportsSignal;

    // Validate and consume nonce
    const valid = consumeNonce(walletAddress, nonce);
    if (!valid) {
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
        res.status(401).json({ error: 'Signature verification failed' });
        return;
      }
    } catch {
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
          ...(supportsSignal === true ? { supportsSignal: true } : {}),
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
          supportsSignal: supportsSignal ?? false,
          lastSeenAt: new Date(),
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
