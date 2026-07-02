'use client';

import React, { useState, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import transferToken from '../../lib/soroban';

type Props = {
  conversationId: string;
  recipient: string;
  socket: Socket | null;
};

export default function MessageInput({ conversationId, recipient, socket }: Props) {
  const [text, setText] = useState('');
  const [showPay, setShowPay] = useState(false);
  const [amount, setAmount] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  function stopTyping() {
    if (socket && conversationId && isTypingRef.current) {
      isTypingRef.current = false;
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      socket.emit('typing_stop', { conversationId });
    }
  }

  function handleTextChange(e: React.ChangeEvent<HTMLInputElement>) {
    setText(e.target.value);
    if (socket && conversationId) {
      if (!isTypingRef.current) {
        isTypingRef.current = true;
        socket.emit('typing_start', { conversationId });
      }
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => {
        isTypingRef.current = false;
        socket.emit('typing_stop', { conversationId });
      }, 2000);
    }
  }

  function handleSendText() {
    if (!text.trim() || !socket) return;
    stopTyping();
    socket.emit('send_message', {
      conversationId,
      content: text.trim(),
    });
    setText('');
  }

  async function handleConfirmTransfer() {
    const n = Number(amount);
    if (!n || n <= 0) {
      alert('Amount must be > 0');
      return;
    }

    if (!socket) {
      alert('Not connected to chat');
      return;
    }

    setBusy(true);
    stopTyping();
    try {
      const txHash = await transferToken(recipient, Math.floor(n));
      const transferMsg = {
        type: 'transfer',
        amount: Math.floor(n),
        token: 'TOKEN',
        txHash,
      };
      socket.emit('send_message', {
        conversationId,
        content: JSON.stringify(transferMsg),
      });
      setAmount('');
      setShowPay(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      alert(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-3 border-t flex items-center gap-2 relative">
      <button
        title="Send payment"
        onClick={() => setShowPay((s) => !s)}
        className="p-2 rounded hover:bg-gray-100"
        disabled={busy}
      >
        🪙
      </button>

      <input
        className="flex-1 p-2 border rounded"
        placeholder="Type a message..."
        value={text}
        onChange={handleTextChange}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSendText();
        }}
        disabled={busy}
      />

      <button
        className="px-3 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
        onClick={handleSendText}
        disabled={busy}
      >
        Send
      </button>

      {showPay && (
        <div className="absolute bottom-20 left-0 w-80 bg-white border rounded shadow-lg p-4 z-50">
          <div className="text-sm font-semibold mb-2">Send token</div>
          <label className="block text-xs text-gray-600">Recipient</label>
          <input className="w-full p-2 border rounded mb-2 text-sm" value={recipient} readOnly />

          <label className="block text-xs text-gray-600 mt-2">Amount</label>
          <input
            className="w-full p-2 border rounded mb-3"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount (integer units)"
            type="number"
            min={1}
            disabled={busy}
          />

          <div className="flex justify-end gap-2">
            <button className="px-3 py-1 text-sm" onClick={() => setShowPay(false)} disabled={busy}>
              Cancel
            </button>
            <button
              className="px-3 py-1 bg-green-600 text-white rounded text-sm disabled:opacity-50"
              onClick={handleConfirmTransfer}
              disabled={busy}
            >
              {busy ? 'Processing...' : 'Confirm'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
