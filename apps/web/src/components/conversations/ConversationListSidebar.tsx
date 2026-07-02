'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE_URL } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useSocket } from '@/hooks/useSocket';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonLoader } from '@/components/ui/SkeletonLoader';
import { Avatar } from '@/components/ui/Avatar';

interface Wallet {
  address?: string;
  isPrimary?: boolean;
}

interface Member {
  user?: {
    id?: string;
    username?: string | null;
    avatarUrl?: string | null;
    wallets?: Wallet[];
  };
}

interface Message {
  id: string;
  content: string;
  createdAt: string;
}

interface Conversation {
  id: string;
  type: 'dm' | 'group';
  name?: string | null;
  createdAt?: string;
  members?: Member[];
  messages?: Message[];
  unreadCount?: number;
}

function truncate(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function relativeTime(value?: string) {
  if (!value) return '';

  const diffSeconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  const units = [
    ['y', 31536000],
    ['mo', 2592000],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ] as const;

  for (const [label, seconds] of units) {
    if (diffSeconds >= seconds) return `${Math.floor(diffSeconds / seconds)}${label} ago`;
  }

  return 'just now';
}

function conversationTitle(conversation: Conversation, walletAddress?: string) {
  if (conversation.name) return conversation.name;

  const peer = conversation.members
    ?.flatMap((member) => member.user?.wallets ?? [])
    .find((wallet) => wallet.address && wallet.address !== walletAddress);

  return peer?.address ?? 'Direct message';
}

function getPeerUser(conversation: Conversation, currentWalletAddress?: string) {
  if (conversation.type !== 'dm') return null;
  const peerMember = conversation.members?.find((m) =>
    m.user?.wallets?.some((w) => w.address && w.address !== currentWalletAddress),
  );
  return peerMember?.user ?? null;
}

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function ConversationListSidebar() {
  const params = useParams<{ id?: string }>();
  const { token, user } = useAuth();
  const socket = useSocket(token);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [onlineUsers, setOnlineUsers] = useState<Map<string, boolean>>(new Map());
  const offlineTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // unreadCounts: initialized from API's unreadCount field, updated by socket events
  const [unreadCounts, setUnreadCounts] = useState<Map<string, number>>(new Map());
  // latestMessageIds: tracks the last known message ID per conversation for message_read emit
  const latestMessageIds = useRef<Map<string, string>>(new Map());

  const selectedId = useMemo(() => params?.id, [params]);
  // Keep a ref so socket callbacks always see the current selected conversation
  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;

    async function loadConversations() {
      if (!token) {
        setConversations([]);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`${API_BASE_URL}/conversations`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          throw new Error('Unable to fetch conversations');
        }

        const data = (await response.json()) as Conversation[];
        if (cancelled) return;

        setConversations(data);

        // Seed unread counts and latest message IDs from API response
        const counts = new Map<string, number>();
        const lastIds = new Map<string, string>();
        for (const conv of data) {
          counts.set(conv.id, conv.unreadCount ?? 0);
          const lastMsg = conv.messages?.[0];
          if (lastMsg?.id) lastIds.set(conv.id, lastMsg.id);
        }
        setUnreadCounts(counts);
        latestMessageIds.current = lastIds;
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Unable to load conversations');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadConversations();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Load initial presence for DM conversations
  useEffect(() => {
    if (!token || conversations.length === 0) return;

    const dmConversations = conversations.filter((c) => c.type === 'dm');
    dmConversations.forEach(async (conv) => {
      const peer = getPeerUser(conv, user?.walletAddress);
      const peerUserId = peer?.id;
      if (!peerUserId) return;

      try {
        const response = await fetch(`${API_BASE_URL}/users/${peerUserId}/presence`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) {
          const data = (await response.json()) as { online: boolean };
          setOnlineUsers((prev) => {
            const next = new Map(prev);
            next.set(peerUserId, data.online);
            return next;
          });
        }
      } catch (err) {
        console.error('Failed to fetch presence for', peerUserId, err);
      }
    });
  }, [conversations, token, user?.walletAddress]);

  // Clean up all offline timers when component unmounts
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      offlineTimers.current.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  // Presence socket listeners
  useEffect(() => {
    if (!socket) return;

    function handleOnline(userId: string) {
      const existingTimer = offlineTimers.current.get(userId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        offlineTimers.current.delete(userId);
      }
      setOnlineUsers((prev) => {
        const next = new Map(prev);
        next.set(userId, true);
        return next;
      });
    }

    function handleOffline(userId: string) {
      const existingTimer = offlineTimers.current.get(userId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }
      const timer = setTimeout(() => {
        setOnlineUsers((prev) => {
          const next = new Map(prev);
          next.set(userId, false);
          return next;
        });
        offlineTimers.current.delete(userId);
      }, 4500);
      offlineTimers.current.set(userId, timer);
    }

    function onUserOnline(data: { userId: string }) {
      handleOnline(data.userId);
    }

    function onUserOffline(data: { userId: string }) {
      handleOffline(data.userId);
    }

    function onPresenceUpdate(data: { userId: string; online?: boolean; status?: 'online' | 'offline'; lastSeen?: number }) {
      const isOnline = data.status ? data.status === 'online' : !!data.online;
      if (isOnline) {
        handleOnline(data.userId);
      } else {
        handleOffline(data.userId);
      }
    }

    socket.on('user_online', onUserOnline);
    socket.on('user_offline', onUserOffline);
    socket.on('presence_update', onPresenceUpdate);

    return () => {
      socket.off('user_online', onUserOnline);
      socket.off('user_offline', onUserOffline);
      socket.off('presence_update', onPresenceUpdate);
    };
  }, [socket]);

  // Handle new_message events: increment unread for background conversations,
  // emit message_read immediately for the active conversation.
  useEffect(() => {
    if (!socket) return;

    function onNewMessage(msg: { id: string; conversationId: string }) {
      const { id, conversationId } = msg;

      // Always track the latest message ID for this conversation
      latestMessageIds.current.set(conversationId, id);

      if (conversationId === selectedIdRef.current) {
        // Conversation is open — mark read immediately
        socket!.emit('message_read', { conversationId, lastReadMessageId: id });
      } else {
        // Background conversation — increment badge
        setUnreadCounts((prev) => {
          const next = new Map(prev);
          next.set(conversationId, (next.get(conversationId) ?? 0) + 1);
          return next;
        });
      }
    }

    socket.on('new_message', onNewMessage);
    return () => {
      socket.off('new_message', onNewMessage);
    };
  }, [socket]);

  // When the selected conversation changes, clear its badge and emit message_read.
  useEffect(() => {
    if (!selectedId || !socket) return;

    setUnreadCounts((prev) => {
      if (!prev.has(selectedId) || prev.get(selectedId) === 0) return prev;
      const next = new Map(prev);
      next.set(selectedId, 0);
      return next;
    });

    const lastId = latestMessageIds.current.get(selectedId);
    if (lastId) {
      socket.emit('message_read', { conversationId: selectedId, lastReadMessageId: lastId });
    }
  }, [selectedId, socket]);

  return (
    <aside className="flex h-full w-full max-w-sm flex-col border-r border-border bg-(--card)/60">
      <div className="border-b border-border px-4 py-5">
        <h2 className="text-lg font-semibold">Conversations</h2>
        <p className="text-sm text-(--foreground)/45">Your latest chats</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {isLoading ? <ConversationSkeleton /> : null}
        {!isLoading && error ? <p className="p-4 text-sm text-red-300">{error}</p> : null}
        {!isLoading && !error && conversations.length === 0 ? (
          <EmptyState
            icon="💬"
            title="No conversations yet."
            description="Start a new chat to see messages here."
          />
        ) : null}

        <div className="flex flex-col gap-2">
          {conversations.map((conversation) => {
            const lastMessage = conversation.messages?.[0];
            const isSelected = selectedId === conversation.id;
            const unread = unreadCounts.get(conversation.id) ?? 0;

            const title = conversationTitle(conversation, user?.walletAddress);
            const peer = getPeerUser(conversation, user?.walletAddress);
            const avatarUrl = peer?.avatarUrl ?? null;
            const isOnline = peer?.id ? (onlineUsers.get(peer.id) ?? false) : false;
            const memberCount = conversation.members?.length ?? 0;

            return (
              <Link
                key={conversation.id}
                href={`/app/conversations/${conversation.id}`}
                className={`flex gap-3 rounded-2xl border p-4 transition-colors ${
                  isSelected
                    ? 'border-accent bg-(--accent)/15'
                    : 'border-transparent hover:border-border hover:bg-(--background)/60'
                }`}
              >
                <Avatar
                  src={avatarUrl ?? undefined}
                  fallback={title}
                  size="md"
                  online={conversation.type === 'dm' && isOnline}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold">{title}</h3>
                      {conversation.type === 'group' && (
                        <span className="text-xs text-(--foreground)/45">
                          {memberCount} member{memberCount !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-xs text-(--foreground)/35">
                        {relativeTime(lastMessage?.createdAt ?? conversation.createdAt)}
                      </span>
                      <UnreadBadge count={unread} />
                    </div>
                  </div>
                  <p className="mt-1 truncate text-sm text-(--foreground)/45">
                    {lastMessage ? truncate(lastMessage.content, 40) : 'No messages yet'}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

function ConversationSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-label="Loading conversations">
      {Array.from({ length: 5 }).map((_, index) => (
        <SkeletonLoader key={index} variant="card" />
      ))}
    </div>
  );
}
