import { createHash } from 'node:crypto';
import { Router, type Router as RouterType } from 'express';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { eq, and, or, ilike, exists, sql, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, wallets, devices, devicePrekeys, conversationMembers } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { redis } from '../lib/redis.js';
import { isOnline, deriveDevicePresence } from '../services/presence.js';

export const usersRouter: RouterType = Router();

usersRouter.use(requireAuth);

const rateLimitedResponse = { error: 'Too many requests' };

/**
 * Limits key-bundle claims per authenticated caller and target device.
 * Ten requests per minute permits normal parallel session establishment while
 * making it impractical to drain a device's one-time prekey pool quickly.
 */
export const keyBundleLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (req) => {
    const callerId = (req as AuthRequest).auth?.userId ?? 'anonymous';
    const targetUserId = req.params['userId'] ?? 'unknown-user';
    const deviceId = req.params['deviceId'] ?? 'unknown-device';
    return `${callerId}:${targetUserId}:${deviceId}`;
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: rateLimitedResponse,
});

usersRouter.get('/search', async (req: AuthRequest, res) => {
  const raw = req.query['q'];
  const q = typeof raw === 'string' ? raw.trim() : '';

  if (!q) {
    res.status(400).json({ error: 'Query parameter "q" is required' });
    return;
  }

  const prefix = `${q.replace(/[\\%_]/g, '\\$&')}%`;

  try {
    const results = await db.query.users.findMany({
      where: or(
        ilike(users.username, prefix),
        exists(
          db
            .select({ one: sql`1` })
            .from(wallets)
            .where(and(eq(wallets.userId, users.id), eq(wallets.address, q))),
        ),
      ),
      columns: {
        id: true,
        username: true,
        avatarUrl: true,
      },
      with: {
        wallets: {
          columns: { address: true, isPrimary: true },
        },
      },
      limit: 10,
    });

    res.json(
      results.map((user) => ({
        id: user.id,
        username: user.username,
        avatarUrl: user.avatarUrl,
        primaryWalletAddress: user.wallets.find((w) => w.isPrimary)?.address ?? null,
      })),
    );
  } catch {
    res.status(500).json({ error: 'Search failed' });
  }
});

usersRouter.get('/me', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        username: true,
        avatarUrl: true,
        presenceVisible: true,
        createdAt: true,
      },
      with: {
        wallets: {
          columns: {
            address: true,
            isPrimary: true,
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      presenceVisible: user.presenceVisible,
      wallets: user.wallets.map((w) => ({
        address: w.address,
        isPrimary: w.isPrimary,
      })),
      createdAt: user.createdAt,
    });
  } catch {
    res.status(404).json({ error: 'User not found' });
  }
});

usersRouter.get('/:id', async (req: AuthRequest, res) => {
  const id = req.params['id'] as string;

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, id),
      columns: {
        id: true,
        username: true,
        avatarUrl: true,
      },
      with: {
        wallets: {
          columns: {
            address: true,
            isPrimary: true,
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      wallets: user.wallets.map((w) => ({
        address: w.address,
        isPrimary: w.isPrimary,
      })),
    });
  } catch {
    res.status(404).json({ error: 'User not found' });
  }
});

usersRouter.get('/:id/presence', async (req: AuthRequest, res) => {
  const id = req.params['id'] as string;
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, id),
      columns: { presenceVisible: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (!user.presenceVisible) {
      res.json({ online: 'unknown' });
      return;
    }

    if (redis) {
      const online = await isOnline(redis, id);
      if (online) {
        res.json({ online: true });
        return;
      }
    }

    try {
      const { online, lastSeen } = await deriveDevicePresence(id);
      res.json({ online, ...(lastSeen ? { lastSeen } : {}) });
    } catch {
      res.json({ online: false });
    }
  } catch {
    res.status(404).json({ error: 'User not found' });
  }
});

/**
 * GET /users/:userId/devices/:deviceId/key-bundle
 *
 * Returns an X3DH prekey bundle and atomically claims at most one one-time
 * prekey. Falls back to a signed-prekey-only bundle when OTPs are exhausted.
 */
usersRouter.get(
  '/:userId/devices/:deviceId/key-bundle',
  keyBundleLimiter,
  async (req: AuthRequest, res) => {
    const targetUserId = req.params['userId'] as string;
    const deviceId = req.params['deviceId'] as string;

    const device = await db.query.devices.findFirst({
      where: eq(devices.id, deviceId),
    });

    if (!device || device.userId !== targetUserId || device.revokedAt) {
      res.status(404).json({ error: 'Device not found or has been revoked' });
      return;
    }

    const signedPreKey = await db.query.devicePrekeys.findFirst({
      where: and(eq(devicePrekeys.deviceId, deviceId), eq(devicePrekeys.keyType, 'signed')),
    });

    if (!signedPreKey) {
      res.status(409).json({ error: 'Device has not uploaded a signed prekey yet' });
      return;
    }

    const claimedOneTimePreKey = await db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({
          id: devicePrekeys.id,
          keyId: devicePrekeys.keyId,
          publicKey: devicePrekeys.publicKey,
        })
        .from(devicePrekeys)
        .where(
          and(
            eq(devicePrekeys.deviceId, deviceId),
            eq(devicePrekeys.keyType, 'one_time'),
            eq(devicePrekeys.consumed, false),
          ),
        )
        .orderBy(devicePrekeys.createdAt)
        .limit(1)
        .for('update', { skipLocked: true });

      if (!candidate) return null;

      await tx
        .update(devicePrekeys)
        .set({ consumed: true })
        .where(eq(devicePrekeys.id, candidate.id));

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
  },
);

usersRouter.get('/:id/key-fingerprint', async (req: AuthRequest, res) => {
  const userId = req.params['id'] as string;

  try {
    const rows = await db.query.devices.findMany({
      where: and(eq(devices.userId, userId), isNull(devices.revokedAt)),
      columns: { identityPublicKey: true },
    });

    if (rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const material = rows
      .map((row) => row.identityPublicKey)
      .sort()
      .join('\n');
    const fingerprint = createHash('sha256').update(material).digest('hex');

    res.json({ userId, fingerprint });
  } catch {
    res.status(404).json({ error: 'User not found' });
  }
});
