import { createHash } from 'node:crypto';
import { Router, type Router as RouterType } from 'express';
import { eq, and, or, ilike, exists, sql, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, wallets, devices, devicePrekeys, conversationMembers } from '../db/schema.js';
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

usersRouter.get('/search', async (req: AuthRequest, res) => {
  const raw = req.query['q'];
  const q = typeof raw === 'string' ? raw.trim() : '';

  if (!q) {
    res.status(400).json({ error: 'Query parameter "q" is required' });
    return;
  }

  // Escape LIKE wildcards so user input is treated literally in the prefix match.
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

    // Check Redis for active WS connections first.
    if (redis) {
      const online = await isOnline(redis, id);
      if (online) {
        res.json({ online: true });
        return;
      }
    }

    // Fall back to device-based presence from devices.lastSeenAt.
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
 * X3DH prekey bundle (issue #110/#305): identity key + signed prekey + one
 * one-time prekey, atomically claimed so it is never handed out twice. Falls
 * back to a signed-prekey-only bundle once one-time prekeys are exhausted —
 * the initiator just runs 3-DH instead of 4-DH in that case. `:deviceId` must
 * belong to `:userId` — this route is the narrower, other-user-facing lookup;
 * callers checking their own devices use GET /devices instead.
 */
usersRouter.get(
  '/:userId/devices/:deviceId/key-bundle',
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

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Fetch all active (non-revoked) device identity public keys.
    const activeDevices = await db.query.devices.findMany({
      where: and(eq(devices.userId, id), isNull(devices.revokedAt)),
      columns: { identityPublicKey: true },
    });

    if (activeDevices.length === 0) {
      res.status(404).json({ error: 'No active devices found for this user' });
      return;
    }

    // Step 2: sort lexicographically.
    const sortedKeys = activeDevices
      .map((d) => d.identityPublicKey)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    // Step 3: concatenate with newline separator.
    const concatenated = sortedKeys.join('\n');

    // Step 4: SHA-256.
    const digest = createHash('sha256').update(concatenated, 'utf8').digest();

    // Steps 5 & 6: produce two 30-digit segments from the 32-byte digest.
    // Segment A: bytes 0–14 (15 bytes → 120 bits), reduce mod 10^30.
    // Segment B: bytes 15–29 (15 bytes), reduce mod 10^30.
    // (15 bytes gives well above the 30 decimal digits we need while keeping
    // overlap-free regions within 32 digest bytes.)
    function bytesToSafetySegment(buf: Buffer, offset: number, length: number): string {
      let value = BigInt(0);
      for (let i = 0; i < length; i++) {
        value = (value << BigInt(8)) | BigInt(buf[offset + i]!);
      }
      const mod = value % BigInt('1' + '0'.repeat(30));
      return mod.toString().padStart(30, '0');
    }

    const segmentA = bytesToSafetySegment(digest, 0, 15);
    const segmentB = bytesToSafetySegment(digest, 15, 15);
    const raw = segmentA + segmentB;

    // Format: 12 groups of 5 digits, space-separated (Signal convention).
    const formatted = raw.match(/.{5}/g)!.join(' ');

    res.json({
      userId: id,
      /**
       * Raw 60-digit numeric fingerprint.  Clients compare this string
       * after stripping spaces; the formatted version is for display.
       */
      fingerprint: raw,
      /**
       * Human-readable version in groups of 5, matching Signal's safety
       * number display format.
       */
      formatted,
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
    if (existing && existing.id !== userId) {
      res.status(409).json({ error: 'Username is already taken' });
      return;
    }

    updateData.username = username;
  }

  updateData.updatedAt = new Date();

  try {
    const oldUser = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { presenceVisible: true, lastSeenVisible: true },
    });

    const [updatedUser] = await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, userId))
      .returning();

    if (!updatedUser) {
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

    res.json(updatedUser);
  } catch {
    res.status(409).json({ error: 'Username conflict or database error' });
  }
});
