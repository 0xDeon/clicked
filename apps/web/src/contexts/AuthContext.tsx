'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { signWalletMessage } from '@/lib/freighter';
import { useWallet } from '@/contexts/WalletContext';
import { getOrCreateDeviceIdentity } from '@/lib/deviceIdentity';
import { parseJwtClaims, rememberRealtimeDeviceId } from '@/lib/realtime';

const TOKEN_STORAGE_KEYS = ['clicked.jwt', 'clicked_token', 'auth_token'];

interface AuthUser {
  id?: string;
  walletAddress: string;
  deviceId?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  signIn: () => Promise<void>;
  signOut: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function persistToken(token: string) {
  for (const key of TOKEN_STORAGE_KEYS) window.localStorage.setItem(key, token);
}

function removeToken() {
  for (const key of TOKEN_STORAGE_KEYS) window.localStorage.removeItem(key);
}

function readToken(): string | null {
  return TOKEN_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(Boolean) ?? null;
}

function parseJwtUser(token: string): AuthUser | null {
  const claims = parseJwtClaims(token);
  return claims.walletAddress
    ? { id: claims.userId, walletAddress: claims.walletAddress, deviceId: claims.deviceId }
    : null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { publicKey, connect } = useWallet();
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const savedToken = readToken();
    if (savedToken) {
      setToken(savedToken);
      setUser(parseJwtUser(savedToken));
    }
  }, []);

  const signIn = useCallback(async () => {
    setIsLoading(true);
    try {
      const walletAddress = publicKey ?? (await connect());
      const device = await getOrCreateDeviceIdentity();
      const challengeResponse = await apiFetch('/auth/challenge', {
        method: 'POST',
        body: JSON.stringify({ walletAddress }),
      });

      if (!challengeResponse.ok) throw new Error('Unable to request sign-in challenge');

      const { message, nonce } = (await challengeResponse.json()) as {
        message: string;
        nonce: string;
      };
      const signature = await signWalletMessage(message, walletAddress);
      const verifyResponse = await apiFetch('/auth/verify', {
        method: 'POST',
        body: JSON.stringify({
          walletAddress,
          signature,
          nonce,
          identityPublicKey: device.identityPublicKey,
        }),
      });

      if (!verifyResponse.ok) throw new Error('Unable to verify signed challenge');

      const { token: nextToken, deviceId } = (await verifyResponse.json()) as {
        token: string;
        deviceId?: string;
      };
      if (deviceId) rememberRealtimeDeviceId(deviceId);
      persistToken(nextToken);
      setToken(nextToken);
      setUser(parseJwtUser(nextToken) ?? { walletAddress });
    } finally {
      setIsLoading(false);
    }
  }, [connect, publicKey]);

  const signOut = useCallback(() => {
    removeToken();
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, token, signIn, signOut, isLoading }),
    [isLoading, signIn, signOut, token, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
