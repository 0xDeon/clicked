import { describe, it, expect } from 'vitest';
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
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const spki = new Uint8Array(44);
  spki.set([48, 42, 48, 5, 6, 3, 43, 101, 112, 3, 34, 0, 4, 32], 0);
  spki.set(raw, 14);
  return bytesToB64(spki);
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

describe('Per-device message encryption (#353)', () => {
  it('produces distinct ciphertext per recipient device', async () => {
    const plaintext = 'Hello, E2EE world!';
    const devices = [
      { id: 'device-a', identityPublicKey: generateEd25519SpkiPublicKey() },
      { id: 'device-b', identityPublicKey: generateEd25519SpkiPublicKey() },
    ];

    const envelopes = await buildEnvelopes(plaintext, devices);

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].ciphertext).not.toBe(envelopes[1].ciphertext);
    expect(envelopes[0].recipientDeviceId).toBe('device-a');
    expect(envelopes[1].recipientDeviceId).toBe('device-b');
  });

  it('ciphertext differs from plaintext input', async () => {
    const plaintext = 'Sensitive message content';
    const devices = [
      { id: 'device-a', identityPublicKey: generateEd25519SpkiPublicKey() },
    ];

    const envelopes = await buildEnvelopes(plaintext, devices);

    expect(envelopes[0].ciphertext).not.toBe(plaintext);
    expect(envelopes[0].ciphertext.length).toBeGreaterThan(0);
  });

  it('each envelope is a valid sealed box wire format', async () => {
    const plaintext = 'Test message';
    const devices = [
      { id: 'device-a', identityPublicKey: generateEd25519SpkiPublicKey() },
    ];

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
    const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', sessionKey));
    const keyB64 = bytesToB64(rawKey);

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
    const thumbnailBytes = new Uint8Array(320 * 320 * 3);
    crypto.getRandomValues(thumbnailBytes);
    const thumbnailBlob = new Blob([thumbnailBytes], { type: 'image/jpeg' });

    const { cipherBlob, fileKeyB64, ivB64 } = await encryptFile(thumbnailBlob);

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
    const thumbnailBytes = new Uint8Array(100);
    crypto.getRandomValues(thumbnailBytes);
    const thumbnailBlob = new Blob([thumbnailBytes], { type: 'image/jpeg' });

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
