/**
 * Load-test fixture seeding (#385).
 *
 * Creates N users, one device each, a single group conversation containing
 * all of them, and signs a JWT per device. Writes the fixture (userId,
 * deviceId, token per participant + conversationId) to stdout as JSON so
 * `run.ts` can consume it without re-touching the database.
 *
 * Usage: tsx scripts/loadtest/seed.ts --devices 200 > fixture.json
 */
import { randomBytes } from 'node:crypto';
import { db } from '../../apps/backend/src/db/index.js';
import { users, devices, conversations, conversationMembers } from '../../apps/backend/src/db/schema.js';
import { signToken } from '../../apps/backend/src/lib/jwt.js';

interface Fixture {
  conversationId: string;
  participants: Array<{ userId: string; deviceId: string; token: string }>;
}

function parseDeviceCount(): number {
  const flagIndex = process.argv.indexOf('--devices');
  if (flagIndex === -1) return 200;
  const parsed = Number(process.argv[flagIndex + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
}

async function seed(): Promise<Fixture> {
  const deviceCount = parseDeviceCount();

  const [conversation] = await db
    .insert(conversations)
    .values({ type: 'group', name: 'loadtest' })
    .returning();
  const conversationId = conversation!.id;

  const participants: Fixture['participants'] = [];

  for (let i = 0; i < deviceCount; i++) {
    const [user] = await db
      .insert(users)
      .values({ username: `loadtest-${randomBytes(4).toString('hex')}-${i}` })
      .returning();
    const userId = user!.id;

    const [device] = await db
      .insert(devices)
      .values({
        userId,
        identityPublicKey: randomBytes(32).toString('base64'),
        deviceName: `loadtest-device-${i}`,
        platform: 'web',
      })
      .returning();
    const deviceId = device!.id;

    await db.insert(conversationMembers).values({ conversationId, userId });

    const token = signToken({ userId, walletAddress: `loadtest-${i}`, deviceId });
    participants.push({ userId, deviceId, token });
  }

  return { conversationId, participants };
}

seed()
  .then((fixture) => {
    process.stdout.write(JSON.stringify(fixture));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[loadtest:seed] failed:', err);
    process.exit(1);
  });
