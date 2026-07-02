'use client';

import type { Socket } from 'socket.io-client';
import { API_BASE_URL } from '@/lib/api';

export type SocketEventPayload = Record<string, unknown>;

export interface EventEnvelope<T extends SocketEventPayload = SocketEventPayload> {
  eventId: string;
  type: string;
  timestamp: number;
  payload: T;
}

export interface JwtRealtimeClaims {
  userId?: string;
  walletAddress?: string;
  deviceId?: string;
}

export interface SyncedEnvelope {
  id: string;
  messageId: string;
  conversationId: string;
  senderId?: string;
  senderDeviceId?: string | null;
  contentType?: string;
  ciphertext: string;
  sequenceNumber: number;
  deliveredAt?: string | null;
  createdAt: string;
}

const RESUME_CURSOR_PREFIX = 'clicked.socket.resumeCursor';
const SYNC_CURSOR_PREFIX = 'clicked.socket.syncSequence';
const E2EE_DEVICE_ID_KEY = 'clicked.e2eeDeviceId';

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return window.atob(padded);
}

export function parseJwtClaims(token: string | null): JwtRealtimeClaims {
  if (!token || typeof window === 'undefined') return {};
  try {
    const [, payload] = token.split('.');
    if (!payload) return {};
    return JSON.parse(base64UrlDecode(payload)) as JwtRealtimeClaims;
  } catch {
    return {};
  }
}

export function getRealtimeDeviceId(token: string | null): string | null {
  if (typeof window === 'undefined') return parseJwtClaims(token).deviceId ?? null;
  return window.localStorage.getItem(E2EE_DEVICE_ID_KEY) ?? parseJwtClaims(token).deviceId ?? null;
}

export function rememberRealtimeDeviceId(deviceId: string): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(E2EE_DEVICE_ID_KEY, deviceId);
}

export function createSocketEnvelope<T extends SocketEventPayload>(
  type: string,
  payload: T,
): EventEnvelope<T> {
  return {
    eventId: crypto.randomUUID(),
    type,
    timestamp: Date.now(),
    payload,
  };
}

export function emitSocketEnvelope<T extends SocketEventPayload>(
  socket: Socket | null,
  type: string,
  payload: T,
): string | null {
  if (!socket) return null;
  const envelope = createSocketEnvelope(type, payload);
  socket.emit('dispatch', envelope);
  return envelope.eventId;
}

function cursorKey(prefix: string, token: string | null): string | null {
  const claims = parseJwtClaims(token);
  const deviceId = getRealtimeDeviceId(token);
  if (!claims.userId || !deviceId) return null;
  return `${prefix}:${claims.userId}:${deviceId}`;
}

export function getResumeCursor(token: string | null): string {
  const key = cursorKey(RESUME_CURSOR_PREFIX, token);
  if (!key || typeof window === 'undefined') return '';
  return window.localStorage.getItem(key) ?? '';
}

export function setResumeCursor(token: string | null, cursor: string | null): void {
  const key = cursorKey(RESUME_CURSOR_PREFIX, token);
  if (!key || typeof window === 'undefined') return;
  if (cursor) window.localStorage.setItem(key, cursor);
}

export function getSyncCursor(token: string | null): number {
  const key = cursorKey(SYNC_CURSOR_PREFIX, token);
  if (!key || typeof window === 'undefined') return 0;
  const parsed = Number(window.localStorage.getItem(key) ?? '0');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function setSyncCursor(token: string | null, cursor: number): void {
  const key = cursorKey(SYNC_CURSOR_PREFIX, token);
  if (!key || typeof window === 'undefined') return;
  window.localStorage.setItem(key, String(Math.max(0, cursor)));
}

export function replaySocketEvent(socket: Socket, event: string, payload: unknown): void {
  const emitEvent = (socket as unknown as { emitEvent?: (args: unknown[]) => void }).emitEvent;
  if (typeof emitEvent === 'function') {
    emitEvent.call(socket, [event, payload]);
    return;
  }

  const callbacks = (socket as unknown as { _callbacks?: Record<string, Array<(p: unknown) => void>> })
    ._callbacks?.[`$${event}`];
  callbacks?.slice().forEach((callback) => callback(payload));
}

export async function runSocketSync(socket: Socket, token: string): Promise<void> {
  const deviceId = getRealtimeDeviceId(token);
  if (!deviceId) return;

  let cursor = getSyncCursor(token);
  let hasMore = true;

  while (hasMore) {
    const url = new URL(`${API_BASE_URL}/sync`);
    url.searchParams.set('deviceId', deviceId);
    url.searchParams.set('sinceSequence', String(cursor));

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) return;

    const data = (await response.json()) as {
      envelopes?: SyncedEnvelope[];
      nextCursor?: number;
      hasMore?: boolean;
    };

    for (const envelope of data.envelopes ?? []) {
      const payload = {
        envelopeId: envelope.id,
        messageId: envelope.messageId,
        id: envelope.messageId,
        conversationId: envelope.conversationId,
        senderId: envelope.senderId,
        senderDeviceId: envelope.senderDeviceId,
        contentType: envelope.contentType ?? 'text',
        ciphertext: envelope.ciphertext,
        sequenceNumber: envelope.sequenceNumber,
        createdAt: envelope.createdAt,
      };
      replaySocketEvent(socket, 'message_envelope', payload);
      replaySocketEvent(socket, 'new_message', { ...payload, ciphertext: null });
      emitSocketEnvelope(socket, 'message_delivered', {
        conversationId: envelope.conversationId,
        messageId: envelope.messageId,
        envelopeId: envelope.id,
        sequenceNumber: envelope.sequenceNumber,
      });
    }

    cursor = Math.max(cursor, data.nextCursor ?? cursor);
    setSyncCursor(token, cursor);
    hasMore = Boolean(data.hasMore && (data.envelopes?.length ?? 0) > 0);
  }
}
