'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useWallet } from '@/contexts/WalletContext';
import { PushPermissionPrompt } from '@/components/PushPermissionPrompt';

// Custom premium SVG Icons to avoid dependency weight
const LogoIcon = () => (
  <svg
    className="w-8 h-8 text-accent animate-pulse"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 13.8214 2.48697 15.5291 3.33782 17L2 22L7 20.6622C8.47089 21.513 10.1786 22 12 22Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M8 12H16M12 8V16"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const MessagesIcon = () => (
  <svg
    className="w-5 h-5 transition-transform group-hover:scale-110"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M21 15C21 15.5304 20.7893 16.0391 20.4142 16.4142C20.0391 16.7893 19.5304 17 19 17H7L3 21V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H19C19.5304 3 20.0391 3.21071 20.4142 3.58579C20.7893 3.96086 21 4.46957 21 5V15Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const TreasuryIcon = () => (
  <svg
    className="w-5 h-5 transition-transform group-hover:scale-110"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect
      x="2"
      y="5"
      width="20"
      height="14"
      rx="2"
      ry="2"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12 14C13.6569 14 15 12.6569 15 11C15 9.34315 13.6569 8 12 8C10.3431 8 9 9.34315 9 11C9 12.6569 10.3431 14 12 14Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M22 11H18M6 11H2"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ProposalsIcon = () => (
  <svg
    className="w-5 h-5 transition-transform group-hover:scale-110"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14 2V8H20M16 13H8M16 17H8M10 9H8"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const WalletIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M20 12V8C20 5.79086 18.2091 4 16 4H4C2.89543 4 2 4.89543 2 6V18C2 19.1046 2.89543 20 4 20H16C18.2091 20 20 18.2091 20 16V14M22 12H18C16.8954 12 16 12.8954 16 14C16 15.1046 16.8954 16 18 16H22"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

interface NavItemProps {
  href: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
}

const NavItem: React.FC<NavItemProps> = ({ href, label, icon, active }) => {
  return (
    <Link
      href={href}
      className={`group relative flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-300 ${
        active
          ? 'bg-accent/15 text-white font-medium shadow-[0_0_15px_rgba(124,92,252,0.15)]'
          : 'text-foreground/60 hover:text-foreground hover:bg-white/5'
      }`}
    >
      {active && (
        <span className="absolute left-0 top-1/4 bottom-1/4 w-[4px] bg-accent rounded-r-md" />
      )}
      <div className={active ? 'text-accent' : 'text-foreground/40 group-hover:text-foreground/75'}>
        {icon}
      </div>
      <span className="hidden md:inline text-sm tracking-wide transition-opacity duration-300">
        {label}
      </span>
    </Link>
  );
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { publicKey, connect, disconnect } = useWallet();
  const [isConnecting, setIsConnecting] = useState(false);

  // Listen for sw:sync messages from the service worker (notification click).
  // Navigate to the conversation so the page re-fetches fresh data.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    function onSwMessage(event: MessageEvent<{ type: string; conversationId?: string | null }>) {
      if (event.data?.type !== 'sw:sync') return;
      const { conversationId } = event.data;
      if (conversationId) {
        router.push(`/app/conversations/${conversationId}`);
      } else {
        router.push('/app/messages');
      }
    }

    navigator.serviceWorker.addEventListener('message', onSwMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onSwMessage);
  }, [router]);

  const handleWalletAction = async () => {
    if (publicKey) {
      disconnect();
    } else {
      setIsConnecting(true);
      try {
        await connect();
      } catch (err) {
        console.error('Wallet connection failed:', err);
      } finally {
        setIsConnecting(false);
      }
    }
  };

  const navItems = [
    { href: '/app/messages', label: 'Messages', icon: <MessagesIcon /> },
    { href: '/app/treasury', label: 'Treasury', icon: <TreasuryIcon /> },
    { href: '/app/proposals', label: 'Proposals', icon: <ProposalsIcon /> },
  ];

  const displayAddress = publicKey ? `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}` : '';

  return (
    <div className="flex min-h-screen bg-background text-foreground font-sans">
      {/* Sidebar Layout */}
      <aside className="fixed left-0 top-0 bottom-0 z-40 flex flex-col justify-between border-r border-border bg-card/60 backdrop-blur-xl transition-all duration-300 w-16 md:w-[240px] px-3 py-6 md:p-6">
        <div className="flex flex-col gap-8">
          {/* Logo Section */}
          <Link href="/app" className="flex items-center gap-3 px-2 md:px-3">
            <LogoIcon />
            <span className="hidden md:inline font-bold text-xl tracking-wider bg-gradient-to-r from-white via-foreground to-accent bg-clip-text text-transparent">
              Clicked
            </span>
          </Link>

          {/* Navigation Links */}
          <nav className="flex flex-col gap-1.5">
            {navItems.map((item) => (
              <NavItem
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={
                  pathname === item.href || (item.href === '/app/messages' && pathname === '/app')
                } // default to messages if exactly /app
              />
            ))}
          </nav>
        </div>

        {/* Connected Wallet Section at bottom */}
        {publicKey ? (
          <button
            onClick={handleWalletAction}
            className="w-full relative flex items-center gap-3 p-2 md:p-3.5 rounded-2xl bg-white/[0.02] border border-white/[0.05] shadow-inner transition-all duration-300 hover:bg-white/[0.05] hover:border-accent/30 text-left group"
          >
            {/* Avatar with glowing status dot */}
            <div className="relative flex-shrink-0">
              <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-accent to-accent-light flex items-center justify-center font-bold text-xs text-white shadow-md">
                C
              </div>
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-500 border-2 border-card rounded-full shadow-[0_0_8px_#10b981]" />
            </div>

            {/* Wallet Address Label */}
            <div className="hidden md:flex flex-col min-w-0">
              <span className="text-[10px] uppercase font-semibold text-foreground/40 tracking-wider group-hover:text-accent-light transition-colors">
                Connected
              </span>
              <span className="text-xs font-mono font-medium text-foreground/80 truncate">
                {displayAddress}
              </span>
            </div>
          </button>
        ) : (
          <button
            onClick={handleWalletAction}
            disabled={isConnecting}
            className="w-full flex items-center justify-center gap-2.5 px-3 py-3 rounded-2xl bg-accent hover:bg-accent-light disabled:bg-accent/40 text-white text-xs font-semibold shadow-md shadow-accent/20 transition-all duration-300 active:scale-95 cursor-pointer disabled:cursor-not-allowed"
          >
            <WalletIcon />
            <span className="hidden md:inline">
              {isConnecting ? 'Connecting...' : 'Connect Wallet'}
            </span>
          </button>
        )}
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 pl-16 md:pl-[240px] transition-all duration-300 min-h-screen flex flex-col">
        <main className="flex-1 p-4 md:p-8 max-w-7xl mx-auto w-full">{children}</main>
      </div>

      {/* Contextual push permission prompt — shown 5 s after the user enters
          the app, suppressed on denial or dismissal. */}
      <PushPermissionPrompt />
    </div>
  );
}
