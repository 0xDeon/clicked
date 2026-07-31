import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { putMessages, getAllMessages, getMessagesByConversation, clearAll } from './db';
import type { DecryptedMessage } from './types';

describe('Local Encrypted Message Cache (#357)', () => {
  beforeEach(async () => {
    await clearAll();
  });

  it('encrypts messages at rest before writing to IndexedDB and decrypts on read', async () => {
    const sampleMessages: DecryptedMessage[] = [
      {
        id: 'msg-1',
        conversationId: 'conv-100',
        senderId: 'user-1',
        plaintext: 'Top secret sensitive message content',
        contentType: 'text/plain',
        createdAt: new Date().toISOString(),
        sequenceNumber: 1,
      },
      {
        id: 'msg-2',
        conversationId: 'conv-100',
        senderId: 'user-2',
        plaintext: 'Another confidential message',
        contentType: 'text/plain',
        createdAt: new Date().toISOString(),
        sequenceNumber: 2,
      },
    ];

    await putMessages(sampleMessages);

    // Read via canonical db module
    const retrieved = await getAllMessages();
    expect(retrieved.length).toBe(2);
    expect(retrieved.find((m) => m.id === 'msg-1')?.plaintext).toBe('Top secret sensitive message content');
    expect(retrieved.find((m) => m.id === 'msg-2')?.plaintext).toBe('Another confidential message');

    const byConv = await getMessagesByConversation('conv-100');
    expect(byConv.length).toBe(2);
  });

  it('confirms inspecting raw IndexedDB store contents directly NEVER reveals plaintext message content', async () => {
    const secretText = 'CONFIDENTIAL_KEY_WORD_12345';
    const sampleMessage: DecryptedMessage = {
      id: 'msg-secret',
      conversationId: 'conv-secret',
      senderId: 'user-alice',
      plaintext: secretText,
      contentType: 'text/plain',
      createdAt: new Date().toISOString(),
      sequenceNumber: 42,
    };

    await putMessages([sampleMessage]);

    // Inspect raw IndexedDB store directly without going through db.ts decryption
    const rawDb = await openDB('clicked-search', 1);
    const rawRecords = await rawDb.getAll('messages');

    expect(rawRecords.length).toBe(1);
    const rawRecord = rawRecords[0];

    // Raw record MUST NOT have 'plaintext' property
    expect(rawRecord.plaintext).toBeUndefined();

    // Raw record MUST contain encryptedContent and iv
    expect(rawRecord.encryptedContent).toBeDefined();
    expect(rawRecord.iv).toBeDefined();

    // Stringified raw database record MUST NEVER expose the plaintext string
    const stringifiedRecord = JSON.stringify(rawRecord);
    expect(stringifiedRecord.includes(secretText)).toBe(false);
  });
});
