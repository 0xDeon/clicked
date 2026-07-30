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
const {
  messagesPersistedTotal,
  fanoutSize,
  pushResultTotal,
  presenceChurnTotal,
  backpressureEventsTotal,
} = await import('../lib/metrics.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /metrics', () => {
  it('exposes Prometheus-format metrics', async () => {
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('clicked_messages_persisted_total');
    expect(res.text).toContain('clicked_fanout_size');
    expect(res.text).toContain('clicked_delivery_latency_seconds');
    expect(res.text).toContain('clicked_prekey_consumed_total');
    expect(res.text).toContain('clicked_push_result_total');
    expect(res.text).toContain('clicked_presence_churn_total');
    expect(res.text).toContain('clicked_backpressure_events_total');
    expect(res.text).toContain('clicked_connected_sockets');
  });

  it('never contains ciphertext, envelope payloads, or free-text content', async () => {
    messagesPersistedTotal.inc({ contentType: 'text' });
    fanoutSize.observe(3);
    pushResultTotal.inc({ result: 'sent' });
    presenceChurnTotal.inc({ transition: 'online' });
    backpressureEventsTotal.inc({ action: 'shed' });

    const res = await request(app).get('/metrics');

    expect(res.text).not.toMatch(/ciphertext/i);
    expect(res.text).not.toMatch(/plaintext/i);
    expect(res.text).not.toMatch(/envelope.{0,20}[A-Za-z0-9+/]{20,}/i);
  });
});
