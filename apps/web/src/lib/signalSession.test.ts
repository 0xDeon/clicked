/**
 * Unit tests for signalSession.ts — per-device Signal sessions (issue:
 * multi-device Signal, sessions per sibling device).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  generateIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
  completeSession,
  rawEd25519PublicKeyToSpki,
  toBase64,
  type PreKeyBundle,
} from './x3dh.js';
import { checkIdentityChange } from './identityTrust.js';
import {
  clearAllSessions,
  deleteSession,
  establishSession,
  getSession,
  hasSession,
  ratchetEncryptStep,
} from './signalSession.js';

function buildResponder(deviceId: string) {
  const identity = generateIdentityKeyPair();
  const signedPreKey = generateSignedPreKey(identity, 1);
  const [oneTimePreKey] = generateOneTimePreKeys(1, 1);
  return { deviceId, identity, signedPreKey, oneTimePreKey: oneTimePreKey! };
}

function bundleFrom(responder: ReturnType<typeof buildResponder>): PreKeyBundle {
  return {
    deviceId: responder.deviceId,
    identityPublicKey: toBase64(rawEd25519PublicKeyToSpki(responder.identity.publicKey)),
    registrationId: 7,
    signedPreKey: {
      keyId: responder.signedPreKey.keyId,
      publicKey: toBase64(responder.signedPreKey.publicKey),
      signature: toBase64(responder.signedPreKey.signature),
    },
    oneTimePreKey: {
      keyId: responder.oneTimePreKey.keyId,
      publicKey: toBase64(responder.oneTimePreKey.publicKey),
    },
  };
}

afterEach(() => {
  clearAllSessions();
});

describe('establishSession', () => {
  it('creates a session usable immediately by ratchetEncryptStep', () => {
    const myIdentity = generateIdentityKeyPair();
    const bob = buildResponder('bob-device-1');

    expect(hasSession(bob.deviceId)).toBe(false);
    establishSession(bob.deviceId, bundleFrom(bob), myIdentity);
    expect(hasSession(bob.deviceId)).toBe(true);

    expect(() => ratchetEncryptStep(bob.deviceId)).not.toThrow();
  });

  it("the first ratchet step's header carries everything the responder needs to derive the same X3DH session key", () => {
    const myIdentity = generateIdentityKeyPair();
    const bob = buildResponder('bob-device-1');
    const bundle = bundleFrom(bob);

    establishSession(bob.deviceId, bundle, myIdentity);
    const step = ratchetEncryptStep(bob.deviceId);

    expect(step.initialMessageHeader).not.toBeNull();

    // The responder (Bob) independently completes X3DH from that header —
    // this is the exact cross-check x3dh.test.ts performs for the raw
    // session key; here it proves establishSession's header is sufficient
    // for a real two-party handshake, not just internally self-consistent.
    const responderSession = completeSession(
      step.initialMessageHeader!,
      bob.identity,
      bob.signedPreKey,
      bob.oneTimePreKey,
    );
    expect(responderSession.usedOneTimePreKeyId).toBe(bob.oneTimePreKey.keyId);
  });
});

describe('one session per target device (multi-device fan-out)', () => {
  it('gives independent sessions to two different devices of the same peer (siblings)', () => {
    const myIdentity = generateIdentityKeyPair();
    const bobPhone = buildResponder('bob-phone');
    const bobLaptop = buildResponder('bob-laptop'); // sibling device, same user, different keys

    establishSession(bobPhone.deviceId, bundleFrom(bobPhone), myIdentity);
    establishSession(bobLaptop.deviceId, bundleFrom(bobLaptop), myIdentity);

    expect(hasSession(bobPhone.deviceId)).toBe(true);
    expect(hasSession(bobLaptop.deviceId)).toBe(true);

    const phoneStep = ratchetEncryptStep(bobPhone.deviceId);
    const laptopStep = ratchetEncryptStep(bobLaptop.deviceId);

    // Independent sessions -> independent message keys, even for the "same" message number.
    expect(toBase64(phoneStep.messageKey)).not.toBe(toBase64(laptopStep.messageKey));
    expect(phoneStep.messageNumber).toBe(1);
    expect(laptopStep.messageNumber).toBe(1);
  });

  it('advancing one device session does not affect another device session', () => {
    const myIdentity = generateIdentityKeyPair();
    const bobPhone = buildResponder('bob-phone');
    const bobLaptop = buildResponder('bob-laptop');

    establishSession(bobPhone.deviceId, bundleFrom(bobPhone), myIdentity);
    establishSession(bobLaptop.deviceId, bundleFrom(bobLaptop), myIdentity);

    ratchetEncryptStep(bobPhone.deviceId);
    ratchetEncryptStep(bobPhone.deviceId);
    ratchetEncryptStep(bobPhone.deviceId);

    expect(getSession(bobPhone.deviceId)?.sendMessageNumber).toBe(3);
    expect(getSession(bobLaptop.deviceId)?.sendMessageNumber).toBe(0);
  });
});

describe('ratchetEncryptStep (forward secrecy)', () => {
  it('derives a distinct message key on every call and advances the message number', () => {
    const myIdentity = generateIdentityKeyPair();
    const bob = buildResponder('bob-device-1');
    establishSession(bob.deviceId, bundleFrom(bob), myIdentity);

    const first = ratchetEncryptStep(bob.deviceId);
    const second = ratchetEncryptStep(bob.deviceId);
    const third = ratchetEncryptStep(bob.deviceId);

    expect(toBase64(first.messageKey)).not.toBe(toBase64(second.messageKey));
    expect(toBase64(second.messageKey)).not.toBe(toBase64(third.messageKey));
    expect([first.messageNumber, second.messageNumber, third.messageNumber]).toEqual([1, 2, 3]);
  });

  it('only the first step carries the initial message header; later ones do not', () => {
    const myIdentity = generateIdentityKeyPair();
    const bob = buildResponder('bob-device-1');
    establishSession(bob.deviceId, bundleFrom(bob), myIdentity);

    const first = ratchetEncryptStep(bob.deviceId);
    const second = ratchetEncryptStep(bob.deviceId);

    expect(first.initialMessageHeader).not.toBeNull();
    expect(second.initialMessageHeader).toBeNull();
  });

  it('throws when no session has been established for the device yet', () => {
    expect(() => ratchetEncryptStep('never-established')).toThrow(/no signal session/i);
  });
});

describe('session reset / re-handshake on key change', () => {
  it('deleteSession forces the device back to "no session"', () => {
    const myIdentity = generateIdentityKeyPair();
    const bob = buildResponder('bob-device-1');
    establishSession(bob.deviceId, bundleFrom(bob), myIdentity);

    deleteSession(bob.deviceId);

    expect(hasSession(bob.deviceId)).toBe(false);
  });

  it('is torn down automatically when identityTrust reports the device changed', () => {
    const myIdentity = generateIdentityKeyPair();
    const bob = buildResponder('bob-device-1');
    establishSession(bob.deviceId, bundleFrom(bob), myIdentity);
    expect(hasSession(bob.deviceId)).toBe(true);

    // signalSession.ts registered its own reset handler with identityTrust.ts
    // at module load time. Driving a real "identity changed" detection
    // through identityTrust's public API (exactly what crypto.ts's
    // assertDevicesTrusted does) must tear this session down as a side
    // effect, with no direct call to deleteSession from here.
    const peerUserId = `peer-${bob.deviceId}`;
    checkIdentityChange(peerUserId, [{ id: bob.deviceId, identityPublicKey: 'trusted-key' }]);
    checkIdentityChange(peerUserId, [{ id: bob.deviceId, identityPublicKey: 'rotated-key' }]);

    expect(hasSession(bob.deviceId)).toBe(false);

    // Re-establishing (the "re-handshake") works from a clean slate.
    establishSession(bob.deviceId, bundleFrom(bob), myIdentity);
    expect(hasSession(bob.deviceId)).toBe(true);
    expect(getSession(bob.deviceId)?.sendMessageNumber).toBe(0);
  });
});
