'use client';

import { createContext } from 'react';

export type AuthContextValue = {
  token: string | null;
  loading: boolean;
  setToken: (token: string) => void;
  clearToken: () => void;
};

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
