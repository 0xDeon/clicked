import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import dotenv from 'dotenv';
import { eq, inArray } from 'drizzle-orm';
import { db } from './db/index.js';
import { conversationMembers, users } from './db/schema.js';
import { publishEphemeral } from './services/resumeStream.js';
import { socketAuthMiddleware, type AuthSocket } from './middleware/socketAuth.js';
import { registerMessagingHandlers } from './socket/messaging.js';
import { app } from './app.js';
import { redis as appRedis } from './lib/redis.js';
import { setSocketServer } from './lib/socket.js';
import {
  cleanupStaleSockets,
  reconcileBoot,
  refreshPresenceSocket,
  registerPresenceSocket,
  setOffline,
  setOnline,
  unregisterPresenceSocket,
} from './services/presence.js';
import { startHeartbeatTimer, clearHeartbeatTimer } from './services/heartbeat.js';
import {
  isDeviceRevoked,
  registerDeviceSocket,
  startDeviceRevocationListener,
  unregisterDeviceSocket,
} from './services/deviceRevocation.js';
import {
  checkPayloadSize,
  checkRateLimit,
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
import { loadEnv } from './config.js';

dotenv.config();

// Validate required environment variables at boot. Exits with code 1 and
// logs the offending vars if anything is missing or malformed.
loadEnv();

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
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

io.use(socketAuthMiddleware);

io.on('connection', async (socket: AuthSocket) => {
  const userId = socket.auth!.userId;
  const deviceId = socket.auth!.deviceId;
  console.log('User connected:', userId, socket.id);

  socket.data['userId'] = userId;
  socket.data['deviceId'] = deviceId;

  // Register socket for device-revocation tracking (cross-instance via Redis pub/sub).
  registerDeviceSocket(deviceId, socket.id);

  // Start the server-side heartbeat watchdog (90 s timeout).
  startHeartbeatTimer(socket, userId, deviceId, appRedis, io);

  // Per-socket middleware: intercept every incoming event before handlers.
  const EXCLUDED_EVENTS = new Set(['heartbeat']);
  socket.use(async ([event, ...args], next) => {
    // Skip internal heartbeat pings.
    if (EXCLUDED_EVENTS.has(event)) {
      return next();
    }

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

    // Per-socket rate limiting (configurable via SOCKET_RATE_LIMIT_PER_SEC env).
    const { allowed } = await checkRateLimit(appRedis, socket.id);
    if (!allowed) {
      const violations = recordViolation(socket.id);
      socket.emit('error', { event: 'rate_limited', message: 'Rate limit exceeded' });
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

  // Auto-join all conversation rooms so the socket receives new_message events
  // for every conversation the user belongs to (needed for unread badge tracking).
  const memberships = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.userId, userId),
    columns: { conversationId: true },
  });
  for (const m of memberships) {
    await socket.join(m.conversationId);
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { presenceVisible: true },
  });
  const presenceVisible = user?.presenceVisible ?? true;

  if (appRedis) {
    await registerPresenceSocket(appRedis, userId, deviceId, socket.id);
    await cleanupStaleSockets(io, appRedis, userId, socket.id);

    const becameOnline = await setOnline(appRedis, userId, deviceId);
    if (becameOnline && presenceVisible) {
      for (const m of memberships) {
        io.to(m.conversationId).emit('user_online', { userId });
        io.to(m.conversationId).emit('presence_update', { userId, online: true });
      }
      await recordPresenceForCoMembers(
        userId,
        true,
        memberships.map((m) => m.conversationId),
      );
    }
  }

  socket.on('heartbeat', async () => {
    if (appRedis) {
      await refreshPresenceSocket(appRedis, userId, deviceId, socket.id);
      await cleanupStaleSockets(io, appRedis, userId, socket.id);
    }
  });

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

    clearHeartbeatTimer(socket.id);
    unregisterDeviceSocket(socket.id);

    // Unsubscribe from the device delivery channel on disconnect.
    if (appRedis) {
      const gatewaySub = getGatewaySubscriber(appRedis);
      gatewaySub.removeDevice(deviceId).catch(() => {});
    }

    unregisterForBackpressure(socket);
    clearViolations(socket.id);

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
        const user = await db.query.users.findFirst({
          where: eq(users.id, userId),
          columns: { presenceVisible: true },
        });
        const presenceVisible = user?.presenceVisible ?? true;

        if (presenceVisible) {
          const memberships = await db.query.conversationMembers.findMany({
            where: eq(conversationMembers.userId, userId),
            columns: { conversationId: true },
          });
          for (const m of memberships) {
            io.to(m.conversationId).emit('user_offline', { userId });
            io.to(m.conversationId).emit('presence_update', { userId, online: false });
          }
          await recordPresenceForCoMembers(
            userId,
            false,
            memberships.map((m) => m.conversationId),
          );
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
