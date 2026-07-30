import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { buildEnvelopes, sealedBoxEncrypt, type DeviceRecord } from './crypto';

function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function decryptSealedBox(
  ciphertextB64: string,
  recipientPrivateKey: CryptoKey,
): Promise<string> {
  const packed = b64ToBytes(ciphertextB64);
  const ephemeralPub = packed.slice(0, 65);
  const iv = packed.slice(65, 77);
  const ciphertext = packed.slice(77);

  const ephemeralKey = await crypto.subtle.importKey(
    'raw',
    ephemeralPub,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: ephemeralKey },
    recipientPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
  return new TextDecoder().decode(plaintext);
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('atob', (value: string) => Buffer.from(value, 'base64').toString('binary'));
  vi.stubGlobal('btoa', (value: string) => Buffer.from(value, 'binary').toString('base64'));
});

describe('sealed-box crypto', () => {
  it('round-trips a message for a single recipient without a backend', async () => {
    const recipient = (await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey'],
    )) as CryptoKeyPair;
    const recipientPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', recipient.publicKey));

    const ciphertext = await sealedBoxEncrypt('hello from clicked', bytesToB64(recipientPublicKey));
    const plaintext = await decryptSealedBox(ciphertext, recipient.privateKey);

    expect(plaintext).toBe('hello from clicked');
    expect(b64ToBytes(ciphertext).length).toBeGreaterThan(77);
  });

  it('builds decryptable envelopes for every target device', async () => {
    const recipients = await Promise.all(
      Array.from({ length: 2 }, async (_, index) => {
        const keyPair = (await crypto.subtle.generateKey(
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          ['deriveKey'],
        )) as CryptoKeyPair;
        const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
        return {
          device: {
            id: `device-${index + 1}`,
            identityPublicKey: bytesToB64(publicKey),
          } satisfies DeviceRecord,
          privateKey: keyPair.privateKey,
        };
      }),
    );

    const envelopes = await buildEnvelopes(
      'per-device payload',
      recipients.map((recipient) => recipient.device),
    );

    expect(envelopes).toHaveLength(2);
    await Promise.all(
      envelopes.map(async (envelope) => {
        const recipient = recipients.find((candidate) => candidate.device.id === envelope.recipientDeviceId);
        expect(recipient).toBeDefined();
        await expect(decryptSealedBox(envelope.ciphertext, recipient!.privateKey)).resolves.toBe(
          'per-device payload',
        );
      }),
    );
  });
});
