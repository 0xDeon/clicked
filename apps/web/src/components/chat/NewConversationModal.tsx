'use client';

import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const MAX_QUERY_LENGTH = 120;

type SearchUser = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
};

type NewConversationModalProps = {
  open: boolean;
  token: string;
  creating: boolean;
  onClose: () => void;
  onSelectUser: (user: SearchUser) => Promise<void>;
};

export function NewConversationModal({
  open,
  token,
  creating,
  onClose,
  onSelectUser,
}: NewConversationModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }

    const trimmed = query.trim();
    const safeQuery = trimmed.slice(0, MAX_QUERY_LENGTH);

    if (!safeQuery) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(`${API_URL}/users/search?q=${encodeURIComponent(safeQuery)}`, {
          headers: { Authorization: 'Bearer ' + token },
        });

        if (!response.ok) {
          throw new Error('Failed to search users');
        }

        const payload = (await response.json()) as SearchUser[];
        setResults(payload);
      } catch (searchError) {
        setResults([]);
        setError(searchError instanceof Error ? searchError.message : 'Failed to search users');
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [open, query, token]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#020617]/70 px-4">
      <div className="w-full max-w-lg rounded-2xl border border-white/15 bg-[#0F172A] p-5 text-white shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">New conversation</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-slate-300 hover:bg-white/10"
          >
            Close
          </button>
        </div>

        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search users"
          className="w-full rounded-xl border border-white/15 bg-[#020617] px-3 py-2 text-sm outline-none focus:border-cyan-400"
        />

        <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
          {loading ? <p className="text-sm text-slate-300">Searching...</p> : null}
          {error ? <p className="text-sm text-rose-300">{error}</p> : null}
          {!loading && !error && query.trim() && results.length === 0 ? (
            <EmptyState
              icon="🔎"
              title="No users found"
              description="Try a different search term."
            />
          ) : null}
          {results.map((user) => (
            <button
              key={user.id}
              type="button"
              disabled={creating}
              onClick={() => void onSelectUser(user)}
              className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left text-sm transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="truncate">{user.username ?? user.id}</span>
              <span className="text-xs text-slate-300">Start DM</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
