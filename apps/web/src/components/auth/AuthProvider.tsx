'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthContext } from './AuthContext';

const TOKEN_STORAGE_KEYS = ['clicked_token', 'clicked.jwt', 'auth_token'];

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const storedToken = TOKEN_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(
      Boolean,
    );
    const frameId = window.requestAnimationFrame(() => {
      if (storedToken) setTokenState(storedToken);
      setLoading(false);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, []);

  const setToken = useCallback((nextToken: string) => {
    if (typeof window !== 'undefined') {
      for (const key of TOKEN_STORAGE_KEYS) window.localStorage.setItem(key, nextToken);
    }
    setTokenState(nextToken);
  }, []);

  const clearToken = useCallback(() => {
    if (typeof window !== 'undefined') {
      for (const key of TOKEN_STORAGE_KEYS) window.localStorage.removeItem(key);
    }
    setTokenState(null);
  }, []);

  const value = useMemo(
    () => ({ token, loading, setToken, clearToken }),
    [clearToken, loading, setToken, token],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
