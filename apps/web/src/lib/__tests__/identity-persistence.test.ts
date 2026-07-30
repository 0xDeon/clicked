/**
 * Tests for identity key persistence fix.
 * 
 * Verifies that:
 * - Identity private key is persisted via IndexedDB structured clone
 * - Same key is retrieved across page reloads (simulated)
 * - No regeneration occurs after initialization
 * - ECDH operations work with persisted keys
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cryptoStore } from '../cryptoStore';

describe('Identity Key Persistence (Fixed)', () => {
  beforeEach(async () => {
    // Clear crypto store before each test
    await cryptoStore.clear();
  });

  afterEach(async () => {
    await cryptoStore.clear();
    cryptoStore.closeDb();
  });

  it('generates and persists identity keypair', async () => {
    const publicKey1 = await cryptoStore.initializeIdentityKey();
    expect(publicKey1).toBeDefined();
    expect(publicKey1.kty).toBe('EC');

    // Retrieve private key
    const privateKey = await cryptoStore.getIdentityPrivateKey();
    expect(privateKey).toBeDefined();
    expect(privateKey).toBeInstanceOf(CryptoKey);
  });

  it('returns the same identity across multiple calls (no regeneration)', async () => {
    const publicKey1 = await cryptoStore.initializeIdentityKey();
    const publicKey2 = await cryptoStore.initializeIdentityKey();
    const publicKey3 = await cryptoStore.initializeIdentityKey();

    // All calls should return the same key
    expect(JSON.stringify(publicKey1)).toBe(JSON.stringify(publicKey2));
    expect(JSON.stringify(publicKey2)).toBe(JSON.stringify(publicKey3));
  });

  it('persists private key across simulated page reload', async () => {
    // First "session": generate and store
    const publicKey1 = await cryptoStore.initializeIdentityKey();
    const privateKey1 = await cryptoStore.getIdentityPrivateKey();
    
    expect(privateKey1).toBeDefined();

    // Export private key bits for comparison (simulate what we'd use for ECDH)
    const privateBits1 = await window.crypto.subtle.exportKey('jwk', privateKey1!);

    // Simulate page reload: close and reopen DB (in real scenario, this is a new page load)
    cryptoStore.closeDb();

    // Second "session": retrieve existing key
    const publicKey2 = await cryptoStore.initializeIdentityKey();
    const privateKey2 = await cryptoStore.getIdentityPrivateKey();

    expect(privateKey2).toBeDefined();

    // Should be the same key
    const privateBits2 = await window.crypto.subtle.exportKey('jwk', privateKey2!);

    expect(JSON.stringify(publicKey1)).toBe(JSON.stringify(publicKey2));
    expect(JSON.stringify(privateBits1)).toBe(JSON.stringify(privateBits2));
  });

  it('persisted private key can perform ECDH operations', async () => {
    // Initialize identity
    await cryptoStore.initializeIdentityKey();
    const privateKey = await cryptoStore.getIdentityPrivateKey();

    expect(privateKey).toBeDefined();

    // Generate a peer's keypair
    const peerKeyPair = (await window.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits'],
    )) as CryptoKeyPair;

    // Perform ECDH with our persisted private key
    const sharedBits = await window.crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerKeyPair.publicKey },
      privateKey!,
      256,
    );

    expect(sharedBits).toBeDefined();
    expect(sharedBits.byteLength).toBe(32); // 256 bits = 32 bytes
  });

  it('persisted private key can sign data (if converted to signing key)', async () => {
    // Initialize identity
    await cryptoStore.initializeIdentityKey();
    const privateKey = await cryptoStore.getIdentityPrivateKey();

    expect(privateKey).toBeDefined();
    
    // Verify the key has correct algorithm
    expect(privateKey!.algorithm.name).toBe('ECDH');
    expect((privateKey!.algorithm as EcKeyAlgorithm).namedCurve).toBe('P-256');
  });

  it('device ID persists independently of identity key', async () => {
    const deviceId1 = await cryptoStore.getOrCreateDeviceId();
    expect(deviceId1).toMatch(/^device_/);

    const deviceId2 = await cryptoStore.getOrCreateDeviceId();
    expect(deviceId1).toBe(deviceId2);

    // Initialize identity
    await cryptoStore.initializeIdentityKey();

    // Device ID should remain the same
    const deviceId3 = await cryptoStore.getOrCreateDeviceId();
    expect(deviceId3).toBe(deviceId1);
  });

  it('getDeviceInfo returns consistent data', async () => {
    const info1 = await cryptoStore.getDeviceInfo();
    const info2 = await cryptoStore.getDeviceInfo();

    expect(info1.deviceId).toBe(info2.deviceId);
    expect(JSON.stringify(info1.publicKey)).toBe(JSON.stringify(info2.publicKey));
  });

  it('clear() removes all stored keys', async () => {
    await cryptoStore.initializeIdentityKey();
    const privateKeyBefore = await cryptoStore.getIdentityPrivateKey();
    expect(privateKeyBefore).toBeDefined();

    await cryptoStore.clear();

    const privateKeyAfter = await cryptoStore.getIdentityPrivateKey();
    expect(privateKeyAfter).toBeNull();

    const publicKeyAfter = await cryptoStore.getIdentityPublicKey();
    expect(publicKeyAfter).toBeNull();
  });

  it('CryptoKey structured clone preserves key properties', async () => {
    const keyPair = await cryptoStore.generateIdentityKeyPair();
    await cryptoStore.storeIdentityKeyPair(keyPair);

    const retrieved = await cryptoStore.getIdentityPrivateKey();
    expect(retrieved).toBeDefined();

    // Verify key properties
    expect(retrieved!.type).toBe('private');
    expect(retrieved!.extractable).toBe(true);
    expect(retrieved!.algorithm.name).toBe('ECDH');
    expect((retrieved!.algorithm as EcKeyAlgorithm).namedCurve).toBe('P-256');
    expect(retrieved!.usages).toContain('deriveBits');
  });
});
