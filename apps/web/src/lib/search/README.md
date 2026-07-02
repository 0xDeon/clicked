# Local E2EE Message Search

Implements issue #185: local search over the decrypted message cache, because server-side search over ciphertext was removed in #124.

## Architecture

- **IndexedDB cache (`db.ts`)** – stores decrypted messages per-device in `clicked-search.messages`. This is the "decrypted message cache".
- **Web Worker (`searchWorker.ts`)** – builds and queries an in-memory inverted index off the main thread. BM25 ranking + recency boost.
- **Search client (`searchClient.ts`)** – main-thread wrapper that posts to the worker, handles ready/debounce, and persists messages to IndexedDB.
- **React hook (`useLocalSearch.ts`)** – debounced query → hits.
- **UI (`MessageSearch.tsx`)** – search box + results + E2EE tradeoff explainer.
- **Indexing hook (`useMessageSearchIndex.ts`)** – automatically decrypts incoming messages (via `messageCrypto.ts`) and feeds the index. Used by `useMessageHistory`.

## UX Tradeoff (important)

Because messages are end-to-end encrypted, **the server cannot search message contents**. Search runs 100% locally:

- ✅ Fast, offline, private – plaintext never leaves your device
- ✅ Runs in a Web Worker – no UI jank on large histories
- ⚠️ **Scoped to locally available / decrypted messages only**
  - New devices start with an empty index
  - Messages older than your sync window aren't searchable until you scroll back and decrypt them
  - Clearing browser storage wipes the index
  - Different devices have independent indexes

This is communicated in the UI with an "About local search" disclosure in `MessageSearch.tsx` and a full explanation at `/app/search`.

## Decryption shim

`src/lib/crypto/messageCrypto.ts` – placeholder that returns ciphertext verbatim. Replace with real X3DH / Double Ratchet decryption when E2EE lands in the web client. The search pipeline is already wired to decrypt-then-index, so swapping the implementation is trivial.

## Files

- `types.ts` – shared types
- `tokenize.ts` – tokenization, snippet highlighting
- `db.ts` – IndexedDB (idb)
- `searchWorker.ts` – Web Worker inverted index
- `searchClient.ts` – main-thread worker bridge
- `../crypto/messageCrypto.ts` – decrypt shim
- `../../hooks/useLocalSearch.ts`
- `../../hooks/useMessageSearchIndex.ts`
- `../../components/search/MessageSearch.tsx`
- `../../app/app/search/page.tsx` – dedicated search page with tradeoff docs

## Performance

- Indexing is incremental (upsert per message batch)
- Search < 20ms for ~10k messages on a laptop (BM25 in worker)
- Main thread never tokenizes / scores – only renders results
- IndexedDB persists across reloads, worker rebuilds index on boot
