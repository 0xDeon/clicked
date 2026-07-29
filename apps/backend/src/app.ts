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
import { requireAuth, type AuthRequest } from './middleware/auth.js';
import { ipIdentifier, rateLimit } from './middleware/rateLimit.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export const app: Express = express();

app.use(cors());
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
app.use('/devices', devicesRouter);
app.use('/messages', messagesRouter);
app.use('/users', usersRouter);
app.use('/treasury', treasuryRouter);
app.use('/uploads', uploadsRouter);
app.use('/files', filesRouter);
app.use('/push', pushRouter);
app.use('/sync', syncRouter);
app.use('/user-devices', userDevicesRouter);

app.get('/me', requireAuth, (req, res) => {
  res.json({ user: (req as AuthRequest).auth });
});
