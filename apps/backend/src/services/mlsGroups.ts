/**
 * MLS group state (#372).
 *
 * The server keeps the public ledger a group needs to agree on — current
 * epoch, which device leaves are in the tree, the commit that produced each
 * epoch, and pending Welcome messages — and never sees group secrets.
 *
 * The two things this module exists to make correct:
 *
 *   1. **Epoch races.** Two members can commit at the same instant. Both
 *      commits claim `currentEpoch + 1`, and only one may win, or members end
 *      up on divergent trees. `recordCommit` resolves that in the database.
 *   2. **Membership windows.** A device's decryption window is an epoch
 *      interval, not a boolean. `getEpochWindow` returns that interval so the
 *      message read paths can mark what a device genuinely cannot read.
 */

import { and, asc, eq, gt, inArray, isNull, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  conversationMembers,
  devices,
  mlsCommits,
  mlsGroupMembers,
  mlsGroups,
  mlsWelcomes,
} from '../db/schema.js';
import type { MlsEpochWindow } from '../lib/mlsVisibility.js';

/** Maximum commits returned by a single catch-up page. */
export const MLS_COMMIT_PAGE_SIZE = 200;

/** Maximum devices a single commit may add or remove. */
export const MLS_MAX_COMMIT_MEMBER_CHANGES = 100;

export interface MlsGroupState {
  id: string;
  conversationId: string;
  groupId: string;
  cipherSuite: number;
  currentEpoch: number;
}

export async function getGroupByConversation(
  conversationId: string,
): Promise<MlsGroupState | null> {
  const row = await db.query.mlsGroups.findFirst({
    where: eq(mlsGroups.conversationId, conversationId),
    columns: {
      id: true,
      conversationId: true,
      groupId: true,
      cipherSuite: true,
      currentEpoch: true,
    },
  });

  return row ?? null;
}

/**
 * The epoch interval `deviceId` can decrypt in `mlsGroupId`, or `null` when the
 * device holds no leaf in the group.
 *
 * A device that was removed and later re-added has more than one row; the most
 * recent one is the live window. The earlier interval is intentionally not
 * merged in — the device genuinely cannot read the epochs it was absent for.
 */
export async function getEpochWindow(
  mlsGroupId: string,
  deviceId: string,
): Promise<MlsEpochWindow | null> {
  const row = await db.query.mlsGroupMembers.findFirst({
    where: and(eq(mlsGroupMembers.mlsGroupId, mlsGroupId), eq(mlsGroupMembers.deviceId, deviceId)),
    orderBy: [desc(mlsGroupMembers.joinedAtEpoch)],
    columns: { joinedAtEpoch: true, removedAtEpoch: true },
  });

  return row ?? null;
}

/**
 * Convenience wrapper for the message read paths: resolves the conversation's
 * group and the caller device's window in one step. Returns
 * `{ hasGroup: false }` for conversations that are not MLS groups, so callers
 * can skip the visibility pass entirely.
 */
export async function getConversationEpochWindow(
  conversationId: string,
  deviceId: string | undefined,
): Promise<{ hasGroup: boolean; window: MlsEpochWindow | null }> {
  const group = await getGroupByConversation(conversationId);
  if (!group) return { hasGroup: false, window: null };
  if (!deviceId) return { hasGroup: true, window: null };

  return { hasGroup: true, window: await getEpochWindow(group.id, deviceId) };
}

/** True when the device currently holds an active leaf in the group. */
export async function isActiveMember(mlsGroupId: string, deviceId: string): Promise<boolean> {
  const row = await db.query.mlsGroupMembers.findFirst({
    where: and(
      eq(mlsGroupMembers.mlsGroupId, mlsGroupId),
      eq(mlsGroupMembers.deviceId, deviceId),
      isNull(mlsGroupMembers.removedAtEpoch),
    ),
    columns: { id: true },
  });

  return row !== undefined && row !== null;
}

/**
 * Active devices belonging to conversation members that hold no leaf in the
 * group yet — the set a committer has to Add.
 *
 * This is how a newly-linked device surfaces to the rest of the group: it
 * registers, appears here, and the next commit brings it into the tree.
 */
export async function listDevicesAwaitingJoin(
  conversationId: string,
  mlsGroupId: string,
): Promise<Array<{ deviceId: string; userId: string; identityPublicKey: string }>> {
  const memberRows = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.conversationId, conversationId),
    columns: { userId: true },
  });

  const userIds = memberRows.map((m) => m.userId);
  if (userIds.length === 0) return [];

  const activeDevices = await db.query.devices.findMany({
    where: and(inArray(devices.userId, userIds), isNull(devices.revokedAt)),
    columns: { id: true, userId: true, identityPublicKey: true },
  });

  if (activeDevices.length === 0) return [];

  const joined = await db.query.mlsGroupMembers.findMany({
    where: and(
      eq(mlsGroupMembers.mlsGroupId, mlsGroupId),
      isNull(mlsGroupMembers.removedAtEpoch),
      inArray(
        mlsGroupMembers.deviceId,
        activeDevices.map((d) => d.id),
      ),
    ),
    columns: { deviceId: true },
  });

  const joinedIds = new Set(joined.map((m) => m.deviceId));

  return activeDevices
    .filter((d) => !joinedIds.has(d.id))
    .map((d) => ({ deviceId: d.id, userId: d.userId, identityPublicKey: d.identityPublicKey }));
}

export interface CommitInput {
  mlsGroupId: string;
  /** Epoch this commit produces. Must be exactly `currentEpoch + 1`. */
  epoch: number;
  committerDeviceId: string;
  commit: string;
  addedDevices: Array<{ deviceId: string; userId: string; welcome: string }>;
  removedDeviceIds: string[];
}

export type CommitResult =
  | { ok: true; epoch: number }
  | { ok: false; reason: 'epoch_conflict'; currentEpoch: number };

/**
 * Applies a commit and everything that follows from it in one transaction:
 * the commit row, removals closed at this epoch, added devices opened at this
 * epoch, their Welcome messages, and the group's new current epoch.
 *
 * The group row is locked for the duration, so a concurrent commit for the
 * same epoch waits and then loses the epoch check rather than both being
 * applied. The loser gets `epoch_conflict` with the epoch it should rebase on.
 */
export async function recordCommit(input: CommitInput): Promise<CommitResult> {
  return db.transaction(async (tx) => {
    const [group] = await tx
      .select({ id: mlsGroups.id, currentEpoch: mlsGroups.currentEpoch })
      .from(mlsGroups)
      .where(eq(mlsGroups.id, input.mlsGroupId))
      .limit(1)
      .for('update');

    if (!group) {
      return { ok: false as const, reason: 'epoch_conflict' as const, currentEpoch: 0 };
    }

    if (input.epoch !== group.currentEpoch + 1) {
      return {
        ok: false as const,
        reason: 'epoch_conflict' as const,
        currentEpoch: group.currentEpoch,
      };
    }

    await tx.insert(mlsCommits).values({
      mlsGroupId: input.mlsGroupId,
      epoch: input.epoch,
      committerDeviceId: input.committerDeviceId,
      commit: input.commit,
    });

    // Removals close the outgoing device's window at this epoch: it can still
    // read everything up to `epoch - 1` and nothing from `epoch` on, which is
    // exactly what the post-commit rekey gives it.
    if (input.removedDeviceIds.length > 0) {
      await tx
        .update(mlsGroupMembers)
        .set({ removedAtEpoch: input.epoch })
        .where(
          and(
            eq(mlsGroupMembers.mlsGroupId, input.mlsGroupId),
            isNull(mlsGroupMembers.removedAtEpoch),
            inArray(mlsGroupMembers.deviceId, input.removedDeviceIds),
          ),
        );
    }

    if (input.addedDevices.length > 0) {
      await tx.insert(mlsGroupMembers).values(
        input.addedDevices.map((d) => ({
          mlsGroupId: input.mlsGroupId,
          deviceId: d.deviceId,
          userId: d.userId,
          joinedAtEpoch: input.epoch,
        })),
      );

      await tx.insert(mlsWelcomes).values(
        input.addedDevices.map((d) => ({
          mlsGroupId: input.mlsGroupId,
          deviceId: d.deviceId,
          epoch: input.epoch,
          welcome: d.welcome,
        })),
      );
    }

    await tx
      .update(mlsGroups)
      .set({ currentEpoch: input.epoch, updatedAt: new Date() })
      .where(eq(mlsGroups.id, input.mlsGroupId));

    return { ok: true as const, epoch: input.epoch };
  });
}

/**
 * Commits after `sinceEpoch`, oldest first — the replay a device uses to catch
 * its local group state back up after being offline.
 */
export async function listCommitsSince(
  mlsGroupId: string,
  sinceEpoch: number,
  limit: number,
): Promise<Array<{ epoch: number; commit: string; createdAt: Date }>> {
  return db
    .select({
      epoch: mlsCommits.epoch,
      commit: mlsCommits.commit,
      createdAt: mlsCommits.createdAt,
    })
    .from(mlsCommits)
    .where(and(eq(mlsCommits.mlsGroupId, mlsGroupId), gt(mlsCommits.epoch, sinceEpoch)))
    .orderBy(asc(mlsCommits.epoch))
    .limit(Math.min(limit, MLS_COMMIT_PAGE_SIZE));
}

/**
 * Claims the device's pending Welcome, marking it consumed.
 *
 * Claiming is idempotent within a transaction but not repeatable across calls:
 * once claimed, the device is expected to have imported the group state. If it
 * fails to, it recovers by being re-added rather than by re-reading a Welcome
 * whose epoch may already be stale.
 */
export async function claimWelcome(
  mlsGroupId: string,
  deviceId: string,
): Promise<{ epoch: number; welcome: string } | null> {
  return db.transaction(async (tx) => {
    const [pending] = await tx
      .select({
        id: mlsWelcomes.id,
        epoch: mlsWelcomes.epoch,
        welcome: mlsWelcomes.welcome,
      })
      .from(mlsWelcomes)
      .where(
        and(
          eq(mlsWelcomes.mlsGroupId, mlsGroupId),
          eq(mlsWelcomes.deviceId, deviceId),
          isNull(mlsWelcomes.claimedAt),
        ),
      )
      // Newest first: if several Welcomes queued up while the device was
      // offline, the latest epoch is the only one still usable.
      .orderBy(desc(mlsWelcomes.epoch))
      .limit(1)
      .for('update', { skipLocked: true });

    if (!pending) return null;

    await tx
      .update(mlsWelcomes)
      .set({ claimedAt: new Date() })
      .where(eq(mlsWelcomes.id, pending.id));

    return { epoch: pending.epoch, welcome: pending.welcome };
  });
}

/** Epoch of the device's unclaimed Welcome, if one is waiting. */
export async function pendingWelcomeEpoch(
  mlsGroupId: string,
  deviceId: string,
): Promise<number | null> {
  const row = await db.query.mlsWelcomes.findFirst({
    where: and(
      eq(mlsWelcomes.mlsGroupId, mlsGroupId),
      eq(mlsWelcomes.deviceId, deviceId),
      isNull(mlsWelcomes.claimedAt),
    ),
    orderBy: [desc(mlsWelcomes.epoch)],
    columns: { epoch: true },
  });

  return row?.epoch ?? null;
}
