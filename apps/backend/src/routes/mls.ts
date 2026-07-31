/**
 * MLS group routes (#372) — mounted alongside `conversationsRouter` on
 * `/conversations` so the paths stay `/conversations/:id/mls/...` without
 * growing that already large file.
 *
 * These endpoints move public MLS artefacts between members. The server orders
 * commits and holds Welcomes for offline devices; it never derives, stores, or
 * inspects group secrets.
 *
 * The flow a newly-linked device follows:
 *
 *   1. registers (POST /devices) and publishes MLS key packages
 *   2. shows up in GET /conversations/:id/mls/pending-devices for every group
 *      its user belongs to
 *   3. an existing member commits an Add for it, attaching a Welcome
 *   4. the new device claims that Welcome and replays commits from its join
 *      epoch onwards
 *
 * After step 4 it decrypts everything from its join epoch on. It cannot
 * decrypt anything before that, by design — see docs/mls-group-membership.md.
 */

import { Router, type Router as RouterType } from 'express';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  conversationMembers,
  conversations,
  devices,
  mlsGroupMembers,
  mlsGroups,
} from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { getSocketServer } from '../lib/socket.js';
import { conversationRoom } from '../services/roomManager.js';
import { deviceRoom } from '../services/deliveryPipeline.js';
import {
  MLS_COMMIT_PAGE_SIZE,
  MLS_MAX_COMMIT_MEMBER_CHANGES,
  claimWelcome,
  getEpochWindow,
  getGroupByConversation,
  isActiveMember,
  listCommitsSince,
  listDevicesAwaitingJoin,
  pendingWelcomeEpoch,
  recordCommit,
} from '../services/mlsGroups.js';

export const mlsRouter: RouterType = Router();

mlsRouter.use(requireAuth);

// ─── Schemas ──────────────────────────────────────────────────────────────────

/** Base64 blob of an MLS wire-format message. Opaque to the server. */
const MlsBlobSchema = z
  .string()
  .min(1)
  .max(262144, 'MLS message exceeds the 256 KiB limit')
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'must be valid base64');

const InitGroupSchema = z.object({
  groupId: MlsBlobSchema,
  cipherSuite: z.number().int().positive(),
});

const PublishCommitSchema = z.object({
  epoch: z.number().int().positive(),
  commit: MlsBlobSchema,
  addedDevices: z
    .array(z.object({ deviceId: z.string().uuid(), welcome: MlsBlobSchema }))
    .max(MLS_MAX_COMMIT_MEMBER_CHANGES)
    .optional()
    .default([]),
  removedDeviceIds: z
    .array(z.string().uuid())
    .max(MLS_MAX_COMMIT_MEMBER_CHANGES)
    .optional()
    .default([]),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Every route here needs the same three facts: the conversation exists, the
 * caller belongs to it, and (usually) it has MLS state. Resolving them in one
 * place keeps the failure codes consistent across the endpoints.
 */
async function resolveContext(
  req: AuthRequest,
  opts: { requireGroup: boolean },
): Promise<
  | {
      ok: true;
      conversationId: string;
      deviceId: string;
      group: Awaited<ReturnType<typeof getGroupByConversation>>;
    }
  | { ok: false; status: number; error: string }
> {
  const conversationId = req.params['id'] as string | undefined;
  const userId = req.auth!.userId;
  const deviceId = req.auth!.deviceId as string | undefined;

  if (!conversationId) {
    return { ok: false, status: 400, error: 'Conversation id is required' };
  }

  if (!deviceId) {
    return { ok: false, status: 400, error: 'Token is missing a deviceId' };
  }

  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
    columns: { id: true },
  });

  if (!membership) {
    return { ok: false, status: 403, error: 'Not a member of this conversation' };
  }

  const group = await getGroupByConversation(conversationId);

  if (opts.requireGroup && !group) {
    return { ok: false, status: 404, error: 'Conversation has no MLS group' };
  }

  return { ok: true, conversationId, deviceId, group };
}

// ─── POST /conversations/:id/mls/group ────────────────────────────────────────
//
// Publishes the group state for a conversation. The founding client has
// already created the group locally; this records the public identifiers and
// seats the founder's device at epoch 0.

mlsRouter.post('/:id/mls/group', validate(InitGroupSchema), async (req: AuthRequest, res) => {
  const ctx = await resolveContext(req, { requireGroup: false });
  if (!ctx.ok) {
    res.status(ctx.status).json({ error: ctx.error });
    return;
  }

  if (ctx.group) {
    res.status(409).json({
      error: 'Conversation already has an MLS group',
      groupId: ctx.group.groupId,
      currentEpoch: ctx.group.currentEpoch,
    });
    return;
  }

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, ctx.conversationId),
    columns: { type: true },
  });

  if (conversation?.type !== 'group') {
    res.status(400).json({ error: 'MLS groups are only available for group conversations' });
    return;
  }

  const { groupId, cipherSuite } = req.body as z.infer<typeof InitGroupSchema>;
  const userId = req.auth!.userId;

  try {
    const created = await db.transaction(async (tx) => {
      const [group] = await tx
        .insert(mlsGroups)
        .values({ conversationId: ctx.conversationId, groupId, cipherSuite })
        .returning({ id: mlsGroups.id, currentEpoch: mlsGroups.currentEpoch });

      if (!group) return null;

      // The founder is the group's only leaf at epoch 0.
      await tx.insert(mlsGroupMembers).values({
        mlsGroupId: group.id,
        deviceId: ctx.deviceId,
        userId,
        joinedAtEpoch: group.currentEpoch,
      });

      return group;
    });

    if (!created) {
      res.status(500).json({ error: 'Failed to create MLS group' });
      return;
    }

    res.status(201).json({
      conversationId: ctx.conversationId,
      groupId,
      cipherSuite,
      currentEpoch: created.currentEpoch,
    });
  } catch {
    // Unique index on conversation_id / group_id — another client won the race.
    res.status(409).json({ error: 'Conversation already has an MLS group' });
  }
});

// ─── GET /conversations/:id/mls/group ─────────────────────────────────────────
//
// The state a device needs on open: where the group is, where the device sits
// in it, whether a Welcome is waiting, and — importantly for the UI — the
// earliest epoch this device will ever be able to read.

mlsRouter.get('/:id/mls/group', async (req: AuthRequest, res) => {
  const ctx = await resolveContext(req, { requireGroup: true });
  if (!ctx.ok) {
    res.status(ctx.status).json({ error: ctx.error });
    return;
  }

  const group = ctx.group!;
  const [window, welcomeEpoch] = await Promise.all([
    getEpochWindow(group.id, ctx.deviceId),
    pendingWelcomeEpoch(group.id, ctx.deviceId),
  ]);

  res.json({
    conversationId: ctx.conversationId,
    groupId: group.groupId,
    cipherSuite: group.cipherSuite,
    currentEpoch: group.currentEpoch,
    membership: window
      ? {
          joinedAtEpoch: window.joinedAtEpoch,
          removedAtEpoch: window.removedAtEpoch,
          active: window.removedAtEpoch === null,
        }
      : null,
    pendingWelcome: welcomeEpoch === null ? null : { epoch: welcomeEpoch },
    // Null until the device has a leaf. Everything strictly before this epoch
    // is permanently unreadable on this device.
    historyAvailableFromEpoch: window?.joinedAtEpoch ?? null,
  });
});

// ─── GET /conversations/:id/mls/pending-devices ───────────────────────────────
//
// Devices of conversation members that hold no leaf yet. A member polls this
// (or reacts to the `device_added` system event) and commits an Add.

mlsRouter.get('/:id/mls/pending-devices', async (req: AuthRequest, res) => {
  const ctx = await resolveContext(req, { requireGroup: true });
  if (!ctx.ok) {
    res.status(ctx.status).json({ error: ctx.error });
    return;
  }

  const pending = await listDevicesAwaitingJoin(ctx.conversationId, ctx.group!.id);

  res.json({ currentEpoch: ctx.group!.currentEpoch, devices: pending });
});

// ─── POST /conversations/:id/mls/commits ──────────────────────────────────────
//
// Publishes a commit, the membership changes it encodes, and the Welcome for
// each added device. `epoch` must be exactly `currentEpoch + 1`; a client that
// raced another committer gets 409 with the epoch to rebase on.

mlsRouter.post('/:id/mls/commits', validate(PublishCommitSchema), async (req: AuthRequest, res) => {
  const ctx = await resolveContext(req, { requireGroup: true });
  if (!ctx.ok) {
    res.status(ctx.status).json({ error: ctx.error });
    return;
  }

  const group = ctx.group!;
  const body = req.body as z.infer<typeof PublishCommitSchema>;

  // Only a device already in the tree can commit — an outsider has no state to
  // commit from, and letting one write would corrupt every member's view.
  if (!(await isActiveMember(group.id, ctx.deviceId))) {
    res.status(403).json({ error: 'Only an active group member device may publish a commit' });
    return;
  }

  const addedIds = body.addedDevices.map((d) => d.deviceId);

  if (new Set(addedIds).size !== addedIds.length) {
    res.status(400).json({ error: 'addedDevices contains duplicate deviceIds' });
    return;
  }

  if (addedIds.some((id) => body.removedDeviceIds.includes(id))) {
    res.status(400).json({ error: 'A device cannot be added and removed by the same commit' });
    return;
  }

  // Added devices must belong to users who are actually in the conversation —
  // otherwise a member could smuggle an arbitrary device into the group.
  let addedDevices: Array<{ deviceId: string; userId: string; welcome: string }> = [];

  if (addedIds.length > 0) {
    const memberRows = await db.query.conversationMembers.findMany({
      where: eq(conversationMembers.conversationId, ctx.conversationId),
      columns: { userId: true },
    });
    const memberUserIds = new Set(memberRows.map((m) => m.userId));

    const deviceRows = await db.query.devices.findMany({
      where: and(inArray(devices.id, addedIds), isNull(devices.revokedAt)),
      columns: { id: true, userId: true },
    });
    const deviceOwner = new Map(deviceRows.map((d) => [d.id, d.userId]));

    const invalid = addedIds.filter((id) => {
      const owner = deviceOwner.get(id);
      return owner === undefined || !memberUserIds.has(owner);
    });

    if (invalid.length > 0) {
      res.status(400).json({
        error: 'Added devices must be active devices of conversation members',
        invalidDeviceIds: invalid,
      });
      return;
    }

    addedDevices = body.addedDevices.map((d) => ({
      deviceId: d.deviceId,
      userId: deviceOwner.get(d.deviceId)!,
      welcome: d.welcome,
    }));
  }

  const result = await recordCommit({
    mlsGroupId: group.id,
    epoch: body.epoch,
    committerDeviceId: ctx.deviceId,
    commit: body.commit,
    addedDevices,
    removedDeviceIds: body.removedDeviceIds,
  });

  if (!result.ok) {
    res.status(409).json({
      error: 'Commit epoch conflict — another commit was applied first',
      currentEpoch: result.currentEpoch,
      expectedEpoch: result.currentEpoch + 1,
    });
    return;
  }

  const io = getSocketServer();
  if (io) {
    io.to(conversationRoom(ctx.conversationId)).emit('mls_commit', {
      conversationId: ctx.conversationId,
      epoch: result.epoch,
      commit: body.commit,
    });

    // Added devices are not in the conversation room's MLS state yet, so they
    // get a direct nudge to come and claim their Welcome.
    for (const added of addedDevices) {
      io.to(deviceRoom(added.deviceId)).emit('mls_welcome_available', {
        conversationId: ctx.conversationId,
        epoch: result.epoch,
      });
    }
  }

  res.status(201).json({
    conversationId: ctx.conversationId,
    epoch: result.epoch,
    addedDeviceIds: addedIds,
    removedDeviceIds: body.removedDeviceIds,
  });
});

// ─── GET /conversations/:id/mls/commits ───────────────────────────────────────
//
// Commit replay for a device catching up. `?sinceEpoch=` defaults to the
// device's join epoch, which is the correct starting point after processing a
// Welcome — earlier commits are not applicable to a tree it was not in.

mlsRouter.get('/:id/mls/commits', async (req: AuthRequest, res) => {
  const ctx = await resolveContext(req, { requireGroup: true });
  if (!ctx.ok) {
    res.status(ctx.status).json({ error: ctx.error });
    return;
  }

  const group = ctx.group!;
  const window = await getEpochWindow(group.id, ctx.deviceId);

  if (!window) {
    res.status(403).json({ error: 'Device is not a member of this MLS group' });
    return;
  }

  const raw = req.query['sinceEpoch'];
  let sinceEpoch = window.joinedAtEpoch;

  if (typeof raw === 'string' && raw !== '') {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      res.status(400).json({ error: 'sinceEpoch must be a non-negative integer' });
      return;
    }
    // Never replay behind the device's join epoch: those commits belong to a
    // tree it had no leaf in and it cannot apply them.
    sinceEpoch = Math.max(parsed, window.joinedAtEpoch);
  }

  const rawLimit = Number(req.query['limit']);
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MLS_COMMIT_PAGE_SIZE)
      : MLS_COMMIT_PAGE_SIZE;

  const commits = await listCommitsSince(group.id, sinceEpoch, limit);
  const lastEpoch = commits[commits.length - 1]?.epoch ?? sinceEpoch;

  res.json({
    conversationId: ctx.conversationId,
    sinceEpoch,
    currentEpoch: group.currentEpoch,
    commits,
    hasMore: lastEpoch < group.currentEpoch,
  });
});

// ─── GET /conversations/:id/mls/welcome ───────────────────────────────────────
//
// A newly-added device claims the Welcome that seats it in the tree. Claiming
// marks it consumed; the device then replays commits from its join epoch.

mlsRouter.get('/:id/mls/welcome', async (req: AuthRequest, res) => {
  const ctx = await resolveContext(req, { requireGroup: true });
  if (!ctx.ok) {
    res.status(ctx.status).json({ error: ctx.error });
    return;
  }

  const group = ctx.group!;
  const claimed = await claimWelcome(group.id, ctx.deviceId);

  if (!claimed) {
    res.status(404).json({ error: 'No pending Welcome for this device' });
    return;
  }

  res.json({
    conversationId: ctx.conversationId,
    groupId: group.groupId,
    cipherSuite: group.cipherSuite,
    epoch: claimed.epoch,
    welcome: claimed.welcome,
    currentEpoch: group.currentEpoch,
  });
});
