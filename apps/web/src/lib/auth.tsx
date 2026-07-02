'use client';

import React, { createContext, useContext, useState } from 'react';

type AuthContextType = {
  token: string | null;
  setToken: (token: string | null) => void;
  isLoading: boolean;
};

const AuthContext = createContext<AuthContextType>({
  token: null,
  setToken: () => {},
  isLoading: true,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const stored = window.localStorage.getItem('auth_token');
    return stored || process.env.NEXT_PUBLIC_AUTH_TOKEN || null;
  });
  const [isLoading] = useState(false);

  const updateToken = (newToken: string | null) => {
    if (newToken) {
      window.localStorage.setItem('auth_token', newToken);
    } else {
      window.localStorage.removeItem('auth_token');
    }
    setToken(newToken);
  };

  return (
    <AuthContext.Provider value={{ token, setToken: updateToken, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
