// Shared tokenization / scoring – runs in worker and for snippets in UI

export function normalize(text: string): string {
  return text.toLowerCase().normalize('NFKD');
}

const STOPWORDS = new Set([
  'the','a','an','and','or','but','is','are','was','were','in','on','at','to','for','of','with','by','it','this','that'
]);

export function tokenize(text: string): string[] {
  const norm = normalize(text);
  return norm
    .split(/[^a-z0-9\u00c0-\u024f]+/i)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

export function uniqueTokens(text: string): string[] {
  return Array.from(new Set(tokenize(text)));
}

// Simple BM25-ish scoring helpers are in the worker.
// For UI snippets:
export function makeSnippet(plaintext: string, queryTokens: string[], radius = 48): string {
  const lower = plaintext.toLowerCase();
  let firstIdx = -1;
  let matchLen = 0;
  for (const tok of queryTokens) {
    const idx = lower.indexOf(tok.toLowerCase());
    if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) {
      firstIdx = idx;
      matchLen = tok.length;
    }
  }
  if (firstIdx === -1) {
    const s = plaintext.slice(0, radius * 2);
    return s + (plaintext.length > s.length ? '…' : '');
  }
  const start = Math.max(0, firstIdx - radius);
  const end = Math.min(plaintext.length, firstIdx + matchLen + radius);
  let snippet = plaintext.slice(start, end);
  // highlight
  for (const tok of queryTokens) {
    const re = new RegExp(`(${escapeRegExp(tok)})`, 'gi');
    snippet = snippet.replace(re, '<mark>$1</mark>');
  }
  if (start > 0) snippet = '…' + snippet;
  if (end < plaintext.length) snippet = snippet + '…';
  return snippet;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
