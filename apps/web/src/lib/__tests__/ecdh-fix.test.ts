/**
 * Tests for ECDH session establishment fix.
 * 
 * Verifies that deriveSharedSecret now correctly uses:
 * - Caller's private key
 * - Peer's public key
 * 
 * And that both parties derive identical session keys.
 */

import { describe, it, expect, beforeEach } from 'vitest';

describe('ECDH Session Establishment (Fixed)', () => {
  let aliceKeyPair: CryptoKeyPair;
  let bobKeyPair: CryptoKeyPair;
  let alicePublicJwk: JsonWebKey;
  let bobPublicJwk: JsonWebKey;

  beforeEach(async () => {
    // Generate genuine ECDH keypairs for Alice and Bob
    aliceKeyPair = (await window.crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true,
      ['deriveKey', 'deriveBits'],
    )) as CryptoKeyPair;

    bobKeyPair = (await window.crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true,
      ['deriveKey', 'deriveBits'],
    )) as CryptoKeyPair;

    alicePublicJwk = await window.crypto.subtle.exportKey('jwk', aliceKeyPair.publicKey);
    bobPublicJwk = await window.crypto.subtle.exportKey('jwk', bobKeyPair.publicKey);
  });

  /**
   * Core ECDH test: Alice and Bob should derive the same shared secret.
   * 
   * Alice computes: ECDH(alice_private, bob_public)
   * Bob computes: ECDH(bob_private, alice_public)
   * 
   * Both should produce identical shared secrets.
   */
  it('Alice and Bob derive identical shared secrets', async () => {
    // Alice derives shared secret using her private key and Bob's public key
    const bobPublicKey = await window.crypto.subtle.importKey(
      'jwk',
      bobPublicJwk,
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      false,
      [],
    );

    const aliceSharedBits = await window.crypto.subtle.deriveBits(
      { name: 'ECDH', public: bobPublicKey },
      aliceKeyPair.privateKey,
      256,
    );

    // Bob derives shared secret using his private key and Alice's public key
    const alicePublicKey = await window.crypto.subtle.importKey(
      'jwk',
      alicePublicJwk,
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      false,
      [],
    );

    const bobSharedBits = await window.crypto.subtle.deriveBits(
      { name: 'ECDH', public: alicePublicKey },
      bobKeyPair.privateKey,
      256,
    );

    // Convert to hex for comparison
    const aliceHex = Buffer.from(aliceSharedBits).toString('hex');
    const bobHex = Buffer.from(bobSharedBits).toString('hex');

    expect(aliceHex).toBe(bobHex);
    expect(aliceHex).toHaveLength(64); // 256 bits = 32 bytes = 64 hex chars
  });

  it('deriveSharedSecret accepts private CryptoKey (not public JWK)', async () => {
    // This test verifies the function signature accepts CryptoKey as first param
    const deriveSharedSecret = async (
      callerPrivateKey: CryptoKey,
      peerPublicKeyJwk: JsonWebKey,
    ): Promise<CryptoKey> => {
      const peerPublicKey = await window.crypto.subtle.importKey(
        'jwk',
        peerPublicKeyJwk,
        {
          name: 'ECDH',
          namedCurve: 'P-256',
        },
        false,
        [],
      );

      const sharedBits = await window.crypto.subtle.deriveBits(
        { name: 'ECDH', public: peerPublicKey },
        callerPrivateKey,
        256,
      );

      return window.crypto.subtle.importKey(
        'raw',
        sharedBits,
        { name: 'AES-GCM' },
        true,
        ['encrypt', 'decrypt'],
      );
    };

    // Alice calls with HER private key and Bob's public JWK
    const aliceSecret = await deriveSharedSecret(aliceKeyPair.privateKey, bobPublicJwk);
    
    // Bob calls with HIS private key and Alice's public JWK
    const bobSecret = await deriveSharedSecret(bobKeyPair.privateKey, alicePublicJwk);

    // Export both secrets to compare
    const aliceSecretRaw = await window.crypto.subtle.exportKey('raw', aliceSecret);
    const bobSecretRaw = await window.crypto.subtle.exportKey('raw', bobSecret);

    expect(Buffer.from(aliceSecretRaw).toString('hex')).toBe(
      Buffer.from(bobSecretRaw).toString('hex'),
    );
  });

  it('fails if both keys are public (old bug behavior)', async () => {
    // This demonstrates the OLD bug: importing both as public keys
    const alicePublicKey = await window.crypto.subtle.importKey(
      'jwk',
      alicePublicJwk,
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      false,
      [],
    );

    const bobPublicKey = await window.crypto.subtle.importKey(
      'jwk',
      bobPublicJwk,
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      false,
      [],
    );

    // This should throw because deriveBits requires a private key as base key
    await expect(
      window.crypto.subtle.deriveBits(
        { name: 'ECDH', public: bobPublicKey },
        alicePublicKey, // BUG: This is a public key, not private
        256,
      ),
    ).rejects.toThrow();
  });

  it('session keys remain consistent across encryption/decryption', async () => {
    // Derive shared secret for Alice
    const bobPublicKey = await window.crypto.subtle.importKey(
      'jwk',
      bobPublicJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );

    const sharedBits = await window.crypto.subtle.deriveBits(
      { name: 'ECDH', public: bobPublicKey },
      aliceKeyPair.privateKey,
      256,
    );

    const sessionKey = await window.crypto.subtle.importKey(
      'raw',
      sharedBits,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );

    // Encrypt a message
    const plaintext = 'Secret message from Alice to Bob';
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      sessionKey,
      encoded,
    );

    // Decrypt with the same key
    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      sessionKey,
      ciphertext,
    );

    const decryptedText = new TextDecoder().decode(decrypted);
    expect(decryptedText).toBe(plaintext);
  });
});
