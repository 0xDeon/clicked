import { describe, it, expect } from 'vitest';
import {
  generateIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
  initiateSession,
  completeSession,
  rawEd25519PublicKeyToSpki,
  spkiToRawEd25519PublicKey,
  toBase64,
  fromBase64,
  type PreKeyBundle,
} from './x3dh';

function buildResponder() {
  const identity = generateIdentityKeyPair();
  const signedPreKey = generateSignedPreKey(identity, 1);
  const [oneTimePreKey] = generateOneTimePreKeys(1, 1);
  return { identity, signedPreKey, oneTimePreKey: oneTimePreKey! };
}

function bundleFrom(
  responder: ReturnType<typeof buildResponder>,
  { includeOtp = true }: { includeOtp?: boolean } = {},
): PreKeyBundle {
  return {
    deviceId: 'responder-device',
    identityPublicKey: toBase64(rawEd25519PublicKeyToSpki(responder.identity.publicKey)),
    registrationId: 7,
    signedPreKey: {
      keyId: responder.signedPreKey.keyId,
      publicKey: toBase64(responder.signedPreKey.publicKey),
      signature: toBase64(responder.signedPreKey.signature),
    },
    oneTimePreKey: includeOtp
      ? {
          keyId: responder.oneTimePreKey.keyId,
          publicKey: toBase64(responder.oneTimePreKey.publicKey),
        }
      : null,
  };
}

describe('SPKI <-> raw Ed25519 conversion', () => {
  it('round-trips', () => {
    const { publicKey } = generateIdentityKeyPair();
    const spki = rawEd25519PublicKeyToSpki(publicKey);
    expect(spki.length).toBe(44);
    expect(spkiToRawEd25519PublicKey(spki)).toEqual(publicKey);
  });

  it('rejects the wrong length', () => {
    expect(() => spkiToRawEd25519PublicKey(new Uint8Array(10))).toThrow();
  });
});

describe('X3DH session establishment', () => {
  it('initiator and responder derive the same session key (4-DH, with OTP)', () => {
    const initiatorIdentity = generateIdentityKeyPair();
    const responder = buildResponder();
    const bundle = bundleFrom(responder);

    const initiatorSession = initiateSession(bundle, initiatorIdentity);

    const header = {
      senderIdentityPublicKey: toBase64(rawEd25519PublicKeyToSpki(initiatorIdentity.publicKey)),
      ephemeralPublicKey: toBase64(initiatorSession.ephemeralPublicKey),
      usedSignedPreKeyId: responder.signedPreKey.keyId,
      usedOneTimePreKeyId: responder.oneTimePreKey.keyId,
    };

    const responderSession = completeSession(
      header,
      responder.identity,
      responder.signedPreKey,
      responder.oneTimePreKey,
    );

    expect(toBase64(responderSession.sessionKey)).toBe(toBase64(initiatorSession.sessionKey));
    expect(responderSession.usedOneTimePreKeyId).toBe(responder.oneTimePreKey.keyId);
  });

  it('falls back to 3-DH and still converges when no OTP is available', () => {
    const initiatorIdentity = generateIdentityKeyPair();
    const responder = buildResponder();
    const bundle = bundleFrom(responder, { includeOtp: false });

    const initiatorSession = initiateSession(bundle, initiatorIdentity);
    expect(initiatorSession.usedOneTimePreKeyId).toBeNull();

    const header = {
      senderIdentityPublicKey: toBase64(rawEd25519PublicKeyToSpki(initiatorIdentity.publicKey)),
      ephemeralPublicKey: toBase64(initiatorSession.ephemeralPublicKey),
      usedSignedPreKeyId: responder.signedPreKey.keyId,
      usedOneTimePreKeyId: null,
    };

    const responderSession = completeSession(header, responder.identity, responder.signedPreKey);

    expect(toBase64(responderSession.sessionKey)).toBe(toBase64(initiatorSession.sessionKey));
  });

  it('rejects a bundle with a tampered signed-prekey signature', () => {
    const initiatorIdentity = generateIdentityKeyPair();
    const responder = buildResponder();
    const bundle = bundleFrom(responder);
    const tamperedPublicKey = fromBase64(bundle.signedPreKey.publicKey);
    tamperedPublicKey[0] ^= 0xff;
    bundle.signedPreKey.publicKey = toBase64(tamperedPublicKey);

    expect(() => initiateSession(bundle, initiatorIdentity)).toThrow(/signature/i);
  });

  it('throws when completing a session without the matching cached one-time prekey', () => {
    const initiatorIdentity = generateIdentityKeyPair();
    const responder = buildResponder();
    const bundle = bundleFrom(responder);
    const initiatorSession = initiateSession(bundle, initiatorIdentity);

    const header = {
      senderIdentityPublicKey: toBase64(rawEd25519PublicKeyToSpki(initiatorIdentity.publicKey)),
      ephemeralPublicKey: toBase64(initiatorSession.ephemeralPublicKey),
      usedSignedPreKeyId: responder.signedPreKey.keyId,
      usedOneTimePreKeyId: responder.oneTimePreKey.keyId,
    };

    expect(() =>
      completeSession(header, responder.identity, responder.signedPreKey, undefined),
    ).toThrow(/one-time prekey/i);
  });
});
