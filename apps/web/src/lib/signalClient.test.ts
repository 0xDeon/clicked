/**
 * Unit tests for signalClient.ts's Phase-2 multi-device wiring (issue:
 * multi-device Signal, sessions per sibling device):
 *   - one independent session per target device, including sibling devices
 *   - a device with no session establishes one via X3DH on first contact
 *   - fan-out produces exactly one envelope per device, unchanged shape
 *     from what the backend already expects ({ recipientDeviceId, ciphertext })
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  generateIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
  rawEd25519PublicKeyToSpki,
  toBase64,
  type PreKeyBundle,
} from './x3dh.js';
import type { DeviceRecord } from './crypto.js';
import { clearAllSessions, hasSession } from './signalSession.js';
import {
  configureSignalClient,
  resetSignalClientConfig,
  SignalClient,
  type FetchKeyBundle,
} from './signalClient.js';

function buildBundle(deviceId: string): PreKeyBundle {
  const identity = generateIdentityKeyPair();
  const signedPreKey = generateSignedPreKey(identity, 1);
  const [oneTimePreKey] = generateOneTimePreKeys(1, 1);
  return {
    deviceId,
    identityPublicKey: toBase64(rawEd25519PublicKeyToSpki(identity.publicKey)),
    registrationId: 1,
    signedPreKey: {
      keyId: signedPreKey.keyId,
      publicKey: toBase64(signedPreKey.publicKey),
      signature: toBase64(signedPreKey.signature),
    },
    oneTimePreKey: { keyId: oneTimePreKey!.keyId, publicKey: toBase64(oneTimePreKey!.publicKey) },
  };
}

function device(id: string, userId: string): DeviceRecord {
  return { id, userId, identityPublicKey: 'unused-in-these-tests' };
}

let fetchCalls: Array<{ userId: string; deviceId: string }>;
let fetchKeyBundle: FetchKeyBundle;

beforeEach(() => {
  clearAllSessions();
  resetSignalClientConfig();
  fetchCalls = [];
  fetchKeyBundle = async (userId, deviceId) => {
    fetchCalls.push({ userId, deviceId });
    return buildBundle(deviceId);
  };
  configureSignalClient({ myIdentity: generateIdentityKeyPair(), fetchKeyBundle });
});

afterEach(() => {
  clearAllSessions();
  resetSignalClientConfig();
});

describe('encryptToDevice — session establishment on first contact', () => {
  it('fetches the bundle and establishes a session the first time a device is targeted', async () => {
    const bobPhone = device('bob-phone', 'bob');
    expect(hasSession(bobPhone.id)).toBe(false);

    await SignalClient.encryptToDevice('hello', bobPhone);

    expect(hasSession(bobPhone.id)).toBe(true);
    expect(fetchCalls).toEqual([{ userId: 'bob', deviceId: 'bob-phone' }]);
  });

  it('reuses the existing session on subsequent sends — no repeated bundle fetch', async () => {
    const bobPhone = device('bob-phone', 'bob');

    await SignalClient.encryptToDevice('first', bobPhone);
    await SignalClient.encryptToDevice('second', bobPhone);
    await SignalClient.encryptToDevice('third', bobPhone);

    expect(fetchCalls).toHaveLength(1);
  });

  it('produces a different ciphertext for every message to the same device (ratchet advances)', async () => {
    const bobPhone = device('bob-phone', 'bob');

    const c1 = await SignalClient.encryptToDevice('same plaintext', bobPhone);
    const c2 = await SignalClient.encryptToDevice('same plaintext', bobPhone);

    expect(c1).not.toBe(c2);
  });

  it('throws a clear error if used before configureSignalClient', async () => {
    resetSignalClientConfig();
    clearAllSessions();

    await expect(SignalClient.encryptToDevice('hi', device('d1', 'u1'))).rejects.toThrow(
      /not configured/i,
    );
  });
});

describe('buildEnvelopes — multi-device fan-out', () => {
  it('produces exactly one envelope per device, addressed by recipientDeviceId', async () => {
    const devices = [device('bob-phone', 'bob'), device('bob-laptop', 'bob')];

    const envelopes = await SignalClient.buildEnvelopes('hi bob', devices);

    expect(envelopes).toHaveLength(2);
    expect(envelopes.map((e) => e.recipientDeviceId).sort()).toEqual(['bob-laptop', 'bob-phone']);
    // Shape the backend expects (services/deviceDelivery.ts, socket/messaging.ts) — unchanged.
    for (const envelope of envelopes) {
      expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'recipientDeviceId']);
      expect(typeof envelope.ciphertext).toBe('string');
    }
  });

  it('establishes an independent session per device, including the sender\'s own siblings', async () => {
    // Recipient's phone, recipient's laptop, and the sender's own second
    // device (a "sibling" of whichever device is calling this) — all three
    // are just entries in the device list crypto.ts's fetchConversationDevices
    // returns; buildEnvelopes doesn't distinguish them.
    const devices = [
      device('bob-phone', 'bob'),
      device('bob-laptop', 'bob'),
      device('my-other-laptop', 'me'),
    ];

    await SignalClient.buildEnvelopes('hi', devices);

    expect(fetchCalls.map((c) => c.deviceId).sort()).toEqual([
      'bob-laptop',
      'bob-phone',
      'my-other-laptop',
    ]);
    for (const d of devices) {
      expect(hasSession(d.id)).toBe(true);
    }
  });

  it('a brand-new sibling device establishes its own session without disturbing existing ones', async () => {
    const bobPhone = device('bob-phone', 'bob');
    await SignalClient.encryptToDevice('already talking to this one', bobPhone);
    expect(fetchCalls).toHaveLength(1);

    // Bob links a new laptop — first message that includes it must establish
    // a session for it, while bob-phone's existing session is untouched.
    const bobLaptop = device('bob-laptop', 'bob');
    await SignalClient.buildEnvelopes('group update', [bobPhone, bobLaptop]);

    expect(fetchCalls).toHaveLength(2); // only the new device triggered a fetch
    expect(fetchCalls[1]).toEqual({ userId: 'bob', deviceId: 'bob-laptop' });
    expect(hasSession(bobPhone.id)).toBe(true);
    expect(hasSession(bobLaptop.id)).toBe(true);
  });
});
