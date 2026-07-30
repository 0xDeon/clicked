/**
 * Tests for Phase-1 → Signal protocol negotiation (#364).
 *
 * The two properties under test:
 *   - a conversation cuts over to Signal only when *every* active device on
 *     every side advertises support
 *   - once it has cut over, a sealed-box fallback is refused
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockMemberFindMany = vi.fn();
const mockDeviceFindMany = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findMany: mockMemberFindMany },
      devices: { findMany: mockDeviceFindMany },
    },
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: { conversationId: 'conversationId', userId: 'userId' },
  devices: { userId: 'userId', revokedAt: 'revokedAt' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ op: 'inArray', col, vals })),
  isNull: vi.fn((col: unknown) => ({ op: 'isNull', col })),
}));

const { negotiateConversationProtocol, checkEnvelopeProtocols } =
  await import('../services/e2eeProtocol.js');

const CONVERSATION_ID = 'conv-1';

function device(id: string, supportsSignal: boolean, userId = 'user-1') {
  return { id, userId, deviceName: `dev-${id}`, platform: 'web', supportsSignal };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMemberFindMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }]);
});

describe('negotiateConversationProtocol', () => {
  it('stays on sealed box while any active device is Phase-1 only', async () => {
    mockDeviceFindMany.mockResolvedValue([
      device('d1', true),
      device('d2', false, 'user-2'),
      device('d3', true, 'user-2'),
    ]);

    const result = await negotiateConversationProtocol(CONVERSATION_ID);

    expect(result.protocol).toBe('sealed_box');
    expect(result.totalActiveDevices).toBe(3);
    expect(result.signalCapableDevices).toBe(2);
    expect(result.blockingDevices).toEqual([
      { deviceId: 'd2', userId: 'user-2', deviceName: 'dev-d2', platform: 'web' },
    ]);
  });

  it('cuts over once every active device is capable', async () => {
    mockDeviceFindMany.mockResolvedValue([device('d1', true), device('d2', true, 'user-2')]);

    const result = await negotiateConversationProtocol(CONVERSATION_ID);

    expect(result.protocol).toBe('signal');
    expect(result.blockingDevices).toEqual([]);
  });

  it('does not cut over on an empty device set', async () => {
    // Reporting `signal` here would flip the conversation to a mode no device
    // can read the moment one joins.
    mockDeviceFindMany.mockResolvedValue([]);

    const result = await negotiateConversationProtocol(CONVERSATION_ID);

    expect(result.protocol).toBe('sealed_box');
    expect(result.totalActiveDevices).toBe(0);
  });

  it('reports sealed box for a conversation with no members', async () => {
    mockMemberFindMany.mockResolvedValue([]);

    const result = await negotiateConversationProtocol(CONVERSATION_ID);

    expect(result.protocol).toBe('sealed_box');
    expect(mockDeviceFindMany).not.toHaveBeenCalled();
  });

  it('one lagging device blocks the cutover for everyone', async () => {
    mockDeviceFindMany.mockResolvedValue([
      device('d1', true),
      device('d2', true),
      device('d3', true, 'user-2'),
      device('d4', false, 'user-2'),
    ]);

    const result = await negotiateConversationProtocol(CONVERSATION_ID);

    expect(result.protocol).toBe('sealed_box');
    expect(result.blockingDevices).toHaveLength(1);
    expect(result.blockingDevices[0]!.deviceId).toBe('d4');
  });
});

describe('checkEnvelopeProtocols', () => {
  it('accepts sealed-box envelopes before the cutover', async () => {
    mockDeviceFindMany.mockResolvedValue([device('d1', true), device('d2', false, 'user-2')]);

    const result = await checkEnvelopeProtocols(CONVERSATION_ID, [
      { recipientDeviceId: 'd1', protocol: 'sealed_box' },
      { recipientDeviceId: 'd2', protocol: 'sealed_box' },
    ]);

    expect(result).toEqual({ ok: true, negotiated: 'sealed_box' });
  });

  it('rejects a Signal envelope addressed to a Phase-1 device', async () => {
    mockDeviceFindMany.mockResolvedValue([device('d1', true), device('d2', false, 'user-2')]);

    const result = await checkEnvelopeProtocols(CONVERSATION_ID, [
      { recipientDeviceId: 'd2', protocol: 'signal' },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(400);
    expect(result.offendingDeviceIds).toEqual(['d2']);
  });

  it('accepts Signal envelopes after the cutover', async () => {
    mockDeviceFindMany.mockResolvedValue([device('d1', true), device('d2', true, 'user-2')]);

    const result = await checkEnvelopeProtocols(CONVERSATION_ID, [
      { recipientDeviceId: 'd1', protocol: 'signal' },
      { recipientDeviceId: 'd2', protocol: 'signal' },
    ]);

    expect(result).toEqual({ ok: true, negotiated: 'signal' });
  });

  it('refuses a sealed-box downgrade once the conversation has cut over', async () => {
    mockDeviceFindMany.mockResolvedValue([device('d1', true), device('d2', true, 'user-2')]);

    const result = await checkEnvelopeProtocols(CONVERSATION_ID, [
      { recipientDeviceId: 'd1', protocol: 'signal' },
      { recipientDeviceId: 'd2', protocol: 'sealed_box' },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(409);
    expect(result.negotiated).toBe('signal');
    expect(result.offendingDeviceIds).toEqual(['d2']);
  });

  it('reports the incapable-recipient error ahead of the downgrade error', async () => {
    // A mixed batch is a client that has not re-fetched the device set; the
    // undecryptable envelope is the more specific problem to report.
    mockDeviceFindMany.mockResolvedValue([device('d1', true), device('d2', false, 'user-2')]);

    const result = await checkEnvelopeProtocols(CONVERSATION_ID, [
      { recipientDeviceId: 'd1', protocol: 'sealed_box' },
      { recipientDeviceId: 'd2', protocol: 'signal' },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(400);
  });

  it('accepts an empty envelope list', async () => {
    mockDeviceFindMany.mockResolvedValue([device('d1', true), device('d2', true, 'user-2')]);

    expect(await checkEnvelopeProtocols(CONVERSATION_ID, [])).toEqual({
      ok: true,
      negotiated: 'signal',
    });
  });
});
