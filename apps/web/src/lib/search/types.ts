// Local search types for E2EE message cache
// Issue #185 – server can no longer search ciphertext (#124),
// so search runs locally over decrypted messages.

export interface DecryptedMessage {
  id: string;
  conversationId: string;
  senderId: string;
  /** Plaintext after local E2EE decryption */
  plaintext: string;
  contentType: string;
  createdAt: string; // ISO
  sequenceNumber?: number | null;
}

export interface SearchHit {
  id: string;
  conversationId: string;
  senderId: string;
  plaintext: string;
  createdAt: string;
  score: number;
  /** Snippet with <mark> tags around matches */
  snippet: string;
}

export interface SearchQuery {
  q: string;
  conversationId?: string;
  limit?: number;
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  total: number;
  tookMs: number;
}

// Worker protocol
export type WorkerIndexMessage =
  | { type: 'init' }
  | { type: 'upsert'; messages: DecryptedMessage[] }
  | { type: 'remove'; ids: string[] }
  | { type: 'clear'; conversationId?: string }
  | { type: 'search'; id: number; query: SearchQuery };

export type WorkerResponseMessage =
  | { type: 'ready' }
  | { type: 'indexed'; count: number }
  | { type: 'search_result'; id: number; response: SearchResponse }
  | { type: 'error'; message: string };
