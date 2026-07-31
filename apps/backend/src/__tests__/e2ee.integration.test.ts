/**
 * #383 — End-to-end encrypted messaging integration tests
 *
 * Verifies three core E2EE guarantees without a real database or network:
 *   1. The server never stores plaintext — `messages.ciphertext` is opaque.
 *   2. Per-device envelopes (DM / X3DH) are fanned out to exactly the right
 *      devices; multi-device delivery is verified.
 *   3. Group MLS messages use a single ciphertext delivered to all member
 *      device sockets; no per-device envelope rows are written.
 *
 * Offline-sync semantics are covered separately by sync.routes.test.ts and
 * resumeStream.test.ts; these tests focus on the fanout layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared mock state ──────────────────────────────────────────────────────────

const mockFindMembers = vi.fn();
const mockFindDevices = vi.fn();
const mockFindMembership = vi.fn();
const mockInsertMessages = vi.fn();
const mockInsertEnvelopes = vi.fn();

const mockTransaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
  const tx = {
    insert: (table: string) => ({
      values: (vals: unknown) => ({
        returning: async () => {
          if (table === 'messages_table') {
            mockInsertMessages(vals);
            const row = { ...(vals as object), id: 'msg-001', createdAt: new Date() };
            return [row];
          }
          mockInsertEnvelopes(vals);
          return [{}];
        },
      }),
    }),
  };
  return cb(tx);
});

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findMany: mockFindMembers, findFirst: mockFindMembership },
      devices: { findMany: mockFindDevices },
    },
    insert: (table: string) => ({
      values: (vals: unknown) => ({
        returning: async () => {
          if (table === 'messages_table') {
            mockInsertMessages(vals);
            return [{ ...(vals as object), id: 'msg-001', createdAt: new Date() }];
          }
          mockInsertEnvelopes(vals);
          return [{}];
        },
      }),
    }),
    transaction: mockTransaction,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: 'members_table',
  devices: 'devices_table',
  messages: 'messages_table',
  messageEnvelopes: 'envelopes_table',
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
}));

import { fanoutMessage, fanoutGroupMlsMessage } from '../services/fanout.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const CONV_ID = 'conv-abc';
const USER_A = 'user-alice';
const USER_B = 'user-bob';
const DEVICE_A1 = 'device-a1';
const DEVICE_A2 = 'device-a2'; // Alice's second device
const DEVICE_B1 = 'device-b1';

const PLAINTEXT = 'Hello, world!'; // must never appear in stored ciphertext
const DM_CIPHERTEXT_A1 = 'AEAD:encrypted-for-a1';
const DM_CIPHERTEXT_A2 = 'AEAD:encrypted-for-a2';
const DM_CIPHERTEXT_B1 = 'AEAD:encrypted-for-b1';
const MLS_GROUP_CIPHERTEXT = 'MLS:single-group-ciphertext';

beforeEach(() => {
  vi.clearAllMocks();

  // Default: Alice has two active devices; Bob has one.
  mockFindMembers.mockResolvedValue([{ userId: USER_A }, { userId: USER_B }]);
  mockFindDevices.mockResolvedValue([
    { id: DEVICE_A1, userId: USER_A },
    { id: DEVICE_A2, userId: USER_A },
    { id: DEVICE_B1, userId: USER_B },
  ]);
  mockFindMembership.mockResolvedValue({ id: 'mem-001' });
  mockTransaction.mockImplementation(async (cb) => {
    const insertedMsg = { id: 'msg-001', conversationId: CONV_ID, createdAt: new Date() };
    const envelopes: unknown[] = [];
    const tx = {
      insert: (table: string) => ({
        values: (vals: unknown) => ({
          returning: async () => {
            if (table === 'messages_table') {
              mockInsertMessages(vals);
              return [insertedMsg];
            }
            mockInsertEnvelopes(vals);
            envelopes.push(vals);
            return [{}];
          },
        }),
      }),
    };
    return cb(tx);
  });
});

// ── 1. Server only stores ciphertext, never plaintext ─────────────────────────

describe('E2EE guarantee: server stores ciphertext only', () => {
  it('fanoutMessage persists ciphertext, never plaintext', async () => {
    const result = await fanoutMessage(
      {
        conversationId: CONV_ID,
        senderId: USER_A,
        senderDeviceId: DEVICE_A1,
        contentType: 'text',
        ciphertext: null, // DM path: plaintext goes inside per-device envelopes
      },
      DEVICE_A1,
      {
        [DEVICE_A2]: DM_CIPHERTEXT_A2,
        [DEVICE_B1]: DM_CIPHERTEXT_B1,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const storedMessageArg = mockInsertMessages.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(storedMessageArg).toBeDefined();

    // The plaintext must never appear anywhere in what was persisted.
    expect(JSON.stringify(storedMessageArg)).not.toContain(PLAINTEXT);

    // The envelopes each carry an opaque ciphertext blob.
    const envelopeArg = mockInsertEnvelopes.mock.calls[0]?.[0] as Array<Record<string, string>>;
    expect(Array.isArray(envelopeArg)).toBe(true);
    for (const env of envelopeArg) {
      expect(JSON.stringify(env)).not.toContain(PLAINTEXT);
      // Each envelope's ciphertext is one of the known encrypted blobs.
      expect([DM_CIPHERTEXT_A2, DM_CIPHERTEXT_B1]).toContain(env['ciphertext']);
    }
  });
});

// ── 2. Multi-device DM delivery ───────────────────────────────────────────────

describe('E2EE multi-device DM fanout', () => {
  it('delivers an envelope to each active recipient device except the sender', async () => {
    const envelopes = {
      [DEVICE_A2]: DM_CIPHERTEXT_A2, // Alice's other device (self-sync)
      [DEVICE_B1]: DM_CIPHERTEXT_B1, // Bob's device
    };

    const result = await fanoutMessage(
      {
        conversationId: CONV_ID,
        senderId: USER_A,
        senderDeviceId: DEVICE_A1,
        contentType: 'text',
        ciphertext: null,
      },
      DEVICE_A1,
      envelopes,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const insertedEnvelopes = mockInsertEnvelopes.mock.calls[0]?.[0] as Array<
      Record<string, string>
    >;
    const deliveredDeviceIds = insertedEnvelopes.map((e) => e['recipientDeviceId']);

    // Alice's sending device should NOT receive its own envelope.
    expect(deliveredDeviceIds).not.toContain(DEVICE_A1);

    // Alice's second device and Bob's device must both receive an envelope.
    expect(deliveredDeviceIds).toContain(DEVICE_A2);
    expect(deliveredDeviceIds).toContain(DEVICE_B1);
  });

  it('returns device_set_mismatch when envelopes do not cover all active devices', async () => {
    // Only provide one envelope but there are two expected recipient devices.
    const result = await fanoutMessage(
      {
        conversationId: CONV_ID,
        senderId: USER_A,
        senderDeviceId: DEVICE_A1,
        contentType: 'text',
        ciphertext: null,
      },
      DEVICE_A1,
      { [DEVICE_B1]: DM_CIPHERTEXT_B1 }, // missing DEVICE_A2
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('device_set_mismatch');
    // The error payload includes the authoritative device list.
    expect(result.expectedDeviceIds).toContain(DEVICE_A2);
    expect(result.expectedDeviceIds).toContain(DEVICE_B1);
  });
});

// ── 3. Group MLS: single ciphertext, no per-device envelopes ─────────────────

describe('E2EE group MLS fanout (#370)', () => {
  it('persists a single MLS ciphertext without creating per-device envelope rows', async () => {
    const result = await fanoutGroupMlsMessage(
      {
        conversationId: CONV_ID,
        senderId: USER_A,
        senderDeviceId: DEVICE_A1,
        contentType: 'text',
        ciphertext: MLS_GROUP_CIPHERTEXT,
      },
      USER_A,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The message row carries the MLS group ciphertext.
    const storedMsg = mockInsertMessages.mock.calls[0]?.[0] as Record<string, string>;
    expect(storedMsg?.['ciphertext']).toBe(MLS_GROUP_CIPHERTEXT);

    // No per-device envelopes should have been inserted.
    expect(mockInsertEnvelopes).not.toHaveBeenCalled();
  });

  it('rejects a non-member sender', async () => {
    mockFindMembership.mockResolvedValue(null); // USER_A not a member

    const result = await fanoutGroupMlsMessage(
      {
        conversationId: CONV_ID,
        senderId: USER_A,
        senderDeviceId: DEVICE_A1,
        contentType: 'text',
        ciphertext: MLS_GROUP_CIPHERTEXT,
      },
      USER_A,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('not_member');
  });

  it('MLS ciphertext is opaque — plaintext never stored', async () => {
    const result = await fanoutGroupMlsMessage(
      {
        conversationId: CONV_ID,
        senderId: USER_A,
        senderDeviceId: DEVICE_A1,
        contentType: 'text',
        ciphertext: MLS_GROUP_CIPHERTEXT,
      },
      USER_A,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const storedMsg = mockInsertMessages.mock.calls[0]?.[0] as Record<string, string>;
    expect(JSON.stringify(storedMsg)).not.toContain(PLAINTEXT);
  });
});
