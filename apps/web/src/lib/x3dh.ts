/**
 * X3DH (Extended Triple Diffie-Hellman) session establishment, issue #305.
 *
 * Identity keys are Ed25519 (used by the backend to verify signed-prekey
 * signatures, see apps/backend/src/lib/keys.ts). DH itself needs Montgomery
 * (X25519) keys, so identity keys are converted via the standard
 * birational Edwards<->Montgomery map (`edwardsToMontgomery*`) instead of
 * maintaining a second identity keypair.
 *
 * Wire format:
 *  - identityPublicKey: base64 SPKI DER (44 bytes: 12-byte Ed25519 SPKI
 *    header + 32-byte raw key), matching apps/backend/src/lib/keys.ts.
 *  - signed/one-time prekey publicKey + signature: base64 raw bytes
 *    (32 / 64 bytes).
 */

import { ed25519, x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { randomBytes } from '@noble/hashes/utils';

// ─── Wire format helpers ────────────────────────────────────────────────────

// RFC 8410 SPKI header for an Ed25519 public key (OID 1.3.101.112).
const ED25519_SPKI_HEADER = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function rawEd25519PublicKeyToSpki(rawPublicKey: Uint8Array): Uint8Array {
  const spki = new Uint8Array(ED25519_SPKI_HEADER.length + rawPublicKey.length);
  spki.set(ED25519_SPKI_HEADER, 0);
  spki.set(rawPublicKey, ED25519_SPKI_HEADER.length);
  return spki;
}

export function spkiToRawEd25519PublicKey(spki: Uint8Array): Uint8Array {
  if (spki.length !== ED25519_SPKI_HEADER.length + 32) {
    throw new Error(`Expected a 44-byte Ed25519 SPKI key, got ${spki.length} bytes`);
  }
  return spki.slice(ED25519_SPKI_HEADER.length);
}

// ─── Key generation ─────────────────────────────────────────────────────────

export interface IdentityKeyPair {
  privateKey: Uint8Array; // 32-byte Ed25519 seed
  publicKey: Uint8Array; // 32-byte raw Ed25519 public key
}

export interface PreKeyPair {
  keyId: number;
  privateKey: Uint8Array; // 32-byte X25519 private key
  publicKey: Uint8Array; // 32-byte X25519 public key
}

export interface SignedPreKeyPair extends PreKeyPair {
  signature: Uint8Array; // 64-byte Ed25519 signature over publicKey
}

export function generateIdentityKeyPair(): IdentityKeyPair {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function generateSignedPreKey(identity: IdentityKeyPair, keyId: number): SignedPreKeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const signature = ed25519.sign(publicKey, identity.privateKey);
  return { keyId, privateKey, publicKey, signature };
}

export function generateOneTimePreKeys(startKeyId: number, count: number): PreKeyPair[] {
  return Array.from({ length: count }, (_, i) => {
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    return { keyId: startKeyId + i, privateKey, publicKey };
  });
}

// ─── X3DH ───────────────────────────────────────────────────────────────────

export interface PreKeyBundle {
  deviceId: string;
  identityPublicKey: string; // base64 SPKI
  registrationId: number | null;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  oneTimePreKey: { keyId: number; publicKey: string } | null;
}

export interface X3dhSession {
  sessionKey: Uint8Array; // 32-byte SK from HKDF
  associatedData: Uint8Array; // IK_a || IK_b, for use as AD by the ratchet
  ephemeralPublicKey: Uint8Array; // EK_a, to send in the initial message
  usedOneTimePreKeyId: number | null;
}

const HKDF_INFO = new TextEncoder().encode('X3DH');
// Signal-spec domain-separation prefix: 32 0xFF bytes prepended to the DH
// concatenation, defending against a small-order-point identity-key attack.
const HKDF_PREFIX = new Uint8Array(32).fill(0xff);

function deriveSessionKey(dhConcat: Uint8Array): Uint8Array {
  const ikm = new Uint8Array(HKDF_PREFIX.length + dhConcat.length);
  ikm.set(HKDF_PREFIX, 0);
  ikm.set(dhConcat, HKDF_PREFIX.length);
  return hkdf(sha256, ikm, undefined, HKDF_INFO, 32);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Initiator side: establish a session with `bundle` fetched from
 * GET /devices/:id/bundle. Verifies the signed prekey before using it.
 */
export function initiateSession(bundle: PreKeyBundle, myIdentity: IdentityKeyPair): X3dhSession {
  const theirIdentityRawEd = spkiToRawEd25519PublicKey(fromBase64(bundle.identityPublicKey));
  const theirSpkPub = fromBase64(bundle.signedPreKey.publicKey);
  const theirSpkSig = fromBase64(bundle.signedPreKey.signature);

  if (!ed25519.verify(theirSpkSig, theirSpkPub, theirIdentityRawEd)) {
    throw new Error('Signed prekey signature verification failed — refusing to start session');
  }

  const ephemeral = x25519.utils.randomSecretKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeral);

  const myIdentityX25519Priv = ed25519.utils.toMontgomerySecret(myIdentity.privateKey);
  const theirIdentityX25519Pub = ed25519.utils.toMontgomery(theirIdentityRawEd);

  const dh1 = x25519.getSharedSecret(myIdentityX25519Priv, theirSpkPub);
  const dh2 = x25519.getSharedSecret(ephemeral, theirIdentityX25519Pub);
  const dh3 = x25519.getSharedSecret(ephemeral, theirSpkPub);

  const dh4 = bundle.oneTimePreKey
    ? x25519.getSharedSecret(ephemeral, fromBase64(bundle.oneTimePreKey.publicKey))
    : new Uint8Array(0);

  const sessionKey = deriveSessionKey(concatBytes(dh1, dh2, dh3, dh4));

  return {
    sessionKey,
    associatedData: concatBytes(myIdentity.publicKey, theirIdentityRawEd),
    ephemeralPublicKey,
    usedOneTimePreKeyId: bundle.oneTimePreKey?.keyId ?? null,
  };
}

export interface InitialMessageHeader {
  senderIdentityPublicKey: string; // base64 SPKI
  ephemeralPublicKey: string; // base64 raw
  usedSignedPreKeyId: number;
  usedOneTimePreKeyId: number | null;
}

/**
 * Responder side: derive the same session key from the initiator's initial
 * message header plus this device's own (cached) prekey material.
 * `myOneTimePreKey` must be the locally-cached private key matching the
 * keyId the initiator claims to have consumed — the server has already
 * deleted that row by the time this runs.
 */
export function completeSession(
  header: InitialMessageHeader,
  myIdentity: IdentityKeyPair,
  mySignedPreKey: SignedPreKeyPair,
  myOneTimePreKey?: PreKeyPair,
): X3dhSession {
  if (header.usedOneTimePreKeyId !== null) {
    if (!myOneTimePreKey || myOneTimePreKey.keyId !== header.usedOneTimePreKeyId) {
      throw new Error('Missing local one-time prekey matching the initial message');
    }
  }

  const theirIdentityRawEd = spkiToRawEd25519PublicKey(fromBase64(header.senderIdentityPublicKey));
  const theirEphemeralPub = fromBase64(header.ephemeralPublicKey);

  const myIdentityX25519Priv = ed25519.utils.toMontgomerySecret(myIdentity.privateKey);
  const theirIdentityX25519Pub = ed25519.utils.toMontgomery(theirIdentityRawEd);

  const dh1 = x25519.getSharedSecret(mySignedPreKey.privateKey, theirIdentityX25519Pub);
  const dh2 = x25519.getSharedSecret(myIdentityX25519Priv, theirEphemeralPub);
  const dh3 = x25519.getSharedSecret(mySignedPreKey.privateKey, theirEphemeralPub);

  const dh4 =
    header.usedOneTimePreKeyId !== null && myOneTimePreKey
      ? x25519.getSharedSecret(myOneTimePreKey.privateKey, theirEphemeralPub)
      : new Uint8Array(0);

  const sessionKey = deriveSessionKey(concatBytes(dh1, dh2, dh3, dh4));

  return {
    sessionKey,
    associatedData: concatBytes(theirIdentityRawEd, myIdentity.publicKey),
    ephemeralPublicKey: theirEphemeralPub,
    usedOneTimePreKeyId: header.usedOneTimePreKeyId,
  };
}

export { randomBytes };
