import { Router } from 'express';
import type { IRouter } from 'express';
import { asc, and, count, desc, eq, inArray, lt, sql, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  conversationMembers,
  conversations,
  messages,
  tokenTransfers,
  messageEnvelopes,
  userDevices,
} from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { redis, CONV_CACHE_TTL, convCacheKey } from '../lib/redis.js';
import { invalidateConversationCaches } from '../lib/conversationCache.js';
import { serializeMessage } from '../lib/messages.js';
import { getSocketServer } from '../lib/socket.js';
import { MAX_MESSAGES_LIMIT, DEFAULT_MESSAGES_LIMIT } from '../constants.js';

export const conversationsRouter: IRouter = Router();

conversationsRouter.use(requireAuth);

const getConversationRelations = (deviceId: string) => ({
  members: {
    with: {
      user: {
        columns: { id: true, username: true, avatarUrl: true },
        with: { wallets: { columns: { address: true, isPrimary: true } } },
      },
    },
  },
  messages: {
    orderBy: desc(messages.createdAt),
    limit: 1,
    with: {
      sender: { columns: { id: true, username: true, avatarUrl: true } },
      envelopes: {
        where: eq(messageEnvelopes.recipientDeviceId, deviceId),
        limit: 1,
      },
    },
  },
});

type ConversationPayload = {
  messages?: Array<ReturnType<typeof serializeMessage>>;
  [key: string]: unknown;
};

function serializeConversation<T extends ConversationPayload>(conversation: T): T {
  return {
    ...conversation,
    messages: (conversation.messages ?? []).map((message) =>
      serializeMessage(message as any),
    ) as any,
  };
}

type ConversationMemberPayload = {
  joinedAt: Date;
  user: {
    id: string;
    username: string | null;
    avatarUrl: string | null;
    wallets: Array<{ address: string; isPrimary: boolean }>;
  };
};

function serializeConversationMember(member: ConversationMemberPayload) {
  return {
    id: member.user.id,
    username: member.user.username,
    avatarUrl: member.user.avatarUrl,
    primaryWalletAddress:
      member.user.wallets.find((wallet) => wallet.isPrimary)?.address ??
      member.user.wallets[0]?.address ??
      null,
    joinedAt: member.joinedAt,
  };
}

// List all conversations the authenticated user belongs to
// Pass ?archived=true to include archived conversations
conversationsRouter.get('/', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const showArchived = req.query['archived'] === 'true';
  const key = convCacheKey(userId);

  // Cache read — skip when requesting archived (different result set)
  if (!showArchived && redis) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        res.json(JSON.parse(cached) as unknown);
        return;
      }
    } catch {
      // Fall through to DB on Redis error
    }
  }

  const memberships = (await db.query.conversationMembers.findMany({
    where: and(
      eq(conversationMembers.userId, userId),
      showArchived ? undefined : ne(conversationMembers.isArchived, true),
    ),
    with: {
      conversation: getConversationRelations(req.auth!.deviceId) as never,
    },
  })) as unknown as Array<{
    conversationId: string;
    isMuted: boolean;
    isArchived: boolean;
    conversation: ConversationPayload;
  }>;

  // Single subquery for message counts — no N+1
  const conversationIds = memberships.map((m) => m.conversationId);
  const countRows =
    conversationIds.length > 0
      ? await db
          .select({ conversationId: messages.conversationId, count: count() })
          .from(messages)
          .where(
            sql`${messages.conversationId} = ANY(ARRAY[${sql.join(
              conversationIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}])`,
          )
          .groupBy(messages.conversationId)
      : [];

  const countMap = new Map(countRows.map((r) => [r.conversationId, r.count]));

  // Unread count per conversation: messages after the member's lastReadMessageId.
  // Returns 0 when lastReadMessageId is NULL (no read position established yet).
  const unreadRows: Array<{ conversationId: string; unreadCount: number }> =
    conversationIds.length > 0
      ? [
          ...(await db.execute<{ conversationId: string; unreadCount: number }>(sql`
            SELECT
              cm.conversation_id AS "conversationId",
              CASE
                WHEN cm.last_read_message_id IS NULL THEN 0
                ELSE (
                  SELECT COUNT(*)::int
                  FROM messages m2
                  WHERE m2.conversation_id = cm.conversation_id
                    AND m2.deleted_at IS NULL
                    AND m2.created_at > lrm.created_at
                )
              END AS "unreadCount"
            FROM conversation_members cm
            LEFT JOIN messages lrm ON lrm.id = cm.last_read_message_id
            WHERE cm.user_id = ${userId}::uuid
              AND cm.conversation_id = ANY(ARRAY[${sql.join(
                conversationIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )}])
          `)),
        ]
      : [];

  const unreadMap = new Map(unreadRows.map((r) => [r.conversationId, r.unreadCount]));

  const result = memberships.map((m) => ({
    ...m.conversation,
    isMuted: m.isMuted,
    isArchived: m.isArchived,
    messageCount: countMap.get(m.conversationId) ?? 0,
    unreadCount: unreadMap.get(m.conversationId) ?? 0,
  }));

  // Cache write with 30-second TTL (only for default non-archived view)
  if (!showArchived && redis) {
    try {
      await redis.setex(key, CONV_CACHE_TTL, JSON.stringify(result));
    } catch {
      // Ignore — response is already computed
    }
  }

  res.json(result);
});

conversationsRouter.get('/:id', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const conversationId = req.params['id'] as string | undefined;

  if (!conversationId) {
    res.status(400).json({ error: 'Conversation id is required' });
    return;
  }

  const conversation = (await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    with: getConversationRelations(req.auth!.deviceId) as never,
  })) as ConversationPayload | undefined;

  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  res.json(serializeConversation(conversation));
});

conversationsRouter.get('/:id/members', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const conversationId = req.params['id'] as string | undefined;

  if (!conversationId) {
    res.status(400).json({ error: 'Conversation id is required' });
    return;
  }

  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  const members = (await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.conversationId, conversationId),
    orderBy: asc(conversationMembers.joinedAt),
    columns: {
      joinedAt: true,
    },
    with: {
      user: {
        columns: { id: true, username: true, avatarUrl: true },
        with: {
          wallets: { columns: { address: true, isPrimary: true } },
        },
      },
    },
  })) as ConversationMemberPayload[];

  res.json({ members: members.map(serializeConversationMember) });
});

conversationsRouter.post('/:id/members', async (req: AuthRequest, res) => {
  const requesterId = req.auth!.userId;
  const conversationId = req.params['id'] as string | undefined;
  const newUserId = typeof req.body.userId === 'string' ? req.body.userId : undefined;

  if (!conversationId) {
    res.status(400).json({ error: 'Conversation id is required' });
    return;
  }

  if (!newUserId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { id: true, type: true },
  });

  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  if (conversation.type === 'dm') {
    res.status(400).json({ error: 'DM conversations cannot add members' });
    return;
  }

  const requesterMembership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, requesterId),
    ),
  });

  if (!requesterMembership) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  const existingMembership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, newUserId),
    ),
  });

  if (existingMembership) {
    res.status(409).json({ error: 'User is already a member' });
    return;
  }

  try {
    const [newMembership] = await db
      .insert(conversationMembers)
      .values({ conversationId, userId: newUserId })
      .returning();

    if (!newMembership) {
      res.status(500).json({ error: 'Failed to add conversation member' });
      return;
    }

    const members = await db.query.conversationMembers.findMany({
      where: eq(conversationMembers.conversationId, conversationId),
      columns: { userId: true },
    });

    await invalidateConversationCaches(members.map((member) => member.userId));

    getSocketServer()?.to(conversationId).emit('member_joined', {
      userId: newUserId,
      conversationId,
    });

    res.status(201).json({
      id: newMembership.id,
      conversationId: newMembership.conversationId,
      userId: newMembership.userId,
      joinedAt: newMembership.joinedAt,
    });
  } catch {
    res.status(409).json({ error: 'Database conflict or validation error' });
  }
});

// PATCH /conversations/:id — Update group conversation name/avatar. Only members can update.
conversationsRouter.patch('/:id', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const conversationId = req.params['id'] as string | undefined;

  if (!conversationId) {
    res.status(400).json({ error: 'Conversation id is required' });
    return;
  }

  const { name, avatarUrl } = req.body as { name?: string; avatarUrl?: string };

  if (name === undefined && avatarUrl === undefined) {
    res.status(400).json({ error: 'At least one of name or avatarUrl must be provided' });
    return;
  }

  if (name !== undefined && typeof name !== 'string') {
    res.status(400).json({ error: 'name must be a string' });
    return;
  }

  if (avatarUrl !== undefined && typeof avatarUrl !== 'string') {
    res.status(400).json({ error: 'avatarUrl must be a string' });
    return;
  }

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { id: true, type: true },
  });

  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  if (conversation.type === 'dm') {
    res.status(400).json({ error: 'DM conversations cannot be updated' });
    return;
  }

  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  const updateData: { name?: string; avatarUrl?: string } = {};
  if (name !== undefined) updateData.name = name;
  if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl;

  try {
    const [updated] = await db
      .update(conversations)
      .set(updateData)
      .where(eq(conversations.id, conversationId))
      .returning();

    if (!updated) {
      res.status(500).json({ error: 'Failed to update conversation' });
      return;
    }

    const members = await db.query.conversationMembers.findMany({
      where: eq(conversationMembers.conversationId, conversationId),
      columns: { userId: true },
    });

    await invalidateConversationCaches(members.map((member) => member.userId));

    getSocketServer()?.to(conversationId).emit('conversation_updated', {
      id: updated.id,
      type: updated.type,
      name: updated.name,
      avatarUrl: updated.avatarUrl,
      createdAt: updated.createdAt,
    });

    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Failed to update conversation' });
  }
});

// #14 — GET /conversations/:id/messages
// Cursor-based pagination via ?before=<messageId>&limit=<n> (max 50).
// Returns messages in ascending order with a `nextCursor` field.
conversationsRouter.get('/:id/messages', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const conversationId = req.params['id'] as string | undefined;

  if (!conversationId) {
    res.status(400).json({ error: 'Conversation id is required' });
    return;
  }

  // Parse & clamp limit
  const rawLimit = parseInt(req.query['limit'] as string, 10);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_MESSAGES_LIMIT)
      : DEFAULT_MESSAGES_LIMIT;

  const before = typeof req.query['before'] === 'string' ? req.query['before'] : undefined;

  // Membership check — non-members receive 403
  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  // Resolve cursor: look up the `createdAt` of the "before" message
  let cursor: Date | undefined;
  if (before) {
    const ref = await db.query.messages.findFirst({
      where: eq(messages.id, before),
    });
    if (!ref) {
      res.status(400).json({ error: 'Invalid cursor' });
      return;
    }
    cursor = ref.createdAt;
  }

  // Fetch one extra to determine whether there is a next page
  const rows = await db.query.messages.findMany({
    where: cursor
      ? and(eq(messages.conversationId, conversationId), lt(messages.createdAt, cursor))
      : eq(messages.conversationId, conversationId),
    orderBy: desc(messages.createdAt),
    limit: limit + 1,
    with: {
      sender: { columns: { id: true, username: true, avatarUrl: true } },
      envelopes: {
        where: eq(messageEnvelopes.recipientDeviceId, req.auth!.deviceId),
        limit: 1,
      },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Return in ascending (oldest-first) order
  page.reverse();

  const nextCursor = hasMore ? (page[0]?.id ?? null) : null;

  res.json({ messages: page, nextCursor });
});

conversationsRouter.get('/:id/search', async (req: AuthRequest, res) => {
  res.status(410).json({ 
    error: 'Server-side search removed; search is now client-side over decrypted messages',
    docs: 'https://github.com/DripWave/clicked/blob/main/docs/message-encryption-migration.md'
  });
});

// PATCH /conversations/:id/settings — update muted/archived state for the authenticated user
conversationsRouter.patch('/:id/settings', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const conversationId = req.params['id'] as string | undefined;

  if (!conversationId) {
    res.status(400).json({ error: 'Conversation id is required' });
    return;
  }

  const { muted, archived } = req.body as { muted?: boolean; archived?: boolean };

  if (muted === undefined && archived === undefined) {
    res.status(400).json({ error: 'At least one of muted or archived is required' });
    return;
  }

  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  const updates: Partial<{ isMuted: boolean; isArchived: boolean }> = {};
  if (muted !== undefined) updates.isMuted = muted;
  if (archived !== undefined) updates.isArchived = archived;

  const [updated] = await db
    .update(conversationMembers)
    .set(updates)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
    .returning();

  // Invalidate conversation list cache for this user
  if (redis) {
    try {
      await redis.del(convCacheKey(userId));
    } catch {
      // Ignore
    }
  }

  res.json({ isMuted: updated!.isMuted, isArchived: updated!.isArchived });
});

// Save a token transfer for a conversation
conversationsRouter.post('/:id/transfers', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const conversationId = req.params['id'] as string | undefined;

  if (!conversationId) {
    res.status(400).json({ error: 'Conversation id is required' });
    return;
  }

  // Check membership
  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  const recipientAddress = req.body.recipient_address ?? req.body.recipientAddress;
  const amount = req.body.amount;
  const tokenContractId = req.body.token_contract_id ?? req.body.tokenContractId;
  const txHash = req.body.tx_hash ?? req.body.txHash;
  const memo = req.body.memo;

  if (!recipientAddress || amount === undefined || !tokenContractId || !txHash) {
    res
      .status(400)
      .json({ error: 'recipientAddress, amount, tokenContractId, and txHash are required' });
    return;
  }

  // Check for duplicate txHash
  const existing = await db.query.tokenTransfers.findFirst({
    where: eq(tokenTransfers.txHash, txHash),
  });

  if (existing) {
    res.status(409).json({ error: 'Transaction hash already exists' });
    return;
  }

  try {
    const [newTransfer] = await db
      .insert(tokenTransfers)
      .values({
        conversationId,
        senderId: userId,
        recipientAddress,
        amount: String(amount),
        tokenContractId,
        txHash,
        memo: memo ?? null,
      })
      .returning();

    res.status(201).json(newTransfer);
  } catch {
    res.status(409).json({ error: 'Database conflict or validation error' });
  }
});

// List token transfers for a conversation
conversationsRouter.get('/:id/transfers', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const conversationId = req.params['id'] as string | undefined;

  if (!conversationId) {
    res.status(400).json({ error: 'Conversation id is required' });
    return;
  }

  // Check membership
  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  try {
    const transfers = await db.query.tokenTransfers.findMany({
      where: eq(tokenTransfers.conversationId, conversationId),
      orderBy: desc(tokenTransfers.createdAt),
    });

    res.json(transfers);
  } catch {
    res.status(500).json({ error: 'Failed to retrieve transfers' });
  }
});

conversationsRouter.delete('/:id/leave', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const conversationId = req.params['id'] as string | undefined;

  if (!conversationId) {
    res.status(400).json({ error: 'Conversation id is required' });
    return;
  }

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { id: true, type: true },
  });

  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  if (conversation.type === 'dm') {
    res.status(400).json({ error: 'DM conversations cannot be left' });
    return;
  }

  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    res.status(404).json({ error: 'Conversation membership not found' });
    return;
  }

  const members = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.conversationId, conversationId),
    columns: { userId: true },
  });

  if (members.length === 1) {
    await db.delete(conversations).where(eq(conversations.id, conversationId));
  } else {
    await db
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      );
  }

  await invalidateConversationCaches(members.map((member) => member.userId));

  res.status(204).send();
});

// ── GET /conversations/:id/devices ─────────────────────────────────────────────
// Returns the full active (non-revoked) device set for all members of a
// conversation.  The web client calls this before encrypting a message so it
// can build one envelope per device (#134 / #138).
//
// Raises 409 device_set_mismatch if the server-side snapshot has changed since
// the caller last fetched (checked via the optional `deviceSetHash` query param).
conversationsRouter.get('/:id/devices', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const conversationId = req.params['id'] as string | undefined;

  if (!conversationId) {
    res.status(400).json({ error: 'Conversation id is required' });
    return;
  }

  // Membership check
  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  // Collect all member user IDs
  const memberRows = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.conversationId, conversationId),
    columns: { userId: true },
  });

  const userIds = memberRows.map((m) => m.userId);

  if (userIds.length === 0) {
    res.json({ devices: [] });
    return;
  }

  // Fetch all active (non-revoked) devices for every member
  const deviceRows = await db.query.userDevices.findMany({
    where: and(
      inArray(userDevices.userId, userIds),
      // revokedAt IS NULL → active devices only
      sql`${userDevices.revokedAt} IS NULL`,
    ),
    columns: {
      id: true,
      userId: true,
      identityPublicKey: true,
      deviceName: true,
      platform: true,
    },
  });

  res.json({
    devices: deviceRows.map((d) => ({
      id: d.id,
      userId: d.userId,
      identityPublicKey: d.identityPublicKey,
      deviceName: d.deviceName,
      platform: d.platform,
    })),
  });
});

