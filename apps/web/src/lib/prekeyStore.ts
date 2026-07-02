import { cryptoStore } from './cryptoStore';
import { apiFetch } from './api';

interface StoredPrekey {
  keyId: string;
  privateKey: CryptoKey;
  publicKey: JsonWebKey;
  createdAt: number;
  isOneTime: boolean;
}

interface SignedPrekey {
  keyId: string;
  publicKey: JsonWebKey;
  signature: string;
}

class PrekeyStore {
  private dbName = 'clicked_prekeys';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;
  private oneTimeKeyBatch = 50;
  private lowThreshold = 10;

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
        if (!db.objectStoreNames.contains('prekeys')) {
          const store = db.createObjectStore('prekeys', { keyPath: 'keyId' });
          store.createIndex('isOneTime', 'isOneTime', { unique: false });
        }
        if (!db.objectStoreNames.contains('signedPrekey')) {
          db.createObjectStore('signedPrekey');
        }
      };
    });
  }

  private dbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
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

  private dbPut<T>(storeName: string, value: T, key?: IDBValidKey): Promise<IDBValidKey> {
    return new Promise(async (resolve, reject) => {
      const db = await this.getDb();
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = key ? store.put(value, key) : store.put(value);

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

  private generateKeyId(): string {
    return `prekey_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private async generatePrekey(): Promise<{ keyId: string; keyPair: CryptoKeyPair }> {
    const keyPair = await window.crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'X25519',
      },
      false,
      ['deriveBits'],
    ) as CryptoKeyPair;

    return {
      keyId: this.generateKeyId(),
      keyPair,
    };
  }

  private async signPrekey(
    privateKey: CryptoKey,
    publicKeyJwk: JsonWebKey,
  ): Promise<string> {
    const publicKeyData = JSON.stringify(publicKeyJwk);
    const data = new TextEncoder().encode(publicKeyData);

    const importedKey = await window.crypto.subtle.importKey(
      'jwk',
      privateKey as JsonWebKey,
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      false,
      ['sign'],
    );

    const signature = await window.crypto.subtle.sign(
      {
        name: 'ECDSA',
        hash: 'SHA-256',
      },
      importedKey,
      data,
    );

    return Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async generateAndStoreSignedPrekey(): Promise<SignedPrekey> {
    const { keyId, keyPair } = await this.generatePrekey();
    const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);

    const identityPrivateKey = await cryptoStore.getIdentityPrivateKey();
    if (!identityPrivateKey) {
      throw new Error('Identity key not initialized');
    }

    const signature = await this.signPrekey(identityPrivateKey, publicKeyJwk);

    const storedPrekey: Omit<StoredPrekey, 'privateKey'> & { privateKeyJwk: JsonWebKey } = {
      keyId,
      publicKey: publicKeyJwk,
      createdAt: Date.now(),
      isOneTime: false,
      privateKeyJwk: await window.crypto.subtle.exportKey('jwk', keyPair.privateKey),
    };

    await this.dbPut('signedPrekey', storedPrekey, 'signed');

    return {
      keyId,
      publicKey: publicKeyJwk,
      signature,
    };
  }

  async generateAndStoreOneTimePrekeys(count: number = this.oneTimeKeyBatch): Promise<Array<{ keyId: string; publicKey: JsonWebKey }>> {
    const prekeys: Array<{ keyId: string; publicKey: JsonWebKey }> = [];

    for (let i = 0; i < count; i++) {
      const { keyId, keyPair } = await this.generatePrekey();
      const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);

      const storedPrekey: Omit<StoredPrekey, 'privateKey'> & { privateKeyJwk: JsonWebKey } = {
        keyId,
        publicKey: publicKeyJwk,
        createdAt: Date.now(),
        isOneTime: true,
        privateKeyJwk: await window.crypto.subtle.exportKey('jwk', keyPair.privateKey),
      };

      await this.dbPut('prekeys', storedPrekey);
      prekeys.push({ keyId, publicKey: publicKeyJwk });
    }

    return prekeys;
  }

  async getSignedPrekey(): Promise<SignedPrekey | null> {
    return this.dbGet<SignedPrekey>('signedPrekey', 'signed');
  }

  async getOneTimePrekey(keyId: string): Promise<CryptoKey | null> {
    const prekey = await this.dbGet<Omit<StoredPrekey, 'privateKey'> & { privateKeyJwk: JsonWebKey }>('prekeys', keyId);
    if (!prekey) return null;

    const privateKey = await window.crypto.subtle.importKey(
      'jwk',
      prekey.privateKeyJwk,
      {
        name: 'ECDH',
        namedCurve: 'X25519',
      },
      false,
      ['deriveBits'],
    );

    return privateKey;
  }

  async consumeOneTimePrekey(keyId: string): Promise<void> {
    await this.dbDelete('prekeys', keyId);
  }

  async getAvailableOneTimeKeysCount(): Promise<number> {
    const oneTimeKeys = await this.dbGetByIndex<Omit<StoredPrekey, 'privateKey'> & { privateKeyJwk: JsonWebKey }>('prekeys', 'isOneTime', true);
    return oneTimeKeys.length;
  }

  async uploadPrekeys(token: string): Promise<void> {
    const signedPrekey = await this.generateAndStoreSignedPrekey();
    const oneTimePrekeys = await this.generateAndStoreOneTimePrekeys(this.oneTimeKeyBatch);

    const response = await apiFetch('/crypto/prekeys', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        signedPrekey,
        oneTimePrekeys,
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to upload prekeys');
    }
  }

  async handlePrekeyLow(token: string): Promise<void> {
    const count = await this.getAvailableOneTimeKeysCount();

    if (count < this.lowThreshold) {
      const needed = this.oneTimeKeyBatch - count;
      const newPrekeys = await this.generateAndStoreOneTimePrekeys(needed);

      const response = await apiFetch('/crypto/prekeys/replenish', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          prekeys: newPrekeys,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to replenish prekeys');
      }
    }
  }

  async clear(): Promise<void> {
    await this.dbClear('prekeys');
    await this.dbClear('signedPrekey');
  }

  closeDb(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const prekeyStore = new PrekeyStore();
