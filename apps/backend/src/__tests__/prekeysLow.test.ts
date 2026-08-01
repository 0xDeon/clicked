/**
 * Tests for the low one-time-prekey signal.
 *
 * Covers the debounce contract: `prekeys_low` fires at most once per threshold
 * crossing, and replenishing back to the threshold re-arms it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));

vi.mock('../db/index.js', () => ({ db: { select: mockSelect } }));

vi.mock('../db/schema.js', () => ({
  devicePrekeys: { deviceId: 'deviceId', keyType: 'keyType', consumed: 'consumed' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  and: vi.fn((...args: unknown[]) => args),
  count: vi.fn(() => 'count(*)'),
}));

vi.mock('../lib/redis.js', () => ({ redis: null }));
vi.mock('../lib/socket.js', () => ({ getSocketServer: vi.fn(() => ({ to: mockTo })) }));

const {
  PREKEY_LOW_THRESHOLD,
  signalPrekeysLowIfNeeded,
  releasePrekeysLowLatch,
  countAvailableOneTimePreKeys,
  __resetPrekeyLowLatches,
} = await import('../services/prekeyLowSignal.js');

const DEVICE = 'device-1';

beforeEach(() => {
  vi.clearAllMocks();
  __resetPrekeyLowLatches();
});

describe('signalPrekeysLowIfNeeded', () => {
  it('defaults the threshold to 20', () => {
    expect(PREKEY_LOW_THRESHOLD).toBe(20);
  });

  it('emits prekeys_low to the device room when below the threshold', async () => {
    await signalPrekeysLowIfNeeded(DEVICE, 19);

    expect(mockTo).toHaveBeenCalledWith(`device:${DEVICE}`);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith('prekeys_low', {
      deviceId: DEVICE,
      oneTimePreKeysRemaining: 19,
      threshold: 20,
    });
  });

  it('does not emit while at or above the threshold', async () => {
    await signalPrekeysLowIfNeeded(DEVICE, 20);
    await signalPrekeysLowIfNeeded(DEVICE, 50);

    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('emits at most once per threshold crossing', async () => {
    for (let remaining = 19; remaining >= 0; remaining--) {
      await signalPrekeysLowIfNeeded(DEVICE, remaining);
    }

    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(
      'prekeys_low',
      expect.objectContaining({ oneTimePreKeysRemaining: 19 }),
    );
  });

  it('latches per device — one device going low does not silence another', async () => {
    await signalPrekeysLowIfNeeded('device-a', 5);
    await signalPrekeysLowIfNeeded('device-b', 5);
    await signalPrekeysLowIfNeeded('device-a', 4);

    expect(mockEmit).toHaveBeenCalledTimes(2);
  });

  it('stops firing after replenishment, then fires again on the next crossing', async () => {
    await signalPrekeysLowIfNeeded(DEVICE, 3);
    expect(mockEmit).toHaveBeenCalledTimes(1);

    // Replenished above the threshold — this re-arms the latch and is itself
    // silent.
    await signalPrekeysLowIfNeeded(DEVICE, 100);
    expect(mockEmit).toHaveBeenCalledTimes(1);

    // Draining back down below the threshold signals once more.
    await signalPrekeysLowIfNeeded(DEVICE, 19);
    await signalPrekeysLowIfNeeded(DEVICE, 18);
    expect(mockEmit).toHaveBeenCalledTimes(2);
  });

  it('re-arms after an explicit latch release (e.g. prekey upload)', async () => {
    await signalPrekeysLowIfNeeded(DEVICE, 2);
    await releasePrekeysLowLatch(DEVICE);
    await signalPrekeysLowIfNeeded(DEVICE, 2);

    expect(mockEmit).toHaveBeenCalledTimes(2);
  });

  it('swallows socket-layer failures', async () => {
    mockTo.mockImplementationOnce(() => {
      throw new Error('socket server exploded');
    });

    await expect(signalPrekeysLowIfNeeded(DEVICE, 1)).resolves.toBeUndefined();
  });
});

describe('countAvailableOneTimePreKeys', () => {
  it('returns the unconsumed one-time prekey count', async () => {
    const where = vi.fn().mockResolvedValue([{ total: 7 }]);
    mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });

    expect(await countAvailableOneTimePreKeys(DEVICE)).toBe(7);
  });

  it('returns 0 when the device has none', async () => {
    const where = vi.fn().mockResolvedValue([]);
    mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });

    expect(await countAvailableOneTimePreKeys(DEVICE)).toBe(0);
  });
});
