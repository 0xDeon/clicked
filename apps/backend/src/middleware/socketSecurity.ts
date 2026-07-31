/**
 * Socket.IO handshake hardening (#374).
 *
 * Runs before `socketAuthMiddleware`, so a connection that fails the transport
 * or origin policy is dropped before any token is parsed or any database
 * lookup happens.
 *
 * Three checks:
 *   1. Transport — `ws://` is refused whenever TLS is enforced.
 *   2. Origin — browser handshakes must come from an allowlisted origin.
 *   3. Cookies — a handshake must never carry credentials over plaintext, and
 *      any cookie this service issues must be marked `Secure`.
 */
import type { Socket } from 'socket.io';
import { isOriginAllowed, isTlsEnforced } from '../lib/transportSecurity.js';

/** Socket.IO surfaces the raw upgrade request, so the same signals as HTTP apply. */
export function isHandshakeSecure(socket: Socket): boolean {
  if (socket.handshake.secure) return true;

  const headers = socket.handshake.headers;
  const forwardedProto = headerValue(headers['x-forwarded-proto']);
  if (forwardedProto) {
    // A proxy chain appends, so the client-facing scheme is the first entry.
    const clientFacing = forwardedProto.split(',')[0]?.trim().toLowerCase();
    if (clientFacing === 'https' || clientFacing === 'wss') return true;
  }

  return headerValue(headers['x-forwarded-ssl'])?.toLowerCase() === 'on';
}

function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

export function socketTransportSecurityMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
): void {
  const secure = isHandshakeSecure(socket);

  if (isTlsEnforced() && !secure) {
    next(new Error('Insecure transport: connect over wss://'));
    return;
  }

  if (!isOriginAllowed(headerValue(socket.handshake.headers.origin))) {
    next(new Error('Origin is not permitted to open a socket'));
    return;
  }

  // Credentials must never ride a plaintext handshake. The gateway
  // authenticates with a bearer token in `handshake.auth`, so a cookie here is
  // either a reverse-proxy session or a future cookie-based client — either
  // way it may not travel in the clear.
  if (!secure && headerValue(socket.handshake.headers.cookie)) {
    next(new Error('Cookies may not be sent over an insecure handshake'));
    return;
  }

  next();
}
