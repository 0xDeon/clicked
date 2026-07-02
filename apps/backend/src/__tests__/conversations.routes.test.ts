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

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversations: { findFirst: mockFindConversation },
      conversationMembers: { findFirst: mockFindMember, findMany: mockFindMany },
    },
    delete: mockDelete,
    insert: mockInsert,
    update: mockUpdate,
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
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args.filter(Boolean)),
  asc: vi.fn(),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  ne: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'ne' })),
  desc: vi.fn(),
  lt: vi.fn(),
  sql: vi.fn(),
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

  it('adds a member to a group conversation and broadcasts member_joined', async () => {
    const joinedAt = new Date('2026-05-31T11:00:00.000Z');

    mockFindConversation.mockResolvedValue({ id: 'conv-1', type: 'group' });
    mockFindMember.mockResolvedValueOnce({ id: 'member-1' }).mockResolvedValueOnce(undefined);
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
    });
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
  });
});
