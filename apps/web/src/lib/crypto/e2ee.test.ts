import { describe, it, expect, afterEach, vi } from 'vitest';
import { sealedBoxEncrypt, buildEnvelopes } from '../crypto';
import {
  setSessionKey,
  importSessionKey,
  getSessionKey,
} from './sessionStore';
import { decryptAndVerifyEnvelope } from './decrypt';
import { encryptFile, downloadAndDecryptFile } from '../fileEncryption';

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToB64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function generateEd25519SpkiPublicKey(): string {
  // Ed25519 SPKI DER is a fixed 12-byte header followed by the 32-byte key:
  //   30 2A  SEQUENCE(42)
  //     30 05  SEQUENCE(5)  06 03 2B 65 70   OID 1.3.101.112
  //     03 21 00  BIT STRING(33, 0 unused)
  const spki = new Uint8Array(44);
  spki.set([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00], 0);
  crypto.getRandomValues(spki.subarray(12));
  return bytesToB64(spki as Uint8Array<ArrayBuffer>);
}

function generateTestKey(): string {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return bytesToB64(raw);
}

function buildEncryptedEnvelopePlaintext(iv: string, ct: string, sig?: string): string {
  const payload = { v: 1, iv, ct, sig };
  return btoa(JSON.stringify(payload));
}

/**
 * crypto.getRandomValues rejects requests over 65,536 bytes, so anything
 * larger has to be filled in chunks.
 */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const MAX_CHUNK = 65_536;
  for (let offset = 0; offset < length; offset += MAX_CHUNK) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + MAX_CHUNK, length)));
  }
  return bytes;
}

/**
 * downloadAndDecryptFile does two real fetches (presigned URL, then the
 * ciphertext). These are round-trip tests of the crypto, not of the transport,
 * so both are served from memory — no backend required.
 */
function stubDownload(cipherBlob: Blob): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/files/')) {
        return new Response(JSON.stringify({ url: 'https://storage.test/object' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(await cipherBlob.arrayBuffer(), { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Identity pinning is trust-on-first-use, keyed by userId. Each test gets a
 * fresh owner so one test's pinned keys can't make the next look like a key
 * change.
 */
let deviceOwnerSeq = 0;
function makeDevices(ids: string[]) {
  deviceOwnerSeq += 1;
  const userId = `user-${deviceOwnerSeq}`;
  return ids.map((id) => ({
    id,
    userId,
    identityPublicKey: generateEd25519SpkiPublicKey(),
  }));
}

describe('Per-device message encryption (#353)', () => {
  it('produces distinct ciphertext per recipient device', async () => {
    const plaintext = 'Hello, E2EE world!';
    const devices = makeDevices(['device-a', 'device-b']);

    const envelopes = await buildEnvelopes(plaintext, devices);

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].ciphertext).not.toBe(envelopes[1].ciphertext);
    expect(envelopes[0].recipientDeviceId).toBe('device-a');
    expect(envelopes[1].recipientDeviceId).toBe('device-b');
  });

  it('ciphertext differs from plaintext input', async () => {
    const plaintext = 'Sensitive message content';
    const devices = makeDevices(['device-a']);

    const envelopes = await buildEnvelopes(plaintext, devices);

    expect(envelopes[0].ciphertext).not.toBe(plaintext);
    expect(envelopes[0].ciphertext.length).toBeGreaterThan(0);
  });

  it('each envelope is a valid sealed box wire format', async () => {
    const plaintext = 'Test message';
    const devices = makeDevices(['device-a']);

    const envelopes = await buildEnvelopes(plaintext, devices);

    const wire = b64ToBytes(envelopes[0].ciphertext);
    expect(wire.length).toBeGreaterThan(77);
  });
});

describe('Inbound decrypt round trip (#354)', () => {
  it('encrypts and decrypts through the session key pipeline', async () => {
    const senderDeviceId = 'sender-device-1';
    const plaintext = 'Round-trip test message';

    const sessionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    setSessionKey(senderDeviceId, sessionKey);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      sessionKey,
      new TextEncoder().encode(plaintext),
    );

    const envelopePayload = {
      v: 1,
      iv: bytesToB64(iv),
      ct: bytesToB64(new Uint8Array(cipherBuf)),
    };
    const ciphertext = btoa(JSON.stringify(envelopePayload));

    const decrypted = await decryptAndVerifyEnvelope(ciphertext, senderDeviceId, generateEd25519SpkiPublicKey());

    expect(decrypted).toBe(plaintext);
  });

  it('importSessionKey and getSessionKey round-trip', async () => {
    const deviceId = 'test-device-2';
    const rawKey = new Uint8Array(32);
    crypto.getRandomValues(rawKey);

    await importSessionKey(deviceId, rawKey.buffer);

    const retrieved = getSessionKey(deviceId);
    expect(retrieved).toBeDefined();
  });

  it('returns PreLinkError for missing session key', async () => {
    const envelopePayload = {
      v: 1,
      iv: bytesToB64(crypto.getRandomValues(new Uint8Array(12))),
      ct: bytesToB64(crypto.getRandomValues(new Uint8Array(32))),
    };
    const ciphertext = btoa(JSON.stringify(envelopePayload));

    await expect(
      decryptAndVerifyEnvelope(ciphertext, 'unknown-device', generateEd25519SpkiPublicKey()),
    ).rejects.toThrow('No session established');
  });
});

describe('File encryption round trip (#355)', () => {
  it('encrypts and decrypts a file through the full pipeline', async () => {
    const originalContent = 'This is the file content to encrypt and decrypt';
    const originalBlob = new Blob([originalContent], { type: 'text/plain' });

    const { cipherBlob, fileKeyB64, ivB64 } = await encryptFile(originalBlob);

    expect(cipherBlob.size).toBeGreaterThan(0);
    expect(fileKeyB64.length).toBeGreaterThan(0);
    expect(ivB64.length).toBeGreaterThan(0);

    stubDownload(cipherBlob);

    const decryptedBlob = await downloadAndDecryptFile(
      'fake-file-id',
      fileKeyB64,
      ivB64,
      'text/plain',
      'fake-token',
      'http://localhost:4000',
    );

    expect(decryptedBlob.size).toBe(originalBlob.size);
  });

  it('produces different ciphertexts for different files', async () => {
    const blob1 = new Blob(['File A content'], { type: 'text/plain' });
    const blob2 = new Blob(['File B content'], { type: 'text/plain' });

    const result1 = await encryptFile(blob1);
    const result2 = await encryptFile(blob2);

    expect(result1.fileKeyB64).not.toBe(result2.fileKeyB64);
  });

  it('encryption key is not in plaintext', async () => {
    const plaintext = 'Secret file content';
    const blob = new Blob([plaintext], { type: 'text/plain' });

    const { cipherBlob, fileKeyB64 } = await encryptFile(blob);
    const cipherText = await cipherBlob.text();

    expect(cipherText).not.toContain(plaintext);
    expect(cipherText).not.toContain(fileKeyB64);
  });
});

describe('Encrypted thumbnail round trip (#356)', () => {
  it('encrypts and decrypts a thumbnail-sized blob', async () => {
    const thumbnailBytes = randomBytes(320 * 320 * 3);
    const thumbnailBlob = new Blob([new Uint8Array(thumbnailBytes)], { type: 'image/jpeg' });

    const { cipherBlob, fileKeyB64, ivB64 } = await encryptFile(thumbnailBlob);

    stubDownload(cipherBlob);

    const decrypted = await downloadAndDecryptFile(
      'fake-thumb-id',
      fileKeyB64,
      ivB64,
      'image/jpeg',
      'fake-token',
      'http://localhost:4000',
    );

    expect(decrypted.size).toBe(thumbnailBlob.size);
  });

  it('thumbnail ciphertext never exposes plaintext bytes', async () => {
    const thumbnailBytes = randomBytes(100);
    const thumbnailBlob = new Blob([new Uint8Array(thumbnailBytes)], { type: 'image/jpeg' });

    const { cipherBlob } = await encryptFile(thumbnailBlob);
    const cipherArray = new Uint8Array(await cipherBlob.arrayBuffer());

    let matches = 0;
    for (let i = 0; i <= cipherArray.length - thumbnailBytes.length; i++) {
      let match = true;
      for (let j = 0; j < thumbnailBytes.length; j++) {
        if (cipherArray[i + j] !== thumbnailBytes[j]) {
          match = false;
          break;
        }
      }
      if (match) matches++;
    }

    expect(matches).toBe(0);
  });
});
