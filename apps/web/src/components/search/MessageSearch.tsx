'use client';

import { useLocalSearch } from '@/hooks/useLocalSearch';
import { useState } from 'react';

interface MessageSearchProps {
  conversationId?: string;
  onSelectHit?: (hitId: string, conversationId: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
}

export function MessageSearch({ conversationId, onSelectHit, autoFocus, placeholder }: MessageSearchProps) {
  const { query, setQuery, hits, total, loading, error, clear } = useLocalSearch({ conversationId });
  const [showInfo, setShowInfo] = useState(false);

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="relative">
        <input
          type="search"
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder ?? (conversationId ? 'Search in conversation…' : 'Search messages…')}
          className="w-full bg-[#13131f]/60 hover:bg-[#13131f]/80 focus:bg-[#13131f] border border-border focus:border-accent rounded-2xl px-5 py-3 pr-10 text-sm focus:outline-none transition-all placeholder:text-foreground/30"
          aria-label="Search decrypted messages"
        />
        {query && (
          <button
            onClick={clear}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-foreground/40 hover:text-foreground"
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      <div className="flex items-center justify-between text-[11px] text-foreground/40 px-1">
        <span>
          {loading ? 'Searching…' : query.length >= 2 ? `${total} result${total !== 1 ? 's' : ''}` : 'Type at least 2 characters'}
          {conversationId ? ' • this conversation' : ' • all synced conversations'}
        </span>
        <button
          onClick={() => setShowInfo(!showInfo)}
          className="underline decoration-dotted hover:text-foreground/60"
        >
          About local search
        </button>
      </div>

      {showInfo && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-200/80 leading-relaxed">
          <strong className="text-amber-200">E2EE search — local only.</strong> Because messages are end-to-end encrypted, the server can&apos;t search ciphertext (#124).
          Search runs entirely in your browser, over messages this device has decrypted and cached in IndexedDB (#185).
          It works offline, runs in a Web Worker, and never leaves your device.
          <br />
          <span className="opacity-80">Only synced / decrypted history is searchable. New devices start with an empty index until history syncs.</span>
        </div>
      )}

      {error && (
        <div className="text-xs text-red-400 px-1">{error}</div>
      )}

      <div className="max-h-[420px] overflow-y-auto rounded-2xl border border-border bg-card/30 divide-y divide-border/60">
        {hits.length === 0 && query.length >= 2 && !loading ? (
          <div className="px-4 py-8 text-center text-sm text-foreground/40">
            No matches in your local decrypted cache.
          </div>
        ) : null}
        {hits.length === 0 && query.length < 2 ? (
          <div className="px-4 py-6 text-center text-xs text-foreground/30">
            Local E2EE search. Results come from your device&apos;s decrypted message cache.
          </div>
        ) : null}
        {hits.map(hit => (
          <button
            key={hit.id}
            onClick={() => onSelectHit?.(hit.id, hit.conversationId)}
            className="w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors"
          >
            <div className="text-[11px] text-foreground/40 mb-1">
              {new Date(hit.createdAt).toLocaleString()} • {hit.conversationId.slice(0,8)}…
            </div>
            <div
              className="text-sm text-foreground/85 leading-snug [&_mark]:bg-accent/30 [&_mark]:text-accent-light [&_mark]:rounded [&_mark]:px-0.5"
              dangerouslySetInnerHTML={{ __html: hit.snippet }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
