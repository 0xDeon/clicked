/**
 * Tests for Phase-1 → Signal protocol enforcement (#364).
 *
 * Negotiation itself (`selectProtocol` over `devices.capabilities`) belongs to
 * the capabilities layer. What is tested here is what the send path does with
 * a protocol a client *claims*:
 *   - an envelope the recipient cannot decrypt is refused
 *   - an envelope weaker than what both devices support is refused
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockDeviceFindFirst = vi.fn();
const mockDeviceFindMany = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      devices: { findFirst: mockDeviceFindFirst, findMany: mockDeviceFindMany },
    },
  },
}));

vi.mock('../db/schema.js', () => ({
  devices: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ op: 'inArray', col, vals })),
}));

const { checkEnvelopeProtocols, protocolsForRecipients } =
  await import('../services/e2eeProtocol.js');

const SENDER = 'device-sender';
const PHASE1_DEVICE = 'device-phase1';
const SIGNAL_DEVICE = 'device-signal';

/** A capability document advertising the given protocols. */
function caps(...protocols: string[]) {
  return { protocols, ciphersuites: [], fileTransfer: [] };
}

function setupDevices(senderProtocols: string[], recipients: Record<string, string[] | null>) {
  mockDeviceFindFirst.mockResolvedValue({ capabilities: caps(...senderProtocols) });
  mockDeviceFindMany.mockResolvedValue(
    Object.entries(recipients).map(([id, protocols]) => ({
      id,
      capabilities: protocols === null ? null : caps(...protocols),
    })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkEnvelopeProtocols', () => {
  it('accepts sealed box when the recipient is Phase-1 only', async () => {
    setupDevices(['sealed_box', 'signal'], { [PHASE1_DEVICE]: ['sealed_box'] });

    const result = await checkEnvelopeProtocols(SENDER, [
      { recipientDeviceId: PHASE1_DEVICE, protocol: 'sealed_box' },
    ]);

    expect(result).toEqual({ ok: true });
  });

  it('accepts Signal when both devices advertise it', async () => {
    setupDevices(['sealed_box', 'signal'], { [SIGNAL_DEVICE]: ['sealed_box', 'signal'] });

    const result = await checkEnvelopeProtocols(SENDER, [
      { recipientDeviceId: SIGNAL_DEVICE, protocol: 'signal' },
    ]);

    expect(result).toEqual({ ok: true });
  });

  it('rejects a Signal envelope aimed at a Phase-1 device', async () => {
    setupDevices(['sealed_box', 'signal'], { [PHASE1_DEVICE]: ['sealed_box'] });

    const result = await checkEnvelopeProtocols(SENDER, [
      { recipientDeviceId: PHASE1_DEVICE, protocol: 'signal' },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(400);
    expect(result.violations).toEqual([
      {
        recipientDeviceId: PHASE1_DEVICE,
        declared: 'signal',
        expected: 'sealed_box',
        reason: 'unsupported_by_recipient',
      },
    ]);
  });

  it('rejects a sealed-box downgrade when both devices can do Signal', async () => {
    setupDevices(['sealed_box', 'signal'], { [SIGNAL_DEVICE]: ['sealed_box', 'signal'] });

    const result = await checkEnvelopeProtocols(SENDER, [
      { recipientDeviceId: SIGNAL_DEVICE, protocol: 'sealed_box' },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(409);
    expect(result.violations[0]).toMatchObject({
      declared: 'sealed_box',
      expected: 'signal',
      reason: 'downgrade',
    });
  });

  it('negotiates per device pair, not per conversation', async () => {
    // One upgraded recipient and one laggard in the same batch: the upgraded
    // pair uses Signal and the laggard stays on sealed box. A conversation-wide
    // rule would hold the upgraded pair back for no benefit.
    setupDevices(['sealed_box', 'signal'], {
      [SIGNAL_DEVICE]: ['sealed_box', 'signal'],
      [PHASE1_DEVICE]: ['sealed_box'],
    });

    const result = await checkEnvelopeProtocols(SENDER, [
      { recipientDeviceId: SIGNAL_DEVICE, protocol: 'signal' },
      { recipientDeviceId: PHASE1_DEVICE, protocol: 'sealed_box' },
    ]);

    expect(result).toEqual({ ok: true });
  });

  it('reports the undecryptable envelope ahead of a downgrade in a mixed batch', async () => {
    setupDevices(['sealed_box', 'signal'], {
      [SIGNAL_DEVICE]: ['sealed_box', 'signal'],
      [PHASE1_DEVICE]: ['sealed_box'],
    });

    const result = await checkEnvelopeProtocols(SENDER, [
      { recipientDeviceId: SIGNAL_DEVICE, protocol: 'sealed_box' }, // downgrade
      { recipientDeviceId: PHASE1_DEVICE, protocol: 'signal' }, // undecryptable
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(400);
    expect(result.violations).toHaveLength(2);
  });

  it('treats a sender with no advertised capabilities as Phase-1 only', async () => {
    // An old client that never sent capabilities must not be pushed onto
    // Signal just because the recipient supports it.
    mockDeviceFindFirst.mockResolvedValue({ capabilities: null });
    mockDeviceFindMany.mockResolvedValue([
      { id: SIGNAL_DEVICE, capabilities: caps('sealed_box', 'signal') },
    ]);

    const result = await checkEnvelopeProtocols(SENDER, [
      { recipientDeviceId: SIGNAL_DEVICE, protocol: 'sealed_box' },
    ]);

    expect(result).toEqual({ ok: true });
  });

  it('treats a recipient with a null capability document as Phase-1 only', async () => {
    setupDevices(['sealed_box', 'signal'], { [PHASE1_DEVICE]: null });

    const result = await checkEnvelopeProtocols(SENDER, [
      { recipientDeviceId: PHASE1_DEVICE, protocol: 'sealed_box' },
    ]);

    expect(result).toEqual({ ok: true });
  });

  it('skips envelopes naming a device that does not resolve', async () => {
    // The send paths drop these before persisting; failing the whole request
    // on one would block delivery to every other recipient.
    setupDevices(['sealed_box'], {});

    const result = await checkEnvelopeProtocols(SENDER, [
      { recipientDeviceId: 'device-gone', protocol: 'signal' },
    ]);

    expect(result).toEqual({ ok: true });
  });

  it('accepts an empty envelope list without querying', async () => {
    expect(await checkEnvelopeProtocols(SENDER, [])).toEqual({ ok: true });
    expect(mockDeviceFindMany).not.toHaveBeenCalled();
  });
});

describe('protocolsForRecipients', () => {
  it('maps each recipient to the protocol the pair should use', async () => {
    setupDevices(['sealed_box', 'signal'], {
      [SIGNAL_DEVICE]: ['sealed_box', 'signal'],
      [PHASE1_DEVICE]: ['sealed_box'],
    });

    const result = await protocolsForRecipients(SENDER, [SIGNAL_DEVICE, PHASE1_DEVICE]);

    expect(result.get(SIGNAL_DEVICE)).toBe('signal');
    expect(result.get(PHASE1_DEVICE)).toBe('sealed_box');
  });

  it('falls back to the baseline for a device that does not resolve', async () => {
    setupDevices(['sealed_box', 'signal'], {});

    const result = await protocolsForRecipients(SENDER, ['device-gone']);

    expect(result.get('device-gone')).toBe('sealed_box');
  });

  it('returns an empty map for no recipients', async () => {
    expect((await protocolsForRecipients(SENDER, [])).size).toBe(0);
  });
});
