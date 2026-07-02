/// <reference lib="webworker" />
// Local E2EE search worker – runs off the main thread
// Inverted index over plaintext messages cached in IndexedDB

import type { DecryptedMessage, SearchHit, SearchQuery, WorkerIndexMessage, WorkerResponseMessage } from './types';
import { tokenize } from './tokenize';
import { getAllMessages } from './db';

const post = (msg: WorkerResponseMessage) => (self as any).postMessage(msg);

type Doc = DecryptedMessage & { tokens: Map<string, number> };

const docs = new Map<string, Doc>();
const inverted = new Map<string, Set<string>>(); // token -> docIds
const docLengths = new Map<string, number>();
let totalTokens = 0;

function indexDoc(m: DecryptedMessage) {
  // remove old
  removeDoc(m.id);

  const toks = tokenize(m.plaintext);
  const tokenCounts = new Map<string, number>();
  for (const t of toks) {
    tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);
  }
  const doc: Doc = { ...m, tokens: tokenCounts };
  docs.set(m.id, doc);
  const len = toks.length || 1;
  docLengths.set(m.id, len);
  totalTokens += len;

  for (const token of tokenCounts.keys()) {
    let set = inverted.get(token);
    if (!set) {
      set = new Set<string>();
      inverted.set(token, set);
    }
    set.add(m.id);
  }
}

function removeDoc(id: string) {
  const existing = docs.get(id);
  if (!existing) return;
  for (const token of existing.tokens.keys()) {
    const set = inverted.get(token);
    if (set) {
      set.delete(id);
      if (set.size === 0) inverted.delete(token);
    }
  }
  totalTokens -= docLengths.get(id) || 0;
  docLengths.delete(id);
  docs.delete(id);
}

function avgDocLen(): number {
  return docs.size ? totalTokens / docs.size : 1;
}

// BM25
function scoreDoc(doc: Doc, queryTokens: string[]): number {
  const k1 = 1.2;
  const b = 0.75;
  const N = docs.size;
  const avgdl = avgDocLen();
  const dl = docLengths.get(doc.id) || 1;
  let score = 0;
  for (const q of queryTokens) {
    const tf = doc.tokens.get(q) || 0;
    if (tf === 0) continue;
    const dfSet = inverted.get(q);
    const df = dfSet ? dfSet.size : 0;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * dl / avgdl);
    score += idf * numerator / denominator;
  }
  // recency boost: newer messages slightly higher
  const ageDays = (Date.now() - new Date(doc.createdAt).getTime()) / 86400000;
  const recency = 1 / (1 + ageDays / 30);
  return score * (1 + 0.1 * recency);
}

function makeSnippet(plaintext: string, queryTokens: string[]): string {
  const lower = plaintext.toLowerCase();
  let firstIdx = -1;
  let matchLen = 0;
  for (const tok of queryTokens) {
    const idx = lower.indexOf(tok);
    if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) {
      firstIdx = idx;
      matchLen = tok.length;
    }
  }
  const radius = 56;
  if (firstIdx === -1) {
    const s = plaintext.slice(0, radius * 2);
    return s + (plaintext.length > s.length ? '…' : '');
  }
  const start = Math.max(0, firstIdx - radius);
  const end = Math.min(plaintext.length, firstIdx + matchLen + radius);
  return (start > 0 ? '…' : '') + plaintext.slice(start, end) + (end < plaintext.length ? '…' : '');
}

function search(query: SearchQuery) {
  const start = performance.now();
  const qTokens = tokenize(query.q);
  if (qTokens.length === 0) {
    return { query: query.q, hits: [], total: 0, tookMs: performance.now() - start };
  }

  // intersect posting lists (AND), fallback to OR if empty
  let candidateIds: Set<string> | null = null;
  for (const tok of qTokens) {
    const posting = inverted.get(tok);
    if (!posting) { candidateIds = new Set<string>(); break; }
    if (candidateIds === null) {
      candidateIds = new Set<string>(posting);
    } else {
      const current = candidateIds;
      const filtered: string[] = Array.from(current).filter((id) => posting.has(id));
      candidateIds = new Set<string>(filtered);
    }
    if (candidateIds.size === 0) break;
  }

  if (!candidateIds || candidateIds.size === 0) {
    // OR fallback – union
    candidateIds = new Set<string>();
    for (const tok of qTokens) {
      const posting = inverted.get(tok);
      if (posting) posting.forEach(id => candidateIds!.add(id));
    }
  }

  let results: SearchHit[] = [];
  for (const id of candidateIds) {
    const doc = docs.get(id)!;
    if (query.conversationId && doc.conversationId !== query.conversationId) continue;
    const score = scoreDoc(doc, qTokens);
    if (score <= 0) continue;
    results.push({
      id: doc.id,
      conversationId: doc.conversationId,
      senderId: doc.senderId,
      plaintext: doc.plaintext,
      createdAt: doc.createdAt,
      score,
      snippet: makeSnippet(doc.plaintext, qTokens),
    });
  }

  results.sort((a, b) => b.score - a.score || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const limit = query.limit ?? 50;
  const total = results.length;
  results = results.slice(0, limit);

  return {
    query: query.q,
    hits: results,
    total,
    tookMs: performance.now() - start,
  };
}

self.addEventListener('message', async (ev: MessageEvent<WorkerIndexMessage>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      const all = await getAllMessages();
      for (const m of all) indexDoc(m);
      post({ type: 'ready' });
      post({ type: 'indexed', count: docs.size });
      return;
    }
    if (msg.type === 'upsert') {
      for (const m of msg.messages) indexDoc(m);
      post({ type: 'indexed', count: docs.size });
      return;
    }
    if (msg.type === 'remove') {
      for (const id of msg.ids) removeDoc(id);
      post({ type: 'indexed', count: docs.size });
      return;
    }
    if (msg.type === 'clear') {
      if (msg.conversationId) {
        const toDelete = [...docs.values()].filter(d => d.conversationId === msg.conversationId).map(d => d.id);
        toDelete.forEach(removeDoc);
      } else {
        docs.clear();
        inverted.clear();
        docLengths.clear();
        totalTokens = 0;
      }
      post({ type: 'indexed', count: docs.size });
      return;
    }
    if (msg.type === 'search') {
      const response = search(msg.query);
      post({ type: 'search_result', id: msg.id, response });
      return;
    }
  } catch (e: any) {
    post({ type: 'error', message: e?.message || String(e) });
  }
});

// initial boot – index what we have in IDB
(async () => {
  try {
    const all = await getAllMessages();
    for (const m of all) indexDoc(m);
    post({ type: 'ready' });
  } catch {
    post({ type: 'ready' });
  }
})();
