'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { useParams } from 'next/navigation';
import { useAuth } from '@/components/auth/useAuth';
import { useSocket } from '@/hooks/useSocket';
import { emitSocketEnvelope, parseJwtClaims, setSyncCursor } from '@/lib/realtime';
import { useInboundPipeline } from '@/hooks/useInboundPipeline';
import { InboundMessageRow } from '@/components/messaging/InboundMessageRow';
import { parseJwtPayload } from '@/lib/jwt';

interface Sender {
  id: string;
  username: string | null;
  avatarUrl: string | null;
}

interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderDeviceId?: string | null;
  contentType?: string;
  content?: string;
  ciphertext?: string | null;
  sequenceNumber?: number;
  createdAt: string;
  pending?: boolean;
  delivered?: boolean;
  readBy?: string[];
  sender?: Sender;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

function dayKey(iso: string) {
  return new Date(iso).toDateString();
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  if (src) {
    return (
      <Image src={src} alt={name} width={32} height={32} className="h-8 w-8 rounded-full object-cover flex-shrink-0" />
    );
  }
  return <div className="h-8 w-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold bg-[var(--accent)] text-white">{name.charAt(0).toUpperCase()}</div>;
}

function normaliseMessage(msg: Partial<Message>): Message | null {
  const id = msg.id ?? (msg as { messageId?: string }).messageId;
  if (!id || !msg.conversationId) return null;
  return {
    id,
    conversationId: msg.conversationId,
    senderId: msg.senderId ?? '',
    senderDeviceId: msg.senderDeviceId,
    contentType: msg.contentType ?? 'text',
    content: msg.content ?? msg.ciphertext ?? '',
    ciphertext: msg.ciphertext ?? msg.content ?? '',
    sequenceNumber: msg.sequenceNumber,
    createdAt: msg.createdAt ?? new Date().toISOString(),
    pending: msg.pending,
    delivered: msg.delivered,
    readBy: msg.readBy ?? [],
    sender: msg.sender,
  };
}

export default function ConversationPage() {
  const { id } = useParams<{ id: string }>();
  const { token } = useAuth();
  const currentUserId = parseJwtClaims(token).userId ?? null;
  const socket = useSocket(token);
  const [messages, setMessages] = useState<Message[]>([]);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollToBottom = useCallback((force = false) => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (force || atBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const upsertMessage = useCallback((incoming: Partial<Message>) => {
    const msg = normaliseMessage(incoming);
    if (!msg || msg.conversationId !== id) return;
    setMessages((prev) => {
      const index = prev.findIndex((m) => m.id === msg.id);
      if (index !== -1) {
        const next = [...prev];
        next[index] = { ...next[index], ...msg, pending: msg.pending ?? next[index].pending };
        return next;
      }
      const next = [...prev, msg];
      return next.sort((a, b) => (a.sequenceNumber ?? Number.MAX_SAFE_INTEGER) - (b.sequenceNumber ?? Number.MAX_SAFE_INTEGER));
    });
  }, [id]);

  useEffect(() => {
    if (!socket) return;

    emitSocketEnvelope(socket, 'join_room', { conversationId: id });
    emitSocketEnvelope(socket, 'message_history', { conversationId: id });

    function onHistory(data: { conversationId: string; messages: Message[] }) {
      if (data.conversationId !== id) return;
      const next = data.messages.map(normaliseMessage).filter((m): m is Message => Boolean(m));
      setMessages(next);
      setTimeout(() => scrollToBottom(true), 50);
    }

    function onNewMessage(msg: Message) {
      if (msg.conversationId !== id) return;
      upsertMessage(msg);
      scrollToBottom();
      if (msg.id) emitSocketEnvelope(socket, 'message_read', { conversationId: id, lastReadMessageId: msg.id });
    }

    function onMessageEnvelope(msg: Message & { messageId?: string }) {
      onNewMessage({ ...msg, id: msg.id ?? msg.messageId, content: msg.ciphertext ?? msg.content });
      if (typeof msg.sequenceNumber === 'number') setSyncCursor(token, msg.sequenceNumber);
    }

    function onAck(ack: { messageId: string; sequenceNumber: number }) {
      setMessages((prev) => prev.map((m) => m.id === ack.messageId ? { ...m, pending: false, sequenceNumber: ack.sequenceNumber } : m));
      setSyncCursor(token, ack.sequenceNumber);
    }

    function onDeliveryReceipt(receipt: { conversationId: string; messageId: string }) {
      if (receipt.conversationId !== id) return;
      setMessages((prev) => prev.map((m) => m.id === receipt.messageId ? { ...m, delivered: true } : m));
    }

    function onReadReceipt(receipt: { conversationId: string; userId: string; lastReadMessageId: string }) {
      if (receipt.conversationId !== id) return;
      setMessages((prev) => prev.map((m) => {
        if (m.id !== receipt.lastReadMessageId) return m;
        return { ...m, readBy: Array.from(new Set([...(m.readBy ?? []), receipt.userId])) };
      }));
    }

    function onTypingStart(payload: { conversationId: string; userId: string }) {
      if (payload.conversationId !== id || payload.userId === currentUserId) return;
      setTypingUsers((prev) => new Set(prev).add(payload.userId));
    }

    function onTypingStop(payload: { conversationId: string; userId: string }) {
      if (payload.conversationId !== id) return;
      setTypingUsers((prev) => {
        const next = new Set(prev);
        next.delete(payload.userId);
        return next;
      });
    }

    socket.on('message_history', onHistory);
    socket.on('new_message', onNewMessage);
    socket.on('message_envelope', onMessageEnvelope);
    socket.on('message_ack', onAck);
    socket.on('delivery_receipt', onDeliveryReceipt);
    socket.on('read_receipt', onReadReceipt);
    socket.on('typing_start', onTypingStart);
    socket.on('typing_stop', onTypingStop);

    return () => {
      socket.off('message_history', onHistory);
      socket.off('new_message', onNewMessage);
      socket.off('message_envelope', onMessageEnvelope);
      socket.off('message_ack', onAck);
      socket.off('delivery_receipt', onDeliveryReceipt);
      socket.off('read_receipt', onReadReceipt);
      socket.off('typing_start', onTypingStart);
      socket.off('typing_stop', onTypingStop);
    };
  }, [socket, id, currentUserId, scrollToBottom, token, upsertMessage]);

  const grouped = useMemo(() => {
    const groups: { label: string; messages: Message[] }[] = [];
    for (const msg of messages) {
      const key = dayKey(msg.createdAt);
      const last = groups[groups.length - 1];
      if (last && dayKey(last.messages[0].createdAt) === key) last.messages.push(msg);
      else groups.push({ label: formatDateLabel(msg.createdAt), messages: [msg] });
    }
    return groups;
  }, [messages]);

  function handleTyping(value: string) {
    setInput(value);
    if (!socket) return;
    emitSocketEnvelope(socket, 'typing_start', { conversationId: id });
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      emitSocketEnvelope(socket, 'typing_stop', { conversationId: id });
    }, 1500);
  }

  function sendMessage() {
    const text = input.trim();
    if (!socket || !text) return;
    const messageId = crypto.randomUUID();
    const optimistic: Message = {
      id: messageId,
      conversationId: id,
      senderId: currentUserId ?? '',
      content: text,
      ciphertext: text,
      contentType: 'text',
      createdAt: new Date().toISOString(),
      pending: true,
      sender: { id: currentUserId ?? '', username: 'You', avatarUrl: null },
    };
    setMessages((prev) => [...prev, optimistic]);
    setInput('');
    emitSocketEnvelope(socket, 'typing_stop', { conversationId: id });
    emitSocketEnvelope(socket, 'send_message', {
      conversationId: id,
      messageId,
      contentType: 'text',
      ciphertext: text,
      envelopes: [{ recipientDeviceId: parseJwtClaims(token).deviceId ?? '', ciphertext: text }],
    });
    setTimeout(() => scrollToBottom(true), 0);
  }

  return (
    <div className="flex flex-col h-screen bg-[var(--background)]">
      <header className="flex-shrink-0 border-b border-[var(--border)] px-4 py-3 bg-[var(--card)]">
        <h1 className="text-sm font-semibold text-[var(--foreground)]">Conversation</h1>
        {syncing && (
          <p className="text-xs text-[var(--muted)] mt-0.5">Syncing encrypted messages…</p>
        )}
      </header>

      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {messages.length === 0 && !syncing && (
          <p className="text-center text-sm text-[var(--muted)] py-8">No messages yet.</p>
        )}

        {grouped.map((group) => (
          <div key={group.label}>
            <div className="flex items-center gap-3 my-4">
              <div className="flex-1 h-px bg-[var(--border)]" />
              <span className="text-xs text-[var(--muted)] font-medium px-2">{group.label}</span>
              <div className="flex-1 h-px bg-[var(--border)]" />
            </div>
            <div className="space-y-3">
              {group.messages.map((msg) => {
                const isSelf = msg.senderId === currentUserId;
                const name = msg.sender?.username ?? (isSelf ? 'You' : 'Unknown');
                return (
                  <div key={msg.id} className={`flex items-end gap-2 ${isSelf ? 'flex-row-reverse' : 'flex-row'}`}>
                    {!isSelf && <Avatar src={msg.sender?.avatarUrl ?? null} name={name} />}
                    <div className={`flex flex-col max-w-[70%] ${isSelf ? 'items-end' : 'items-start'}`}>
                      {!isSelf && <span className="text-xs text-[var(--muted)] mb-1 px-1">{name}</span>}
                      <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed break-words ${isSelf ? 'bg-[var(--accent)] text-white rounded-br-sm' : 'bg-[var(--card)] text-[var(--foreground)] border border-[var(--border)] rounded-bl-sm'}`}>
                        {msg.content ?? msg.ciphertext}
                      </div>
                      <span className="text-[10px] text-[var(--muted)] mt-1 px-1">
                        {formatTime(msg.createdAt)} {msg.pending ? '• sending…' : msg.readBy?.length ? '• read' : msg.delivered ? '• delivered' : ''}
                      </span>
                    </div>
                    {isSelf && <Avatar src={msg.sender?.avatarUrl ?? null} name={name} />}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {typingUsers.size > 0 && <div className="text-xs text-[var(--muted)] italic">Someone is typing…</div>}
        <div ref={bottomRef} />
      </div>

      <form className="flex gap-2 border-t border-[var(--border)] bg-[var(--card)] p-3" onSubmit={(e) => { e.preventDefault(); sendMessage(); }}>
        <input value={input} onChange={(e) => handleTyping(e.target.value)} placeholder="Type a secure message…" className="flex-1 rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" />
        <button type="submit" className="rounded-xl bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white disabled:opacity-50" disabled={!input.trim()}>Send</button>
      </form>
    </div>
  );
}
