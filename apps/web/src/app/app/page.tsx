'use client';

import React, { useEffect, useState } from 'react';
import { MessageSearch } from '@/components/search/MessageSearch';
import { indexMessages } from '@/lib/search/searchClient';
import Link from 'next/link';

interface Message {
  id: string;
  sender: string;
  avatar: string;
  text: string;
  timestamp: string;
  isSelf: boolean;
  tokenTransfer?: {
    amount: string;
    token: string;
    txHash: string;
  };
}

const DEMO_CONVERSATION_ID = 'demo-jed-conversation';

export default function MessagesPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      sender: 'Jed McCaleb',
      avatar: 'J',
      text: 'Hey! Did you check out the new stellar-core upgrade? The transaction speeds are looking incredibly solid.',
      timestamp: '10:24 AM',
      isSelf: false,
    },
    {
      id: '2',
      sender: 'You',
      avatar: 'Y',
      text: 'Yes! The ledger close times are consistently under 4 seconds now. Just sent some test transactions.',
      timestamp: '10:26 AM',
      isSelf: true,
    },
    {
      id: '3',
      sender: 'Jed McCaleb',
      avatar: 'J',
      text: "Awesome. I've sent you the 50 XLM for the contract review. Let me know when you receive it.",
      timestamp: '10:27 AM',
      isSelf: false,
      tokenTransfer: {
        amount: '50 XLM',
        token: 'Stellar Lumens',
        txHash: '0x78ab...e912',
      },
    },
  ]);

  const [inputText, setInputText] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  // Seed the local E2EE search index with demo messages (#185)
  useEffect(() => {
    indexMessages(messages.map(m => ({
      id: m.id,
      conversationId: DEMO_CONVERSATION_ID,
      senderId: m.isSelf ? 'you' : 'jed',
      plaintext: m.text,
      contentType: 'text/plain',
      createdAt: new Date().toISOString(),
    }))).catch(() => {});
  }, [messages]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    const newMessage: Message = {
      id: Date.now().toString(),
      sender: 'You',
      avatar: 'Y',
      text: inputText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isSelf: true,
    };

    setMessages([...messages, newMessage]);
    setInputText('');
  };

  return (
    <div className="grid lg:grid-cols-[1fr_380px] gap-6 h-[calc(100vh-8rem)] min-h-[500px]">
      <div className="flex flex-col bg-card/30 border border-border rounded-3xl overflow-hidden shadow-2xl backdrop-blur-md">
        {/* Top Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card/50">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-accent to-accent-light flex items-center justify-center font-bold text-sm text-white">
                J
              </div>
              <span className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 border-2 border-[#13131f] rounded-full" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground text-sm md:text-base">Jed McCaleb</h2>
              <p className="text-xs text-foreground/40">Active now • GC3K...7Z8P</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSearch(!showSearch)}
              className="px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-xs font-medium transition-colors lg:hidden"
            >
              {showSearch ? 'Hide search' : 'Search'}
            </button>
            <Link href="/app/search" className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-foreground/70 text-xs font-medium transition-all">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
              Search
            </Link>
            {/* Quick Pay Action Button */}
            <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent/10 hover:bg-accent/20 text-accent-light text-xs font-semibold transition-all duration-300">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.5}
                  d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              Send XLM
            </button>
          </div>
        </div>

        {showSearch && (
          <div className="px-4 py-3 border-b border-border bg-card/20 lg:hidden">
            <MessageSearch conversationId={DEMO_CONVERSATION_ID} placeholder="Search this conversation…" />
          </div>
        )}

        {/* Messages Scroll Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-thin scrollbar-thumb-white/5">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex items-end gap-3.5 max-w-[85%] md:max-w-[70%] ${
                msg.isSelf ? 'ml-auto flex-row-reverse' : ''
              }`}
            >
              {/* Avatar */}
              <div className="flex-shrink-0">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs ${
                    msg.isSelf
                      ? 'bg-white/10 text-white'
                      : 'bg-gradient-to-tr from-accent to-accent-light text-white'
                  }`}
                >
                  {msg.avatar}
                </div>
              </div>

              {/* Message Bubble Container */}
              <div className="flex flex-col gap-1">
                <div
                  className={`px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-sm ${
                    msg.isSelf
                      ? 'bg-accent text-white rounded-br-none'
                      : 'bg-[#1e1e2f] text-foreground/90 rounded-bl-none border border-white/[0.03]'
                  }`}
                >
                  {msg.text}

                  {/* Optional token transfer attachment */}
                  {msg.tokenTransfer && (
                    <div className="mt-3 p-3 rounded-xl bg-black/20 border border-white/5 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2.5}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-emerald-400">
                            Received {msg.tokenTransfer.amount}
                          </p>
                          <p className="text-[10px] text-white/40">{msg.tokenTransfer.token}</p>
                        </div>
                      </div>
                      <span className="text-[10px] font-mono text-accent-light bg-accent/10 px-2 py-0.5 rounded">
                        {msg.tokenTransfer.txHash}
                      </span>
                    </div>
                  )}
                </div>
                <span
                  className={`text-[10px] text-foreground/30 px-1 ${msg.isSelf ? 'text-right' : ''}`}
                >
                  {msg.timestamp}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Input Form */}
        <form
          onSubmit={handleSendMessage}
          className="p-4 bg-card/40 border-t border-border flex items-center gap-3"
        >
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Type a secure message..."
            className="flex-1 bg-[#13131f]/60 hover:bg-[#13131f]/80 focus:bg-[#13131f] border border-border focus:border-accent rounded-2xl px-5 py-3.5 text-sm focus:outline-none transition-all duration-300 placeholder:text-foreground/30"
          />
          <button
            type="submit"
            className="p-3.5 rounded-2xl bg-accent hover:bg-accent-light text-white font-medium shadow-md shadow-accent/20 transition-all duration-300 hover:scale-105 active:scale-95"
          >
            <svg
              className="w-5 h-5 transform rotate-90"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
                d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
              />
            </svg>
          </button>
        </form>
      </div>

      {/* Search sidebar - desktop */}
      <div className="hidden lg:block bg-card/30 border border-border rounded-3xl p-5 overflow-y-auto">
        <h3 className="font-semibold text-sm mb-3">Search messages</h3>
        <MessageSearch conversationId={DEMO_CONVERSATION_ID} placeholder="Search in conversation…" />
        <div className="mt-4 text-[11px] text-foreground/40 leading-relaxed">
          Local E2EE search. Try: <code>stellar</code>, <code>xlm</code>, <code>transactions</code>.
        </div>
      </div>
    </div>
  );
}
