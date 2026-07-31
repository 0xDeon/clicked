import { openDB, IDBPDatabase } from 'idb';
import type { DecryptedMessage } from './types';
import { cryptoStore } from '../cryptoStore';

const DB_NAME = 'clicked-search';
const DB_VERSION = 1;
const STORE_MESSAGES = 'messages';

interface StoredMessageRecord {
  id: string;
  conversationId: string;
  senderId: string;
  encryptedContent: string; // base64
  iv: string; // base64
  contentType?: string;
  createdAt: string;
  sequenceNumber?: number | null;
}

let dbPromise: Promise<IDBPDatabase> | null = null;
let cacheKeyPromise: Promise<CryptoKey> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          const store = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('conversation_created', ['conversationId', 'createdAt'], {
            unique: false,
          });
        }
      },
    });
  }
  return dbPromise;
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function deriveCacheKey(): Promise<CryptoKey> {
  await cryptoStore.initializeIdentityKey();
  let privateKeyJwk = await cryptoStore.getIdentityPrivateKeyJwk();

  if (!privateKeyJwk) {
    const keyPair = await cryptoStore.generateIdentityKeyPair();
    await cryptoStore.storeIdentityKeyPair(keyPair);
    privateKeyJwk = await cryptoStore.getIdentityPrivateKeyJwk();
  }

  const keyMaterial = new TextEncoder().encode(
    JSON.stringify(privateKeyJwk ?? { kty: 'EC', crv: 'P-256', secret: 'fallback_private_key_seed' }),
  );

  const derivedKeyMaterial = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('clicked_cache_salt_v1'),
      iterations: 100000,
    },
    derivedKeyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function getCacheEncryptionKey(): Promise<CryptoKey> {
  if (cacheKeyPromise) return cacheKeyPromise;
  cacheKeyPromise = deriveCacheKey();
  return cacheKeyPromise;
}

function toBufferSource(arr: Uint8Array): BufferSource {
  return new Uint8Array(Array.from(arr));
}

async function encryptText(plaintext: string): Promise<{ encryptedContent: string; iv: string }> {
  const key = await getCacheEncryptionKey();
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes },
    key,
    toBufferSource(encoded),
  );

  return {
    encryptedContent: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(ivBytes),
  };
}

async function decryptText(encryptedContent: string, iv: string): Promise<string> {
  const key = await getCacheEncryptionKey();
  const ivBytes = base64ToBytes(iv);
  const encryptedBytes = base64ToBytes(encryptedContent);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBufferSource(ivBytes) },
    key,
    toBufferSource(encryptedBytes),
  );

  return new TextDecoder().decode(decrypted);
}

export async function putMessages(messages: DecryptedMessage[]): Promise<void> {
  if (messages.length === 0) return;

  const records = await Promise.all(
    messages.map(async (m) => {
      const { encryptedContent, iv } = await encryptText(m.plaintext);
      return {
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        encryptedContent,
        iv,
        contentType: m.contentType,
        createdAt: m.createdAt,
        sequenceNumber: m.sequenceNumber,
      } as StoredMessageRecord;
    }),
  );

  const db = await getDB();
  const tx = db.transaction(STORE_MESSAGES, 'readwrite');
  await Promise.all(records.map((record) => tx.store.put(record)));
  await tx.done;
}

export async function deleteMessages(ids: string[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE_MESSAGES, 'readwrite');
  await Promise.all(ids.map((id) => tx.store.delete(id)));
  await tx.done;
}

async function convertRecordToMessage(record: StoredMessageRecord): Promise<DecryptedMessage> {
  let plaintext = '';
  try {
    plaintext = await decryptText(record.encryptedContent, record.iv);
  } catch {
    plaintext = '';
  }
  return {
    id: record.id,
    conversationId: record.conversationId,
    senderId: record.senderId,
    plaintext,
    contentType: record.contentType ?? 'text/plain',
    createdAt: record.createdAt,
    sequenceNumber: record.sequenceNumber ?? null,
  };
}

export async function getAllMessages(): Promise<DecryptedMessage[]> {
  const db = await getDB();
  const records = (await db.getAll(STORE_MESSAGES)) as StoredMessageRecord[];
  return Promise.all(records.map(convertRecordToMessage));
}

export async function getMessagesByConversation(
  conversationId: string,
): Promise<DecryptedMessage[]> {
  const db = await getDB();
  const records = (await db.getAllFromIndex(
    STORE_MESSAGES,
    'conversationId',
    conversationId,
  )) as StoredMessageRecord[];
  return Promise.all(records.map(convertRecordToMessage));
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
