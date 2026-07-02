'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ChatMessage } from '@/hooks/useMessageHistory';
import type { Socket } from 'socket.io-client';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';

export interface MessageThreadProps {
  messages: ChatMessage[];
  loadingOlder: boolean;
  hasReachedStart: boolean;
  onLoadOlder: () => void;
  triggerDistance?: number;
  renderMessage?: (message: ChatMessage) => React.ReactNode;
  /** Socket instance for listening to typing events */
  socket?: Socket | null;
  /** The current user's id — used to suppress own typing indicator */
  currentUserId?: string;
  /** The conversation being viewed */
  conversationId?: string;
}

export function MessageThread({
  messages,
  loadingOlder,
  hasReachedStart,
  onLoadOlder,
  triggerDistance = 120,
  renderMessage,
  socket,
  currentUserId,
  conversationId,
}: MessageThreadProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previousHeightRef = useRef<number | null>(null);
  const previousFirstIdRef = useRef<string | null>(null);
  const triggeredRef = useRef(false);

  // Typing indicator state: set of userIds currently typing
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const autoHideTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (!socket || !conversationId) return;

    function addTyping(userId: string) {
      if (userId === currentUserId) return;
      // Clear existing auto-hide timer
      const existing = autoHideTimers.current.get(userId);
      if (existing) clearTimeout(existing);
      setTypingUsers((prev) => new Set([...prev, userId]));
      // Auto-hide after 3s if no typing_stop received
      autoHideTimers.current.set(
        userId,
        setTimeout(() => removeTyping(userId), 3000),
      );
    }

    function removeTyping(userId: string) {
      const timer = autoHideTimers.current.get(userId);
      if (timer) clearTimeout(timer);
      autoHideTimers.current.delete(userId);
      setTypingUsers((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }

    function onTypingStart(payload: { conversationId: string; userId: string }) {
      if (payload.conversationId !== conversationId) return;
      addTyping(payload.userId);
    }

    function onTypingStop(payload: { conversationId: string; userId: string }) {
      if (payload.conversationId !== conversationId) return;
      removeTyping(payload.userId);
    }

    function onNewMessage(msg: { conversationId: string }) {
      if (msg.conversationId !== conversationId) return;
      // Hide all typing indicators when a new message arrives
      autoHideTimers.current.forEach((t) => clearTimeout(t));
      autoHideTimers.current.clear();
      setTypingUsers(new Set());
    }

    socket.on('typing_start', onTypingStart);
    socket.on('typing_stop', onTypingStop);
    socket.on('new_message', onNewMessage);

    return () => {
      socket.off('typing_start', onTypingStart);
      socket.off('typing_stop', onTypingStop);
      socket.off('new_message', onNewMessage);
    };
  }, [socket, conversationId, currentUserId]);

  // Capture scroll metrics BEFORE the next paint so we can restore scrollTop
  // after older messages are prepended.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const firstId = messages[0]?.id ?? null;
    const previousFirstId = previousFirstIdRef.current;
    const previousHeight = previousHeightRef.current;

    // Only adjust on a real prepend: a different head-of-list id AND we
    // had a prior height to compare against.
    if (
      previousFirstId !== null &&
      firstId !== null &&
      previousFirstId !== firstId &&
      previousHeight !== null
    ) {
      const delta = el.scrollHeight - previousHeight;
      if (delta > 0) {
        el.scrollTop = el.scrollTop + delta;
      }
    }

    previousHeightRef.current = el.scrollHeight;
    previousFirstIdRef.current = firstId;
  }, [messages]);

  // Re-arm the load-older trigger when the user scrolls back down.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function handleScroll() {
      if (!el) return;
      const nearTop = el.scrollTop <= triggerDistance;
      if (!nearTop) {
        triggeredRef.current = false;
        return;
      }
      if (triggeredRef.current || loadingOlder || hasReachedStart) return;
      triggeredRef.current = true;
      onLoadOlder();
    }
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [triggerDistance, loadingOlder, hasReachedStart, onLoadOlder]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      className="flex h-full flex-col gap-2 overflow-y-auto px-4 py-3"
    >
      {messages.length === 0 && !loadingOlder && hasReachedStart ? (
        <div className="flex flex-1 items-center justify-center px-4 py-3">
          <EmptyState
            icon="💬"
            title="No messages yet"
            description="Start the conversation by sending a message."
          />
        </div>
      ) : (
        <>
          {/* Top indicators: spinner while loading, "no more messages" once we hit the start. */}
          <div className="flex flex-col items-center gap-1 py-2 text-xs text-gray-500">
            {loadingOlder ? (
              <Spinner size="sm" label="Loading older messages" />
            ) : hasReachedStart && messages.length > 0 ? (
              <span>No more messages</span>
            ) : null}
          </div>

          {messages.map((message) =>
            renderMessage ? (
              <div key={message.id}>{renderMessage(message)}</div>
            ) : (
              <DefaultMessageRow key={message.id} message={message} />
            ),
          )}

          {typingUsers.size > 0 && (
            <div
              aria-live="polite"
              aria-atomic="true"
              className="px-1 text-xs text-gray-500 italic"
            >
              {[...typingUsers].join(', ')} {typingUsers.size === 1 ? 'is' : 'are'} typing…
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DefaultMessageRow({ message }: { message: ChatMessage }) {
  // #185 – display decrypted content. In E2EE mode content comes in as ciphertext,
  // which our decryption shim currently passes through verbatim.
  const text = message.content || message.ciphertext || '';
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm">
      <div className="text-xs font-semibold text-gray-700">{message.senderId}</div>
      <div className="text-gray-900">{text}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wide text-gray-400">
        {new Date(message.createdAt).toLocaleString()}
      </div>
    </div>
  );
}
