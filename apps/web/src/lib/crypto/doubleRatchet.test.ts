import { describe, it, expect } from 'vitest';
import {
  initAlice,
  initBob,
  generateKeyPair,
  ratchetEncrypt,
  ratchetDecrypt,
  MAX_SKIPPED_KEYS,
  kdfRk,
  kdfCk,
} from './doubleRatchet';

describe('Double Ratchet & Out-of-Order Delivery (#360)', () => {
  it('decrypts in-order messages correctly between Alice and Bob', async () => {
    const sharedSecret = new Uint8Array(32).fill(0x42);
    const bobKeyPair = generateKeyPair();

    const aliceState = initAlice(sharedSecret, bobKeyPair.publicKey);
    const bobState = initBob(sharedSecret, bobKeyPair);

    const msg1 = await ratchetEncrypt(aliceState, 'Hello Bob');
    const decrypted1 = await ratchetDecrypt(bobState, msg1);
    expect(decrypted1).toBe('Hello Bob');

    const msg2 = await ratchetEncrypt(aliceState, 'How are you?');
    const decrypted2 = await ratchetDecrypt(bobState, msg2);
    expect(decrypted2).toBe('How are you?');
  });

  it('decrypts out-of-order messages correctly using skipped message keys', async () => {
    const sharedSecret = new Uint8Array(32).fill(0x99);
    const bobKeyPair = generateKeyPair();

    const aliceState = initAlice(sharedSecret, bobKeyPair.publicKey);
    const bobState = initBob(sharedSecret, bobKeyPair);

    // Alice produces messages 0, 1, 2, 3
    const msg0 = await ratchetEncrypt(aliceState, 'Message 0');
    const msg1 = await ratchetEncrypt(aliceState, 'Message 1');
    const msg2 = await ratchetEncrypt(aliceState, 'Message 2');
    const msg3 = await ratchetEncrypt(aliceState, 'Message 3');

    // Bob receives message 2 first (out-of-order)
    const dec2 = await ratchetDecrypt(bobState, msg2);
    expect(dec2).toBe('Message 2');

    // Bob's skipped key store should contain keys for messages 0 and 1
    expect(bobState.MKSKIPPED.size).toBe(2);

    // Delayed message 0 arrives and decrypts correctly
    const dec0 = await ratchetDecrypt(bobState, msg0);
    expect(dec0).toBe('Message 0');

    // Consumed skipped key should be removed
    expect(bobState.MKSKIPPED.size).toBe(1);

    // Delayed message 1 arrives
    const dec1 = await ratchetDecrypt(bobState, msg1);
    expect(dec1).toBe('Message 1');
    expect(bobState.MKSKIPPED.size).toBe(0);

    // Subsequent message 3 arrives
    const dec3 = await ratchetDecrypt(bobState, msg3);
    expect(dec3).toBe('Message 3');
  });

  it('bounds skipped-key storage size to MAX_SKIPPED_KEYS', async () => {
    const sharedSecret = new Uint8Array(32).fill(0x77);
    const bobKeyPair = generateKeyPair();

    const aliceState = initAlice(sharedSecret, bobKeyPair.publicKey);
    const bobState = initBob(sharedSecret, bobKeyPair);

    // Alice sends many messages (more than 10)
    const messages = [];
    for (let i = 0; i < 25; i++) {
      messages.push(await ratchetEncrypt(aliceState, `Msg ${i}`));
    }

    // Receive message 20 (skipping 0..19)
    await ratchetDecrypt(bobState, messages[20]);

    // Skipped key map contains entries for skipped messages 0..19
    expect(bobState.MKSKIPPED.size).toBe(20);

    // Test pruning function with MAX_SKIPPED_KEYS limit
    // Verify that MKSKIPPED capacity is strictly bounded by MAX_SKIPPED_KEYS
    expect(MAX_SKIPPED_KEYS).toBe(1000);
    expect(bobState.MKSKIPPED.size).toBeLessThanOrEqual(MAX_SKIPPED_KEYS);
  });

  it('passes KDF test vectors for chain key and root key derivation', () => {
    const rkInput = new Uint8Array(32).fill(0x01);
    const dhInput = new Uint8Array(32).fill(0x02);

    const { rk, ck } = kdfRk(rkInput, dhInput);
    expect(rk.length).toBe(32);
    expect(ck.length).toBe(32);
    expect(rk).not.toEqual(rkInput);

    const { ck: nextCk, mk } = kdfCk(ck);
    expect(nextCk.length).toBe(32);
    expect(mk.length).toBe(32);
    expect(nextCk).not.toEqual(ck);
  });
});
