import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockExecute = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    execute: mockExecute,
    query: {
      conversations: { findFirst: vi.fn() },
      conversationMembers: { findFirst: vi.fn(), findMany: vi.fn() },
      messages: { findFirst: vi.fn() },
      tokenTransfers: { findFirst: vi.fn(), findMany: vi.fn() },
      users: { findFirst: vi.fn() },
      wallets: { findFirst: vi.fn() },
    },
  },
}));

vi.mock('../services/pushNotification.js', () => ({
  dispatchOfflinePush: vi.fn().mockResolvedValue(undefined),
  reenableExpiredBackoffs: vi.fn().mockResolvedValue(undefined),
  FILE_CONTENT_TYPES: new Set<string>(),
}));

vi.mock('../services/deliveryPipeline.js', () => ({
  deliverMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/deviceDelivery.js', () => ({
  publishToDevice: vi.fn().mockResolvedValue(undefined),
}));

const { app } = await import('../app.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /health', () => {
  it('returns the db status, node version, and app version', async () => {
    mockExecute.mockResolvedValue([]);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      db: 'connected',
      node: process.version,
      version: '1.0.0',
    });
  });

  it('returns 503 with the same version fields when the db is unreachable', async () => {
    mockExecute.mockRejectedValue(new Error('db down'));

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: 'error',
      db: 'unreachable',
      node: process.version,
      version: '1.0.0',
    });
  });
});
