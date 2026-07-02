'use client';

import type { DecryptedMessage, SearchQuery, SearchResponse, WorkerIndexMessage, WorkerResponseMessage } from './types';
import { putMessages as dbPutMessages, deleteMessages as dbDeleteMessages } from './db';

let worker: Worker | null = null;
let ready = false;
const pending = new Map<number, { resolve: (r: SearchResponse)=>void; reject: (e: any)=>void }>();
let nextId = 1;
const readyWaiters: Array<() => void> = [];

function ensureWorker(): Worker {
  if (worker) return worker;
  // Next.js / Webpack: new URL with import.meta.url
  worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WorkerResponseMessage>) => {
    const msg = ev.data;
    if (msg.type === 'ready') {
      ready = true;
      readyWaiters.splice(0).forEach(fn => fn());
      return;
    }
    if (msg.type === 'search_result') {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.resolve(msg.response);
      }
      return;
    }
    if (msg.type === 'error') {
      console.error('[searchWorker]', msg.message);
    }
  };
  worker.onerror = (e) => {
    console.error('search worker error', e);
  };
  return worker;
}

function post(msg: WorkerIndexMessage) {
  ensureWorker().postMessage(msg);
}

export async function waitReady(): Promise<void> {
  ensureWorker();
  if (ready) return;
  await new Promise<void>(resolve => readyWaiters.push(resolve));
}

export async function indexMessages(messages: DecryptedMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await dbPutMessages(messages);
  await waitReady();
  post({ type: 'upsert', messages });
}

export async function removeMessages(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await dbDeleteMessages(ids);
  await waitReady();
  post({ type: 'remove', ids });
}

export async function search(query: SearchQuery): Promise<SearchResponse> {
  await waitReady();
  const id = nextId++;
  return new Promise<SearchResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ type: 'search', id, query });
    // safety timeout
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('search timeout'));
      }
    }, 5000);
  });
}

export async function clearIndex(conversationId?: string): Promise<void> {
  await waitReady();
  post({ type: 'clear', conversationId });
}

// One-time boot
if (typeof window !== 'undefined') {
  ensureWorker();
}
