'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { useMessageSearchIndex } from './useMessageSearchIndex';

/**
 * Shape we keep in client state. Mirrors the columns the backend currently
 * returns from `db.query.messages.findMany`. Kept here so consumers don't
 * need to import anything else.
 */
export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  createdAt: string; // ISO timestamp
  /** E2EE fields – present when messages come from the real backend */
  ciphertext?: string | null;
  contentType?: string;
  sequenceNumber?: number | null;
}

interface HistoryAck {
  conversationId: string;
  messages: ChatMessage[];
  /** `true` when the server returned an empty page (no older messages). */
  done?: boolean;
}

interface UseMessageHistoryOptions {
  socket: Socket | null;
  conversationId: string;
}

interface UseMessageHistoryReturn {
  messages: ChatMessage[];
  loadingOlder: boolean;
  hasReachedStart: boolean;
  /** Triggers fetching one page older than the current oldest message. */
  loadOlder: () => void;
}

/**
 * Issue #32 — client side of the existing backend `message_history`
 * socket event (see `apps/backend/src/socket/messaging.ts`).
 *
 * Maintains messages in oldest-first order. `loadOlder()` emits
 * `message_history` with `{ conversationId, before }`, where `before`
 * is the id of the currently-oldest message — exactly what the backend
 * handler expects. On ack:
 *
 * - Prepends only messages whose ids are not already in the list (so a
 *   replayed event or a paged-over boundary message doesn't duplicate).
 * - Flips `hasReachedStart = true` when the server returns an empty page.
 *
 * Tying the de-duplication to ids (not indices) is what lets
 * `MessageThread` use `id` as a React key without ever rendering two
 * rows with the same key.
 *
 * #185 – messages are indexed into a local E2EE search cache (IndexedDB +
 * Web Worker) as they arrive, so search works offline over decrypted
 * plaintext.
 */
export function useMessageHistory({
  socket,
  conversationId,
}: UseMessageHistoryOptions): UseMessageHistoryReturn {
  // All per-conversation state is kept in a single object so switching
  // conversations is one setState call. React's documented pattern for
  // "reset state when a prop changes" is to call setState directly
  // during render, comparing the new prop against the previous-render
  // value already held in state — no useEffect, no extra commit.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [conversationState, setConversationState] = useState({
    conversationId,
    messages: [] as ChatMessage[],
    loadingOlder: false,
    hasReachedStart: false,
  });
  if (conversationState.conversationId !== conversationId) {
    setConversationState({
      conversationId,
      messages: [],
      loadingOlder: false,
      hasReachedStart: false,
    });
  }
  const { messages, loadingOlder, hasReachedStart } = conversationState;
  const setMessages = useCallback(
    (next: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) =>
      setConversationState((state) => ({
        ...state,
        messages: typeof next === 'function' ? next(state.messages) : next,
      })),
    [],
  );
  const setLoadingOlder = useCallback(
    (next: boolean) => setConversationState((state) => ({ ...state, loadingOlder: next })),
    [],
  );
  const setHasReachedStart = useCallback(
    (next: boolean) => setConversationState((state) => ({ ...state, hasReachedStart: next })),
    [],
  );

  // The oldest-known id powers the cursor for the next fetch.
  const oldestIdRef = useRef<string | null>(null);
  useEffect(() => {
    oldestIdRef.current = messages[0]?.id ?? null;
  }, [messages]);

  // Listen for ack payloads addressed to this conversation.
  useEffect(() => {
    if (!socket) return undefined;
    function onHistory(ack: HistoryAck) {
      if (ack.conversationId !== conversationId) return;
      setLoadingOlder(false);
      if (!ack.messages || ack.messages.length === 0 || ack.done) {
        setHasReachedStart(true);
        return;
      }
      setMessages((current) => {
        const seen = new Set(current.map((m) => m.id));
        const fresh = ack.messages.filter((m) => !seen.has(m.id));
        if (fresh.length === 0) return current;
        // Backend may return newest-first or oldest-first; normalize to
        // oldest-first so prepending is just a head splice.
        const ordered = [...fresh].sort(
          (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
        );
        return [...ordered, ...current];
      });
    }
    socket.on('message_history', onHistory);
    return () => {
      socket.off('message_history', onHistory);
    };
  }, [socket, conversationId, setHasReachedStart, setLoadingOlder, setMessages]);

  // Listen for live new_message events and append them.
  useEffect(() => {
    if (!socket) return;
    function onNewMessage(raw: any) {
      if (!raw || raw.conversationId !== conversationId) return;
      const msg: ChatMessage = {
        id: raw.id,
        conversationId: raw.conversationId,
        senderId: raw.senderId,
        content: raw.ciphertext ?? raw.content ?? '',
        createdAt: raw.createdAt ?? new Date().toISOString(),
        ciphertext: raw.ciphertext ?? null,
        contentType: raw.contentType,
        sequenceNumber: raw.sequenceNumber ?? null,
      };
      setMessages((current) => {
        if (current.some(m => m.id === msg.id)) return current;
        return [...current, msg];
      });
    }
    socket.on('new_message', onNewMessage);
    return () => { socket.off('new_message', onNewMessage); };
  }, [socket, conversationId, setMessages]);

  const loadOlder = useCallback(() => {
    if (!socket || loadingOlder || hasReachedStart) return;
    setLoadingOlder(true);
    socket.emit('message_history', {
      conversationId,
      before: oldestIdRef.current ?? undefined,
    });
  }, [socket, conversationId, loadingOlder, hasReachedStart, setLoadingOlder]);

  // #185 – index decrypted messages for local search
  useMessageSearchIndex(messages);

  return useMemo(
    () => ({ messages, loadingOlder, hasReachedStart, loadOlder }),
    [messages, loadingOlder, hasReachedStart, loadOlder],
  );
}
