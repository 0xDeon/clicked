'use client';

import { useEffect, useMemo } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  emitSocketEnvelope,
  getResumeCursor,
  getRealtimeDeviceId,
  replaySocketEvent,
  runSocketSync,
  setResumeCursor,
} from '@/lib/realtime';

const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL ??
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  'http://localhost:3001';

export function useSocket(token: string | null) {
  const socket = useMemo<Socket | null>(() => {
    if (!token) return null;

    const deviceId = getRealtimeDeviceId(token);

    return io(SOCKET_URL, {
      auth: { token, deviceId },
      transports: ['websocket'],
      reconnection: true,
    });
  }, [token]);

  useEffect(() => {
    if (!socket || !token) return undefined;

    let closed = false;
    const authToken = token;

    async function resumeThenSync() {
      if (!socket || !token || closed) return;
      emitSocketEnvelope(socket, 'resume', { lastEventId: getResumeCursor(authToken) });
      await runSocketSync(socket, authToken);
    }

    function onConnect() {
      void resumeThenSync();
    }

    function onResumeComplete(payload: { lastEventId?: string | null; syncRequired?: boolean }) {
      setResumeCursor(authToken, payload.lastEventId ?? null);
      if (payload.syncRequired && socket) void runSocketSync(socket, authToken);
    }

    function onEphemeralReplay(payload: { id?: string; type?: string; data?: Record<string, unknown> }) {
      if (payload.id) setResumeCursor(authToken, payload.id);
      if (payload.type && socket) replaySocketEvent(socket, payload.type, payload.data ?? {});
    }

    function onMessageEnvelope(payload: { conversationId?: string; messageId?: string; envelopeId?: string; sequenceNumber?: number }) {
      if (!payload.conversationId || !payload.messageId) return;
      emitSocketEnvelope(socket, 'message_delivered', {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        envelopeId: payload.envelopeId,
        sequenceNumber: payload.sequenceNumber,
      });
    }

    socket.on('connect', onConnect);
    socket.on('resume_complete', onResumeComplete);
    socket.on('ephemeral_replay', onEphemeralReplay);
    socket.on('message_envelope', onMessageEnvelope);

    if (socket.connected) void resumeThenSync();

    return () => {
      closed = true;
      socket.off('connect', onConnect);
      socket.off('resume_complete', onResumeComplete);
      socket.off('ephemeral_replay', onEphemeralReplay);
      socket.off('message_envelope', onMessageEnvelope);
      socket.disconnect();
    };
  }, [socket, token]);

  return socket;
}
