/**
 * Tests for push notification service (#236, #237, #239).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── DB mock ────────────────────────────────────────────────────────────────────
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockExecute = vi.fn();
const mockFindMany = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: { pushSubscriptions: { findMany: mockFindMany } },
    update: mockUpdate,
    delete: mockDelete,
    execute: mockExecute,
  },
}));

vi.mock('../db/schema.js', () => ({
  pushSubscriptions: { id: 'id', deviceId: 'device_id', disabledAt: 'disabled_at' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  isNull: vi.fn((col: unknown) => ({ col, isNull: true })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, vals })),
    { raw: vi.fn() },
  ),
}));

// ── web-push mock ──────────────────────────────────────────────────────────────
const mockSendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: mockSendNotification,
  },
}));

// ── deviceRevocation mock ──────────────────────────────────────────────────────
const mockIsDeviceConnected = vi.fn();
vi.mock('../services/deviceRevocation.js', () => ({
  isDeviceConnected: mockIsDeviceConnected,
}));

process.env['VAPID_PUBLIC_KEY'] = 'test-public-key';
process.env['VAPID_PRIVATE_KEY'] = 'test-private-key';

const { dispatchOfflinePush } = await import('../services/pushNotification.js');

const mockSetFn = vi.fn().mockReturnThis();
const mockWhereFn = vi.fn().mockResolvedValue(undefined);
const mockDeleteWhereFn = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockReturnValue({ set: mockSetFn });
  mockSetFn.mockReturnValue({ where: mockWhereFn });
  mockDelete.mockReturnValue({ where: mockDeleteWhereFn });
  mockExecute.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// Use unique device IDs per test to avoid rate-limit state bleed between tests.
let testDeviceCounter = 0;
function uniqueDevice(): string {
  return `dev-push-test-${++testDeviceCounter}`;
}

describe('#236 – dispatchOfflinePush', () => {
  it('skips devices that are connected', async () => {
    vi.useFakeTimers();
    mockIsDeviceConnected.mockReturnValue(true);

    await dispatchOfflinePush('conv-1', 'msg-1', [uniqueDevice()]);
    await vi.runAllTimersAsync();

    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('queues push for offline devices and sends after coalesce window', async () => {
    vi.useFakeTimers();
    mockIsDeviceConnected.mockReturnValue(false);
    mockFindMany.mockResolvedValue([
      { id: 'sub-1', endpoint: 'https://push.example.com/sub1', p256dh: 'p256', auth: 'auth' },
    ]);
    mockSendNotification.mockResolvedValue(undefined);

    await dispatchOfflinePush('conv-2', 'msg-2', [uniqueDevice()]);
    await vi.runAllTimersAsync();

    expect(mockFindMany).toHaveBeenCalled();
    expect(mockSendNotification).toHaveBeenCalledWith(
      { endpoint: 'https://push.example.com/sub1', keys: { p256dh: 'p256', auth: 'auth' } },
      expect.stringContaining('"type":"new_message"'),
    );
  });

  it('payload is content-free: no ciphertext or sender data', async () => {
    vi.useFakeTimers();
    mockIsDeviceConnected.mockReturnValue(false);
    mockFindMany.mockResolvedValue([
      { id: 'sub-2', endpoint: 'https://push.example.com/s2', p256dh: 'p', auth: 'a' },
    ]);
    mockSendNotification.mockResolvedValue(undefined);

    await dispatchOfflinePush('conv-3', 'msg-3', [uniqueDevice()]);
    await vi.runAllTimersAsync();

    const [, payloadStr] = mockSendNotification.mock.calls[0] as [unknown, string];
    const payload = JSON.parse(payloadStr) as Record<string, unknown>;
    expect(payload).toHaveProperty('type', 'new_message');
    expect(payload).toHaveProperty('conversationId', 'conv-3');
    expect(payload).toHaveProperty('messageId', 'msg-3');
    expect(payload).not.toHaveProperty('ciphertext');
    expect(payload).not.toHaveProperty('content');
    expect(payload).not.toHaveProperty('sender');
  });
});

describe('#239 – coalescing', () => {
  it('coalesces burst into single push with accurate count', async () => {
    vi.useFakeTimers();
    mockIsDeviceConnected.mockReturnValue(false);
    mockFindMany.mockResolvedValue([
      { id: 'sub-c', endpoint: 'https://push.example.com/sc', p256dh: 'p', auth: 'a' },
    ]);
    mockSendNotification.mockResolvedValue(undefined);

    const dev = uniqueDevice();
    await dispatchOfflinePush('conv-burst', 'msg-b1', [dev]);
    await dispatchOfflinePush('conv-burst', 'msg-b2', [dev]);
    await dispatchOfflinePush('conv-burst', 'msg-b3', [dev]);
    await vi.runAllTimersAsync();

    // Only one push must be sent
    expect(mockSendNotification).toHaveBeenCalledTimes(1);

    const [, payloadStr] = mockSendNotification.mock.calls[0] as [unknown, string];
    const payload = JSON.parse(payloadStr) as Record<string, unknown>;
    expect(payload).toHaveProperty('count', 3);
    expect(payload).toHaveProperty('messageId', 'msg-b3');
  });
});

describe('#237 – push hygiene', () => {
  it('prunes dead subscription on 410 Gone', async () => {
    vi.useFakeTimers();
    mockIsDeviceConnected.mockReturnValue(false);
    mockFindMany.mockResolvedValue([
      { id: 'sub-dead', endpoint: 'https://gone.example.com', p256dh: 'p', auth: 'a' },
    ]);
    const err = Object.assign(new Error('Gone'), { statusCode: 410 });
    mockSendNotification.mockRejectedValue(err);

    await dispatchOfflinePush('conv-4', 'msg-4', [uniqueDevice()]);
    await vi.runAllTimersAsync();

    expect(mockDelete).toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('prunes dead subscription on 404 Not Found', async () => {
    vi.useFakeTimers();
    mockIsDeviceConnected.mockReturnValue(false);
    mockFindMany.mockResolvedValue([
      { id: 'sub-404', endpoint: 'https://notfound.example.com', p256dh: 'p', auth: 'a' },
    ]);
    const err = Object.assign(new Error('Not Found'), { statusCode: 404 });
    mockSendNotification.mockRejectedValue(err);

    await dispatchOfflinePush('conv-5', 'msg-5', [uniqueDevice()]);
    await vi.runAllTimersAsync();

    expect(mockDelete).toHaveBeenCalled();
  });

  it('backs off on transient 500 error (sets disabledAt)', async () => {
    vi.useFakeTimers();
    mockIsDeviceConnected.mockReturnValue(false);
    mockFindMany.mockResolvedValue([
      { id: 'sub-500', endpoint: 'https://push.example.com/s500', p256dh: 'p', auth: 'a' },
    ]);
    const err = Object.assign(new Error('Server Error'), { statusCode: 500 });
    mockSendNotification.mockRejectedValue(err);

    await dispatchOfflinePush('conv-6', 'msg-6', [uniqueDevice()]);
    await vi.runAllTimersAsync();

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSetFn).toHaveBeenCalledWith({ disabledAt: expect.any(Date) });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('updates lastUsedAt on successful delivery', async () => {
    vi.useFakeTimers();
    mockIsDeviceConnected.mockReturnValue(false);
    mockFindMany.mockResolvedValue([
      { id: 'sub-ok', endpoint: 'https://push.example.com/sok', p256dh: 'p', auth: 'a' },
    ]);
    mockSendNotification.mockResolvedValue(undefined);

    await dispatchOfflinePush('conv-7', 'msg-7', [uniqueDevice()]);
    await vi.runAllTimersAsync();

    expect(mockSetFn).toHaveBeenCalledWith({ lastUsedAt: expect.any(Date) });
  });
});
