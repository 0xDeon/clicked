import { cryptoStore } from './cryptoStore';

interface CachedMessage {
  id: string;
  conversationId: string;
  content: string;
  senderId: string;
  timestamp: number;
  iv: string;
  encryptedContent: string;
}

class MessageCache {
  private dbName = 'clicked_messages';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;
  private cacheKeyPromise: Promise<CryptoKey> | null = null;

  private async getDb(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'id' });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });
  }

  private async getCacheEncryptionKey(): Promise<CryptoKey> {
    if (this.cacheKeyPromise) return this.cacheKeyPromise;

    this.cacheKeyPromise = this.deriveCacheKey();
    return this.cacheKeyPromise;
  }

  private async deriveCacheKey(): Promise<CryptoKey> {
    const publicKeyJwk = await cryptoStore.getIdentityPublicKey();
    if (!publicKeyJwk) {
      throw new Error('Identity key not initialized');
    }

    const keyMaterial = new TextEncoder().encode(JSON.stringify(publicKeyJwk));
    const derivedKey = await window.crypto.subtle.importKey(
      'raw',
      keyMaterial,
      { name: 'PBKDF2' },
      false,
      ['deriveKey'],
    );

    const cacheKey = await window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('clicked_cache_salt'),
        iterations: 100000,
      },
      derivedKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

    return cacheKey;
  }

  private async encryptMessage(message: Omit<CachedMessage, 'iv' | 'encryptedContent'>): Promise<{ iv: string; encryptedContent: string }> {
    const cacheKey = await this.getCacheEncryptionKey();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const messageData = JSON.stringify({
      content: message.content,
      senderId: message.senderId,
    });

    const encrypted = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cacheKey,
      new TextEncoder().encode(messageData),
    );

    return {
      iv: Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''),
      encryptedContent: Array.from(new Uint8Array(encrypted)).map(b => b.toString(16).padStart(2, '0')).join(''),
    };
  }

  private async decryptMessage(encryptedMessage: CachedMessage): Promise<{ content: string; senderId: string }> {
    const cacheKey = await this.getCacheEncryptionKey();
    const iv = new Uint8Array(
      encryptedMessage.iv.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
    );
    const encryptedContent = new Uint8Array(
      encryptedMessage.encryptedContent.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
    );

    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      cacheKey,
      encryptedContent,
    );

    const decryptedText = new TextDecoder().decode(decrypted);
    return JSON.parse(decryptedText);
  }

  private dbGet<T>(storeName: string, key: string): Promise<T | undefined> {
    return new Promise(async (resolve, reject) => {
      const db = await this.getDb();
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as T);
    });
  }

  private dbGetByIndex<T>(storeName: string, indexName: string, key: IDBValidKey): Promise<T[]> {
    return new Promise(async (resolve, reject) => {
      const db = await this.getDb();
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as T[]);
    });
  }

  private dbPut<T>(storeName: string, value: T): Promise<IDBValidKey> {
    return new Promise(async (resolve, reject) => {
      const db = await this.getDb();
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.put(value);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  private dbDelete(storeName: string, key: IDBValidKey): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const db = await this.getDb();
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.delete(key);

      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private dbClear(storeName: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const db = await this.getDb();
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async addMessage(message: Omit<CachedMessage, 'iv' | 'encryptedContent'>): Promise<void> {
    const { iv, encryptedContent } = await this.encryptMessage(message);
    const cachedMessage: CachedMessage = {
      ...message,
      iv,
      encryptedContent,
    };
    await this.dbPut('messages', cachedMessage);
  }

  async getMessage(id: string): Promise<{ id: string; conversationId: string; content: string; senderId: string; timestamp: number } | null> {
    const cached = await this.dbGet<CachedMessage>('messages', id);
    if (!cached) return null;

    const { content, senderId } = await this.decryptMessage(cached);
    return {
      id: cached.id,
      conversationId: cached.conversationId,
      content,
      senderId,
      timestamp: cached.timestamp,
    };
  }

  async getConversationMessages(conversationId: string): Promise<Array<{ id: string; conversationId: string; content: string; senderId: string; timestamp: number }>> {
    const cached = await this.dbGetByIndex<CachedMessage>('messages', 'conversationId', conversationId);

    const decrypted = await Promise.all(
      cached.map(async (msg) => {
        const { content, senderId } = await this.decryptMessage(msg);
        return {
          id: msg.id,
          conversationId: msg.conversationId,
          content,
          senderId,
          timestamp: msg.timestamp,
        };
      })
    );

    return decrypted.sort((a, b) => a.timestamp - b.timestamp);
  }

  async deleteMessage(id: string): Promise<void> {
    await this.dbDelete('messages', id);
  }

  async clearCache(): Promise<void> {
    await this.dbClear('messages');
  }

  closeDb(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const messageCache = new MessageCache();
