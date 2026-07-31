import { createHash } from 'node:crypto';
import { Router, type Router as RouterType } from 'express';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { eq, and, or, ilike, exists, sql, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, wallets, devices, devicePrekeys, conversationMembers, deviceKeyHistory } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { redis } from '../lib/redis.js';
import { isOnline, deriveDevicePresence } from '../services/presence.js';
import { getSocketServer } from '../lib/socket.js';
import { conversationRoom } from '../services/roomManager.js';
import { actorFromRequest, recordAuditEvent } from '../services/auditLog.js';
import { prekeyConsumedTotal } from '../lib/metrics.js';

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
        lastSeenVisible: true,
        sendReadReceipts: true,
        allowDirectMessages: true,
        allowGroupInvites: true,
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
      lastSeenVisible: user.lastSeenVisible,
      sendReadReceipts: user.sendReadReceipts,
      allowDirectMessages: user.allowDirectMessages,
      allowGroupInvites: user.allowGroupInvites,
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
      columns: { presenceVisible: true, lastSeenVisible: true },
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
      res.json({
        online,
        ...(user.lastSeenVisible && lastSeen ? { lastSeen } : {}),
      });
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
  // Two buckets guard the same endpoint (#375): the per-minute limit stops a
  // scraper enumerating device bundles, and the daily quota stops a slow drip
  // that never trips it from draining a victim's one-time prekeys — which
  // would silently downgrade every new session with that device from 4-DH to
  // 3-DH. Charged to the caller, not the target, so one abusive account cannot
  // deny service to everyone fetching that device.
  rateLimit(['key_bundle', 'key_bundle_daily']),
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

  // A one-time prekey was consumed and cannot be handed out again (#376).
  // Draining a device's supply forces every later session with it down from
  // 4-DH to 3-DH, and it happens quietly, so the count left is the signal an
  // incident responder actually needs. Subject is the device owner — the
  // account this was done *to* — while the actor is whoever fetched it.
  if (claimedOneTimePreKey) {
    // The remaining count is the useful part but only a nice-to-have: if the
    // count query fails, still record that a prekey was consumed rather than
    // losing the event, and never fail the bundle fetch over bookkeeping.
    let remaining: number | null = null;
    try {
      const [remainingRow] = await db
        .select({ remaining: sql<number>`count(*)::int` })
        .from(devicePrekeys)
        .where(
          and(
            eq(devicePrekeys.deviceId, deviceId),
            eq(devicePrekeys.keyType, 'one_time'),
            eq(devicePrekeys.consumed, false),
          ),
        );
      remaining = remainingRow?.remaining ?? 0;
    } catch {
      // Leave it null — the event itself is what must not be lost.
    }

    void recordAuditEvent({
      action: 'key_bundle_drained',
      ...actorFromRequest(req),
      subjectUserId: targetUserId,
      targetType: 'device',
      targetId: deviceId,
      metadata: { oneTimePreKeysRemaining: remaining, exhausted: remaining === 0 },
    });
  }

  res.json({
    deviceId: device.id,
    identityPublicKey: device.identityPublicKey,
    registrationId: device.registrationId,
    // Lets the initiating sender pick an encryption path this recipient
    // device supports before running X3DH (#180-follow-on).
    capabilities: normalizeCapabilities(device.capabilities),
    signedPreKey: {
      keyId: signedPreKey.keyId,
      publicKey: signedPreKey.publicKey,
      signature: signedPreKey.signature,
    },
    oneTimePreKey: claimedOneTimePreKey,
  });
});

/**
 * GET /users/:id/key-fingerprint
 *
 * Returns a 60-digit numeric safety number derived from the user's set of
 * active device identity public keys.  The derivation is deterministic and
 * identical on all clients:
 *
 *   1. Collect all non-revoked device identityPublicKey values for the user.
 *   2. Sort them lexicographically (UTF-8 byte order on the base64 strings).
 *   3. Concatenate them separated by a single newline (`\n`).
 *   4. Compute SHA-256 of the UTF-8-encoded concatenated string.
 *   5. Take the first 30 bytes of the digest and interpret them as a
 *      big-endian unsigned integer modulo 10^30, zero-padded to 30 digits.
 *   6. Repeat with bytes 16–31 and reduce modulo 10^30 to produce a second
 *      30-digit segment, then concatenate → 60 digits total.
 *      (This matches Signal's safety-number derivation: two independent
 *      30-digit numbers from non-overlapping digest halves, formatted in
 *      groups of 5 separated by spaces.)
 *
 * The final value is returned both as a raw 60-character digit string and as
 * the canonical "groups of 5" display format (12 groups of 5, space-separated).
 */
usersRouter.get('/:id/key-fingerprint', async (req: AuthRequest, res) => {
  const id = req.params['id'] as string;

  try {
    // Verify the target user exists.
    const user = await db.query.users.findFirst({
      where: eq(users.id, id),
      columns: { id: true },
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
  } catch {
    res.status(500).json({ error: 'Failed to compute key fingerprint' });
  }
});

usersRouter.patch('/me', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const {
    username,
    avatarUrl,
    presenceVisible,
    lastSeenVisible,
    sendReadReceipts,
    allowDirectMessages,
    allowGroupInvites,
  } = req.body;

  const updateData: Partial<typeof users.$inferInsert> = {};

  if (avatarUrl !== undefined) {
    updateData.avatarUrl = avatarUrl;
  }

  if (presenceVisible !== undefined) {
    if (typeof presenceVisible !== 'boolean') {
      res.status(400).json({ error: 'presenceVisible must be a boolean' });
      return;
    }
    updateData.presenceVisible = presenceVisible;
  }

  if (lastSeenVisible !== undefined) {
    if (typeof lastSeenVisible !== 'boolean') {
      res.status(400).json({ error: 'lastSeenVisible must be a boolean' });
      return;
    }
    updateData.lastSeenVisible = lastSeenVisible;
  }

  if (sendReadReceipts !== undefined) {
    if (typeof sendReadReceipts !== 'boolean') {
      res.status(400).json({ error: 'sendReadReceipts must be a boolean' });
      return;
    }
    updateData.sendReadReceipts = sendReadReceipts;
  }

  if (allowDirectMessages !== undefined) {
    if (typeof allowDirectMessages !== 'boolean') {
      res.status(400).json({ error: 'allowDirectMessages must be a boolean' });
      return;
    }
    updateData.allowDirectMessages = allowDirectMessages;
  }

  if (allowGroupInvites !== undefined) {
    if (typeof allowGroupInvites !== 'boolean') {
      res.status(400).json({ error: 'allowGroupInvites must be a boolean' });
      return;
    }
    updateData.allowGroupInvites = allowGroupInvites;
  }

  if (username !== undefined) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      res
        .status(400)
        .json({ error: 'Username must be 3-30 alphanumeric characters and underscores only' });
      return;
    }

    // Check conflict
    const existing = await db.query.users.findFirst({
      where: eq(users.username, username),
    });
  },
);

usersRouter.get('/:id/key-fingerprint', async (req: AuthRequest, res) => {
  const userId = req.params['id'] as string;

  try {
    const oldUser = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { presenceVisible: true, lastSeenVisible: true },
    });

    if (rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (presenceVisible !== undefined && oldUser && presenceVisible !== oldUser.presenceVisible) {
      const io = getSocketServer();
      if (io && redis) {
        const memberships = await db.query.conversationMembers.findMany({
          where: eq(conversationMembers.userId, userId),
          columns: { conversationId: true },
        });
        const online = await isOnline(redis, userId);
        if (online) {
          for (const m of memberships) {
            if (presenceVisible) {
              io.to(conversationRoom(m.conversationId)).emit('user_online', { userId });
              io.to(conversationRoom(m.conversationId)).emit('presence_update', {
                userId,
                online: true,
                ...(updatedUser.lastSeenVisible ? { lastSeen: Date.now() } : {}),
              });
              // Also emit to direct conversation room for backward compatibility
              io.to(m.conversationId).emit('user_online', { userId });
              io.to(m.conversationId).emit('presence_update', {
                userId,
                online: true,
                ...(updatedUser.lastSeenVisible ? { lastSeen: Date.now() } : {}),
              });
            } else {
              io.to(conversationRoom(m.conversationId)).emit('user_offline', { userId });
              io.to(conversationRoom(m.conversationId)).emit('presence_update', {
                userId,
                online: false,
              });
              // Also emit to direct conversation room for backward compatibility
              io.to(m.conversationId).emit('user_offline', { userId });
              io.to(m.conversationId).emit('presence_update', { userId, online: false });
            }
          }
        }
      }
    }

    res.json({ userId, fingerprint });
  } catch {
    res.status(404).json({ error: 'User not found' });
  }
});

// ── GET /users/:id/key-history (#379) ─────────────────────────────────────────
// Returns the append-only device-key-change log for any user so that clients
// can detect silent key swaps and display safety-number warnings.
usersRouter.get('/:id/key-history', async (req: AuthRequest, res) => {
  const targetUserId = req.params['id'];

  if (!targetUserId) {
    res.status(400).json({ error: 'User id is required' });
    return;
  }

  const target = await db.query.users.findFirst({
    where: eq(users.id, targetUserId),
    columns: { id: true },
  });

  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const history = await db.query.deviceKeyHistory.findMany({
    where: eq(deviceKeyHistory.userId, targetUserId),
    orderBy: [asc(deviceKeyHistory.recordedAt)],
    columns: {
      id: true,
      deviceId: true,
      previousKey: true,
      newKey: true,
      changeReason: true,
      recordedAt: true,
    },
  });

  res.json({ userId: targetUserId, keyHistory: history });
});
