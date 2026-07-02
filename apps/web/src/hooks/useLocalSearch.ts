'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { search as doSearch } from '@/lib/search/searchClient';
import type { SearchHit, SearchResponse } from '@/lib/search/types';

interface UseLocalSearchOptions {
  conversationId?: string;
  debounceMs?: number;
  minQueryLength?: number;
}

export function useLocalSearch(opts: UseLocalSearchOptions = {}) {
  const { conversationId, debounceMs = 180, minQueryLength = 2 } = opts;
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(0);

  const runSearch = useCallback(async (q: string) => {
    const runId = ++abortRef.current;
    if (q.trim().length < minQueryLength) {
      setHits([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res: SearchResponse = await doSearch({ q, conversationId, limit: 50 });
      if (runId !== abortRef.current) return;
      setHits(res.hits);
      setTotal(res.total);
    } catch (e: any) {
      if (runId !== abortRef.current) return;
      setError(e?.message || 'Search failed');
      setHits([]);
      setTotal(0);
    } finally {
      if (runId === abortRef.current) setLoading(false);
    }
  }, [conversationId, minQueryLength]);

  useEffect(() => {
    const t = setTimeout(() => { runSearch(query); }, debounceMs);
    return () => clearTimeout(t);
  }, [query, runSearch, debounceMs]);

  return {
    query,
    setQuery,
    hits,
    total,
    loading,
    error,
    clear: () => setQuery(''),
  };
}
