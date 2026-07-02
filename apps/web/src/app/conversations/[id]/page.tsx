'use client';

import { useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
import { useParams } from 'next/navigation';
import { useSocket } from '@/hooks/useSocket';
import { useInboundPipeline } from '@/hooks/useInboundPipeline';
import { InboundMessageRow } from '@/components/messaging/InboundMessageRow';
import { parseJwtPayload } from '@/lib/jwt';

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
      <Image
        src={src}
        alt={name}
        width={32}
        height={32}
        className="h-8 w-8 rounded-full object-cover flex-shrink-0"
      />
    );
  }
  return (
    <div className="h-8 w-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold bg-[var(--accent)] text-white">
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export default function ConversationPage() {
  const { id } = useParams<{ id: string }>();

  const token =
    typeof window !== 'undefined'
      ? (localStorage.getItem('clicked.jwt') ?? localStorage.getItem('token'))
      : null;
  const currentUserId =
    typeof window !== 'undefined' && token ? (parseJwtPayload(token)?.userId ?? null) : null;

  const socket = useSocket(token);
  const { messages, syncing } = useInboundPipeline({ socket, token, conversationId: id });

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback((force = false) => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (force || atBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    if (!socket) return;

    socket.emit('join_room', { conversationId: id });

    return () => {
      socket.emit('leave_room', { conversationId: id });
    };
  }, [socket, id]);

  useEffect(() => {
    scrollToBottom(true);
  }, [messages.length, scrollToBottom]);

  const grouped: { label: string; messages: typeof messages }[] = [];
  for (const msg of messages) {
    const key = dayKey(msg.createdAt);
    const last = grouped[grouped.length - 1];
    if (last && dayKey(last.messages[0]!.createdAt) === key) {
      last.messages.push(msg);
    } else {
      grouped.push({ label: formatDateLabel(msg.createdAt), messages: [msg] });
    }
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
                const name = isSelf ? 'You' : 'Contact';

                return (
                  <div
                    key={msg.messageId}
                    className={`flex items-end gap-2 ${isSelf ? 'flex-row-reverse' : 'flex-row'}`}
                  >
                    {!isSelf && <Avatar src={null} name={name} />}
                    <InboundMessageRow message={msg} isSelf={isSelf} senderName={name} />
                    {isSelf && <Avatar src={null} name={name} />}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
