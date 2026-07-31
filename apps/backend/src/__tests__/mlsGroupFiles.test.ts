/**
 * Tests for group file sharing over MLS (#371).
 *
 * The model: the file is encrypted once, to a random file key, and that key is
 * distributed by putting it inside the MLS group message that references the
 * file. Every member derives the same key from group state, the server never
 * sees it, and a device removed from the group stops being able to fetch the
 * ciphertext for anything shared from the removal epoch on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockFileFindFirst = vi.fn();
const mockMessageFindMany = vi.fn();
const mockMemberFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockGetConversationEpochWindow = vi.fn();
const mockGetGroupByConversation = vi.fn();
const mockIsActiveMember = vi.fn();
const mockGeneratePresignedGet = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      files: { findFirst: mockFileFindFirst },
      messages: { findMany: mockMessageFindMany },
      conversationMembers: { findFirst: mockMemberFindFirst },
    },
    insert: mockInsert,
    update: vi.fn(),
  },
}));

vi.mock('../db/schema.js', () => ({
  files: { id: 'id' },
  messages: { fileId: 'fileId' },
  conversationMembers: { conversationId: 'conversationId', userId: 'userId' },
  fileStatusEnum: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
}));

vi.mock('../lib/storage.js', () => ({
  generatePresignedGet: mockGeneratePresignedGet,
  generatePresignedPut: vi.fn(async (key: string) => `https://storage.example.com/${key}`),
  generateStorageKey: vi.fn(() => 'uploads/conv-1/hash'),
}));

vi.mock('../services/mlsGroups.js', () => ({
  getConversationEpochWindow: mockGetConversationEpochWindow,
  getGroupByConversation: mockGetGroupByConversation,
  isActiveMember: mockIsActiveMember,
}));

const USER_ID = 'user-1';
const DEVICE_ID = 'device-1';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string; deviceId: string } }).auth = {
      userId: USER_ID,
      deviceId: DEVICE_ID,
    };
    next();
  },
}));

const { filesRouter } = await import('../routes/files.js');
const { uploadsRouter } = await import('../routes/uploads.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/files', filesRouter);
  app.use('/uploads', uploadsRouter);
  return app;
}

const READY_FILE = {
  id: 'file-1',
  storageKey: 'uploads/conv-1/hash',
  status: 'ready',
  deletedAt: null,
};

function groupMessage(mlsEpoch: number | null, conversationId = CONVERSATION_ID) {
  return { id: `msg-${mlsEpoch}`, conversationId, mlsEpoch };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFileFindFirst.mockResolvedValue(READY_FILE);
  mockMemberFindFirst.mockResolvedValue({ id: 'membership-1' });
  mockGeneratePresignedGet.mockResolvedValue('https://storage.example.com/signed');
});

// ── Download: single ciphertext, MLS-gated ────────────────────────────────────

describe('GET /files/:fileId — MLS group files', () => {
  const url = '/files/file-1';

  it('serves the one stored ciphertext to a member inside the epoch window', async () => {
    mockMessageFindMany.mockResolvedValue([groupMessage(7)]);
    mockGetConversationEpochWindow.mockResolvedValue({
      hasGroup: true,
      window: { joinedAtEpoch: 5, removedAtEpoch: null },
    });

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://storage.example.com/signed');
    expect(res.body.mlsEpoch).toBe(7);
    // One object in storage, shared by the whole group — not one per member.
    expect(mockGeneratePresignedGet).toHaveBeenCalledWith('uploads/conv-1/hash', 300);
  });

  it('serves the same storage key regardless of which member asks', async () => {
    mockMessageFindMany.mockResolvedValue([groupMessage(7)]);
    mockGetConversationEpochWindow.mockResolvedValue({
      hasGroup: true,
      window: { joinedAtEpoch: 0, removedAtEpoch: null },
    });

    await request(makeApp()).get(url);
    await request(makeApp()).get(url);

    const keys = mockGeneratePresignedGet.mock.calls.map((c) => c[0]);
    expect(new Set(keys).size).toBe(1);
  });

  it('denies a device removed from the group access to a later-epoch file', async () => {
    // Removed by the commit that produced epoch 6; the file was shared at 7.
    mockMessageFindMany.mockResolvedValue([groupMessage(7)]);
    mockGetConversationEpochWindow.mockResolvedValue({
      hasGroup: true,
      window: { joinedAtEpoch: 1, removedAtEpoch: 6 },
    });

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('mls_no_key_after_removal');
    expect(mockGeneratePresignedGet).not.toHaveBeenCalled();
  });

  it('still serves a file shared before the removal epoch', async () => {
    mockMessageFindMany.mockResolvedValue([groupMessage(5)]);
    mockGetConversationEpochWindow.mockResolvedValue({
      hasGroup: true,
      window: { joinedAtEpoch: 1, removedAtEpoch: 6 },
    });

    const res = await request(makeApp()).get(url);

    // The device already held that file key; withholding the ciphertext now
    // would be theatre, not forward secrecy.
    expect(res.status).toBe(200);
  });

  it('denies a device that joined after the file was shared', async () => {
    mockMessageFindMany.mockResolvedValue([groupMessage(2)]);
    mockGetConversationEpochWindow.mockResolvedValue({
      hasGroup: true,
      window: { joinedAtEpoch: 5, removedAtEpoch: null },
    });

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('mls_no_key_before_join');
  });

  it('denies a device that holds no leaf in the group', async () => {
    mockMessageFindMany.mockResolvedValue([groupMessage(2)]);
    mockGetConversationEpochWindow.mockResolvedValue({ hasGroup: true, window: null });

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('mls_not_a_group_member');
  });

  it('grants access when the file was re-shared into an epoch the device holds', async () => {
    // Originally shared at epoch 2, re-shared at 6 for members who joined later.
    mockMessageFindMany.mockResolvedValue([groupMessage(2), groupMessage(6)]);
    mockGetConversationEpochWindow.mockResolvedValue({
      hasGroup: true,
      window: { joinedAtEpoch: 5, removedAtEpoch: null },
    });

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(200);
    expect(res.body.mlsEpoch).toBe(6);
  });

  it('reports the reason from the original share when no reference is readable', async () => {
    mockMessageFindMany.mockResolvedValue([groupMessage(2), groupMessage(3)]);
    mockGetConversationEpochWindow.mockResolvedValue({
      hasGroup: true,
      window: { joinedAtEpoch: 9, removedAtEpoch: null },
    });

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('mls_no_key_before_join');
  });

  it('leaves non-MLS file sharing unchanged', async () => {
    mockMessageFindMany.mockResolvedValue([groupMessage(null)]);

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(200);
    expect(res.body.mlsEpoch).toBeNull();
    expect(mockGetConversationEpochWindow).not.toHaveBeenCalled();
  });

  it('does not apply the epoch gate when the file also has a non-MLS reference', async () => {
    mockMessageFindMany.mockResolvedValue([groupMessage(2), groupMessage(null)]);

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(200);
    expect(mockGetConversationEpochWindow).not.toHaveBeenCalled();
  });

  it('rejects a non-member before any MLS lookup happens', async () => {
    mockMessageFindMany.mockResolvedValue([groupMessage(7)]);
    mockMemberFindFirst.mockResolvedValue(undefined);

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Not authorized/i);
    expect(mockGetConversationEpochWindow).not.toHaveBeenCalled();
  });

  it('treats a null membership lookup as not-a-member', async () => {
    // Guards the membership filter against a driver that reports "no row" as
    // null rather than undefined — a truthiness slip here would hand a
    // non-member a download URL.
    mockMessageFindMany.mockResolvedValue([groupMessage(7)]);
    mockMemberFindFirst.mockResolvedValue(null);

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(403);
    expect(mockGeneratePresignedGet).not.toHaveBeenCalled();
  });

  it('returns 404 for a soft-deleted file', async () => {
    mockFileFindFirst.mockResolvedValue({ ...READY_FILE, deletedAt: new Date() });

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(404);
  });

  it('returns 404 when no message references the file', async () => {
    mockMessageFindMany.mockResolvedValue([]);

    const res = await request(makeApp()).get(url);

    expect(res.status).toBe(404);
  });

  it('never returns a file key — only the ciphertext location', async () => {
    mockMessageFindMany.mockResolvedValue([groupMessage(7)]);
    mockGetConversationEpochWindow.mockResolvedValue({
      hasGroup: true,
      window: { joinedAtEpoch: 0, removedAtEpoch: null },
    });

    const res = await request(makeApp()).get(url);

    expect(Object.keys(res.body).sort()).toEqual(['mlsEpoch', 'url']);
  });
});

// ── Upload ────────────────────────────────────────────────────────────────────

describe('POST /uploads — MLS group conversations', () => {
  const body = {
    conversationId: CONVERSATION_ID,
    size: 1024,
    mimeType: 'image/png',
    sha256: 'abc123',
  };

  beforeEach(() => {
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'file-1' }]),
      }),
    });
  });

  it('returns the current epoch so the client knows what to encrypt the key to', async () => {
    mockGetGroupByConversation.mockResolvedValue({ id: 'mls-group-1', currentEpoch: 7 });
    mockIsActiveMember.mockResolvedValue(true);

    const res = await request(makeApp()).post('/uploads').send(body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ fileId: 'file-1', mlsEpoch: 7 });
  });

  it('refuses a device that holds no leaf in the group', async () => {
    mockGetGroupByConversation.mockResolvedValue({ id: 'mls-group-1', currentEpoch: 7 });
    mockIsActiveMember.mockResolvedValue(false);

    const res = await request(makeApp()).post('/uploads').send(body);

    expect(res.status).toBe(403);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('reports a null epoch for a conversation with no MLS group', async () => {
    mockGetGroupByConversation.mockResolvedValue(null);

    const res = await request(makeApp()).post('/uploads').send(body);

    expect(res.status).toBe(201);
    expect(res.body.mlsEpoch).toBeNull();
    expect(mockIsActiveMember).not.toHaveBeenCalled();
  });
});
