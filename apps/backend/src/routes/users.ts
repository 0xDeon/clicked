import { createHash } from 'node:crypto';
import { Router, type Router as RouterType } from 'express';
import { eq, and, or, ilike, exists, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, wallets, devices, conversationMembers } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { redis } from '../lib/redis.js';
import { isOnline, deriveDevicePresence } from '../services/presence.js';
import { getSocketServer } from '../lib/socket.js';

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

    // Check Redis for active WS connections first.
    if (redis) {
      const online = await isOnline(redis, id);
      if (online) {
        res.json({ online: true });
        return;
      }
    }

    // Fall back to device-based presence from user_devices.lastSeenAt.
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
      where: and(eq(devices.userId, id), eq(devices.isRevoked, false)),
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
  const { username, avatarUrl, presenceVisible } = req.body;

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
      columns: { presenceVisible: true },
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
              io.to(m.conversationId).emit('user_online', { userId });
              io.to(m.conversationId).emit('presence_update', { userId, online: true });
            } else {
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
