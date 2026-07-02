'use client';

import { MessageSearch } from '@/components/search/MessageSearch';
import Link from 'next/link';
import { useState } from 'react';
import { getMessageCount } from '@/lib/search/db';

export default function SearchPage() {
  const [count, setCount] = useState<number | null>(null);

  useState(() => {
    getMessageCount().then(setCount).catch(() => {});
  });

  return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">Message search</h1>
        <p className="text-sm text-foreground/60">
          End-to-end encrypted local search. {count !== null ? `${count} messages indexed on this device.` : ''}
        </p>
      </div>

      <MessageSearch autoFocus />

      <div className="mt-10 rounded-2xl border border-border bg-card/30 p-5 text-sm leading-relaxed text-foreground/70 space-y-3">
        <h2 className="font-semibold text-foreground">Why local search?</h2>
        <p>
          With E2EE messaging, message bodies are encrypted on-device before they ever reach the server. 
          The server stores only ciphertext, so it <strong>cannot</strong> search message contents (#124).
        </p>
        <p>
          Instead, Clicked builds a search index <strong>locally</strong>, over messages your device has already decrypted (#185):
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Decrypted messages are cached in <code>IndexedDB</code></li>
          <li>An inverted index is built in a <code>Web Worker</code> – search never blocks the UI</li>
          <li>BM25 ranking with recency boost</li>
          <li>Works fully offline</li>
          <li>Plaintext never leaves your device</li>
        </ul>
        <p className="text-amber-200/80">
          <strong>Trade-off:</strong> search is scoped to messages this device has seen and decrypted.
          New devices, cleared storage, or messages older than your sync window won&apos;t appear until they&apos;re synced and decrypted locally.
          Use the conversation history scrollback to pull older messages into the index.
        </p>
        <p className="text-xs text-foreground/50">
          Files indexed: IndexedDB <code>clicked-search</code> / store <code>messages</code>. 
          Worker: <code>src/lib/search/searchWorker.ts</code>.
        </p>
        <Link href="/app/messages" className="inline-block text-accent-light hover:underline text-xs">← Back to messages</Link>
      </div>
    </div>
  );
}
