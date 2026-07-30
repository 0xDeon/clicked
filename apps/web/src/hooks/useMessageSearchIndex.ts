'use client';

import { useEffect } from 'react';
import { indexMessages } from '@/lib/search/searchClient';
import { decryptMessageText } from '@/lib/crypto/messageCrypto';
import type { DecryptedMessage } from '@/lib/search/types';

export type IndexableMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  senderDeviceId?: string | null;
  senderIdentityPublicKey?: string | null;
  ciphertext?: string | null;
  content?: string; // fallback for legacy plaintext field
  contentType?: string;
  createdAt: string | Date;
  sequenceNumber?: number | null;
};

/**
 * Indexes an array of messages into the local search store.
 * Decrypts ciphertext client-side via the real decryption pipeline,
 * stores encrypted-at-rest in IndexedDB, and updates the Web Worker inverted index.
 */
export function useMessageSearchIndex(messages: IndexableMessage[]) {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!messages.length) return;
      const toIndex: DecryptedMessage[] = [];
      for (const m of messages) {
        const ciphertext = m.ciphertext ?? m.content ?? null;
        const plaintext = await decryptMessageText(
          ciphertext,
          m.senderDeviceId,
          m.senderIdentityPublicKey,
        );
        if (!plaintext) continue;
        toIndex.push({
          id: m.id,
          conversationId: m.conversationId,
          senderId: m.senderId,
          plaintext,
          contentType: m.contentType ?? 'text/plain',
          createdAt: typeof m.createdAt === 'string' ? m.createdAt : m.createdAt.toISOString(),
          sequenceNumber: m.sequenceNumber ?? null,
        });
      }
      if (!cancelled && toIndex.length) {
        try {
          await indexMessages(toIndex);
        } catch (e) {
          console.warn('search index failed', e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages]);
}
