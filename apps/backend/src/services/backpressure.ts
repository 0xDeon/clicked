import type { AuthSocket } from '../middleware/socketAuth.js';

function getBufferThreshold(): number {
  const val = process.env['SOCKET_BUFFER_THRESHOLD'];
  if (val) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 65536;
}

function getShedThreshold(): number {
  const val = process.env['SOCKET_SHED_THRESHOLD'];
  if (val) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 32768;
}

const shedSockets = new Set<string>();
const socketsToMonitor = new Set<AuthSocket>();
let monitorInterval: ReturnType<typeof setInterval> | null = null;

export function registerForBackpressure(socket: AuthSocket): void {
  socketsToMonitor.add(socket);
  if (!monitorInterval) {
    monitorInterval = setInterval(checkBuffers, 5000);
  }
}

export function unregisterForBackpressure(socket: AuthSocket): void {
  socketsToMonitor.delete(socket);
  shedSockets.delete(socket.id);
  if (socketsToMonitor.size === 0 && monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

export function isSocketShed(socketId: string): boolean {
  return shedSockets.has(socketId);
}

function checkBuffers(): void {
  const disconnectThreshold = getBufferThreshold();
  const shedThreshold = getShedThreshold();

  for (const socket of socketsToMonitor) {
    const buffered = getBufferedAmount(socket);

    if (buffered > disconnectThreshold) {
      console.warn(
        `Socket ${socket.id} buffer ${buffered} exceeds disconnect threshold ${disconnectThreshold}, disconnecting`,
      );
      shedSockets.add(socket.id);
      socket.disconnect(true);
    } else if (buffered > shedThreshold) {
      if (!shedSockets.has(socket.id)) {
        console.warn(
          `Socket ${socket.id} buffer ${buffered} exceeds shed threshold ${shedThreshold}, shedding`,
        );
        shedSockets.add(socket.id);
      }
    } else {
      if (shedSockets.has(socket.id)) {
        shedSockets.delete(socket.id);
      }
    }
  }
}

function getBufferedAmount(socket: AuthSocket): number {
  try {
    const conn = socket.conn as unknown as {
      transport?: { socket?: { bufferedAmount?: number } };
    };
    const ws = conn.transport?.socket;
    if (ws && typeof ws.bufferedAmount === 'number') {
      return ws.bufferedAmount;
    }
  } catch {
    // Ignore errors accessing internal transport
  }
  return 0;
}
