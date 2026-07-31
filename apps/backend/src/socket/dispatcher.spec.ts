import { describe, it, expect, beforeEach, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { Server as SocketIOServer } from 'socket.io';
import { EventDispatcher } from './dispatcher.js';
import type { AuthSocket } from '../middleware/socketAuth.js';
import { createEnvelope } from '../lib/eventEnvelope.js';

describe('EventDispatcher with Replay Protection', () => {
  let redis: Redis;
  let mockIo: Partial<SocketIOServer>;
  let mockSocket: Partial<AuthSocket>;
  let dispatcher: EventDispatcher;
  let handlerSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    redis = new RedisMock() as unknown as Redis;
    delete process.env['REPLAY_PROTECTION_TTL_SECONDS'];

    // Mock Socket.IO server
    mockIo = {
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    };

    // Mock socket with auth
    handlerSpy = vi.fn();
    mockSocket = {
      auth: {
        userId: 'test-user',
        deviceId: 'test-device',
      },
      emit: vi.fn(),
      on: vi.fn((event, handler) => {
        if (event === 'dispatch') {
          // Store the dispatch listener for manual invocation in tests
          (mockSocket as any).dispatchHandler = handler;
        }
      }),
      rooms: new Set(['test-room']),
    };

    dispatcher = new EventDispatcher(mockIo as SocketIOServer, mockSocket as AuthSocket, redis);

    // Register a test event handler
    dispatcher.register('test_event', handlerSpy);
    dispatcher.listen();
  });

  afterEach(async () => {
    if (redis) {
      await redis.flushdb();
      redis.disconnect();
    }
  });

  describe('replay protection integration', () => {
    it('should process legitimate distinct events normally', async () => {
      const eventId1 = 'event-1';
      const eventId2 = 'event-2';

      const envelope1 = createEnvelope('test_event', { message: 'first' }, eventId1);
      const envelope2 = createEnvelope('test_event', { message: 'second' }, eventId2);

      // Manually invoke dispatch handler
      await (mockSocket as any).dispatchHandler(envelope1);
      await (mockSocket as any).dispatchHandler(envelope2);

      // Both handlers should be called
      expect(handlerSpy).toHaveBeenCalledTimes(2);
    });

    it('should drop duplicate event (same eventId, same device) and not persist it twice', async () => {
      const eventId = 'event-123';

      const envelope = createEnvelope('test_event', { message: 'duplicate' }, eventId);

      // First invocation
      await (mockSocket as any).dispatchHandler(envelope);

      // Reset spy to check second call
      handlerSpy.mockClear();

      // Second invocation (replay)
      await (mockSocket as any).dispatchHandler(envelope);

      // Handler should NOT be called for the duplicate
      expect(handlerSpy).not.toHaveBeenCalled();

      // But socket should acknowledge with duplicate flag
      const emitCalls = (mockSocket.emit as any).mock.calls;
      const ackCall = emitCalls.find(([event]: any) => event === 'dispatch_ack');
      expect(ackCall).toBeTruthy();
      expect(ackCall[1]).toEqual({ eventId, duplicate: true });
    });

    it('should allow same eventId from different device', async () => {
      const eventId = 'event-123';
      const envelope = createEnvelope('test_event', { message: 'test' }, eventId);

      // First device
      await (mockSocket as any).dispatchHandler(envelope);
      expect(handlerSpy).toHaveBeenCalledTimes(1);

      handlerSpy.mockClear();

      // Simulate different device
      mockSocket.auth = {
        userId: 'test-user',
        deviceId: 'different-device',
      };

      // Recreate dispatcher with same Redis but different socket
      const mockSocket2: Partial<AuthSocket> = {
        auth: {
          userId: 'test-user',
          deviceId: 'different-device',
        },
        emit: vi.fn(),
        on: vi.fn((event, handler) => {
          if (event === 'dispatch') {
            (mockSocket2 as any).dispatchHandler = handler;
          }
        }),
        rooms: new Set(['test-room']),
      };

      const dispatcher2 = new EventDispatcher(mockIo as SocketIOServer, mockSocket2 as AuthSocket, redis);
      const handler2Spy = vi.fn();
      dispatcher2.register('test_event', handler2Spy);
      dispatcher2.listen();

      // Same eventId from different device should be allowed
      await (mockSocket2 as any).dispatchHandler(envelope);
      expect(handler2Spy).toHaveBeenCalledTimes(1);
    });

    it('should allow same eventId after TTL expires', async () => {
      process.env['REPLAY_PROTECTION_TTL_SECONDS'] = '1';

      const eventId = 'event-123';
      const envelope = createEnvelope('test_event', { message: 'test' }, eventId);

      // First occurrence
      await (mockSocket as any).dispatchHandler(envelope);
      expect(handlerSpy).toHaveBeenCalledTimes(1);

      handlerSpy.mockClear();

      // Second occurrence within TTL (should be replay)
      await (mockSocket as any).dispatchHandler(envelope);
      expect(handlerSpy).not.toHaveBeenCalled();

      handlerSpy.mockClear();

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // After expiry, same eventId should be allowed
      await (mockSocket as any).dispatchHandler(envelope);
      expect(handlerSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle missing eventId gracefully', async () => {
      // eventId is required by schema, so this should fail validation before replay check
      const invalidEnvelope = {
        // Missing eventId
        type: 'test_event',
        timestamp: Date.now(),
        payload: {},
      };

      await (mockSocket as any).dispatchHandler(invalidEnvelope);

      // Handler should not be called
      expect(handlerSpy).not.toHaveBeenCalled();

      // Error should be emitted
      const emitCalls = (mockSocket.emit as any).mock.calls;
      const errorCall = emitCalls.find(([event]: any) => event === 'error');
      expect(errorCall).toBeTruthy();
    });

    it('should log replay event detection', async () => {
      const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      const eventId = 'event-123';
      const envelope = createEnvelope('test_event', { message: 'test' }, eventId);

      // First occurrence
      await (mockSocket as any).dispatchHandler(envelope);
      consoleDebugSpy.mockClear();

      // Second occurrence (replay) — should log
      await (mockSocket as any).dispatchHandler(envelope);

      expect(consoleDebugSpy).toHaveBeenCalledWith(
        '[replay-protection] Dropping replay event',
        expect.objectContaining({
          deviceId: 'test-device',
          eventId,
        }),
      );

      consoleDebugSpy.mockRestore();
    });

    it('should emit dispatch_ack with duplicate flag for replays', async () => {
      const eventId = 'event-123';
      const envelope = createEnvelope('test_event', { message: 'test' }, eventId);

      // First occurrence
      await (mockSocket as any).dispatchHandler(envelope);

      // Reset emit to check second call
      (mockSocket.emit as any).mockClear();

      // Second occurrence (replay)
      await (mockSocket as any).dispatchHandler(envelope);

      // Should emit dispatch_ack with duplicate: true
      const emitCalls = (mockSocket.emit as any).mock.calls;
      const ackCall = emitCalls.find(([event]: any) => event === 'dispatch_ack');
      expect(ackCall).toBeTruthy();
      expect(ackCall[1]).toEqual({
        eventId,
        duplicate: true,
      });
    });

    it('should emit dispatch_ack with duplicate: false for first occurrence', async () => {
      const eventId = 'event-123';
      const envelope = createEnvelope('test_event', { message: 'test' }, eventId);

      await (mockSocket as any).dispatchHandler(envelope);

      // Should emit dispatch_ack with duplicate: false
      const emitCalls = (mockSocket.emit as any).mock.calls;
      const ackCall = emitCalls.find(([event]: any) => event === 'dispatch_ack');
      expect(ackCall).toBeTruthy();
      expect(ackCall[1]).toEqual({
        eventId,
        duplicate: false,
      });
    });

    it('should handle Redis unavailable gracefully (fail open)', async () => {
      const mockSocketNoRedis: Partial<AuthSocket> = {
        auth: {
          userId: 'test-user',
          deviceId: 'test-device',
        },
        emit: vi.fn(),
        on: vi.fn((event, handler) => {
          if (event === 'dispatch') {
            (mockSocketNoRedis as any).dispatchHandler = handler;
          }
        }),
        rooms: new Set(['test-room']),
      };

      // Pass null for Redis
      const dispatcherNoRedis = new EventDispatcher(
        mockIo as SocketIOServer,
        mockSocketNoRedis as AuthSocket,
        null, // No Redis
      );

      const handlerNoRedis = vi.fn();
      dispatcherNoRedis.register('test_event', handlerNoRedis);
      dispatcherNoRedis.listen();

      const eventId = 'event-123';
      const envelope = createEnvelope('test_event', { message: 'test' }, eventId);

      // First occurrence — should process
      await (mockSocketNoRedis as any).dispatchHandler(envelope);
      expect(handlerNoRedis).toHaveBeenCalledTimes(1);

      handlerNoRedis.mockClear();

      // Second occurrence — should also process (fail open)
      await (mockSocketNoRedis as any).dispatchHandler(envelope);
      expect(handlerNoRedis).toHaveBeenCalledTimes(1);
    });
  });
});
