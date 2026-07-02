/**
 * Tests for POST /uploads — presigned upload slot (issue #226)
 * and client-encrypted thumbnail handling (issue #230).
 *
 * The server:
 *  - Validates size/MIME limits before issuing a slot.
 *  - Inserts a `files` row with status `pending`.
 *  - Returns { fileId, uploadUrl }.
 *  - Never reads or generates previews from uploaded bytes.
 *  - Confirms a file (pending → ready) via POST /uploads/:id/confirm.
 *  - Thumbnails are separate `files` rows with isThumbnail=true.
 *  - Missing/optional thumbnail is handled gracefully.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockMemberFindFirst = vi.fn();
const mockFileFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockMemberFindFirst },
      files: { findFirst: mockFileFindFirst },
    },
    insert: mockInsert,
    update: mockUpdate,
  },
}));

vi.mock('../db/schema.js', () => ({
  files: { id: 'id' },
  conversationMembers: {},
  fileStatusEnum: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

vi.mock('../lib/storage.js', () => ({
  generatePresignedPut: vi.fn(
    async (key: string) => `https://storage.example.com/${key}?X-Expires=999`,
  ),
  generateStorageKey: vi.fn(() => 'uploads/conv-123/abc123def456'),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth?: { userId: string } }).auth = { userId: 'user-abc' };
    next();
  },
}));

// ── App setup ─────────────────────────────────────────────────────────────────

async function buildApp() {
  const { uploadsRouter } = await import('../routes/uploads.js');
  const app = express();
  app.use(express.json());
  app.use('/uploads', uploadsRouter);
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_BODY = {
  conversationId: '550e8400-e29b-41d4-a716-446655440000',
  size: 1024,
  mimeType: 'image/jpeg',
  sha256: 'abc123',
};

function mockMember() {
  mockMemberFindFirst.mockResolvedValueOnce({
    userId: 'user-abc',
    conversationId: VALID_BODY.conversationId,
  });
}

function mockInsertReturning(fileId = 'file-uuid-001') {
  mockInsert.mockReturnValueOnce({
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValueOnce([{ id: fileId }]),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /uploads — issue #226', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('returns 201 with fileId and uploadUrl for a valid request', async () => {
    mockMember();
    mockInsertReturning('file-001');

    const res = await request(app).post('/uploads').send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('fileId', 'file-001');
    expect(res.body).toHaveProperty('uploadUrl');
    expect(typeof res.body.uploadUrl).toBe('string');
  });

  it('uploadUrl is a non-empty string', async () => {
    mockMember();
    mockInsertReturning();

    const res = await request(app).post('/uploads').send(VALID_BODY);
    expect(res.body.uploadUrl.length).toBeGreaterThan(0);
  });

  it('returns 400 when conversationId is missing', async () => {
    const res = await request(app)
      .post('/uploads')
      .send({ size: 100, mimeType: 'image/jpeg', sha256: 'x' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when size is zero', async () => {
    const res = await request(app)
      .post('/uploads')
      .send({ ...VALID_BODY, size: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when size exceeds 100 MB', async () => {
    const res = await request(app)
      .post('/uploads')
      .send({ ...VALID_BODY, size: 100 * 1024 * 1024 + 1 });
    expect(res.status).toBe(400);
  });

  it('returns 415 for a disallowed MIME type', async () => {
    const res = await request(app)
      .post('/uploads')
      .send({ ...VALID_BODY, mimeType: 'application/x-msdownload' });
    expect(res.status).toBe(415);
    expect(res.body).toHaveProperty('error', 'Unsupported media type');
  });

  it('returns 403 when caller is not a conversation member', async () => {
    mockMemberFindFirst.mockResolvedValueOnce(null);

    const res = await request(app).post('/uploads').send(VALID_BODY);
    expect(res.status).toBe(403);
  });

  it('inserts file row with status pending', async () => {
    mockMember();
    const valuesSpy = vi.fn().mockReturnThis();
    const returningSpy = vi.fn().mockResolvedValueOnce([{ id: 'file-002' }]);
    mockInsert.mockReturnValueOnce({ values: valuesSpy, returning: returningSpy });

    await request(app).post('/uploads').send(VALID_BODY);

    const insertedValues = valuesSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(insertedValues.status).toBe('pending');
  });

  it('accepts image/png', async () => {
    mockMember();
    mockInsertReturning();
    const res = await request(app)
      .post('/uploads')
      .send({ ...VALID_BODY, mimeType: 'image/png' });
    expect(res.status).toBe(201);
  });

  it('accepts application/pdf', async () => {
    mockMember();
    mockInsertReturning();
    const res = await request(app)
      .post('/uploads')
      .send({ ...VALID_BODY, mimeType: 'application/pdf' });
    expect(res.status).toBe(201);
  });
});

describe('POST /uploads/:fileId/confirm', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('returns 200 and status ready when file is pending and owned by caller', async () => {
    mockFileFindFirst.mockResolvedValueOnce({
      id: 'file-001',
      uploaderId: 'user-abc',
      status: 'pending',
    });
    mockUpdate.mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValueOnce(undefined),
    });

    const res = await request(app).post('/uploads/file-001/confirm');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fileId: 'file-001', status: 'ready' });
  });

  it('returns 404 when file does not exist', async () => {
    mockFileFindFirst.mockResolvedValueOnce(null);
    const res = await request(app).post('/uploads/nonexistent/confirm');
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller is not the uploader', async () => {
    mockFileFindFirst.mockResolvedValueOnce({
      id: 'file-001',
      uploaderId: 'someone-else',
      status: 'pending',
    });
    const res = await request(app).post('/uploads/file-001/confirm');
    expect(res.status).toBe(403);
  });

  it('returns 409 when file is already ready', async () => {
    mockFileFindFirst.mockResolvedValueOnce({
      id: 'file-001',
      uploaderId: 'user-abc',
      status: 'ready',
    });
    const res = await request(app).post('/uploads/file-001/confirm');
    expect(res.status).toBe(409);
  });

  it('returns 409 when file is deleted', async () => {
    mockFileFindFirst.mockResolvedValueOnce({
      id: 'file-001',
      uploaderId: 'user-abc',
      status: 'deleted',
    });
    const res = await request(app).post('/uploads/file-001/confirm');
    expect(res.status).toBe(409);
  });
});

describe('Thumbnail handling — issue #230', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('accepts isThumbnail=true and inserts row with isThumbnail flag', async () => {
    mockMember();
    const valuesSpy = vi.fn().mockReturnThis();
    const returningSpy = vi.fn().mockResolvedValueOnce([{ id: 'thumb-001' }]);
    mockInsert.mockReturnValueOnce({ values: valuesSpy, returning: returningSpy });

    const res = await request(app)
      .post('/uploads')
      .send({ ...VALID_BODY, mimeType: 'image/jpeg', isThumbnail: true });
    expect(res.status).toBe(201);
    const inserted = valuesSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.isThumbnail).toBe(true);
  });

  it('isThumbnail defaults to false when not provided', async () => {
    mockMember();
    const valuesSpy = vi.fn().mockReturnThis();
    mockInsert.mockReturnValueOnce({
      values: valuesSpy,
      returning: vi.fn().mockResolvedValueOnce([{ id: 'f-001' }]),
    });

    await request(app).post('/uploads').send(VALID_BODY);
    const inserted = valuesSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.isThumbnail).toBe(false);
  });

  it('server never generates previews — no thumbnail derivation in the route', async () => {
    // The route must not import or call any image-processing library.
    // We verify this structurally: the route module source does not reference
    // sharp / jimp / canvas / imagemagick / ffmpeg.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(dir, '../routes/uploads.ts'), 'utf8');
    for (const lib of ['sharp', 'jimp', 'canvas', 'imagemagick', 'ffmpeg']) {
      expect(src).not.toContain(lib);
    }
  });

  it('missing thumbnail is handled gracefully — request without isThumbnail succeeds', async () => {
    mockMember();
    mockInsertReturning('file-no-thumb');
    const res = await request(app).post('/uploads').send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.fileId).toBe('file-no-thumb');
  });

  it('thumbnail upload returns its own fileId for referencing in message payload', async () => {
    mockMember();
    const valuesSpy = vi.fn().mockReturnThis();
    mockInsert.mockReturnValueOnce({
      values: valuesSpy,
      returning: vi.fn().mockResolvedValueOnce([{ id: 'thumb-xyz' }]),
    });

    const res = await request(app)
      .post('/uploads')
      .send({ ...VALID_BODY, isThumbnail: true });
    expect(res.body.fileId).toBe('thumb-xyz');
  });
});
