'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { requestWalletAccess } from '@/lib/freighter';

interface WalletContextValue {
  publicKey: string | null;
  connect: () => Promise<string>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);

  const connect = useCallback(async () => {
    const nextPublicKey = await requestWalletAccess();
    setPublicKey(nextPublicKey);
    return nextPublicKey;
  }, []);

  const disconnect = useCallback(() => {
    setPublicKey(null);
  }, []);

  const value = useMemo(
    () => ({ publicKey, connect, disconnect }),
    [connect, disconnect, publicKey],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within WalletProvider');
  }
  return context;
}
