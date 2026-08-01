/**
 * Unit tests for crypto.ts's `assertDevicesTrusted` — the choke point that
 * wires identityTrust.ts's session-reset invariant into the actual
 * encryption pipeline (buildEnvelopes / sendEncryptedMessage /
 * SessionCrypto.encryptToDevice, see session.ts).
 *
 * Each test uses distinct userIds so the identityTrust in-memory storage
 * fallback (see identityTrust.test.ts) doesn't leak state between cases.
 */

import { describe, it, expect } from 'vitest';
import { assertDevicesTrusted, type DeviceRecord } from './crypto.js';
import { IdentityKeyChangedError, trustDevices } from './identityTrust.js';

let counter = 0;
function freshUserId(): string {
  counter += 1;
  return `guard-user-${counter}`;
}

describe('assertDevicesTrusted', () => {
  it('does not throw on first contact with a peer', () => {
    const userId = freshUserId();
    const devices: DeviceRecord[] = [{ id: 'd1', userId, identityPublicKey: 'k1' }];

    expect(() => assertDevicesTrusted(devices)).not.toThrow();
  });

  it('does not throw when the device set matches the pinned trust', () => {
    const userId = freshUserId();
    const devices: DeviceRecord[] = [{ id: 'd1', userId, identityPublicKey: 'k1' }];

    assertDevicesTrusted(devices); // pins on first contact
    expect(() => assertDevicesTrusted(devices)).not.toThrow();
  });

  it('throws IdentityKeyChangedError when a device identity key rotates', () => {
    const userId = freshUserId();
    const original: DeviceRecord[] = [{ id: 'd1', userId, identityPublicKey: 'k1' }];
    assertDevicesTrusted(original);

    const rotated: DeviceRecord[] = [{ id: 'd1', userId, identityPublicKey: 'k1-rotated' }];

    expect(() => assertDevicesTrusted(rotated)).toThrow(IdentityKeyChangedError);
  });

  it('blocks the entire batch when only one peer (of several) has a changed identity', () => {
    const userA = freshUserId();
    const userB = freshUserId();
    assertDevicesTrusted([
      { id: 'a1', userId: userA, identityPublicKey: 'ka' },
      { id: 'b1', userId: userB, identityPublicKey: 'kb' },
    ]);

    // userB's device rotates; userA's is unchanged.
    expect(() =>
      assertDevicesTrusted([
        { id: 'a1', userId: userA, identityPublicKey: 'ka' },
        { id: 'b1', userId: userB, identityPublicKey: 'kb-rotated' },
      ]),
    ).toThrow(IdentityKeyChangedError);
  });

  it('proceeds again after the user explicitly re-verifies the new identity', () => {
    const userId = freshUserId();
    assertDevicesTrusted([{ id: 'd1', userId, identityPublicKey: 'k1' }]);

    const rotated: DeviceRecord[] = [{ id: 'd1', userId, identityPublicKey: 'k1-rotated' }];
    expect(() => assertDevicesTrusted(rotated)).toThrow(IdentityKeyChangedError);

    // User re-verifies the new safety number (conversation page "Mark verified").
    trustDevices(userId, [{ id: 'd1', identityPublicKey: 'k1-rotated' }]);

    expect(() => assertDevicesTrusted(rotated)).not.toThrow();
  });
});
