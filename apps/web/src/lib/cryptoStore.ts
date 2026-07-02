class CryptoStore {
  private dbName = 'clicked_crypto';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;

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
        if (!db.objectStoreNames.contains('keys')) {
          db.createObjectStore('keys');
        }
        if (!db.objectStoreNames.contains('deviceId')) {
          db.createObjectStore('deviceId');
        }
      };
    });
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

  private dbPut<T>(storeName: string, value: T, key?: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const db = await this.getDb();
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = key ? store.put(value, key) : store.put(value);

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

  private generateDeviceId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 9);
    return `device_${timestamp}_${random}`;
  }

  async getOrCreateDeviceId(): Promise<string> {
    const existingId = await this.dbGet<string>('deviceId', 'id');
    if (existingId) return existingId;

    const newId = this.generateDeviceId();
    await this.dbPut('deviceId', newId, 'id');
    return newId;
  }

  async generateIdentityKeyPair(): Promise<CryptoKeyPair> {
    const keyPair = await window.crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      false,
      ['deriveKey', 'deriveBits'],
    ) as CryptoKeyPair;

    return keyPair;
  }

  async storeIdentityKeyPair(keyPair: CryptoKeyPair): Promise<void> {
    const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);

    await this.dbPut('keys', {
      id: 'identity_keypair',
      publicKey: publicKeyJwk,
      createdAt: Date.now(),
    }, 'identity_keypair');
  }

  async getIdentityPrivateKey(): Promise<CryptoKey | null> {
    const keyExists = await this.dbGet<{ id: string; publicKey: JsonWebKey; createdAt: number }>('keys', 'identity_keypair');
    if (!keyExists) return null;

    const privateKey = await window.crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      false,
      ['deriveKey', 'deriveBits'],
    );

    return privateKey.privateKey;
  }

  async getIdentityPublicKey(): Promise<JsonWebKey | null> {
    const keyData = await this.dbGet<{ id: string; publicKey: JsonWebKey; createdAt: number }>('keys', 'identity_keypair');
    if (!keyData) return null;
    return keyData.publicKey;
  }

  async initializeIdentityKey(): Promise<JsonWebKey> {
    const db = await this.getDb();
    const existing = await db.get('keys', 'identity_keypair');
    if (existing) return existing.publicKey;

    const keyPair = await this.generateIdentityKeyPair();
    await this.storeIdentityKeyPair(keyPair);

    const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);
    return publicKeyJwk;
  }

  async getDeviceInfo(): Promise<{ deviceId: string; publicKey: JsonWebKey }> {
    const deviceId = await this.getOrCreateDeviceId();
    const publicKey = await this.initializeIdentityKey();

    if (!publicKey) {
      throw new Error('Failed to initialize identity key');
    }

    return { deviceId, publicKey };
  }

  async clear(): Promise<void> {
    await this.dbClear('keys');
    await this.dbClear('deviceId');
  }

  closeDb(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const cryptoStore = new CryptoStore();
