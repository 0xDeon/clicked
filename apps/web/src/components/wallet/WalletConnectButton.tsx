'use client';

import { useRef, useEffect } from 'react';
import { useState } from 'react';
import { useWallet } from '@/contexts/WalletContext';
import { useRouter } from 'next/navigation';

function truncateAddress(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function WalletConnectButton() {
  const { publicKey, connect, disconnect } = useWallet();
  const router = useRouter();
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const handleConnect = async () => {
    setIsConnecting(true);
    setError(null);
    try {
      await connect();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wallet connection failed');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleCopyAddress = async () => {
    if (publicKey) {
      await navigator.clipboard.writeText(publicKey);
      alert(`Address copied to clipboard ${publicKey}`);
      setIsDropdownOpen(false);
    }
  };

  const handleEditProfile = () => {
    router.push('/app/profile');
    setIsDropdownOpen(false);
  };

  const handleDisconnect = () => {
    disconnect();
    setIsDropdownOpen(false);
  };

  // Close dropdown on outside click or Escape
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }

    function handleEscapeKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsDropdownOpen(false);
      }
    }

    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscapeKey);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscapeKey);
    };
  }, [isDropdownOpen]);

  return (
    <div className="flex flex-col items-start gap-2">
      {publicKey ? (
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="rounded-full border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-sm font-medium text-[var(--foreground)] transition-colors hover:border-[var(--accent)]"
            title="Wallet menu"
          >
            {truncateAddress(publicKey)}
          </button>

          {isDropdownOpen && (
            <div className="absolute right-0 mt-2 w-48 rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-lg">
              <button
                type="button"
                onClick={handleEditProfile}
                className="w-full px-4 py-2 text-left text-sm font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] hover:bg-opacity-20 first:rounded-t-lg"
              >
                Edit profile
              </button>
              <button
                type="button"
                onClick={handleCopyAddress}
                className="w-full px-4 py-2 text-left text-sm font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] hover:bg-opacity-20"
              >
                Copy address
              </button>
              <button
                type="button"
                onClick={handleDisconnect}
                className="w-full px-4 py-2 text-left text-sm font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] hover:bg-opacity-20 last:rounded-b-lg"
              >
                Disconnect wallet
              </button>
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={handleConnect}
          disabled={isConnecting}
          className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isConnecting ? 'Connecting…' : 'Connect Wallet'}
        </button>
      )}
      {error && <p className="max-w-64 text-xs text-red-300">{error}</p>}
    </div>
  );
}
