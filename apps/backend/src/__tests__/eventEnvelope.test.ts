import { describe, it, expect } from 'vitest';
import {
  EventEnvelopeSchema,
  isKnownEventType,
  createEnvelope,
  KNOWN_EVENT_TYPES,
} from '../lib/eventEnvelope.js';

describe('EventEnvelopeSchema', () => {
  it('accepts a valid envelope', () => {
    const result = EventEnvelopeSchema.safeParse({
      eventId: 'abc-123',
      type: 'send_message',
      timestamp: Date.now(),
      payload: { conversationId: 'conv-1' },
    });
    expect(result.success).toBe(true);
  });

  it('defaults payload to empty object when omitted', () => {
    const result = EventEnvelopeSchema.safeParse({
      eventId: 'abc-123',
      type: 'join_room',
      timestamp: 1000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload).toEqual({});
    }
  });

  it('rejects missing eventId', () => {
    const result = EventEnvelopeSchema.safeParse({
      type: 'send_message',
      timestamp: 1000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty eventId', () => {
    const result = EventEnvelopeSchema.safeParse({
      eventId: '',
      type: 'send_message',
      timestamp: 1000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing type', () => {
    const result = EventEnvelopeSchema.safeParse({
      eventId: 'abc',
      timestamp: 1000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive timestamp', () => {
    const result = EventEnvelopeSchema.safeParse({
      eventId: 'abc',
      type: 'send_message',
      timestamp: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer timestamp', () => {
    const result = EventEnvelopeSchema.safeParse({
      eventId: 'abc',
      type: 'send_message',
      timestamp: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-object payload', () => {
    const result = EventEnvelopeSchema.safeParse({
      eventId: 'abc',
      type: 'send_message',
      timestamp: 1000,
      payload: 'not-an-object',
    });
    expect(result.success).toBe(false);
  });
});

describe('isKnownEventType', () => {
  it('returns true for every registered type', () => {
    for (const type of KNOWN_EVENT_TYPES) {
      expect(isKnownEventType(type)).toBe(true);
    }
  });

  it('returns false for unknown types', () => {
    expect(isKnownEventType('unknown_type')).toBe(false);
    expect(isKnownEventType('')).toBe(false);
    expect(isKnownEventType('SEND_MESSAGE')).toBe(false);
  });
});

describe('createEnvelope', () => {
  it('creates a valid envelope with generated eventId', () => {
    const env = createEnvelope('send_message', { foo: 'bar' });
    expect(env.type).toBe('send_message');
    expect(env.payload).toEqual({ foo: 'bar' });
    expect(typeof env.eventId).toBe('string');
    expect(env.eventId.length).toBeGreaterThan(0);
    expect(env.timestamp).toBeGreaterThan(0);
  });

  it('uses provided eventId when given', () => {
    const env = createEnvelope('join_room', {}, 'custom-id');
    expect(env.eventId).toBe('custom-id');
  });

  it('sets timestamp close to now', () => {
    const before = Date.now();
    const env = createEnvelope('resume', {});
    const after = Date.now();
    expect(env.timestamp).toBeGreaterThanOrEqual(before);
    expect(env.timestamp).toBeLessThanOrEqual(after);
  });
});
