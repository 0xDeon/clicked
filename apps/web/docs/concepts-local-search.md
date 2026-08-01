# Client-Side Local Encrypted Search

To support End-to-End Encryption (E2EE), the server only stores ciphertext. This imposes a strict security constraint: **the server cannot perform full-text search on message content**. 

To provide users with a fast, comprehensive search experience without compromising privacy, we implemented a 100% local, client-side search architecture powered by IndexedDB and Web Workers, using a BM25 ranking algorithm.

## 1. The Indexing Pipeline

Keeping the index up-to-date with a stream of incoming E2EE messages involves a clear, step-by-step pipeline from encrypted network transit to queryable plaintext:

1. **Incoming Messages**: Encrypted messages arrive via WebSockets or API pagination.
2. **Decryption**: The `useMessageSearchIndex` React hook intercepts these messages, looks up the necessary keys, and decrypts the ciphertext into plaintext entirely in the main thread.
3. **Persistence (`db.ts`)**: The decrypted plaintexts are persisted to a local IndexedDB cache (`clicked-search`) so they survive page reloads without requiring costly re-decryption.
4. **Worker Upsert**: The plaintexts are then dispatched via `postMessage` to the background Web Worker (`searchWorker.ts`).
5. **Tokenization & Indexing**: The Web Worker tokenizes the plaintext, updates term frequencies, and updates its in-memory inverted index mappings.

## 2. Web Worker Boundary

To ensure the UI remains smooth (60fps) even when indexing thousands of messages or performing complex queries, work is split across the Main Thread and a Web Worker.

### Main Thread
- **`hooks/useMessageSearchIndex.ts`**: Handles the decryption of incoming messages and initiates the indexing flow.
- **`lib/search/db.ts`**: Manages the IndexedDB lifecycle for persisting decrypted messages locally.
- **`hooks/useLocalSearch.ts`**: Manages the React state for search inputs, debounces user typing (e.g., 180ms), and coordinates query requests to the worker.

### Web Worker (`searchWorker.ts`)
- **Inverted Index**: Maintains a `Map` of tokens to Set of document IDs.
- **Tokenization**: Breaks plaintext down into searchable tokens.
- **BM25 Scoring**: Performs the mathematical heavy lifting of ranking documents based on Term Frequency (TF), Document Frequency (DF), and average document length.
- **Snippet Generation**: Extracts the surrounding context of the matched text to display in the UI.

**Why the boundary?** 
String manipulation, tokenization, large Set intersections, and floating-point scoring loops are CPU-bound. If run on the main thread, they would block React renders and cause jank during typing.

## 3. The BM25 Inverted-Index Approach

Inside the worker, we don't just use `String.includes()`. Instead, we maintain a genuine search engine data structure in memory:

- **Inverted Index**: A `Map<string, Set<string>>` mapping each unique word token to the IDs of the messages that contain it.
- **Intersecting Queries**: When a multi-word query is searched, the worker fetches the `Set` for each word and computes the intersection (AND logic). If no results are found, it gracefully falls back to a union (OR logic).
- **Ranking (BM25)**: Instead of simple boolean matches, results are scored using BM25. This boosts the score if a word appears frequently in a single message (TF), but reduces the weight of words that appear in almost all messages (IDF). We also apply a subtle recency boost to slightly prioritize newer messages.

By shifting this entire stack to the client edge, we maintain absolute zero-knowledge on the server while preserving a rich, instant search experience for the user.
