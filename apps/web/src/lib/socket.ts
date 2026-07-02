import { io, Socket } from 'socket.io-client';
import {
  emitSocketEnvelope,
  getRealtimeDeviceId,
  getResumeCursor,
  replaySocketEvent,
  runSocketSync,
  setResumeCursor,
} from '@/lib/realtime';

let socket: Socket | null = null;
let activeToken: string | null = null;

export function initSocket(
  token: string,
  serverUrl = process.env.NEXT_PUBLIC_BACKEND_URL || process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001',
): Socket {
  if (socket && activeToken === token) return socket;
  if (socket) closeSocket();

  activeToken = token;
  socket = io(serverUrl, {
    auth: { token, deviceId: getRealtimeDeviceId(token) },
    reconnection: true,
    transports: ['websocket'],
  });

  socket.on('connect', () => {
    console.log('Socket connected');
    if (!socket) return;
    emitSocketEnvelope(socket, 'resume', { lastEventId: getResumeCursor(token) });
    void runSocketSync(socket, token);
  });

  socket.on('resume_complete', (payload: { lastEventId?: string | null; syncRequired?: boolean }) => {
    setResumeCursor(token, payload.lastEventId ?? null);
    if (payload.syncRequired && socket) void runSocketSync(socket, token);
  });

  socket.on('ephemeral_replay', (payload: { id?: string; type?: string; data?: Record<string, unknown> }) => {
    if (!socket) return;
    if (payload.id) setResumeCursor(token, payload.id);
    if (payload.type) replaySocketEvent(socket, payload.type, payload.data ?? {});
  });

  socket.on('message_envelope', (payload: { conversationId?: string; messageId?: string; envelopeId?: string; sequenceNumber?: number }) => {
    if (!socket || !payload.conversationId || !payload.messageId) return;
    emitSocketEnvelope(socket, 'message_delivered', {
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      envelopeId: payload.envelopeId,
      sequenceNumber: payload.sequenceNumber,
    });
  });

  socket.on('disconnect', () => console.log('Socket disconnected'));
  socket.on('error', (error) => console.error('Socket error:', error));

  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function closeSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
    activeToken = null;
  }
}
