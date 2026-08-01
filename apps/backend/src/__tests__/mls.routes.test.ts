/**
 * Tests for the MLS group routes (#372) under /conversations/:id/mls/*.
 *
 * The group-state service is mocked here so these cases stay focused on the
 * HTTP contract: authorisation, request validation, status codes and the
 * socket events a commit fans out. The service's own transaction behaviour is
 * covered in mlsGroups.service.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockMemberFindFirst = vi.fn();
const mockMemberFindMany = vi.fn();
const mockConversationFindFirst = vi.fn();
const mockDeviceFindMany = vi.fn();
const mockTransaction = vi.fn();
const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));

const mockGetGroupByConversation = vi.fn();
const mockGetEpochWindow = vi.fn();
const mockIsActiveMember = vi.fn();
const mockListDevicesAwaitingJoin = vi.fn();
const mockRecordCommit = vi.fn();
const mockListCommitsSince = vi.fn();
const mockClaimWelcome = vi.fn();
const mockPendingWelcomeEpoch = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockMemberFindFirst, findMany: mockMemberFindMany },
      conversations: { findFirst: mockConversationFindFirst },
      devices: { findMany: mockDeviceFindMany },
    },
    transaction: mockTransaction,
    insert: vi.fn(),
    update: vi.fn(),
    select: vi.fn(),
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: { conversationId: 'conversationId', userId: 'userId' },
  conversations: { id: 'id' },
  devices: { id: 'id', userId: 'userId', revokedAt: 'revokedAt' },
  mlsGroups: { id: 'id', currentEpoch: 'currentEpoch' },
  mlsGroupMembers: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  inArray: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('../lib/socket.js', () => ({ getSocketServer: vi.fn(() => ({ to: mockTo })) }));
vi.mock('../services/roomManager.js', () => ({
  conversationRoom: (id: string) => `room:conversation:${id}`,
}));
vi.mock('../services/deliveryPipeline.js', () => ({
  deviceRoom: (id: string) => `room:device:${id}`,
}));

vi.mock('../services/mlsGroups.js', () => ({
  MLS_COMMIT_PAGE_SIZE: 200,
  MLS_MAX_COMMIT_MEMBER_CHANGES: 100,
  getGroupByConversation: mockGetGroupByConversation,
  getEpochWindow: mockGetEpochWindow,
  isActiveMember: mockIsActiveMember,
  listDevicesAwaitingJoin: mockListDevicesAwaitingJoin,
  recordCommit: mockRecordCommit,
  listCommitsSince: mockListCommitsSince,
  claimWelcome: mockClaimWelcome,
  pendingWelcomeEpoch: mockPendingWelcomeEpoch,
}));

const USER_ID = 'user-1';
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = 'conv-1';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string; deviceId: string } }).auth = {
      userId: USER_ID,
      deviceId: DEVICE_ID,
    };
    next();
  },
}));

const { mlsRouter } = await import('../routes/mls.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/conversations', mlsRouter);
  return app;
}

/** Base64 stand-in for an opaque MLS wire-format blob. */
const BLOB = Buffer.alloc(64, 'x').toString('base64');

const GROUP = {
  id: 'mls-group-1',
  conversationId: CONVERSATION_ID,
  groupId: BLOB,
  cipherSuite: 1,
  currentEpoch: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTo.mockReturnValue({ emit: mockEmit });
  mockMemberFindFirst.mockResolvedValue({ id: 'membership-1' });
  mockGetGroupByConversation.mockResolvedValue(GROUP);
  mockPendingWelcomeEpoch.mockResolvedValue(null);
});

// ── Shared authorisation behaviour ────────────────────────────────────────────

describe('MLS routes: authorisation', () => {
  it('returns 403 on every route when the caller is not a conversation member', async () => {
    mockMemberFindFirst.mockResolvedValue(undefined);

    const app = makeApp();
    const responses = await Promise.all([
      request(app).get(`/conversations/${CONVERSATION_ID}/mls/group`),
      request(app).get(`/conversations/${CONVERSATION_ID}/mls/pending-devices`),
      request(app).get(`/conversations/${CONVERSATION_ID}/mls/commits`),
      request(app).get(`/conversations/${CONVERSATION_ID}/mls/welcome`),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(403);
    }
  });

  it('returns 404 when the conversation has no MLS group', async () => {
    mockGetGroupByConversation.mockResolvedValue(null);

    const res = await request(makeApp()).get(`/conversations/${CONVERSATION_ID}/mls/group`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no MLS group/i);
  });
});

// ── Group initialisation ──────────────────────────────────────────────────────

describe('POST /conversations/:id/mls/group', () => {
  const body = { groupId: BLOB, cipherSuite: 1 };

  it('seats the founding device at epoch 0', async () => {
    mockGetGroupByConversation.mockResolvedValue(null);
    mockConversationFindFirst.mockResolvedValue({ type: 'group' });

    const memberValues = vi.fn().mockResolvedValue(undefined);
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'mls-group-1', currentEpoch: 0 }]),
          }),
        })
        .mockReturnValueOnce({ values: memberValues }),
    };
    mockTransaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));

    const res = await request(makeApp())
      .post(`/conversations/${CONVERSATION_ID}/mls/group`)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ groupId: BLOB, cipherSuite: 1, currentEpoch: 0 });
    expect(memberValues).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: DEVICE_ID, userId: USER_ID, joinedAtEpoch: 0 }),
    );
  });

  it('returns 409 when the conversation already has a group', async () => {
    const res = await request(makeApp())
      .post(`/conversations/${CONVERSATION_ID}/mls/group`)
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.currentEpoch).toBe(4);
  });

  it('refuses to create a group for a DM', async () => {
    mockGetGroupByConversation.mockResolvedValue(null);
    mockConversationFindFirst.mockResolvedValue({ type: 'dm' });

    const res = await request(makeApp())
      .post(`/conversations/${CONVERSATION_ID}/mls/group`)
      .send(body);

    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects a groupId that is not base64', async () => {
    mockGetGroupByConversation.mockResolvedValue(null);

    const res = await request(makeApp())
      .post(`/conversations/${CONVERSATION_ID}/mls/group`)
      .send({ groupId: 'not base64!', cipherSuite: 1 });

    expect(res.status).toBe(400);
  });
});

// ── Group state ───────────────────────────────────────────────────────────────

describe('GET /conversations/:id/mls/group', () => {
  it('reports the device epoch window and where its readable history starts', async () => {
    mockGetEpochWindow.mockResolvedValue({ joinedAtEpoch: 3, removedAtEpoch: null });

    const res = await request(makeApp()).get(`/conversations/${CONVERSATION_ID}/mls/group`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      groupId: BLOB,
      cipherSuite: 1,
      currentEpoch: 4,
      membership: { joinedAtEpoch: 3, removedAtEpoch: null, active: true },
      historyAvailableFromEpoch: 3,
    });
  });

  it('reports a null membership and a pending Welcome for a device awaiting join', async () => {
    mockGetEpochWindow.mockResolvedValue(null);
    mockPendingWelcomeEpoch.mockResolvedValue(5);

    const res = await request(makeApp()).get(`/conversations/${CONVERSATION_ID}/mls/group`);

    expect(res.status).toBe(200);
    expect(res.body.membership).toBeNull();
    expect(res.body.pendingWelcome).toEqual({ epoch: 5 });
    expect(res.body.historyAvailableFromEpoch).toBeNull();
  });

  it('reports a removed device as inactive', async () => {
    mockGetEpochWindow.mockResolvedValue({ joinedAtEpoch: 1, removedAtEpoch: 3 });

    const res = await request(makeApp()).get(`/conversations/${CONVERSATION_ID}/mls/group`);

    expect(res.body.membership).toEqual({ joinedAtEpoch: 1, removedAtEpoch: 3, active: false });
  });
});

// ── Devices awaiting join ─────────────────────────────────────────────────────

describe('GET /conversations/:id/mls/pending-devices', () => {
  it('lists member devices that hold no leaf yet', async () => {
    mockListDevicesAwaitingJoin.mockResolvedValue([
      { deviceId: OTHER_DEVICE_ID, userId: USER_ID, identityPublicKey: 'idk' },
    ]);

    const res = await request(makeApp()).get(
      `/conversations/${CONVERSATION_ID}/mls/pending-devices`,
    );

    expect(res.status).toBe(200);
    expect(res.body.currentEpoch).toBe(4);
    expect(res.body.devices).toEqual([
      { deviceId: OTHER_DEVICE_ID, userId: USER_ID, identityPublicKey: 'idk' },
    ]);
  });
});

// ── Commits ───────────────────────────────────────────────────────────────────

describe('POST /conversations/:id/mls/commits', () => {
  const url = `/conversations/${CONVERSATION_ID}/mls/commits`;

  beforeEach(() => {
    mockIsActiveMember.mockResolvedValue(true);
    mockMemberFindMany.mockResolvedValue([{ userId: USER_ID }]);
    mockDeviceFindMany.mockResolvedValue([{ id: OTHER_DEVICE_ID, userId: USER_ID }]);
    mockRecordCommit.mockResolvedValue({ ok: true, epoch: 5 });
  });

  it('refuses a commit from a device that holds no leaf', async () => {
    mockIsActiveMember.mockResolvedValue(false);

    const res = await request(makeApp()).post(url).send({ epoch: 5, commit: BLOB });

    expect(res.status).toBe(403);
    expect(mockRecordCommit).not.toHaveBeenCalled();
  });

  it('adds a device, records the Welcome and notifies both rooms', async () => {
    const res = await request(makeApp())
      .post(url)
      .send({
        epoch: 5,
        commit: BLOB,
        addedDevices: [{ deviceId: OTHER_DEVICE_ID, welcome: BLOB }],
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ epoch: 5, addedDeviceIds: [OTHER_DEVICE_ID] });

    expect(mockRecordCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        epoch: 5,
        committerDeviceId: DEVICE_ID,
        addedDevices: [{ deviceId: OTHER_DEVICE_ID, userId: USER_ID, welcome: BLOB }],
      }),
    );

    expect(mockTo).toHaveBeenCalledWith(`room:conversation:${CONVERSATION_ID}`);
    expect(mockEmit).toHaveBeenCalledWith('mls_commit', expect.objectContaining({ epoch: 5 }));
    expect(mockTo).toHaveBeenCalledWith(`room:device:${OTHER_DEVICE_ID}`);
    expect(mockEmit).toHaveBeenCalledWith(
      'mls_welcome_available',
      expect.objectContaining({ epoch: 5, conversationId: CONVERSATION_ID }),
    );
  });

  it('returns 409 with the epoch to rebase on when another commit won the race', async () => {
    mockRecordCommit.mockResolvedValue({ ok: false, reason: 'epoch_conflict', currentEpoch: 5 });

    const res = await request(makeApp()).post(url).send({ epoch: 5, commit: BLOB });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ currentEpoch: 5, expectedEpoch: 6 });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('rejects adding a device that belongs to a non-member', async () => {
    mockDeviceFindMany.mockResolvedValue([{ id: OTHER_DEVICE_ID, userId: 'outsider' }]);

    const res = await request(makeApp())
      .post(url)
      .send({
        epoch: 5,
        commit: BLOB,
        addedDevices: [{ deviceId: OTHER_DEVICE_ID, welcome: BLOB }],
      });

    expect(res.status).toBe(400);
    expect(res.body.invalidDeviceIds).toEqual([OTHER_DEVICE_ID]);
    expect(mockRecordCommit).not.toHaveBeenCalled();
  });

  it('rejects adding a device that does not exist or is revoked', async () => {
    mockDeviceFindMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .post(url)
      .send({
        epoch: 5,
        commit: BLOB,
        addedDevices: [{ deviceId: OTHER_DEVICE_ID, welcome: BLOB }],
      });

    expect(res.status).toBe(400);
    expect(mockRecordCommit).not.toHaveBeenCalled();
  });

  it('rejects a commit that both adds and removes the same device', async () => {
    const res = await request(makeApp())
      .post(url)
      .send({
        epoch: 5,
        commit: BLOB,
        addedDevices: [{ deviceId: OTHER_DEVICE_ID, welcome: BLOB }],
        removedDeviceIds: [OTHER_DEVICE_ID],
      });

    expect(res.status).toBe(400);
    expect(mockRecordCommit).not.toHaveBeenCalled();
  });

  it('rejects duplicate deviceIds in addedDevices', async () => {
    const res = await request(makeApp())
      .post(url)
      .send({
        epoch: 5,
        commit: BLOB,
        addedDevices: [
          { deviceId: OTHER_DEVICE_ID, welcome: BLOB },
          { deviceId: OTHER_DEVICE_ID, welcome: BLOB },
        ],
      });

    expect(res.status).toBe(400);
    expect(mockRecordCommit).not.toHaveBeenCalled();
  });

  it('passes removals through to the service', async () => {
    const res = await request(makeApp())
      .post(url)
      .send({ epoch: 5, commit: BLOB, removedDeviceIds: [OTHER_DEVICE_ID] });

    expect(res.status).toBe(201);
    expect(mockRecordCommit).toHaveBeenCalledWith(
      expect.objectContaining({ removedDeviceIds: [OTHER_DEVICE_ID] }),
    );
  });

  it('rejects epoch 0 — a commit always advances the group', async () => {
    const res = await request(makeApp()).post(url).send({ epoch: 0, commit: BLOB });

    expect(res.status).toBe(400);
  });
});

// ── Commit replay ─────────────────────────────────────────────────────────────

describe('GET /conversations/:id/mls/commits', () => {
  const url = `/conversations/${CONVERSATION_ID}/mls/commits`;

  it('returns 403 for a device that holds no leaf', async () => {
    mockGetEpochWindow.mockResolvedValue(null);

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(403);
  });

  it('defaults sinceEpoch to the device join epoch', async () => {
    mockGetEpochWindow.mockResolvedValue({ joinedAtEpoch: 3, removedAtEpoch: null });
    mockListCommitsSince.mockResolvedValue([{ epoch: 4, commit: BLOB, createdAt: new Date() }]);

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(200);
    expect(res.body.sinceEpoch).toBe(3);
    expect(mockListCommitsSince).toHaveBeenCalledWith('mls-group-1', 3, 200);
    expect(res.body.hasMore).toBe(false);
  });

  it('never replays behind the join epoch even when asked to', async () => {
    mockGetEpochWindow.mockResolvedValue({ joinedAtEpoch: 3, removedAtEpoch: null });
    mockListCommitsSince.mockResolvedValue([]);

    const res = await request(makeApp()).get(`${url}?sinceEpoch=0`);

    expect(res.body.sinceEpoch).toBe(3);
    expect(mockListCommitsSince).toHaveBeenCalledWith('mls-group-1', 3, 200);
  });

  it('reports hasMore when the page stops short of the current epoch', async () => {
    mockGetEpochWindow.mockResolvedValue({ joinedAtEpoch: 0, removedAtEpoch: null });
    mockListCommitsSince.mockResolvedValue([{ epoch: 2, commit: BLOB, createdAt: new Date() }]);

    const res = await request(makeApp()).get(`${url}?limit=1`);

    expect(res.body.hasMore).toBe(true);
    expect(mockListCommitsSince).toHaveBeenCalledWith('mls-group-1', 0, 1);
  });

  it('rejects a negative sinceEpoch', async () => {
    mockGetEpochWindow.mockResolvedValue({ joinedAtEpoch: 0, removedAtEpoch: null });

    const res = await request(makeApp()).get(`${url}?sinceEpoch=-1`);

    expect(res.status).toBe(400);
  });
});

// ── Welcome ───────────────────────────────────────────────────────────────────

describe('GET /conversations/:id/mls/welcome', () => {
  const url = `/conversations/${CONVERSATION_ID}/mls/welcome`;

  it('returns the Welcome together with the group parameters needed to import it', async () => {
    mockClaimWelcome.mockResolvedValue({ epoch: 5, welcome: BLOB });

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      groupId: BLOB,
      cipherSuite: 1,
      epoch: 5,
      welcome: BLOB,
      currentEpoch: 4,
    });
    expect(mockClaimWelcome).toHaveBeenCalledWith('mls-group-1', DEVICE_ID);
  });

  it('returns 404 when nothing is pending', async () => {
    mockClaimWelcome.mockResolvedValue(null);

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(404);
  });
});
