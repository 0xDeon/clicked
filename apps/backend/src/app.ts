import express from 'express';
import type { Express } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { authRouter } from './routes/auth.js';
import { conversationsRouter } from './routes/conversations.js';
import { devicesRouter } from './routes/devices.js';
import { messagesRouter } from './routes/messages.js';
import { usersRouter } from './routes/users.js';
import { treasuryRouter } from './routes/treasury.js';
import { uploadsRouter } from './routes/uploads.js';
import { filesRouter } from './routes/files.js';
import { pushRouter } from './routes/push.js';
import { syncRouter } from './routes/sync.js';
import { userDevicesRouter } from './routes/userDevices.js';
import { mlsRouter } from './routes/mls.js';
import { localStorageRouter } from './routes/localStorage.js';
import { requireAuth, type AuthRequest } from './middleware/auth.js';
import { registry } from './lib/metrics.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export const app: Express = express();

// TLS is terminated at the edge in every non-local deployment, so `req.secure`
// must be allowed to consult X-Forwarded-Proto from the trusted hops only
// (#374). TRUST_PROXY=0 disables it for a directly-exposed gateway.
app.set('trust proxy', trustProxyHops());

app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin ?? undefined));
    },
    credentials: allowedOrigins().length > 0,
  }),
);
app.use(enforceTransportSecurity);
app.use(enforceOriginPolicy);
app.use(express.json());
if (process.env['NODE_ENV'] !== 'test') {
  app.use(morgan('dev'));
}

app.get('/health', async (_req, res) => {
  const health = {
    status: 'ok' as const,
    db: 'connected' as const,
    node: process.version,
    version: packageJson.version,
  };

  try {
    await db.execute(sql`SELECT 1`);
    res.json(health);
  } catch {
    res.status(503).json({
      ...health,
      status: 'error',
      db: 'unreachable',
    });
  }
});

// Catch-all per-IP ceiling (#375). Sits below every per-endpoint bucket and
// exists to bound a caller hammering endpoints that have no specific limit.
// Mounted after /health so orchestrator probes are never rate limited.
app.use(rateLimit('global_ip', { identifier: ipIdentifier }));

app.use('/auth', authRouter);
app.use('/conversations', conversationsRouter);
// MLS group state lives on /conversations/:id/mls/* but in its own router so
// conversations.ts does not keep growing (#372).
app.use('/conversations', mlsRouter);
app.use('/devices', devicesRouter);
app.use('/messages', messagesRouter);
app.use('/users', usersRouter);
app.use('/treasury', treasuryRouter);
app.use('/uploads', uploadsRouter);
app.use('/files', filesRouter);
app.use('/push', pushRouter);
app.use('/sync', syncRouter);
app.use('/user-devices', userDevicesRouter);
app.use('/security', securityRouter);

// #393 — Prometheus scrape endpoint. Never includes message content: only
// counters/histograms defined in lib/metrics.ts, which take no ciphertext
// or free-text labels.
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.get('/me', requireAuth, (req, res) => {
  res.json({ user: (req as AuthRequest).auth });
});
