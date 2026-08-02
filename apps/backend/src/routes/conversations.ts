import { Router } from 'express';
import type { IRouter } from 'express';
import {
  asc,
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  notInArray,
  or,
  sql,
  ne,
} from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  conversationMembers,
  conversations,
  messages,
  tokenTransfers,
  messageEnvelopes,
  devices,
  users,
} from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { redis, CONV_CACHE_TTL, convCacheKey } from '../lib/redis.js';
import { invalidateConversationCaches } from '../lib/conversationCache.js';
import { serializeMessage, type MessageLike } from '../lib/messages.js';
import { getSocketServer } from '../lib/socket.js';
import { MAX_MESSAGES_LIMIT, DEFAULT_MESSAGES_LIMIT } from '../constants.js';
import { applyMlsVisibility } from '../lib/mlsVisibility.js';
import { getConversationEpochWindow } from '../services/mlsGroups.js';
import { checkGroupInviteLimit } from '../services/rateLimit.js';
import { actorFromRequest, recordAuditEvent } from '../services/auditLog.js';

export const conversationsRouter: IRouter = Router();

conversationsRouter.use(requireAuth);

// Post-schema-overhaul audit (see PR description): every relation name below
// (`members`, `user`, `wallets`, `messages`, `sender`, `envelopes`) was
// checked against the current `relations()` declarations in db/schema.ts and
// every selected column against the current table definitions — none
// reference dropped columns/relations. The `as never` casts at the call
// sites below exist only because TS can't correlate this function's return
// type with drizzle's recursive `with:` generic when it's built dynamically
// (a known drizzle limitation, not a sign the shape is unverified); the
// `ConversationPayload`/`ConversationMemberPayload` types the results are
// cast to afterward are what's actually checked against the query shape.
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

type ConversationPayload = Conversation & {
  messages?: MessageLike[];
  members?: unknown[]; // from relation
};

type SerializedConversationPayload = {
  messages?: Array<ReturnType<typeof serializeMessage>>;
  [key: string]: unknown;
};

function serializeConversation(conversation: ConversationPayload): SerializedConversationPayload {
  return {
    id: conversation.id,
    type: conversation.type,
    name: conversation.name,
    avatarUrl: conversation.avatarUrl,
    createdAt: conversation.createdAt,
    messages: (conversation.messages ?? []).map(serializeMessage),
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
    ...serializeConversation(m.conversation),
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

  // #378: throttle group-invite spam (10 invites per user per hour by default)
  const inviteCheck = await checkGroupInviteLimit(redis, requesterId);
  if (!inviteCheck.allowed) {
    res.status(429).json({ error: 'Too many group invites. Please try again later.' });
    return;
  }

  const targetUser = await db.query.users.findFirst({
    where: eq(users.id, newUserId),
    columns: { allowGroupInvites: true },
  });

  if (targetUser && !targetUser.allowGroupInvites) {
    res.status(403).json({ error: 'User is not accepting group invites' });
    return;
  }

  try {
    // The membership row and its group-control event are written together
    // (#369). A member committed without the epoch bump that announces them
    // would leave every other client unaware of someone who can now decrypt —
    // exactly the divergence the control log exists to prevent.
    const result = await db.transaction(async (tx) => {
      const [newMembership] = await tx
        .insert(conversationMembers)
        .values({ conversationId, userId: newUserId })
        .returning();

      if (!newMembership) {
        return null;
      }

      const appended = await appendGroupControlEvent(
        {
          conversationId,
          eventType: 'member_added',
          actorUserId: requesterId,
          targetUserId: newUserId,
        },
        tx,
      );

      return { newMembership, appended };
    });

    if (!result) {
      res.status(500).json({ error: 'Failed to add conversation member' });
      return;
    }

    const { newMembership, appended } = result;

    const members = await db.query.conversationMembers.findMany({
      where: eq(conversationMembers.conversationId, conversationId),
      columns: { userId: true },
    });

    await invalidateConversationCaches(members.map((member) => member.userId));

    getSocketServer()?.to(conversationId).emit('member_joined', {
      userId: newUserId,
      conversationId,
    });

    // Fanned out only once the transaction has committed, so a client that
    // reacts to the event always finds the member already present.
    broadcastGroupControlEvent(appended);
    // Group membership defines who can decrypt what from here on, so the
    // change is a security event for both parties: the requester who made it
    // and the account that was added (#376).
    void recordAuditEvent({
      action: 'group_member_added',
      ...actorFromRequest(req),
      subjectUserId: newUserId,
      targetType: 'conversation',
      targetId: conversationId,
      metadata: { memberCount: members.length },
    });

    res.status(201).json({
      id: newMembership.id,
      conversationId: newMembership.conversationId,
      userId: newMembership.userId,
      joinedAt: newMembership.joinedAt,
      epoch: appended.event.epoch,
      sequence: appended.event.sequence,
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

  // #340 — Resolve each edit chain to its newest version server-side.
  // Editing a message inserts a *new* row whose `editsMessageId` points back
  // at the row it replaces (see `messages.editsMessageId` in db/schema.ts),
  // so a chain of edits is a backward-linked list: newest -> ... -> original.
  // The set of every id referenced by some other row's `editsMessageId` is
  // exactly the set of "superseded" (non-latest) versions — excluding them
  // collapses any chain, however long, down to just its tip in one extra
  // query, with no recursive CTE needed. Older versions are left in the
  // table untouched; they're just excluded from this default list response.
  const supersededRows = await db
    .select({ id: messages.editsMessageId })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), isNotNull(messages.editsMessageId)));
  const supersededIds = supersededRows
    .map((row) => row.id)
    .filter((id): id is string => id !== null);

  // Resolve cursor: look up the `(createdAt, id)` of the "before" message.
  // `id` breaks ties for same-millisecond inserts — createdAt alone can
  // silently skip or duplicate rows across pages under concurrent writes.
  let cursor: { createdAt: Date; id: string } | undefined;
  if (before) {
    const ref = await db.query.messages.findFirst({
      where: eq(messages.id, before),
      columns: { createdAt: true, id: true },
    });
    if (!ref) {
      res.status(400).json({ error: 'Invalid cursor' });
      return;
    }
    cursor = ref;
  }

  const conversationScope = and(
    eq(messages.conversationId, conversationId),
    cursor
      ? or(
          lt(messages.createdAt, cursor.createdAt),
          and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id)),
        )
      : undefined,
    // Only apply the NOT IN filter when there's something to exclude —
    // an empty array here is a no-op in Postgres/drizzle, but skipping it
    // entirely avoids relying on that edge-case behavior.
    supersededIds.length > 0 ? notInArray(messages.id, supersededIds) : undefined,
  );

  // Fetch one extra to determine whether there is a next page
  const rows = await db.query.messages.findMany({
    where: conversationScope,
    orderBy: [desc(messages.createdAt), desc(messages.id)],
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

  // #372 — MLS group messages from epochs outside this device's membership
  // window are returned as placeholders rather than as ciphertext the device
  // is guaranteed to fail on. Non-MLS conversations skip the lookup entirely.
  const { hasGroup, window } = await getConversationEpochWindow(conversationId, req.auth!.deviceId);

  const visible = hasGroup ? page.map((message) => applyMlsVisibility(message, window)) : page;

  res.json({ messages: visible, nextCursor });
});

conversationsRouter.get('/:id/search', async (req: AuthRequest, res) => {
  res.status(410).json({
    error: 'Server-side search removed; search is now client-side over decrypted messages',
    docs: 'https://github.com/DripWave/clicked/blob/main/docs/message-encryption-migration.md',
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

  const isLastMember = members.length === 1;

  if (isLastMember) {
    // The conversation row — and with it the whole control log — goes away,
    // so there is nobody left to reconcile and nothing to reconcile against.
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await invalidateConversationCaches(members.map((member) => member.userId));
    res.status(204).send();
    return;
  }

  // Departure and its epoch bump commit together, so remaining members can
  // never observe a membership set that no control event accounts for (#369).
  const appended = await db.transaction(async (tx) => {
    await tx
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      );

    return appendGroupControlEvent(
      {
        conversationId,
        eventType: 'member_left',
        actorUserId: userId,
        targetUserId: userId,
      },
      tx,
    );
  });

  await invalidateConversationCaches(members.map((member) => member.userId));

  broadcastGroupControlEvent(appended);
  void recordAuditEvent({
    action: 'group_member_removed',
    ...actorFromRequest(req),
    subjectUserId: userId,
    targetType: 'conversation',
    targetId: conversationId,
    metadata: {
      // Leaving as the last member deletes the conversation outright, which
      // is a materially different outcome to a departure.
      conversationDeleted: members.length === 1,
      memberCountBefore: members.length,
    },
  });

  res.status(204).send();
});

// ── Group control log (#369) ─────────────────────────────────────────────────
//
// The ordered sequence of everything that changed group membership or the
// epoch. A client that missed commits — offline, or reconnected mid-change —
// replays from its last applied sequence and converges on the current epoch.

// GET /conversations/:id/epoch — cheap "am I behind?" check.
conversationsRouter.get('/:id/epoch', async (req: AuthRequest, res) => {
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

  const state = await getGroupState(conversationId);

  if (!state) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  res.json({ conversationId, ...state });
});

// GET /conversations/:id/group-control?sinceSequence=&limit=
// Ordered, gap-free catch-up. `sinceSequence` is exclusive, so replaying with
// the same cursor never re-applies an event the client already has.
conversationsRouter.get('/:id/group-control', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const conversationId = req.params['id'] as string | undefined;

  if (!conversationId) {
    res.status(400).json({ error: 'Conversation id is required' });
    return;
  }

  const rawSince = req.query['sinceSequence'];
  const sinceSequence = rawSince === undefined ? 0 : Number.parseInt(String(rawSince), 10);

  if (!Number.isFinite(sinceSequence) || sinceSequence < 0) {
    res.status(400).json({ error: 'sinceSequence must be a non-negative integer' });
    return;
  }

  const rawLimit = Number.parseInt(req.query['limit'] as string, 10);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_GROUP_CONTROL_PAGE_SIZE)
      : DEFAULT_GROUP_CONTROL_PAGE_SIZE;

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

  const state = await getGroupState(conversationId);

  if (!state) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const { events, hasMore } = await readGroupControlEvents({
    conversationId,
    sinceSequence,
    limit,
  });

  const lastSequence = events[events.length - 1]?.sequence ?? sinceSequence;

  res.json({
    conversationId,
    // Where the group is now, so a client knows whether this page finished
    // the catch-up even before it looks at `hasMore`.
    currentEpoch: state.epoch,
    latestSequence: state.latestSequence,
    events: events.map(serializeGroupControlEvent),
    // Feed straight back as `sinceSequence` for the next page.
    nextSequence: lastSequence,
    hasMore,
  });
});

// POST /conversations/:id/group-control — submit an MLS commit for sequencing.
// The payload is opaque: the server orders group control, it does not
// interpret it.
conversationsRouter.post('/:id/group-control', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const conversationId = req.params['id'] as string | undefined;

  if (!conversationId) {
    res.status(400).json({ error: 'Conversation id is required' });
    return;
  }

  const { payload } = req.body as { payload?: unknown };

  if (typeof payload !== 'string' || payload.length === 0) {
    res.status(400).json({ error: 'payload must be a non-empty string' });
    return;
  }

  if (Buffer.byteLength(payload, 'utf8') > MAX_GROUP_CONTROL_PAYLOAD_BYTES) {
    res.status(413).json({
      error: `payload exceeds ${MAX_GROUP_CONTROL_PAYLOAD_BYTES} bytes`,
    });
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

  try {
    const appended = await appendGroupControlEvent({
      conversationId,
      eventType: 'commit',
      actorUserId: userId,
      payload,
    });
    broadcastGroupControlEvent(appended);

    res.status(201).json(serializeGroupControlEvent(appended.event));
  } catch {
    res.status(500).json({ error: 'Failed to append group control event' });
  }
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
  const deviceRows = await db.query.devices.findMany({
    where: and(
      inArray(devices.userId, userIds),
      // revokedAt IS NULL → active devices only
      sql`${devices.revokedAt} IS NULL`,
    ),
    columns: {
      id: true,
      userId: true,
      identityPublicKey: true,
      deviceName: true,
      platform: true,
      capabilities: true,
    },
  });

  // Look up the caller's own device capabilities so each returned device can
  // carry the protocol the sender should actually use with it (#180-follow-
  // on) — sparing every client from re-implementing selectProtocol().
  const callerDevice = await db.query.devices.findFirst({
    where: eq(devices.id, req.auth!.deviceId),
    columns: { capabilities: true },
  });

  res.json({
    devices: deviceRows.map((d) => ({
      id: d.id,
      userId: d.userId,
      identityPublicKey: d.identityPublicKey,
      deviceName: d.deviceName,
      platform: d.platform,
      capabilities: normalizeCapabilities(d.capabilities),
      negotiatedProtocol: selectProtocol(callerDevice?.capabilities, d.capabilities).protocol,
    })),
  });
});
