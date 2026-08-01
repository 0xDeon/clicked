'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Fingerprint,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useParams } from 'next/navigation';
import { API_BASE_URL } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { emitSocketEnvelope } from '@/lib/realtime';
import { useAuth } from '@/components/auth/useAuth';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import TransferCard from '@/components/chat/TransferCard';
import { clearSessionKeys } from '@/lib/crypto/sessionStore';
import { sessionStore } from '@/lib/sessionStore';

import { useInboundPipeline } from '@/hooks/useInboundPipeline';
import { sendEncryptedMessage, fetchConversationDevices } from '@/lib/crypto';
import type { InboundMessage } from '@/lib/crypto/types';
import {
  sendEncryptedFile,
  downloadAndDecryptFile,
  parseFileMessagePayload,
} from '@/lib/fileEncryption';
import { generateEncryptedThumbnail } from '@/lib/thumbnail';
import { EncryptedThumbnail } from '@/components/messaging/EncryptedThumbnail';
import { UnavailableMessagePlaceholder } from '@/components/messaging/UnavailableMessagePlaceholder';

type Wallet = {
  address?: string;
  isPrimary?: boolean;
};

type Member = {
  user?: {
    id?: string;
    username?: string | null;
    avatarUrl?: string | null;
    wallets?: Wallet[];
  };
};

type Sender = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
};

type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  content?: string | null;
  ciphertext?: string | null;
  contentType?: string | null;
  /** Structured metadata for system messages; null for every other type. */
  systemPayload?: { userId?: string; change?: string } | null;
  createdAt: string;
  sender?: Sender;
  unavailable?: boolean;
  /** File message payload (decrypted envelope plaintext for file messages) */
  filePayload?: {
    fileId: string;
    fileName: string;
    mimeType: string;
    size: number;
    fileKey: string;
    iv: string;
    thumbnail?: { fileId: string; fileKey: string; iv: string; mimeType: string };
  };
};

type Conversation = {
  id: string;
  type: 'dm' | 'group';
  name?: string | null;
  members?: Member[];
};

type CurrentUser = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  wallets: Wallet[];
};

type SafetyFingerprint = {
  userId: string;
  fingerprint: string;
  formatted: string;
};

type SafetyVerification = {
  fingerprint: string;
  verifiedAt: string;
};

type SafetyState = {
  fingerprint: string | null;
  formatted: string | null;
  verifiedAt: string | null;
  changed: boolean;
  loading: boolean;
  error: string | null;
};

const EMPTY_SAFETY_STATE: SafetyState = {
  fingerprint: null,
  formatted: null,
  verifiedAt: null,
  changed: false,
  loading: true,
  error: null,
};

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function displayName(member: Member) {
  const user = member.user;
  return user?.username ?? user?.wallets?.find((wallet) => wallet.isPrimary)?.address ?? 'Contact';
}

function primaryWallet(member: Member) {
  return (
    member.user?.wallets?.find((wallet) => wallet.isPrimary)?.address ??
    member.user?.wallets?.[0]?.address ??
    null
  );
}

function verificationStorageKey(userId: string) {
  return `clicked.safetyVerification.${userId}`;
}

function readVerification(userId: string): SafetyVerification | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(verificationStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SafetyVerification>;
    if (typeof parsed.fingerprint !== 'string' || typeof parsed.verifiedAt !== 'string') {
      return null;
    }
    return { fingerprint: parsed.fingerprint, verifiedAt: parsed.verifiedAt };
  } catch {
    return null;
  }
}

function writeVerification(userId: string, fingerprint: string) {
  const record = { fingerprint, verifiedAt: new Date().toISOString() };
  window.localStorage.setItem(verificationStorageKey(userId), JSON.stringify(record));
  return record;
}

const SYSTEM_EVENT_LABELS: Record<string, string> = {
  device_added: 'A new device was added',
  device_revoked: 'A device was revoked',
};

function systemMessageBody(message: Message) {
  const change = message.systemPayload?.change;
  if (change) return SYSTEM_EVENT_LABELS[change] ?? 'System event';
  return message.content ?? 'System event';
}

function messageBody(message: Message) {
  if (message.unavailable) return 'Encrypted message unavailable on this device';
  // System messages carry structured metadata in `systemPayload`; `ciphertext`
  // is always null for them and must never be rendered as body text.
  if (message.contentType === 'system') return systemMessageBody(message);
  if (message.contentType === 'file' && message.filePayload) {
    return `📎 ${message.filePayload.fileName}`;
  }
  if (message.contentType === 'image' && message.filePayload) {
    return `🖼️ ${message.filePayload.fileName}`;
  }
  if (message.contentType === 'video' && message.filePayload) {
    return `🎬 ${message.filePayload.fileName}`;
  }
  return message.content ?? message.ciphertext ?? 'Encrypted message';
}

type TransferPayload = {
  amount: number;
  token?: string;
  txHash: string;
};

function parseTransferPayload(message: Message): TransferPayload | null {
  if (message.unavailable) return null;
  const raw = message.content ?? message.ciphertext;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<TransferPayload> & { type?: string };
    if (parsed?.type !== 'transfer' || typeof parsed.txHash !== 'string') return null;
    const amount = typeof parsed.amount === 'number' ? parsed.amount : Number(parsed.amount);
    if (!Number.isFinite(amount)) return null;
    return {
      amount,
      token: typeof parsed.token === 'string' ? parsed.token : undefined,
      txHash: parsed.txHash,
    };
  } catch {
    return null;
  }
}

function isRelevantKeyChangeEvent(payload: unknown, userIds: Set<string>, conversationId: string) {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  const payloadConversationId =
    typeof record.conversationId === 'string' ? record.conversationId : undefined;
  const affectedUserId =
    typeof record.userId === 'string'
      ? record.userId
      : typeof record.contactId === 'string'
        ? record.contactId
        : typeof record.subjectUserId === 'string'
          ? record.subjectUserId
          : undefined;

  if (payloadConversationId && payloadConversationId !== conversationId) return false;
  return Boolean(affectedUserId && userIds.has(affectedUserId));
}

export default function ConversationPage() {
  const { id } = useParams<{ id: string }>();
  const { token, loading: authLoading } = useAuth();
  const socket = useSocket(token);

  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [safetyByUser, setSafetyByUser] = useState<Record<string, SafetyState>>({});
  const [isSafetyOpen, setIsSafetyOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sendText, setSendText] = useState('');
  const [sending, setSending] = useState(false);

  const { messages: inboundMessages } = useInboundPipeline({
    socket,
    token,
    conversationId: id,
  });

  const allMessages = useMemo(() => {
    const inboundById = new Map<string, InboundMessage>();
    for (const m of inboundMessages) {
      if (!inboundById.has(m.messageId)) inboundById.set(m.messageId, m);
    }

    const merged: Message[] = [];
    for (const msg of messages) {
      const inbound = inboundById.get(msg.id);
      if (inbound && inbound.status === 'decrypted' && inbound.plaintext) {
        let filePayload: Message['filePayload'];
        if (msg.contentType === 'file' || msg.contentType === 'image' || msg.contentType === 'video') {
          try {
            filePayload = parseFileMessagePayload(inbound.plaintext);
          } catch {
            // Not a valid file payload, treat as text
          }
        }
        merged.push({
          ...msg,
          content: inbound.plaintext,
          filePayload,
          unavailable: false,
        });
      } else if (inbound && inbound.status === 'unavailable') {
        merged.push({ ...msg, unavailable: true });
      } else {
        merged.push(msg);
      }
    }

    for (const inbound of inboundMessages) {
      const exists = merged.some((m) => m.id === inbound.messageId);
      if (!exists) {
        if (inbound.status === 'decrypted' && inbound.plaintext) {
          let filePayload: Message['filePayload'];
          if (inbound.contentType === 'file' || inbound.contentType === 'image' || inbound.contentType === 'video') {
            try {
              filePayload = parseFileMessagePayload(inbound.plaintext);
            } catch {
              // Not a valid file payload
            }
          }
          merged.push({
            id: inbound.messageId,
            conversationId: inbound.conversationId,
            senderId: inbound.senderId,
            content: inbound.plaintext,
            contentType: inbound.contentType,
            createdAt: inbound.createdAt,
            filePayload,
          });
        } else if (inbound.status === 'unavailable') {
          merged.push({
            id: inbound.messageId,
            conversationId: inbound.conversationId,
            senderId: inbound.senderId,
            contentType: inbound.contentType,
            createdAt: inbound.createdAt,
            unavailable: true,
          });
        }
      }
    }

    return merged.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }, [messages, inboundMessages]);

  const contacts = useMemo(() => {
    const members = conversation?.members ?? [];
    return members.filter((member) => {
      const userId = member.user?.id;
      return userId && userId !== currentUser?.id;
    });
  }, [conversation?.members, currentUser?.id]);

  const contactIds = useMemo(
    () => new Set(contacts.map((member) => member.user?.id).filter(Boolean) as string[]),
    [contacts],
  );

  const title = useMemo(() => {
    if (!conversation) return 'Conversation';
    if (conversation.type === 'group') return conversation.name ?? 'Group conversation';
    return contacts[0] ? displayName(contacts[0]) : 'Direct message';
  }, [contacts, conversation]);

  const hasChangedSafetyNumber = useMemo(
    () => Object.values(safetyByUser).some((state) => state.changed),
    [safetyByUser],
  );

  const loadSafetyNumber = useCallback(
    async (userId: string) => {
      if (!token) return;

      setSafetyByUser((prev) => ({
        ...prev,
        [userId]: { ...(prev[userId] ?? EMPTY_SAFETY_STATE), loading: true, error: null },
      }));

      try {
        const response = await fetch(`${API_BASE_URL}/users/${userId}/key-fingerprint`, {
          headers: authHeaders(token),
        });

        if (!response.ok) {
          throw new Error('Safety number unavailable');
        }

        const fingerprint = (await response.json()) as SafetyFingerprint;
        const verification = readVerification(userId);
        const changed = Boolean(
          verification && verification.fingerprint !== fingerprint.fingerprint,
        );

        setSafetyByUser((prev) => ({
          ...prev,
          [userId]: {
            fingerprint: fingerprint.fingerprint,
            formatted: fingerprint.formatted,
            verifiedAt: changed ? null : (verification?.verifiedAt ?? null),
            changed,
            loading: false,
            error: null,
          },
        }));

        if (changed) setIsSafetyOpen(true);
      } catch (err) {
        setSafetyByUser((prev) => ({
          ...prev,
          [userId]: {
            ...(prev[userId] ?? EMPTY_SAFETY_STATE),
            loading: false,
            error: err instanceof Error ? err.message : 'Safety number unavailable',
          },
        }));
      }
    },
    [token],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadConversation() {
      if (authLoading) return;
      if (!token) {
        setIsLoading(false);
        setError('Sign in to view this conversation.');
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const [meResponse, conversationResponse, messagesResponse] = await Promise.all([
          fetch(`${API_BASE_URL}/users/me`, { headers: authHeaders(token) }),
          fetch(`${API_BASE_URL}/conversations/${id}`, { headers: authHeaders(token) }),
          fetch(`${API_BASE_URL}/conversations/${id}/messages`, { headers: authHeaders(token) }),
        ]);

        if (!meResponse.ok) throw new Error('Unable to load current user');
        if (!conversationResponse.ok) throw new Error('Unable to load conversation');
        if (!messagesResponse.ok) throw new Error('Unable to load messages');

        const [me, nextConversation, messagePage] = (await Promise.all([
          meResponse.json(),
          conversationResponse.json(),
          messagesResponse.json(),
        ])) as [CurrentUser, Conversation, { messages: Message[] }];

        if (cancelled) return;
        setCurrentUser(me);
        setConversation(nextConversation);
        setMessages(messagePage.messages ?? []);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to load conversation');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void loadConversation();

    return () => {
      cancelled = true;
    };
  }, [authLoading, id, token]);

  useEffect(() => {
    contacts.forEach((member) => {
      const userId = member.user?.id;
      if (userId) void loadSafetyNumber(userId);
    });
  }, [contacts, loadSafetyNumber]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [allMessages.length]);

  useEffect(() => {
    if (!socket) return;

    emitSocketEnvelope(socket, 'join_room', { conversationId: id });

    return () => {};
  }, [id, socket]);

  useEffect(() => {
    if (!socket || contactIds.size === 0) return;

    function handleKeyChange(payload: unknown) {
      if (!isRelevantKeyChangeEvent(payload, contactIds, id)) return;
      const record = payload as Record<string, unknown>;
      const userId =
        typeof record.userId === 'string'
          ? record.userId
          : typeof record.contactId === 'string'
            ? record.contactId
            : (record.subjectUserId as string);

      clearSessionKeys();
      void sessionStore.clear();

      setSafetyByUser((prev) => ({
        ...prev,
        [userId]: {
          ...(prev[userId] ?? EMPTY_SAFETY_STATE),
          changed: true,
          verifiedAt: null,
          loading: false,
        },
      }));
      setIsSafetyOpen(true);
      void loadSafetyNumber(userId);
    }

    const eventNames = [
      'key_set_changed',
      'key_changed',
      'contact_key_changed',
      'safety_number_changed',
      'system_event',
    ];

    eventNames.forEach((eventName) => socket.on(eventName, handleKeyChange));
    return () => {
      eventNames.forEach((eventName) => socket.off(eventName, handleKeyChange));
    };
  }, [contactIds, id, loadSafetyNumber, socket]);

  async function handleSendEncrypted() {
    if (!sendText.trim() || !socket || !token) return;
    setSending(true);
    try {
      const messageId = crypto.randomUUID();
      await sendEncryptedMessage({
        conversationId: id,
        messageId,
        plaintext: sendText.trim(),
        contentType: 'text',
        authToken: token,
        apiBaseUrl: API_BASE_URL,
      });
      socket.emit('send_message', {
        conversationId: id,
        messageId,
        content: sendText.trim(),
      });
      setSendText('');
    } catch (err) {
      console.error('Failed to send encrypted message:', err);
    } finally {
      setSending(false);
    }
  }

  async function handleSendFile() {
    const file = fileInputRef.current?.files?.[0];
    if (!file || !token || !socket) return;
    setSending(true);
    try {
      const messageId = crypto.randomUUID();
      const devices = await fetchConversationDevices(id, token, API_BASE_URL);
      const thumbnail = await generateEncryptedThumbnail({ file, authToken: token, apiBaseUrl: API_BASE_URL });
      const result = await sendEncryptedFile({
        file,
        conversationId: id,
        messageId,
        devices,
        thumbnail: thumbnail ?? undefined,
        authToken: token,
        apiBaseUrl: API_BASE_URL,
      });
      socket.emit('send_file_message', {
        conversationId: id,
        messageId,
        fileId: result.fileId,
        contentType: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file',
        envelopes: result.envelopes,
      });
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      console.error('Failed to send encrypted file:', err);
    } finally {
      setSending(false);
    }
  }

  function handleFileDownload(message: Message) {
    if (!message.filePayload || !token) return;
    const { fileId, fileKey, iv, mimeType, fileName } = message.filePayload;
    downloadAndDecryptFile(fileId, fileKey, iv, mimeType, token, API_BASE_URL)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((err) => console.error('File download failed:', err));
  }

  function verifyContact(userId: string) {
    const state = safetyByUser[userId];
    if (!state?.fingerprint) return;

    const verification = writeVerification(userId, state.fingerprint);
    setSafetyByUser((prev) => ({
      ...prev,
      [userId]: {
        ...state,
        verifiedAt: verification.verifiedAt,
        changed: false,
      },
    }));
  }

  if (isLoading || authLoading) {
    return (
      <div className="flex h-[calc(100vh-8rem)] items-center justify-center rounded-lg border border-border bg-card/40">
        <RefreshCw className="h-5 w-5 animate-spin text-foreground/50" aria-hidden="true" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-[calc(100vh-8rem)]">
        <EmptyState icon="!" title="Conversation unavailable" description={error} />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-[560px] overflow-hidden rounded-lg border border-border bg-card/40 shadow-2xl backdrop-blur-md">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-card/60 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar src={contacts[0]?.user?.avatarUrl ?? undefined} fallback={title} size="md" />
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-foreground">{title}</h1>
              <p className="truncate text-xs text-foreground/45">
                {conversation?.type === 'group'
                  ? `${contacts.length + 1} members`
                  : (primaryWallet(contacts[0] ?? {}) ?? 'Direct message')}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsSafetyOpen((open) => !open)}
            className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold transition-colors ${
              hasChangedSafetyNumber
                ? 'border-amber-400/50 bg-amber-400/15 text-amber-200 hover:bg-amber-400/20'
                : 'border-border bg-background/40 text-foreground/75 hover:bg-background/70'
            }`}
          >
            {hasChangedSafetyNumber ? (
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Fingerprint className="h-4 w-4" aria-hidden="true" />
            )}
            {hasChangedSafetyNumber ? 'Safety number changed' : 'Safety numbers'}
          </button>
        </header>

        {hasChangedSafetyNumber ? (
          <button
            type="button"
            onClick={() => setIsSafetyOpen(true)}
            className="flex items-center gap-3 border-b border-amber-400/30 bg-amber-400/15 px-5 py-3 text-left text-sm text-amber-100"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="font-semibold">Safety number changed, tap to re-verify.</span>
          </button>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {allMessages.length === 0 ? (
            <EmptyState
              icon="."
              title="No messages yet"
              description="Messages for this conversation will appear here."
            />
          ) : (
            <div className="space-y-4">
              {allMessages.map((message) => {
                const isSelf = message.senderId === currentUser?.id;
                const senderName = message.sender?.username ?? 'Unknown';
                const transfer = parseTransferPayload(message);

                return (
                  <div
                    key={message.id}
                    className={`flex items-end gap-3 ${isSelf ? 'flex-row-reverse' : ''}`}
                  >
                    <Avatar
                      src={message.sender?.avatarUrl ?? undefined}
                      fallback={isSelf ? 'You' : senderName}
                      size="sm"
                    />
                    <div className={`max-w-[75%] ${isSelf ? 'text-right' : ''}`}>
                      {!isSelf ? (
                        <p className="mb-1 px-1 text-xs text-foreground/45">{senderName}</p>
                      ) : null}
                      {transfer ? (
                        <TransferCard
                          amount={transfer.amount}
                          token={transfer.token}
                          txHash={transfer.txHash}
                        />
                      {message.unavailable ? (
                        <UnavailableMessagePlaceholder reason="undecryptable" />
                      ) : message.filePayload &&
                        (message.contentType === 'image' || message.contentType === 'video') ? (
                        <div className="space-y-1">
                          <EncryptedThumbnail
                            thumbnail={message.filePayload.thumbnail}
                            authToken={token ?? ''}
                            apiBaseUrl={API_BASE_URL}
                            alt={message.filePayload.fileName}
                          />
                          <button
                            type="button"
                            onClick={() => handleFileDownload(message)}
                            className="text-xs text-accent underline"
                          >
                            Download {message.filePayload.fileName}
                          </button>
                        </div>
                      ) : message.filePayload && message.contentType === 'file' ? (
                        <button
                          type="button"
                          onClick={() => handleFileDownload(message)}
                          className="flex items-center gap-2 rounded-2xl border border-border bg-background/60 px-4 py-3 text-sm text-foreground/90 hover:bg-background/80"
                        >
                          <FileUp className="h-4 w-4" />
                          {message.filePayload.fileName}
                        </button>
                      ) : (
                        <div
                          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                            isSelf
                              ? 'rounded-br-sm bg-accent text-white'
                              : 'rounded-bl-sm border border-border bg-background/60 text-foreground/90'
                          }`}
                        >
                          {messageBody(message)}
                        </div>
                      )}
                      <p className="mt-1 px-1 text-[10px] text-foreground/35">
                        {formatTime(message.createdAt)}
                      </p>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-card/60 px-5 py-3">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleSendFile}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-full p-2 text-foreground/50 transition-colors hover:bg-background/70 hover:text-foreground"
            title="Attach file"
            disabled={sending}
          >
            <FileUp className="h-5 w-5" />
          </button>
          <input
            className="flex-1 rounded-full border border-border bg-background/40 px-4 py-2 text-sm text-foreground placeholder-foreground/40 focus:border-accent focus:outline-none"
            placeholder="Type a message..."
            value={sendText}
            onChange={(e) => setSendText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSendEncrypted();
              }
            }}
            disabled={sending}
          />
          <button
            type="button"
            onClick={() => void handleSendEncrypted()}
            disabled={!sendText.trim() || sending}
            className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </section>

      {isSafetyOpen ? (
        <aside className="fixed inset-4 z-50 overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-2xl lg:static lg:z-auto lg:w-96 lg:shrink-0 lg:rounded-none lg:border-y-0 lg:border-r-0 lg:bg-background/50 lg:shadow-none">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-accent" aria-hidden="true" />
              <h2 className="text-sm font-semibold">Safety numbers</h2>
            </div>
            <button
              type="button"
              onClick={() => setIsSafetyOpen(false)}
              className="rounded-full p-2 text-foreground/60 transition-colors hover:bg-card hover:text-foreground"
              aria-label="Close safety numbers"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="mt-4 space-y-4">
            {contacts.map((member) => {
              const userId = member.user!.id!;
              const state = safetyByUser[userId] ?? EMPTY_SAFETY_STATE;
              const isVerified = Boolean(state.verifiedAt && !state.changed);

              return (
                <div key={userId} className="rounded-lg border border-border bg-card/60 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold">{displayName(member)}</h3>
                      <p className="truncate text-xs text-foreground/40">{primaryWallet(member)}</p>
                    </div>
                    {isVerified ? (
                      <CheckCircle2
                        className="h-5 w-5 shrink-0 text-emerald-400"
                        aria-hidden="true"
                      />
                    ) : state.changed ? (
                      <AlertTriangle
                        className="h-5 w-5 shrink-0 text-amber-300"
                        aria-hidden="true"
                      />
                    ) : null}
                  </div>

                  {state.changed ? (
                    <p className="mt-3 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-100">
                      Safety number changed, tap to re-verify.
                    </p>
                  ) : null}

                  <div className="mt-3 rounded-md bg-background/70 p-3 font-mono text-xs leading-6 tracking-normal text-foreground/80">
                    {state.loading
                      ? 'Loading safety number...'
                      : state.error
                        ? state.error
                        : state.formatted}
                  </div>

                  <button
                    type="button"
                    disabled={!state.fingerprint || state.loading}
                    onClick={() => verifyContact(userId)}
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full bg-accent px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    {isVerified ? 'Verified' : 'Mark verified'}
                  </button>
                </div>
              );
            })}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
