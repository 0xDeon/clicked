import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const conversationsTable = { id: 'id', type: 'type' };
const conversationMembersTable = {
  conversationId: 'conversationId',
  userId: 'userId',
  joinedAt: 'joinedAt',
};

const mockFindConversation = vi.fn();
const mockFindMember = vi.fn();
const mockFindMany = vi.fn();
const mockFindUser = vi.fn();
const mockDelete = vi.fn();
const mockReturning = vi.fn();
const mockValues = vi.fn(() => ({ returning: mockReturning }));
const mockInsert = vi.fn(() => ({ values: mockValues }));
const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
const mockUpdateReturning = vi.fn();
const mockUpdateWhere = vi.fn(() => ({ returning: mockUpdateReturning }));
const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));

vi.mock('../lib/socket.js', () => ({
  getSocketServer: () => ({ to: mockTo }),
}));

vi.mock('../lib/redis.js', () => ({
  get redis() {
    return null;
  },
  CONV_CACHE_TTL: 30,
  convCacheKey: (userId: string) => `conversations:${userId}`,
}));

const mockGroupBy = vi.fn().mockResolvedValue([]);
const mockWhere = vi.fn(() => ({ groupBy: mockGroupBy }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockExecute = vi.fn().mockResolvedValue([]);

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversations: { findFirst: mockFindConversation },
      conversationMembers: { findFirst: mockFindMember, findMany: mockFindMany },
      users: { findFirst: mockFindUser },
    },
    delete: mockDelete,
    insert: mockInsert,
    update: mockUpdate,
    select: mockSelect,
    execute: mockExecute,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversations: conversationsTable,
  conversationMembers: conversationMembersTable,
  messages: {
    id: 'id',
    conversationId: 'conversationId',
    senderId: 'senderId',
    ciphertext: 'ciphertext',
    createdAt: 'createdAt',
    deletedAt: 'deletedAt',
  },
  messageEnvelopes: { recipientDeviceId: 'recipientDeviceId' },
  tokenTransfers: {},
  devices: {},
  users: {},
}));

const sqlJoinMock = vi.fn();
const sqlMock = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(sqlMock as any).join = sqlJoinMock;

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args.filter(Boolean)),
  asc: vi.fn(),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  ne: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'ne' })),
  desc: vi.fn(),
  lt: vi.fn(),
  sql: sqlMock,
  count: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string; deviceId: string } }).auth = {
      userId: 'user-1',
      deviceId: 'device-1',
    };
    next();
  },
}));

const { conversationsRouter } = await import('../routes/conversations.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/conversations', conversationsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, so restate the group-control default
  // rather than letting one test's mockResolvedValue leak into the next.
  mockAppendGroupControlEvent.mockResolvedValue({
    event: { conversationId: 'conv-1', epoch: 1, sequence: 1, eventType: 'member_added' },
    systemMessage: null,
  });
});

describe('GET /conversations', () => {
  it('does not leak unserialized relation fields', async () => {
    const conversation = {
      id: 'conv-1',
      type: 'group',
      name: 'General',
      avatarUrl: null,
      createdAt: new Date().toISOString(),
      // This is the field that should not be leaked
      members: [
        {
          id: 'member-1',
          conversationId: 'conv-1',
          userId: 'user-1',
          user: {
            id: 'user-1',
            username: 'alice',
            avatarUrl: null,
            wallets: [],
          },
        },
      ],
      messages: [
        {
          id: 'msg-1',
          conversationId: 'conv-1',
          senderId: 'user-1',
          ciphertext: 'encrypted-hello',
          deletedAt: null,
          sender: {
            id: 'user-1',
            username: 'alice',
            avatarUrl: null,
          },
        },
      ],
    };

    // Mock the database response for the main query
    mockFindMany.mockResolvedValue([
      {
        conversationId: 'conv-1',
        isMuted: false,
        isArchived: false,
        conversation: conversation,
      },
    ]);

    const res = await request(makeApp()).get('/conversations');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const conv = res.body[0];
    expect(conv.id).toBe('conv-1');
    expect(conv.messages).toHaveLength(1);

    // Assert that the unserialized `members` field is not present
    expect(conv.members).toBeUndefined();

    const message = conv.messages[0];
    expect(message.ciphertext).toBe('encrypted-hello');
  });
});

describe('GET /conversations/:id', () => {
  it('returns 404 for an unknown conversation', async () => {
    mockFindConversation.mockResolvedValue(undefined);

    const res = await request(makeApp()).get('/conversations/conv-1');

    expect(res.status).toBe(404);
    expect(mockFindMember).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not a member', async () => {
    mockFindConversation.mockResolvedValue({
      id: 'conv-1',
      type: 'group',
      members: [],
      messages: [],
    });
    mockFindMember.mockResolvedValue(undefined);

    const res = await request(makeApp()).get('/conversations/conv-1');

    expect(res.status).toBe(403);
  });

  it('returns the same conversation shape as the list endpoint', async () => {
    const conversation = {
      id: 'conv-1',
      type: 'group',
      name: 'General',
      members: [
        {
          id: 'member-1',
          conversationId: 'conv-1',
          userId: 'user-1',
          user: {
            id: 'user-1',
            username: 'alice',
            avatarUrl: null,
            wallets: [],
          },
        },
      ],
      messages: [
        {
          id: 'msg-1',
          conversationId: 'conv-1',
          senderId: 'user-1',
          ciphertext: 'hello',
          deletedAt: null,
          sender: {
            id: 'user-1',
            username: 'alice',
            avatarUrl: null,
          },
        },
      ],
    };

    mockFindConversation.mockResolvedValue(conversation);
    mockFindMember.mockResolvedValue({ id: 'member-1' });

    const res = await request(makeApp()).get('/conversations/conv-1');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('conv-1');
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].ciphertext).toBe('hello');
  });
});

describe('GET /conversations/:id/members', () => {
  it('returns 403 when the caller is not a member', async () => {
    mockFindMember.mockResolvedValue(undefined);

    const res = await request(makeApp()).get('/conversations/conv-1/members');

    expect(res.status).toBe(403);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('returns conversation members with primary wallet addresses and joinedAt', async () => {
    const joinedAt = new Date('2026-05-31T10:00:00.000Z');

    mockFindMember.mockResolvedValue({ id: 'member-1' });
    mockFindMany.mockResolvedValue([
      {
        joinedAt,
        user: {
          id: 'user-1',
          username: 'alice',
          avatarUrl: null,
          wallets: [
            { address: 'GSECONDARY', isPrimary: false },
            { address: 'GPRIMARY', isPrimary: true },
          ],
        },
      },
      {
        joinedAt,
        user: {
          id: 'user-2',
          username: 'bob',
          avatarUrl: 'https://example.com/bob.png',
          wallets: [],
        },
      },
    ]);

    const res = await request(makeApp()).get('/conversations/conv-1/members');

    expect(res.status).toBe(200);
    expect(res.body.members).toEqual([
      {
        id: 'user-1',
        username: 'alice',
        avatarUrl: null,
        primaryWalletAddress: 'GPRIMARY',
        joinedAt: joinedAt.toISOString(),
      },
      {
        id: 'user-2',
        username: 'bob',
        avatarUrl: 'https://example.com/bob.png',
        primaryWalletAddress: null,
        joinedAt: joinedAt.toISOString(),
      },
    ]);
  });
});

describe('POST /conversations/:id/members', () => {
  it('returns 400 for DM conversations', async () => {
    mockFindConversation.mockResolvedValue({ id: 'conv-dm', type: 'dm' });

    const res = await request(makeApp())
      .post('/conversations/conv-dm/members')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not a member', async () => {
    mockFindConversation.mockResolvedValue({ id: 'conv-1', type: 'group' });
    mockFindMember.mockResolvedValue(undefined);

    const res = await request(makeApp())
      .post('/conversations/conv-1/members')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(403);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 409 when the user is already a member', async () => {
    mockFindConversation.mockResolvedValue({ id: 'conv-1', type: 'group' });
    mockFindMember
      .mockResolvedValueOnce({ id: 'member-1' })
      .mockResolvedValueOnce({ id: 'member-2' });

    const res = await request(makeApp())
      .post('/conversations/conv-1/members')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(409);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 403 when the target user is not accepting group invites', async () => {
    mockFindConversation.mockResolvedValue({ id: 'conv-1', type: 'group' });
    mockFindMember.mockResolvedValueOnce({ id: 'member-1' }).mockResolvedValueOnce(undefined);
    mockFindUser.mockResolvedValue({ allowGroupInvites: false });

    const res = await request(makeApp())
      .post('/conversations/conv-1/members')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'User is not accepting group invites' });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('adds a member to a group conversation and broadcasts member_joined', async () => {
    const joinedAt = new Date('2026-05-31T11:00:00.000Z');

    mockFindConversation.mockResolvedValue({ id: 'conv-1', type: 'group' });
    mockFindMember.mockResolvedValueOnce({ id: 'member-1' }).mockResolvedValueOnce(undefined);
    mockFindUser.mockResolvedValue({ allowGroupInvites: true });
    mockReturning.mockResolvedValue([
      {
        id: 'member-2',
        conversationId: 'conv-1',
        userId: 'user-2',
        joinedAt,
      },
    ]);
    mockFindMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }]);

    const res = await request(makeApp())
      .post('/conversations/conv-1/members')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(201);
    expect(mockInsert).toHaveBeenCalledWith(conversationMembersTable);
    expect(mockValues).toHaveBeenCalledWith({ conversationId: 'conv-1', userId: 'user-2' });
    expect(mockTo).toHaveBeenCalledWith('conv-1');
    expect(mockEmit).toHaveBeenCalledWith('member_joined', {
      userId: 'user-2',
      conversationId: 'conv-1',
    });
    expect(res.body).toEqual({
      id: 'member-2',
      conversationId: 'conv-1',
      userId: 'user-2',
      joinedAt: joinedAt.toISOString(),
      // The join is sequenced, so the caller learns the new epoch (#369).
      epoch: 1,
      sequence: 1,
    });
    expect(mockAppendGroupControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        eventType: 'member_added',
        actorUserId: 'user-1',
        targetUserId: 'user-2',
      }),
      expect.anything(),
    );
    expect(mockBroadcastGroupControlEvent).toHaveBeenCalled();
  });
});

describe('PATCH /conversations/:id', () => {
  it('returns 400 for DM conversations', async () => {
    mockFindConversation.mockResolvedValue({ id: 'conv-dm', type: 'dm' });

    const res = await request(makeApp()).patch('/conversations/conv-dm').send({ name: 'New Name' });

    expect(res.status).toBe(400);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not a member', async () => {
    mockFindConversation.mockResolvedValue({ id: 'conv-1', type: 'group' });
    mockFindMember.mockResolvedValue(undefined);

    const res = await request(makeApp()).patch('/conversations/conv-1').send({ name: 'New Name' });

    expect(res.status).toBe(403);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('returns 400 when neither name nor avatarUrl is provided', async () => {
    const res = await request(makeApp()).patch('/conversations/conv-1').send({});

    expect(res.status).toBe(400);
  });

  it('updates the conversation name and broadcasts conversation_updated', async () => {
    const updatedConv = {
      id: 'conv-1',
      type: 'group',
      name: 'New Name',
      avatarUrl: null,
      createdAt: new Date('2026-05-31T10:00:00.000Z'),
    };

    mockFindConversation.mockResolvedValue({ id: 'conv-1', type: 'group' });
    mockFindMember.mockResolvedValue({ id: 'member-1' });
    mockUpdateReturning.mockResolvedValue([updatedConv]);
    mockFindMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }]);

    const res = await request(makeApp()).patch('/conversations/conv-1').send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalled();
    expect(mockUpdateWhere).toHaveBeenCalled();
    expect(mockTo).toHaveBeenCalledWith('conv-1');
    expect(mockEmit).toHaveBeenCalledWith('conversation_updated', {
      id: updatedConv.id,
      type: updatedConv.type,
      name: updatedConv.name,
      avatarUrl: updatedConv.avatarUrl,
      createdAt: updatedConv.createdAt,
    });
    expect(res.body).toEqual({
      id: updatedConv.id,
      type: updatedConv.type,
      name: updatedConv.name,
      avatarUrl: updatedConv.avatarUrl,
      createdAt: updatedConv.createdAt.toISOString(),
    });
  });

  it('updates the conversation avatarUrl and broadcasts conversation_updated', async () => {
    const updatedConv = {
      id: 'conv-1',
      type: 'group',
      name: 'General',
      avatarUrl: 'https://example.com/avatar.png',
      createdAt: new Date('2026-05-31T10:00:00.000Z'),
    };

    mockFindConversation.mockResolvedValue({ id: 'conv-1', type: 'group' });
    mockFindMember.mockResolvedValue({ id: 'member-1' });
    mockUpdateReturning.mockResolvedValue([updatedConv]);
    mockFindMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }]);

    const res = await request(makeApp())
      .patch('/conversations/conv-1')
      .send({ avatarUrl: 'https://example.com/avatar.png' });

    expect(res.status).toBe(200);
    expect(mockTo).toHaveBeenCalledWith('conv-1');
    expect(mockEmit).toHaveBeenCalledWith('conversation_updated', {
      id: updatedConv.id,
      type: updatedConv.type,
      name: updatedConv.name,
      avatarUrl: updatedConv.avatarUrl,
      createdAt: updatedConv.createdAt,
    });
    expect(res.body).toEqual({
      id: updatedConv.id,
      type: updatedConv.type,
      name: updatedConv.name,
      avatarUrl: updatedConv.avatarUrl,
      createdAt: updatedConv.createdAt.toISOString(),
    });
  });
});

describe('DELETE /conversations/:id/leave', () => {
  it('returns 400 for DM conversations', async () => {
    mockFindConversation.mockResolvedValue({ id: 'conv-dm', type: 'dm' });

    const res = await request(makeApp()).delete('/conversations/conv-dm/leave');

    expect(res.status).toBe(400);
  });

  it('returns 404 when the caller is not a member', async () => {
    mockFindConversation.mockResolvedValue({ id: 'conv-1', type: 'group' });
    mockFindMember.mockResolvedValue(undefined);

    const res = await request(makeApp()).delete('/conversations/conv-1/leave');

    expect(res.status).toBe(404);
  });

  it('deletes the conversation when the last member leaves', async () => {
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    mockDelete.mockReturnValue({ where: deleteWhere });
    mockFindConversation.mockResolvedValue({ id: 'conv-1', type: 'group' });
    mockFindMember.mockResolvedValue({ id: 'member-1' });
    mockFindMany.mockResolvedValue([{ userId: 'user-1' }]);

    const res = await request(makeApp()).delete('/conversations/conv-1/leave');

    expect(res.status).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith(conversationsTable);
  });

  it('removes only the caller when other members remain', async () => {
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    mockDelete.mockReturnValue({ where: deleteWhere });
    mockFindConversation.mockResolvedValue({ id: 'conv-1', type: 'group' });
    mockFindMember.mockResolvedValue({ id: 'member-1' });
    mockFindMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }]);

    const res = await request(makeApp()).delete('/conversations/conv-1/leave');

    expect(res.status).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith(conversationMembersTable);
    expect(deleteWhere).toHaveBeenCalled();
    expect(mockAppendGroupControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        eventType: 'member_left',
        actorUserId: 'user-1',
      }),
      expect.anything(),
    );
    expect(mockBroadcastGroupControlEvent).toHaveBeenCalled();
  });

  it('does not sequence an event when the conversation itself is deleted', async () => {
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    mockDelete.mockReturnValue({ where: deleteWhere });
    mockFindConversation.mockResolvedValue({ id: 'conv-1', type: 'group' });
    mockFindMember.mockResolvedValue({ id: 'member-1' });
    mockFindMany.mockResolvedValue([{ userId: 'user-1' }]);

    await request(makeApp()).delete('/conversations/conv-1/leave');

    // Nothing survives to reconcile against, so no epoch bump is recorded.
    expect(mockAppendGroupControlEvent).not.toHaveBeenCalled();
  });
});

// ── Group control endpoints (#369) ───────────────────────────────────────────

describe('GET /conversations/:id/epoch', () => {
  it('returns 403 for a non-member', async () => {
    mockFindMember.mockResolvedValue(undefined);

    const res = await request(makeApp()).get('/conversations/conv-1/epoch');

    expect(res.status).toBe(403);
  });

  it('reports the current epoch and latest sequence', async () => {
    mockFindMember.mockResolvedValue({ id: 'member-1' });
    mockGetGroupState.mockResolvedValue({ epoch: 4, latestSequence: 7 });

    const res = await request(makeApp()).get('/conversations/conv-1/epoch');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ conversationId: 'conv-1', epoch: 4, latestSequence: 7 });
  });

  it('returns 404 when the conversation is gone', async () => {
    mockFindMember.mockResolvedValue({ id: 'member-1' });
    mockGetGroupState.mockResolvedValue(null);

    const res = await request(makeApp()).get('/conversations/conv-1/epoch');

    expect(res.status).toBe(404);
  });
});

describe('GET /conversations/:id/group-control', () => {
  const events = [
    { id: 'evt-3', sequence: 3, epoch: 3, eventType: 'member_added' },
    { id: 'evt-4', sequence: 4, epoch: 4, eventType: 'commit' },
  ];

  it('returns 403 for a non-member', async () => {
    mockFindMember.mockResolvedValue(undefined);

    const res = await request(makeApp()).get('/conversations/conv-1/group-control');

    expect(res.status).toBe(403);
  });

  it('AC1 — returns the missed events in order with a cursor for the next page', async () => {
    mockFindMember.mockResolvedValue({ id: 'member-1' });
    mockGetGroupState.mockResolvedValue({ epoch: 5, latestSequence: 5 });
    mockReadGroupControlEvents.mockResolvedValue({ events, hasMore: true });

    const res = await request(makeApp()).get(
      '/conversations/conv-1/group-control?sinceSequence=2&limit=2',
    );

    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { sequence: number }) => e.sequence)).toEqual([3, 4]);
    expect(res.body.currentEpoch).toBe(5);
    expect(res.body.latestSequence).toBe(5);
    expect(res.body.nextSequence).toBe(4);
    expect(res.body.hasMore).toBe(true);
    expect(mockReadGroupControlEvents).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      sinceSequence: 2,
      limit: 2,
    });
  });

  it('keeps the cursor where it was when nothing new arrived', async () => {
    mockFindMember.mockResolvedValue({ id: 'member-1' });
    mockGetGroupState.mockResolvedValue({ epoch: 5, latestSequence: 5 });
    mockReadGroupControlEvents.mockResolvedValue({ events: [], hasMore: false });

    const res = await request(makeApp()).get('/conversations/conv-1/group-control?sinceSequence=5');

    expect(res.body.nextSequence).toBe(5);
    expect(res.body.hasMore).toBe(false);
  });

  it('rejects a negative or non-numeric cursor', async () => {
    mockFindMember.mockResolvedValue({ id: 'member-1' });

    for (const cursor of ['-1', 'abc']) {
      const res = await request(makeApp()).get(
        `/conversations/conv-1/group-control?sinceSequence=${cursor}`,
      );
      expect(res.status).toBe(400);
    }
  });
});

describe('POST /conversations/:id/group-control', () => {
  it('rejects a missing or empty payload', async () => {
    const res = await request(makeApp()).post('/conversations/conv-1/group-control').send({});

    expect(res.status).toBe(400);
  });

  it('rejects a payload beyond the size cap', async () => {
    const res = await request(makeApp())
      .post('/conversations/conv-1/group-control')
      .send({ payload: 'x'.repeat(65537) });

    expect(res.status).toBe(413);
  });

  it('returns 403 for a non-member', async () => {
    mockFindMember.mockResolvedValue(undefined);

    const res = await request(makeApp())
      .post('/conversations/conv-1/group-control')
      .send({ payload: 'opaque-commit' });

    expect(res.status).toBe(403);
  });

  it('sequences a member commit and broadcasts it', async () => {
    mockFindMember.mockResolvedValue({ id: 'member-1' });
    mockAppendGroupControlEvent.mockResolvedValue({
      event: { conversationId: 'conv-1', epoch: 6, sequence: 6, eventType: 'commit' },
      systemMessage: null,
    });

    const res = await request(makeApp())
      .post('/conversations/conv-1/group-control')
      .send({ payload: 'opaque-commit' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ epoch: 6, sequence: 6, eventType: 'commit' });
    expect(mockAppendGroupControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        eventType: 'commit',
        actorUserId: 'user-1',
        payload: 'opaque-commit',
      }),
    );
    expect(mockBroadcastGroupControlEvent).toHaveBeenCalled();
  });
});
