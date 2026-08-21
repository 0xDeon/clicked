import {
  DecryptError,
  PreLinkError,
  VerificationFailedError,
  type EncryptedEnvelopePayload,
} from './types';
import { getSessionKey } from './sessionStore';

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function concatBytes(
  a: Uint8Array<ArrayBuffer>,
  b: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function parseEnvelopePayload(ciphertext: string): EncryptedEnvelopePayload {
  let parsed: unknown;
  try {
    const json = new TextDecoder().decode(base64ToBytes(ciphertext));
    parsed = JSON.parse(json);
  } catch {
    throw new DecryptError('Invalid envelope format');
  }

  const payload = parsed as Partial<EncryptedEnvelopePayload>;
  if (payload.v !== 1 || !payload.iv || !payload.ct) {
    throw new DecryptError('Unsupported envelope version');
  }

  return payload as EncryptedEnvelopePayload;
}

async function importIdentityPublicKey(spkiB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', base64ToBytes(spkiB64), { name: 'Ed25519' }, false, [
    'verify',
  ]);
}

async function verifyEnvelopeSignature(
  identityPublicKeyB64: string,
  iv: string,
  ct: string,
  sigB64: string,
): Promise<boolean> {
  const key = await importIdentityPublicKey(identityPublicKeyB64);
  const message = concatBytes(base64ToBytes(iv), base64ToBytes(ct));
  return crypto.subtle.verify('Ed25519', key, base64ToBytes(sigB64), message);
}

/**
 * Decrypt and verify an inbound envelope ciphertext.
 *
 * 1. Parse the base64 JSON envelope payload.
 * 2. Verify the Ed25519 signature against the sender identity key.
 * 3. Decrypt the body with the in-memory session AES key.
 *
 * Throws PreLinkError when no session exists (pre-link message).
 */
export async function decryptAndVerifyEnvelope(
  ciphertext: string,
  senderDeviceId: string,
  senderIdentityPublicKey: string,
): Promise<string> {
  const payload = parseEnvelopePayload(ciphertext);

  if (payload.sig) {
    const valid = await verifyEnvelopeSignature(
      senderIdentityPublicKey,
      payload.iv,
      payload.ct,
      payload.sig,
    );
    if (!valid) {
      throw new VerificationFailedError();
    }
  }

  const sessionKey = getSessionKey(senderDeviceId);
  if (!sessionKey) {
    throw new PreLinkError();
  }

  try {
    const plaintextBytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
      sessionKey,
      base64ToBytes(payload.ct),
    );
    return new TextDecoder().decode(plaintextBytes);
  } catch {
    throw new DecryptError();
  }
}
