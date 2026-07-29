/**
 * Unit tests for identityTrust.ts — session reset / re-handshake on key
 * change.
 *
 * Runs under vitest's `environment: 'node'` (see apps/web/vitest.config.ts),
 * where `window` is undefined, so these tests exercise the in-memory
 * storage fallback. Each test uses a distinct userId to avoid bleeding
 * state through that shared fallback map across tests in this file.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  checkIdentityChange,
  clearTrustedSnapshot,
  getTrustedSnapshot,
  IdentityKeyChangedError,
  onSessionReset,
  trustDevices,
  type TrustedDevice,
} from './identityTrust.js';

let userCounter = 0;
function freshUserId(): string {
  userCounter += 1;
  return `user-${userCounter}`;
}

const unregisterHandlers: Array<() => void> = [];
afterEach(() => {
  while (unregisterHandlers.length > 0) unregisterHandlers.pop()!();
});

const DEVICE_A: TrustedDevice = { id: 'device-a', identityPublicKey: 'key-a' };
const DEVICE_B: TrustedDevice = { id: 'device-b', identityPublicKey: 'key-b' };

describe('checkIdentityChange', () => {
  it('trusts a peer on first contact and pins their current device set', () => {
    const userId = freshUserId();

    const result = checkIdentityChange(userId, [DEVICE_A]);

    expect(result).toEqual({ status: 'first-contact', changedDeviceIds: [] });
    expect(getTrustedSnapshot(userId)?.devices).toEqual([DEVICE_A]);
  });

  it('reports "trusted" when the live device set matches the pin', () => {
    const userId = freshUserId();
    checkIdentityChange(userId, [DEVICE_A]); // pins on first contact

    const result = checkIdentityChange(userId, [DEVICE_A]);

    expect(result).toEqual({ status: 'trusted', changedDeviceIds: [] });
  });

  it('is order-independent when comparing multi-device sets', () => {
    const userId = freshUserId();
    checkIdentityChange(userId, [DEVICE_A, DEVICE_B]);

    const result = checkIdentityChange(userId, [DEVICE_B, DEVICE_A]);

    expect(result.status).toBe('trusted');
  });

  it('flags a swapped identity key on an existing device id as changed', () => {
    const userId = freshUserId();
    checkIdentityChange(userId, [DEVICE_A]);

    const rotated: TrustedDevice = { id: DEVICE_A.id, identityPublicKey: 'rotated-key' };
    const result = checkIdentityChange(userId, [rotated]);

    expect(result.status).toBe('changed');
    expect(result.changedDeviceIds).toEqual([DEVICE_A.id]);
  });

  it('flags a newly-appeared device on an already-trusted peer as changed', () => {
    const userId = freshUserId();
    checkIdentityChange(userId, [DEVICE_A]);

    const result = checkIdentityChange(userId, [DEVICE_A, DEVICE_B]);

    expect(result.status).toBe('changed');
    expect(result.changedDeviceIds).toEqual([DEVICE_B.id]);
  });

  it('flags a disappeared (revoked) device as changed', () => {
    const userId = freshUserId();
    checkIdentityChange(userId, [DEVICE_A, DEVICE_B]);

    const result = checkIdentityChange(userId, [DEVICE_A]);

    expect(result.status).toBe('changed');
    expect(result.changedDeviceIds).toEqual([DEVICE_B.id]);
  });

  it('does not move the pin forward on a detected change — it keeps failing until re-verified', () => {
    const userId = freshUserId();
    checkIdentityChange(userId, [DEVICE_A]);

    const rotated: TrustedDevice = { id: DEVICE_A.id, identityPublicKey: 'rotated-key' };
    checkIdentityChange(userId, [rotated]); // detected as changed

    // Same rotated set checked again — still "changed", not silently re-trusted.
    const result = checkIdentityChange(userId, [rotated]);
    expect(result.status).toBe('changed');
    expect(getTrustedSnapshot(userId)?.devices).toEqual([DEVICE_A]);
  });

  it('resumes as "trusted" only after the user explicitly re-verifies via trustDevices', () => {
    const userId = freshUserId();
    checkIdentityChange(userId, [DEVICE_A]);

    const rotated: TrustedDevice = { id: DEVICE_A.id, identityPublicKey: 'rotated-key' };
    checkIdentityChange(userId, [rotated]); // changed, blocked

    trustDevices(userId, [rotated]); // user re-verifies the new safety number

    const result = checkIdentityChange(userId, [rotated]);
    expect(result.status).toBe('trusted');
  });

  it('invokes registered session-reset handlers with exactly the changed device ids', () => {
    const userId = freshUserId();
    checkIdentityChange(userId, [DEVICE_A, DEVICE_B]);

    const resetIds: string[][] = [];
    unregisterHandlers.push(onSessionReset((ids) => resetIds.push(ids)));

    const rotatedA: TrustedDevice = { id: DEVICE_A.id, identityPublicKey: 'rotated-key' };
    checkIdentityChange(userId, [rotatedA, DEVICE_B]);

    expect(resetIds).toHaveLength(1);
    expect(resetIds[0]).toEqual([DEVICE_A.id]);
  });

  it('does not invoke session-reset handlers when nothing changed', () => {
    const userId = freshUserId();
    checkIdentityChange(userId, [DEVICE_A]);

    const resetIds: string[][] = [];
    unregisterHandlers.push(onSessionReset((ids) => resetIds.push(ids)));

    checkIdentityChange(userId, [DEVICE_A]);

    expect(resetIds).toHaveLength(0);
  });

  it('an unregistered handler is no longer called', () => {
    const userId = freshUserId();
    checkIdentityChange(userId, [DEVICE_A]);

    const resetIds: string[][] = [];
    const unregister = onSessionReset((ids) => resetIds.push(ids));
    unregister();

    checkIdentityChange(userId, [{ id: DEVICE_A.id, identityPublicKey: 'rotated' }]);

    expect(resetIds).toHaveLength(0);
  });
});

describe('clearTrustedSnapshot', () => {
  it('removes the pin so the next check is treated as first contact again', () => {
    const userId = freshUserId();
    checkIdentityChange(userId, [DEVICE_A]);
    expect(getTrustedSnapshot(userId)).not.toBeNull();

    clearTrustedSnapshot(userId);

    expect(getTrustedSnapshot(userId)).toBeNull();
    expect(checkIdentityChange(userId, [DEVICE_A]).status).toBe('first-contact');
  });
});

describe('IdentityKeyChangedError', () => {
  it('carries the affected userId and device ids', () => {
    const err = new IdentityKeyChangedError('user-x', ['device-a', 'device-b']);
    expect(err.name).toBe('IdentityKeyChangedError');
    expect(err.userId).toBe('user-x');
    expect(err.changedDeviceIds).toEqual(['device-a', 'device-b']);
    expect(err.message).toMatch(/user-x/);
  });
});
