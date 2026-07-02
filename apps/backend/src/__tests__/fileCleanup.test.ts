/**
 * Tests for file cleanup service (#231).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── S3 mock (must use vi.hoisted so it's available in the factory) ────────────
const mockS3Send = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class MockS3 {
    send = mockS3Send;
  },
  DeleteObjectCommand: class MockDeleteCmd {
    constructor(public input: unknown) {}
  },
}));

// ── DB mock ───────────────────────────────────────────────────────────────────
const mockFindMany = vi.fn();
const mockUpdate = vi.fn();
const mockExecute = vi.fn();
const mockDelete = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: { files: { findMany: mockFindMany } },
    update: mockUpdate,
    execute: mockExecute,
    delete: mockDelete,
  },
}));

vi.mock('../db/schema.js', () => ({
  files: { id: 'id', deletedAt: 'deleted_at', hardDeletedAt: 'hard_deleted_at' },
}));

vi.mock('drizzle-orm', () => ({
  isNotNull: vi.fn((col: unknown) => ({ col, isNotNull: true })),
  isNull: vi.fn((col: unknown) => ({ col, isNull: true })),
  and: vi.fn(),
  eq: vi.fn(),
  lt: vi.fn(),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, vals })),
    { raw: vi.fn() },
  ),
}));

vi.mock('../services/pushNotification.js', () => ({
  reenableExpiredBackoffs: vi.fn().mockResolvedValue(undefined),
}));

const mockSetFn = vi.fn().mockReturnThis();
const mockWhereFn = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  mockS3Send.mockResolvedValue(undefined);
  mockUpdate.mockReturnValue({ set: mockSetFn });
  mockSetFn.mockReturnValue({ where: mockWhereFn });
  mockDelete.mockReturnValue({ where: mockWhereFn });
});

const { softDeleteFile, runHardDeletePass } = await import('../services/fileCleanup.js');

describe('#231 – softDeleteFile', () => {
  it('calls db.update with deletedAt set on the matching file', async () => {
    await softDeleteFile('file-uuid-1');
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSetFn).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
  });
});

describe('#231 – runHardDeletePass', () => {
  it('skips files that still have live message references', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: 'file-1', storageKey: 'key-1' }]) // first pass (candidates)
                .mockResolvedValueOnce([]); // second pass (pendingCandidates)
    mockExecute.mockResolvedValueOnce([{ '?column?': 1 }]); // live ref exists

    await runHardDeletePass();

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockSetFn).not.toHaveBeenCalled();
  });

  it('hard-deletes from S3 and marks hardDeletedAt when no live refs', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: 'file-2', storageKey: 'key-2' }])
                .mockResolvedValueOnce([]);
    mockExecute.mockResolvedValueOnce([]); // no live refs

    await runHardDeletePass();

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockSetFn).toHaveBeenCalledWith({ hardDeletedAt: expect.any(Date) });
  });

  it('does not mark hardDeletedAt when S3 delete throws (safe retry)', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: 'file-3', storageKey: 'key-3' }])
                .mockResolvedValueOnce([]);
    mockExecute.mockResolvedValueOnce([]);
    mockS3Send.mockRejectedValueOnce(new Error('NoSuchKey'));

    await runHardDeletePass();

    expect(mockSetFn).not.toHaveBeenCalledWith({ hardDeletedAt: expect.any(Date) });
  });

  it('processes multiple files in one pass', async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: 'file-a', storageKey: 'key-a' },
      { id: 'file-b', storageKey: 'key-b' },
    ]).mockResolvedValueOnce([]);
    mockExecute.mockResolvedValue([]); // no live refs for either

    await runHardDeletePass();

    expect(mockS3Send).toHaveBeenCalledTimes(2);
  });

  it('deletes pending files older than 24 hours', async () => {
    mockFindMany.mockResolvedValueOnce([]) // no soft-deleted candidates
                .mockResolvedValueOnce([
                  { id: 'pending-1', storageKey: 'pending-key-1' },
                ]);

    await runHardDeletePass();

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalled();
  });
});
