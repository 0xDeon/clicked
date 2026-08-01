import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import dotenv from 'dotenv';
import { eq, isNull, and, inArray } from 'drizzle-orm';
import { db } from './db/index.js';
import { conversationMembers, users, devices } from './db/schema.js';
import { publishEphemeral } from './services/resumeStream.js';
import { socketAuthMiddleware, type AuthSocket } from './middleware/socketAuth.js';
import { socketTransportSecurityMiddleware } from './middleware/socketSecurity.js';
import {
  allowedOrigins,
  assertTransportSecurityConfig,
  isOriginAllowed,
} from './lib/transportSecurity.js';
import { registerMessagingHandlers } from './socket/messaging.js';
import { app } from './app.js';
import { redis as appRedis } from './lib/redis.js';
import { setSocketServer } from './lib/socket.js';
import {
  cleanupStaleSockets,
  reconcileBoot,
  registerPresenceSocket,
  setOffline,
  setOnline,
  unregisterPresenceSocket,
  deriveDevicePresence,
  scheduleOfflineBroadcast,
  cancelPendingOfflineBroadcast,
} from './services/presence.js';
import { startHeartbeatTimer, clearHeartbeatTimer } from './services/heartbeat.js';
import { isDeviceRevoked, startDeviceRevocationListener } from './services/deviceRevocation.js';
import {
  checkPayloadSize,
  checkSocketEventRateLimit,
  clearViolations,
  recordViolation,
} from './services/rateLimit.js';
import { registerForBackpressure, unregisterForBackpressure } from './services/backpressure.js';
import { getGatewaySubscriber } from './services/deviceDelivery.js';
import {
  buildRpcFetcher,
  buildTreasuryRpcFetcher,
  runForever as runStellarListener,
} from './services/stellarListener.js';
import { startFileCleanupJob } from './services/fileCleanup.js';
import { startDeviceGcJob } from './services/deviceGc.js';
import { startEnvelopeGcJob } from './services/envelopeGc.js';
import { loadEnv } from './config.js';
import { getObjectStore } from './lib/objectStore.js';
import { presenceChurnTotal, connectedSockets } from './lib/metrics.js';
import {
  conversationRoom,
  joinUserRoom,
  rebuildRoomsAfterRestart,
} from './services/roomManager.js';

dotenv.config();

// Validate required environment variables at boot. Exits with code 1 and
// logs the offending vars if anything is missing or malformed.
loadEnv();

// Refuse to boot a non-dev gateway that would accept plaintext transport (#374).
assertTransportSecurityConfig();

export const objectStore = getObjectStore();

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin ?? undefined));
    },
    credentials: allowedOrigins().length > 0,
  },
});

let isShuttingDown = false;

const handleShutdown = () => {
  isShuttingDown = true;
};

process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);

const origIoClose = io.close.bind(io);
io.close = ((fn?: () => void) => {
  isShuttingDown = true;
  return origIoClose(fn);
}) as typeof io.close;

const origHttpClose = httpServer.close.bind(httpServer);
httpServer.close = ((fn?: (err?: Error) => void) => {
  isShuttingDown = true;
  return origHttpClose(fn);
}) as typeof httpServer.close;

setSocketServer(io);

// Record a presence change on the resume streams of everyone who shares a
// conversation with this user (#200), so members who are offline at the moment
// of the change can replay it when they reconnect. Best-effort and Redis-only.
async function recordPresenceForCoMembers(
  userId: string,
  online: boolean,
  conversationIds: string[],
): Promise<void> {
  if (!appRedis || conversationIds.length === 0) {
    return;
  }

  const coMembers = await db.query.conversationMembers.findMany({
    where: inArray(conversationMembers.conversationId, conversationIds),
    columns: { userId: true },
  });

  await publishEphemeral(
    appRedis,
    coMembers.map((m) => m.userId).filter((id) => id !== userId),
    { type: 'presence_update', data: { userId, online } },
  );
}

// Transport + origin policy runs first: an insecure or disallowed handshake is
// dropped before any token parsing or database lookup (#374).
io.use(socketTransportSecurityMiddleware);
io.use(socketAuthMiddleware);

io.on('connection', async (socket: AuthSocket) => {
  const userId = socket.auth!.userId;
  const deviceId = socket.auth!.deviceId;
  console.log('User connected:', userId, socket.id);

  socket.data['userId'] = userId;
  socket.data['deviceId'] = deviceId;
  connectedSockets.inc();

  // Start the server-side heartbeat watchdog (90 s timeout).
  startHeartbeatTimer(socket, userId, deviceId, appRedis, io);

  // Update devices.lastSeenAt for device-based presence derivation.
  try {
    await db
      .update(devices)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)));
  } catch {
    // Non-critical update; ignore errors.
  }

  // Per-socket middleware: intercept every incoming event before handlers.
  socket.use(async ([event, ...args], next) => {
    // Reject events from a device that was revoked mid-session.
    if (isDeviceRevoked(deviceId)) {
      socket.emit('error', { event: 'device_revoked', message: 'Device has been revoked' });
      socket.disconnect(true);
      return;
    }

    // Enforce maximum payload size (configurable via MAX_PAYLOAD_SIZE env).
    const payloadArgs = args.filter((a) => typeof a !== 'function');
    const { valid, size } = checkPayloadSize(payloadArgs);
    if (!valid) {
      socket.emit('error', {
        event: 'payload_too_large',
        message: `Payload size ${size} exceeds limit`,
      });
      return;
    }

    // Per-event rate limiting, counted in Redis so the budget is shared across
    // gateway nodes and survives a reconnect (see config/rateLimits.ts).
    const { allowed, limit, resetSeconds } = await checkSocketEventRateLimit(event, deviceId);
    if (!allowed) {
      const violations = recordViolation(socket.id);
      socket.emit('error', {
        event: 'rate_limited',
        message: 'Rate limit exceeded',
        limitedEvent: event,
        limit,
        retryAfterSeconds: resetSeconds,
      });
      if (violations >= 3) {
        socket.disconnect(true);
      }
      return;
    }

    next();
  });

  // Join a device-scoped room so the delivery pipeline can push envelopes to
  // exactly this device, even across horizontally-scaled instances via the
  // Redis adapter.
  await socket.join(`device:${deviceId}`);

  // Join user room for cross-device synchronization
  joinUserRoom(socket);

  // Auto-join all conversation rooms so the socket receives new_message events
  // for every conversation the user belongs to (needed for unread badge tracking).
  const memberships = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.userId, userId),
    columns: { conversationId: true },
  });
  for (const m of memberships) {
    // Join the conversation room for optimized fan-out
    await socket.join(conversationRoom(m.conversationId));
    // Also join the direct conversation room for backward compatibility
    await socket.join(m.conversationId);
  }

  if (appRedis) {
    await registerPresenceSocket(appRedis, userId, deviceId, socket.id);
    await cleanupStaleSockets(io, appRedis, userId, socket.id);

    // #345 — a device reconnecting cancels any offline broadcast still
    // pending from a very recent disconnect (same user, any device). When
    // that happens the reconnect is invisible to observers too: no
    // offline/online pair, since nothing was ever announced offline.
    const cancelledPendingOffline = cancelPendingOfflineBroadcast(userId);

    const becameOnline = await setOnline(appRedis, userId, deviceId);
    const connectUser = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { presenceVisible: true, lastSeenVisible: true },
    });
    const presenceVisible = connectUser?.presenceVisible ?? true;
    if (becameOnline && presenceVisible && !cancelledPendingOffline) {
      for (const m of memberships) {
        io.to(conversationRoom(m.conversationId)).emit('user_online', { userId });
        io.to(conversationRoom(m.conversationId)).emit('presence_update', {
          userId,
          online: true,
          status: 'online',
          ...(lastSeenVisible ? { lastSeen: Date.now() } : {}),
        });
        // Also emit to direct conversation room for backward compatibility
        io.to(m.conversationId).emit('user_online', { userId });
        io.to(m.conversationId).emit('presence_update', {
          userId,
          online: true,
          status: 'online',
          ...(lastSeenVisible ? { lastSeen: Date.now() } : {}),
        });
      }
      await recordPresenceForCoMembers(
        userId,
        true,
        memberships.map((m) => m.conversationId),
      );
    }
  }

  registerMessagingHandlers(io, socket);

  // Subscribe to the device delivery channel so cross-node per-device
  // envelopes reach this socket (#192).
  if (appRedis) {
    const gatewaySub = getGatewaySubscriber(appRedis);
    gatewaySub
      .addDevice(deviceId, (payload) => {
        socket.emit('device_envelope', payload);
      })
      .catch((err: Error) => {
        console.warn('[deviceDelivery] failed to subscribe device', deviceId, err.message);
      });
  }

  // Monitor send-buffer to detect slow/stalled consumers.
  registerForBackpressure(socket);

  socket.on('disconnect', async (reason: string) => {
    console.log('User disconnected:', userId, reason);
    connectedSockets.dec();

    clearHeartbeatTimer(socket.id);

    // Unsubscribe from the device delivery channel on disconnect.
    if (appRedis) {
      const gatewaySub = getGatewaySubscriber(appRedis);
      gatewaySub.removeDevice(deviceId).catch(() => {});
    }

    unregisterForBackpressure(socket);
    clearViolations(socket.id);

    // Update devices.lastSeenAt on disconnect.
    try {
      await db
        .update(devices)
        .set({ lastSeenAt: new Date() })
        .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)));
    } catch {
      // Non-critical update; ignore errors.
    }
    // During a gateway restart we must NOT wipe presence — surviving devices
    // re-assert via heartbeat and Redis TTLs.
    if (
      isShuttingDown ||
      reason === 'server shutting down' ||
      reason === 'server namespace disconnect'
    ) {
      return;
    }

    if (appRedis) {
      const deviceHasNoSockets = await unregisterPresenceSocket(
        appRedis,
        userId,
        deviceId,
        socket.id,
      );
      await cleanupStaleSockets(io, appRedis, userId);

      const fullyOffline = deviceHasNoSockets
        ? await setOffline(appRedis, userId, deviceId)
        : false;

      if (fullyOffline) {
        presenceChurnTotal.inc({ transition: 'offline' });
      }

      if (fullyOffline) {
        const user = await db.query.users.findFirst({
          where: eq(users.id, userId),
          columns: { presenceVisible: true, lastSeenVisible: true },
        });
        const presenceVisible = user?.presenceVisible ?? true;
        const lastSeenVisible = user?.lastSeenVisible ?? false;

        if (presenceVisible) {
          // #345 — defer the broadcast by the configured grace window instead
          // of announcing offline immediately. A reconnect within the window
          // cancels this via cancelPendingOfflineBroadcast() in the connect
          // handler above, so a brief blip never produces an offline/online pair.
          scheduleOfflineBroadcast(userId, async () => {
            const memberships = await db.query.conversationMembers.findMany({
              where: eq(conversationMembers.userId, userId),
              columns: { conversationId: true },
            });

            const { lastSeen } = await deriveDevicePresence(userId);

            for (const m of memberships) {
              io.to(conversationRoom(m.conversationId)).emit('user_offline', { userId });
              io.to(conversationRoom(m.conversationId)).emit('presence_update', {
                userId,
                online: false,
                ...(lastSeen ? { lastSeen } : {}),
              });
              // Also emit to direct conversation room for backward compatibility
              io.to(m.conversationId).emit('user_offline', { userId });
              io.to(m.conversationId).emit('presence_update', {
                userId,
                online: false,
                ...(lastSeen ? { lastSeen } : {}),
              });
            }
            await recordPresenceForCoMembers(
              userId,
              false,
              memberships.map((m) => m.conversationId),
            );
          });
        }
      }
    }
  });
});

/**
 * Issue #7 — Redis pub/sub adapter for horizontal Socket.IO scaling.
 *
 * When `REDIS_URL` is reachable, attach `@socket.io/redis-adapter` so
 * multiple backend instances share rooms via Redis pub/sub. If the
 * connection fails (Redis down, wrong URL, or env var unset), log a
 * warning and continue running in single-instance mode — the in-process
 * adapter remains active so the server still works locally.
 */
async function attachRedisAdapter(): Promise<void> {
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const pubClient = createClient({ url: redisUrl });
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) => {
    console.warn('[socket.io] Redis pub client error — degrading to local adapter:', err.message);
  });
  subClient.on('error', (err) => {
    console.warn('[socket.io] Redis sub client error — degrading to local adapter:', err.message);
  });

  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    console.log(`[socket.io] Redis adapter attached (${redisUrl})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[socket.io] Redis unavailable (${message}) — running in single-instance mode`);
    await Promise.allSettled([pubClient.quit(), subClient.quit()]);
  } finally {
    if (appRedis) {
      try {
        await reconcileBoot(io, appRedis);
        console.log('[presence] Boot reconciliation complete');

        // Rebuild rooms after restart for optimized fan-out
        await rebuildRoomsAfterRestart(io);
        console.log('[roomManager] Rooms rebuilt after restart');
      } catch (err) {
        console.warn('[presence] Boot reconciliation failed:', err);
      }
    }
  }
}

const PORT = process.env['PORT'] ?? 3001;
httpServer.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

// Attach the Redis adapter after listen() so the API is reachable even if
// Redis is unreachable; on failure we fall back to the in-process adapter.
void attachRedisAdapter();

// #231 – start background file cleanup + push backoff re-enable job
startFileCleanupJob();

// Background GC: prune consumed/expired prekeys + MLS key packages, flag
// long-revoked devices, and delete fully-delivered/expired message envelopes.
// Retention windows are configurable via env (see services/deviceGc.ts and
// services/envelopeGc.ts) so operators can tune them per deployment.
startDeviceGcJob();
startEnvelopeGcJob();

// Subscribe to device_revoked:* channels so any gateway instance can
// disconnect a revoked device's sockets within seconds, even when the
// revocation was issued on a different node.
if (appRedis) {
  void startDeviceRevocationListener(appRedis, appRedis);
}

// #46 — Stellar transfer event listener. Only spin up when the contract
// id is configured so local-dev and unit-test runs don't try to talk to
// Soroban RPC. The listener never throws out of runForever, so a failed
// chain connection logs but doesn't crash the API.
const stellarRpcUrl = process.env['STELLAR_RPC_URL'];
const tokenTransferContractId = process.env['TOKEN_TRANSFER_CONTRACT_ID'];
const groupTreasuryContractId = process.env['GROUP_TREASURY_CONTRACT_ID'];

if (stellarRpcUrl && tokenTransferContractId) {
  void runStellarListener({
    fetchEvents: buildRpcFetcher({
      rpcUrl: stellarRpcUrl,
      contractId: tokenTransferContractId,
    }),
    ...(groupTreasuryContractId && {
      fetchTreasuryEvents: buildTreasuryRpcFetcher({
        rpcUrl: stellarRpcUrl,
        contractId: groupTreasuryContractId,
      }),
    }),
  });
} else {
  console.log(
    '[stellar-listener] STELLAR_RPC_URL or TOKEN_TRANSFER_CONTRACT_ID unset; listener disabled.',
  );
}

export { httpServer, io };
