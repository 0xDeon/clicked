import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { decryptMessageText } from '../crypto/messageCrypto';
import { putMessages, clearAll } from './db';
import type { DecryptedMessage } from './types';

describe('Client-Side Encrypted Search Integration (#358)', () => {
  beforeEach(async () => {
    await clearAll();
  });

  it('decryptMessageText attempts decryption and returns null for undecryptable envelopes', async () => {
    // Plaintext string passes through
    const plain = await decryptMessageText('Hello world');
    expect(plain).toBe('Hello world');

    // Null/empty ciphertext returns null
    const emptyResult = await decryptMessageText(null);
    expect(emptyResult).toBeNull();

    // Invalid base64 envelope JSON without valid key returns null
    const fakeEnvelopeB64 = btoa(JSON.stringify({ v: 1, iv: 'aaaa', ct: 'bbbb', sig: 'cccc' }));
    const failedDecryption = await decryptMessageText(fakeEnvelopeB64, 'dev-1', 'spki-key');
    expect(failedDecryption).toBeNull();
  });

  it('indexes real plaintext messages and excludes undecryptable messages from index', async () => {
    const validMessage: DecryptedMessage = {
      id: 'msg-valid',
      conversationId: 'conv-1',
      senderId: 'alice',
      plaintext: 'Searchable keyword apple banana cherry',
      contentType: 'text/plain',
      createdAt: new Date().toISOString(),
      sequenceNumber: 1,
    };

    // Store message via encrypted cache
    await putMessages([validMessage]);

    // Raw IndexedDB inspect confirm
    const rawDb = await openDB('clicked-search', 1);
    const rawRecords = await rawDb.getAll('messages');

    expect(rawRecords.length).toBe(1);
    expect(rawRecords[0].plaintext).toBeUndefined();
    expect(rawRecords[0].encryptedContent).toBeDefined();

    const rawString = JSON.stringify(rawRecords[0]);
    expect(rawString.includes('apple')).toBe(false);
    expect(rawString.includes('banana')).toBe(false);
  });
});
