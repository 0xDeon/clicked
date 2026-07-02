import { openDB, IDBPDatabase } from 'idb';
import type { DecryptedMessage } from './types';

const DB_NAME = 'clicked-search';
const DB_VERSION = 1;
const STORE_MESSAGES = 'messages';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          const store = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('conversation_created', ['conversationId', 'createdAt'], { unique: false });
        }
      },
    });
  }
  return dbPromise;
}

export async function putMessages(messages: DecryptedMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const db = await getDB();
  const tx = db.transaction(STORE_MESSAGES, 'readwrite');
  await Promise.all(messages.map(m => tx.store.put(m)));
  await tx.done;
}

export async function deleteMessages(ids: string[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE_MESSAGES, 'readwrite');
  await Promise.all(ids.map(id => tx.store.delete(id)));
  await tx.done;
}

export async function getAllMessages(): Promise<DecryptedMessage[]> {
  const db = await getDB();
  return db.getAll(STORE_MESSAGES);
}

export async function getMessagesByConversation(conversationId: string): Promise<DecryptedMessage[]> {
  const db = await getDB();
  return db.getAllFromIndex(STORE_MESSAGES, 'conversationId', conversationId);
}

export async function clearConversation(conversationId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE_MESSAGES, 'readwrite');
  let cursor = await tx.store.index('conversationId').openCursor(conversationId);
  while (cursor) {
    cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function clearAll(): Promise<void> {
  const db = await getDB();
  await db.clear(STORE_MESSAGES);
}

export async function getMessageCount(): Promise<number> {
  const db = await getDB();
  return db.count(STORE_MESSAGES);
}
