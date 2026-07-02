import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordEphemeralEvent,
  publishEphemeral,
  readMissedEvents,
  eventStreamKey,
  RESUME_STREAM_TTL_SECONDS,
  RESUME_STREAM_MAXLEN,
} from '../services/resumeStream.js';

function makeRedis() {
  return {
    xadd: vi.fn().mockResolvedValue('1-0'),
    expire: vi.fn().mockResolvedValue(1),
    xrange: vi.fn().mockResolvedValue([]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('eventStreamKey', () => {
  it('namespaces per user', () => {
    expect(eventStreamKey('u1')).toBe('resume:events:u1');
  });
});

describe('recordEphemeralEvent', () => {
  it('appends a capped entry, refreshes TTL, and returns the stream id', async () => {
    const redis = makeRedis();

    const id = await recordEphemeralEvent(redis as never, 'u1', {
      type: 'read_receipt',
      data: { conversationId: 'c1' },
    });

    expect(id).toBe('1-0');
    expect(redis.xadd).toHaveBeenCalledWith(
      'resume:events:u1',
      'MAXLEN',
      '~',
      RESUME_STREAM_MAXLEN,
      '*',
      'type',
      'read_receipt',
      'data',
      JSON.stringify({ conversationId: 'c1' }),
    );
    expect(redis.expire).toHaveBeenCalledWith('resume:events:u1', RESUME_STREAM_TTL_SECONDS);
  });
});

describe('publishEphemeral', () => {
  it('does nothing when Redis is unavailable', async () => {
    await expect(
      publishEphemeral(null, ['u1'], { type: 'presence_update', data: {} }),
    ).resolves.toBeUndefined();
  });

  it('records once per unique recipient', async () => {
    const redis = makeRedis();

    await publishEphemeral(redis as never, ['u1', 'u1', 'u2'], {
      type: 'presence_update',
      data: { online: true },
    });

    expect(redis.xadd).toHaveBeenCalledTimes(2);
  });

  it('is a no-op for an empty recipient list', async () => {
    const redis = makeRedis();
    await publishEphemeral(redis as never, [], { type: 'system', data: {} });
    expect(redis.xadd).not.toHaveBeenCalled();
  });
});

describe('readMissedEvents', () => {
  it('reads the whole stream when no cursor is supplied', async () => {
    const redis = makeRedis();
    redis.xrange.mockResolvedValue([
      ['1-0', ['type', 'read_receipt', 'data', '{"conversationId":"c1"}']],
      ['2-0', ['type', 'presence_update', 'data', '{"online":true}']],
    ]);

    const out = await readMissedEvents(redis as never, 'u1', '');

    expect(redis.xrange).toHaveBeenCalledWith('resume:events:u1', '-', '+');
    expect(out).toEqual([
      { id: '1-0', type: 'read_receipt', data: { conversationId: 'c1' } },
      { id: '2-0', type: 'presence_update', data: { online: true } },
    ]);
  });

  it('uses an exclusive lower bound so replay is idempotent', async () => {
    const redis = makeRedis();
    await readMissedEvents(redis as never, 'u1', '5-0');
    expect(redis.xrange).toHaveBeenCalledWith('resume:events:u1', '(5-0', '+');
  });

  it('tolerates malformed payloads without throwing', async () => {
    const redis = makeRedis();
    redis.xrange.mockResolvedValue([['9-0', ['type', 'system', 'data', 'not-json']]]);

    const out = await readMissedEvents(redis as never, 'u1', '');

    expect(out).toEqual([{ id: '9-0', type: 'system', data: {} }]);
  });
});
