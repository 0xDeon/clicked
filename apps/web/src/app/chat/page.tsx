'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { useAuth } from '../../lib/auth';
import { initSocket, closeSocket } from '../../lib/socket';
import MessageInput from '../../components/chat/MessageInput';
import TransferCard from '../../components/chat/TransferCard';

type TextMsg = { id: string; type: 'text'; content: string; sender: { username: string } };
type TransferMsg = {
  id: string;
  type: 'transfer';
  amount: number;
  token?: string;
  txHash: string;
  sender: { username: string };
};
type Msg = TextMsg | TransferMsg;

type MessageSender = { username?: string };
type SocketMessage = {
  id?: string;
  content?: string;
  sender?: MessageSender;
  [key: string]: unknown;
};

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  return typeof err === 'string' ? err : 'An unexpected error occurred';
}

export default function ChatPage() {
  const { token, isLoading: authLoading } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [conversationId] = useState<string>('test-convo-1');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const parseMessage = useCallback((msg: SocketMessage | null | undefined): Msg | null => {
    if (!msg) return null;

    const content = typeof msg.content === 'string' ? msg.content : '';
    const senderName = typeof msg.sender?.username === 'string' ? msg.sender.username : 'unknown';
    const sender = { username: senderName };

    try {
      const parsed = JSON.parse(content) as Partial<TransferMsg> & {
        type?: string;
        txHash?: string;
        amount?: number | string;
        token?: string;
      };

      if (parsed?.type === 'transfer' && typeof parsed.txHash === 'string') {
        const amountValue =
          typeof parsed.amount === 'number' ? parsed.amount : Number(parsed.amount);

        return {
          id: typeof msg.id === 'string' ? msg.id : `${sender.username}-${Date.now()}`,
          type: 'transfer',
          amount: Number.isFinite(amountValue) ? amountValue : 0,
          token: typeof parsed.token === 'string' ? parsed.token : undefined,
          txHash: parsed.txHash,
          sender,
        };
      }
    } catch {
      // Not JSON, treat as plain text
    }

    return {
      id: typeof msg.id === 'string' ? msg.id : `${sender.username}-${Date.now()}`,
      type: 'text',
      content,
      sender,
    };
  }, []);

  useEffect(() => {
    if (!token || authLoading) return;

    try {
      const s = initSocket(token);
      const frame = window.requestAnimationFrame(() => {
        setSocket(s);
      });

      s.on('new_message', (msg: SocketMessage) => {
        const parsedMsg = parseMessage(msg);
        if (parsedMsg) {
          setMessages((prev) => [...prev, parsedMsg]);
        }
      });

      s.on('room_joined', ({ conversationId: cid }: { conversationId: string }) => {
        console.log('Joined room:', cid);
        s.emit('message_history', { conversationId: cid });
      });

      s.on('message_history', (data: { messages?: SocketMessage[] }) => {
        const history = data.messages || [];
        const parsed = history.map((msg) => parseMessage(msg)).filter((m): m is Msg => m !== null);
        setMessages(parsed.reverse());
        setLoading(false);
      });

      s.on('error', (err: unknown) => {
        console.error('Socket error:', err);
        setError(formatError(err));
      });

      s.emit('join_room', { conversationId });

      return () => {
        window.cancelAnimationFrame(frame);
        closeSocket();
      };
    } catch (err: unknown) {
      const frame = window.requestAnimationFrame(() => {
        setError(formatError(err));
        setLoading(false);
      });

      return () => window.cancelAnimationFrame(frame);
    }
  }, [token, authLoading, conversationId, parseMessage]);

  const recipient = 'GDESTRECIPIENTEXAMPLEXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

  if (authLoading) {
    return (
      <div className="max-w-2xl mx-auto h-screen flex items-center justify-center">
        <div className="text-gray-600">Loading...</div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="max-w-2xl mx-auto h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-gray-600 mb-4">No authentication token found</div>
          <p className="text-sm text-gray-500">
            Please log in first, or set NEXT_PUBLIC_AUTH_TOKEN in .env.local
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto h-screen flex items-center justify-center">
        <div className="text-gray-600">Connecting to chat...</div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto h-screen flex flex-col bg-white">
      <header className="p-4 border-b flex justify-between items-center">
        <h1 className="font-bold">Chat</h1>
        <span className="text-sm text-gray-500">
          {socket?.connected ? 'Connected ✓' : 'Disconnected'}
        </span>
      </header>

      {error && <div className="p-3 bg-red-100 text-red-700 text-sm">{error}</div>}

      <main className="flex-1 overflow-auto p-4 space-y-3">
        {messages.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            No messages yet. Start a conversation!
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="flex gap-2">
              <div className="text-xs text-gray-500 w-24">{m.sender.username}</div>
              <div className="flex-1">
                {m.type === 'text' ? (
                  <div className="p-2 bg-gray-100 rounded inline-block">{m.content}</div>
                ) : (
                  <TransferCard amount={m.amount} token={m.token} txHash={m.txHash} />
                )}
              </div>
            </div>
          ))
        )}
      </main>

      <MessageInput conversationId={conversationId} recipient={recipient} socket={socket} />
    </div>
  );
}
