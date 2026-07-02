'use client';

import { useRef, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';

interface Member {
  user?: {
    id?: string;
    username?: string | null;
    avatarUrl?: string | null;
    wallets?: { address?: string; isPrimary?: boolean }[];
  };
}

interface ConversationHeaderProps {
  conversationId: string;
  type: 'dm' | 'group';
  name?: string | null;
  members?: Member[];
  /** Current user's wallet address — used to find the DM peer */
  currentWalletAddress?: string;
  /** Whether the current user has muted this conversation */
  isMuted?: boolean;
  onLeave: (conversationId: string) => Promise<void>;
  onMuteToggle: (conversationId: string, muted: boolean) => Promise<void>;
  onViewMembers: () => void;
}

function peerLabel(members: Member[], currentWalletAddress?: string): string {
  const peer = members
    .flatMap((m) => m.user?.wallets ?? [])
    .find((w) => w.address && w.address !== currentWalletAddress);
  return peer?.address ?? 'Direct message';
}

function peerAvatarUrl(members: Member[], currentWalletAddress?: string): string | null {
  const peerMember = members.find((m) =>
    m.user?.wallets?.some((w) => w.address && w.address !== currentWalletAddress),
  );
  return peerMember?.user?.avatarUrl ?? null;
}

export function ConversationHeader({
  conversationId,
  type,
  name,
  members = [],
  currentWalletAddress,
  isMuted = false,
  onLeave,
  onMuteToggle,
  onViewMembers,
}: ConversationHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [muted, setMuted] = useState(isMuted);
  const menuRef = useRef<HTMLDivElement>(null);

  const title =
    type === 'group' ? (name ?? 'Group conversation') : peerLabel(members, currentWalletAddress);

  const avatarUrl = type === 'dm' ? peerAvatarUrl(members, currentWalletAddress) : null;

  // Derive online status: not tracked server-side yet, placeholder false
  const isOnline = false;

  async function handleLeaveConfirm() {
    setConfirmLeave(false);
    setMenuOpen(false);
    await onLeave(conversationId);
  }

  async function handleMuteToggle() {
    const next = !muted;
    setMuted(next);
    setMenuOpen(false);
    await onMuteToggle(conversationId, next);
  }

  return (
    <header className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--card)]/60 px-4 py-3">
      <div className="flex items-center gap-3">
        {/* Avatar (DM only) */}
        {type === 'dm' && (
          <div className="relative shrink-0">
            <Avatar src={avatarUrl ?? undefined} fallback={title} size="md" />
            {/* Online status dot */}
            <span
              aria-label={isOnline ? 'Online' : 'Offline'}
              className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white ${
                isOnline ? 'bg-green-500' : 'bg-gray-400'
              }`}
            />
          </div>
        )}

        <div>
          <h1 className="text-sm font-semibold leading-tight">{title}</h1>
          {type === 'group' && (
            <p className="text-xs text-[var(--foreground)]/45">
              {members.length} member{members.length !== 1 ? 's' : ''}
            </p>
          )}
        </div>
      </div>

      {/* Three-dot menu */}
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          aria-label="Conversation options"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
          className="rounded-full p-2 text-[var(--foreground)]/60 transition hover:bg-[var(--background)]/60 hover:text-[var(--foreground)]"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <circle cx="8" cy="2" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="8" cy="14" r="1.5" />
          </svg>
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-xl border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onViewMembers();
              }}
              className="w-full px-4 py-2 text-left text-sm hover:bg-[var(--background)]/60"
            >
              View members
            </button>
            <button
              type="button"
              onClick={() => void handleMuteToggle()}
              className="w-full px-4 py-2 text-left text-sm hover:bg-[var(--background)]/60"
            >
              {muted ? 'Unmute' : 'Mute'}
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setConfirmLeave(true);
              }}
              className="w-full px-4 py-2 text-left text-sm text-red-500 hover:bg-[var(--background)]/60"
            >
              Leave conversation
            </button>
          </div>
        )}
      </div>

      {/* Leave confirmation dialog */}
      {confirmLeave && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="leave-dialog-title"
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/40"
        >
          <div className="w-80 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-xl">
            <h2 id="leave-dialog-title" className="text-sm font-semibold">
              Leave conversation?
            </h2>
            <p className="mt-2 text-xs text-[var(--foreground)]/60">
              You will no longer receive messages from this conversation.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmLeave(false)}
                className="rounded-full px-4 py-2 text-xs font-semibold hover:bg-[var(--background)]/60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleLeaveConfirm()}
                className="rounded-full bg-red-500 px-4 py-2 text-xs font-semibold text-white hover:bg-red-600"
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
