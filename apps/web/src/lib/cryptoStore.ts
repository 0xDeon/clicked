type StoredIdentityKeyPair = {
  id: 'identity_keypair';
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
  createdAt: number;
};

const memoryDbs = globalThis as typeof globalThis & {
  __clickedMemoryDbs?: Map<string, Map<string, Map<IDBValidKey, unknown>>>;
};

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function getMemoryStore(dbName: string, storeName: string): Map<IDBValidKey, unknown> {
  const dbs = (memoryDbs.__clickedMemoryDbs ??= new Map());
  const db = dbs.get(dbName) ?? new Map<string, Map<IDBValidKey, unknown>>();
  dbs.set(dbName, db);

  const store = db.get(storeName) ?? new Map<IDBValidKey, unknown>();
  db.set(storeName, store);
  return store;
}

function getWebCrypto(): Crypto {
  const cryptoApi = globalThis.crypto ?? globalThis.window?.crypto;
  if (!cryptoApi) {
    throw new Error('WebCrypto is not available');
  }
  return cryptoApi;
}

class CryptoStore {
  private dbName = 'clicked_crypto';
  private dbVersion = 2; // Incremented for identity key storage upgrade
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
        // Version 2: Add identityKeyPair store for structured CryptoKey persistence
        if (event.oldVersion < 2 && !db.objectStoreNames.contains('identityKeyPair')) {
          db.createObjectStore('identityKeyPair');
        }
      };
    });
  }

  private dbGet<T>(storeName: string, key: string): Promise<T | undefined> {
    if (!hasIndexedDb()) {
      return Promise.resolve(getMemoryStore(this.dbName, storeName).get(key) as T | undefined);
    }

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
    if (!hasIndexedDb()) {
      const store = getMemoryStore(this.dbName, storeName);
      store.set(key ?? String((store.size + 1).toString()), value);
      return Promise.resolve();
    }

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
    if (!hasIndexedDb()) {
      getMemoryStore(this.dbName, storeName).clear();
      return Promise.resolve();
    }

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

  /**
   * Generate a new identity keypair with extractable=true for private key persistence.
   * The private CryptoKey is stored via IndexedDB structured clone (no export required).
   */
  async generateIdentityKeyPair(): Promise<CryptoKeyPair> {
    const keyPair = (await getWebCrypto().subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true,
      // extractable=true keeps test serialization and persistence flows working.
      ['deriveKey', 'deriveBits'],
    )) as CryptoKeyPair;

    return keyPair;
  }

  /**
   * Persist the identity keypair using IndexedDB structured clone.
   * Stores both the full CryptoKeyPair and the exported public JWK for compatibility.
   */
  async storeIdentityKeyPair(keyPair: CryptoKeyPair): Promise<void> {
    const cryptoApi = getWebCrypto();
    const publicKeyJwk = await cryptoApi.subtle.exportKey('jwk', keyPair.publicKey);
    const privateKeyJwk = await cryptoApi.subtle.exportKey('jwk', keyPair.privateKey);

    // Store full CryptoKeyPair via structured clone (no export needed for private key)
    await this.dbPut(
      'identityKeyPair',
      {
        keyPair, // IndexedDB can serialize CryptoKey objects directly
        createdAt: Date.now(),
      },
      'current',
    );

    // Maintain legacy public key storage for backwards compatibility
    await this.dbPut(
      'keys',
      {
        id: 'identity_keypair',
        publicKey: publicKeyJwk,
        privateKey: privateKeyJwk,
        createdAt: Date.now(),
      },
      'identity_keypair',
    );
  }

  /**
   * Retrieve the persisted identity private key.
   * Returns the same CryptoKey across page reloads, preserving identity continuity.
   */
  async getIdentityPrivateKey(): Promise<CryptoKey | null> {
    const stored = await this.dbGet<{ keyPair: CryptoKeyPair; createdAt: number }>(
      'identityKeyPair',
      'current',
    );
    
    if (stored?.keyPair?.privateKey) {
      return stored.keyPair.privateKey;
    }

    // Fallback: check if we have legacy data (migration path)
    const legacyKey = await this.dbGet<StoredIdentityKeyPair>('keys', 'identity_keypair');
    
    if (!legacyKey) {
      return null;
    }

    return getWebCrypto().subtle.importKey(
      'jwk',
      legacyKey.privateKey,
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true,
      ['deriveKey', 'deriveBits'],
    );
  }

  async getIdentityPublicKey(): Promise<JsonWebKey | null> {
    const keyData = await this.dbGet<StoredIdentityKeyPair>('keys', 'identity_keypair');
    if (!keyData) return null;
    return keyData.publicKey;
  }

  /**
   * Initialize or retrieve the identity key, ensuring the private key is persisted.
   */
  async initializeIdentityKey(): Promise<JsonWebKey> {
    const stored = await this.dbGet<{ keyPair: CryptoKeyPair; createdAt: number }>(
      'identityKeyPair',
      'current',
    );

    if (stored?.keyPair?.privateKey) {
      const publicKeyJwk = await getWebCrypto().subtle.exportKey('jwk', stored.keyPair.publicKey);

      const legacyRecord = await this.dbGet<StoredIdentityKeyPair>('keys', 'identity_keypair');
      if (!legacyRecord) {
        const privateKeyJwk = await getWebCrypto().subtle.exportKey(
          'jwk',
          stored.keyPair.privateKey,
        );
        await this.dbPut(
          'keys',
          {
            id: 'identity_keypair',
            publicKey: publicKeyJwk,
            privateKey: privateKeyJwk,
            createdAt: stored.createdAt,
          },
          'identity_keypair',
        );
      }

      return publicKeyJwk;
    }

    const existing = await this.dbGet<StoredIdentityKeyPair>('keys', 'identity_keypair');
    if (existing) {
      return existing.publicKey;
    }

    const keyPair = await this.generateIdentityKeyPair();
    await this.storeIdentityKeyPair(keyPair);

    const publicKeyJwk = await getWebCrypto().subtle.exportKey('jwk', keyPair.publicKey);
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
    await this.dbClear('identityKeyPair');
  }

  closeDb(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const cryptoStore = new CryptoStore();
