import type { Server } from 'socket.io';
import type { Redis } from 'ioredis';
import type { AuthSocket } from '../middleware/socketAuth.js';
import {
  EventEnvelopeSchema,
  isKnownEventType,
  createEnvelope,
  type EventEnvelope,
} from '../lib/eventEnvelope.js';

type Handler = (payload: Record<string, unknown>) => Promise<void>;

const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 h

export class EventDispatcher {
  private handlers = new Map<string, Handler>();

  constructor(
    private io: Server,
    private socket: AuthSocket,
    private redis: Redis | null,
  ) {}

  // Register a handler for an event type.
  // Also attaches a backward-compatible socket.on listener so legacy clients
  // that emit raw events (without the standard envelope) continue to work.
  register(type: string, handler: Handler): void {
    this.handlers.set(type, handler);

    this.socket.on(type, async (rawPayload: unknown) => {
      const payload =
        rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
          ? (rawPayload as Record<string, unknown>)
          : {};
      try {
        await handler(payload);
      } catch (err) {
        console.error(`[dispatcher] handler error for "${type}":`, err);
      }
    });
  }

  // Attach the standard envelope listener. Call after all register() calls.
  listen(): void {
    this.socket.on('dispatch', async (raw: unknown) => {
      if (!this.socket.auth) {
        this.socket.emit(
          'error',
          createEnvelope('error', { message: 'Unauthenticated', event: 'dispatch' }),
        );
        return;
      }

      const result = EventEnvelopeSchema.safeParse(raw);
      if (!result.success) {
        this.socket.emit(
          'error',
          createEnvelope('error', {
            message: 'Malformed envelope',
            details: result.error.flatten(),
          }),
        );
        return;
      }

      const envelope = result.data as EventEnvelope;

      if (!isKnownEventType(envelope.type)) {
        console.warn(`[dispatcher] unknown event type "${envelope.type}" — discarding`);
        this.socket.emit(
          'error',
          createEnvelope('error', {
            message: `Unknown event type: ${envelope.type}`,
            eventId: envelope.eventId,
          }),
        );
        return;
      }

      // Idempotency check: skip already-processed eventIds.
      if (this.redis) {
        const idempotencyKey = `event:idempotency:${envelope.eventId}`;
        const set = await this.redis
          .set(idempotencyKey, '1', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX')
          .catch(() => null);
        if (set === null) {
          // Already processed — acknowledge without re-running.
          this.socket.emit('dispatch_ack', { eventId: envelope.eventId, duplicate: true });
          return;
        }
      }

      const handler = this.handlers.get(envelope.type);
      if (!handler) {
        console.warn(`[dispatcher] no handler for known type "${envelope.type}"`);
        return;
      }

      try {
        await handler(envelope.payload ?? {});
        this.socket.emit('dispatch_ack', { eventId: envelope.eventId, duplicate: false });
      } catch (err) {
        console.error(`[dispatcher] handler error for "${envelope.type}":`, err);
      }
    });
  }

  // Emit an outgoing envelope to this socket.
  emit(type: string, payload: Record<string, unknown>): void {
    this.socket.emit('dispatch', createEnvelope(type, payload));
  }
}
