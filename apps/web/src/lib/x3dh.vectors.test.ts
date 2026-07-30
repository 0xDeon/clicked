import { describe, expect, it, vi } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import {
  completeSession,
  generateIdentityKeyPair,
  generateOneTimePreKeys,
  generateSignedPreKey,
  initiateSession,
  rawEd25519PublicKeyToSpki,
  toBase64,
  type IdentityKeyPair,
  type PreKeyBundle,
  type PreKeyPair,
  type SignedPreKeyPair,
} from './x3dh';

const INITIATOR_SEED = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
const RESPONDER_SEED = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 33));
const SIGNED_PREKEY_SEED = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 65));
const ONE_TIME_PREKEY_SEED = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 97));
const EPHEMERAL_SEED = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 129));

const VECTOR = {
  signedPreKeyPublicKey: 'ZLEBsdC+WocEvQePmJUAH8A+jp+VIvGI3RKNmEbUhGY=',
  signedPreKeySignature:
    '/jM7lZDsd2BJbu7iYHLwOyDKCpVGdm//KwTQ4fiVOnldC3B3YyAFml30ItI0bI2ODA2z6IWNyD4YSR2uncrXAA==',
  oneTimePublicKey: 'JE/juWPomd0pW6/84kjTUw86mnR5ugYwAmgOv+etrUk=',
  ephemeralPublicKey: 'iDGGuAC0HVzwQpaV2ps8xPMo680YSm5IL6V4wQPwbHc=',
  sessionKey: '2o2Sw2R+H/hVzzTYZOp51jI/Sd9hdWeP7v47Hxvq4i0=',
  associatedData:
    'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmTn8WKhC+xVmv6hleTc6EtpVo1dLLCWPrRGwGheKxfy8A==',
};

function buildIdentity(seed: Uint8Array): IdentityKeyPair {
  return {
    privateKey: seed,
    publicKey: ed25519.getPublicKey(seed),
  };
}

function buildPreKey(seed: Uint8Array, keyId: number): PreKeyPair {
  return {
    keyId,
    privateKey: seed,
    publicKey: x25519.getPublicKey(seed),
  };
}

function buildSignedPreKey(identity: IdentityKeyPair, seed: Uint8Array, keyId: number): SignedPreKeyPair {
  const preKey = buildPreKey(seed, keyId);
  return {
    ...preKey,
    signature: ed25519.sign(preKey.publicKey, identity.privateKey),
  };
}

describe('X3DH known-answer vectors', () => {
  it('matches the fixed signed-prekey and session vector', () => {
    const initiatorIdentity = buildIdentity(INITIATOR_SEED);
    const responderIdentity = buildIdentity(RESPONDER_SEED);
    const signedPreKey = buildSignedPreKey(responderIdentity, SIGNED_PREKEY_SEED, 7);
    const oneTimePreKey = buildPreKey(ONE_TIME_PREKEY_SEED, 11);

    expect(toBase64(signedPreKey.publicKey)).toBe(VECTOR.signedPreKeyPublicKey);
    expect(toBase64(signedPreKey.signature)).toBe(VECTOR.signedPreKeySignature);
    expect(ed25519.verify(signedPreKey.signature, signedPreKey.publicKey, responderIdentity.publicKey)).toBe(
      true,
    );
    expect(toBase64(oneTimePreKey.publicKey)).toBe(VECTOR.oneTimePublicKey);

    const bundle: PreKeyBundle = {
      deviceId: 'device-2',
      identityPublicKey: toBase64(rawEd25519PublicKeyToSpki(responderIdentity.publicKey)),
      registrationId: 99,
      signedPreKey: {
        keyId: signedPreKey.keyId,
        publicKey: toBase64(signedPreKey.publicKey),
        signature: toBase64(signedPreKey.signature),
      },
      oneTimePreKey: {
        keyId: oneTimePreKey.keyId,
        publicKey: toBase64(oneTimePreKey.publicKey),
      },
    };

    const randomSecretSpy = vi
      .spyOn(x25519.utils, 'randomSecretKey')
      .mockReturnValueOnce(EPHEMERAL_SEED);

    const initiatorSession = initiateSession(bundle, initiatorIdentity);
    randomSecretSpy.mockRestore();

    expect(toBase64(initiatorSession.ephemeralPublicKey)).toBe(VECTOR.ephemeralPublicKey);
    expect(toBase64(initiatorSession.sessionKey)).toBe(VECTOR.sessionKey);
    expect(toBase64(initiatorSession.associatedData)).toBe(VECTOR.associatedData);

    const responderSession = completeSession(
      {
        senderIdentityPublicKey: toBase64(rawEd25519PublicKeyToSpki(initiatorIdentity.publicKey)),
        ephemeralPublicKey: toBase64(initiatorSession.ephemeralPublicKey),
        usedSignedPreKeyId: signedPreKey.keyId,
        usedOneTimePreKeyId: oneTimePreKey.keyId,
      },
      responderIdentity,
      signedPreKey,
      oneTimePreKey,
    );

    expect(toBase64(responderSession.sessionKey)).toBe(VECTOR.sessionKey);
  });

  it('generates structurally valid key material with the helper APIs', () => {
    const identity = generateIdentityKeyPair();
    const signedPreKey = generateSignedPreKey(identity, 42);
    const oneTimePreKeys = generateOneTimePreKeys(100, 2);

    expect(identity.privateKey).toHaveLength(32);
    expect(identity.publicKey).toHaveLength(32);
    expect(signedPreKey.publicKey).toHaveLength(32);
    expect(signedPreKey.signature).toHaveLength(64);
    expect(ed25519.verify(signedPreKey.signature, signedPreKey.publicKey, identity.publicKey)).toBe(
      true,
    );
    expect(oneTimePreKeys.map((key) => key.keyId)).toEqual([100, 101]);
    expect(new Set(oneTimePreKeys.map((key) => toBase64(key.publicKey))).size).toBe(2);
  });
});
