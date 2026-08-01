/**
 * Tests for the MLS group state service (#372).
 *
 * The behaviour that matters here is transactional: a commit either applies
 * completely at the epoch it claims or not at all, and a Welcome is handed out
 * once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockTransaction = vi.fn();
const mockMlsGroupMemberFindFirst = vi.fn();
const mockMlsWelcomeFindFirst = vi.fn();
const mockMemberFindMany = vi.fn();
const mockDeviceFindMany = vi.fn();
const mockGroupMemberFindMany = vi.fn();
const mockSelect = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      mlsGroups: { findFirst: vi.fn() },
      mlsGroupMembers: {
        findFirst: mockMlsGroupMemberFindFirst,
        findMany: mockGroupMemberFindMany,
      },
      mlsWelcomes: { findFirst: mockMlsWelcomeFindFirst },
      conversationMembers: { findMany: mockMemberFindMany },
      devices: { findMany: mockDeviceFindMany },
    },
    transaction: mockTransaction,
    select: mockSelect,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: { conversationId: 'conversationId', userId: 'userId' },
  devices: { id: 'id', userId: 'userId', revokedAt: 'revokedAt' },
  mlsCommits: { id: 'id', mlsGroupId: 'mlsGroupId', epoch: 'epoch', commit: 'commit' },
  mlsGroupMembers: {
    id: 'id',
    mlsGroupId: 'mlsGroupId',
    deviceId: 'deviceId',
    joinedAtEpoch: 'joinedAtEpoch',
    removedAtEpoch: 'removedAtEpoch',
  },
  mlsGroups: { id: 'id', currentEpoch: 'currentEpoch' },
  mlsWelcomes: {
    id: 'id',
    mlsGroupId: 'mlsGroupId',
    deviceId: 'deviceId',
    epoch: 'epoch',
    welcome: 'welcome',
    claimedAt: 'claimedAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  asc: vi.fn((col: unknown) => col),
  desc: vi.fn((col: unknown) => col),
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  gt: vi.fn((col: unknown, val: unknown) => ({ op: 'gt', col, val })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ op: 'inArray', col, vals })),
  isNull: vi.fn((col: unknown) => ({ op: 'isNull', col })),
}));

const { claimWelcome, getEpochWindow, listDevicesAwaitingJoin, recordCommit } =
  await import('../services/mlsGroups.js');

const GROUP_ID = 'mls-group-1';
const DEVICE_A = 'device-a';
const DEVICE_B = 'device-b';

/** Transaction double for recordCommit. */
function setupCommitTx(currentEpoch: number | null) {
  const commitValues = vi.fn().mockResolvedValue(undefined);
  const memberValues = vi.fn().mockResolvedValue(undefined);
  const welcomeValues = vi.fn().mockResolvedValue(undefined);
  const removeWhere = vi.fn().mockResolvedValue(undefined);
  const groupWhere = vi.fn().mockResolvedValue(undefined);

  const inserts = [{ values: commitValues }, { values: memberValues }, { values: welcomeValues }];
  let insertCall = 0;

  const tx = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            for: vi
              .fn()
              .mockResolvedValue(currentEpoch === null ? [] : [{ id: GROUP_ID, currentEpoch }]),
          }),
        }),
      }),
    }),
    insert: vi.fn(() => inserts[insertCall++] ?? { values: vi.fn().mockResolvedValue(undefined) }),
    update: vi
      .fn()
      .mockReturnValueOnce({ set: vi.fn().mockReturnValue({ where: removeWhere }) })
      .mockReturnValue({ set: vi.fn().mockReturnValue({ where: groupWhere }) }),
  };

  mockTransaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));

  return { tx, commitValues, memberValues, welcomeValues, removeWhere, groupWhere };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordCommit', () => {
  const base = {
    mlsGroupId: GROUP_ID,
    committerDeviceId: DEVICE_A,
    commit: 'commit-blob',
    addedDevices: [],
    removedDeviceIds: [],
  };

  it('applies a commit that claims exactly currentEpoch + 1', async () => {
    const { commitValues } = setupCommitTx(4);

    const result = await recordCommit({ ...base, epoch: 5 });

    expect(result).toEqual({ ok: true, epoch: 5 });
    expect(commitValues).toHaveBeenCalledWith(
      expect.objectContaining({ mlsGroupId: GROUP_ID, epoch: 5, committerDeviceId: DEVICE_A }),
    );
  });

  it('rejects a commit that skips an epoch', async () => {
    const { commitValues } = setupCommitTx(4);

    const result = await recordCommit({ ...base, epoch: 7 });

    expect(result).toEqual({ ok: false, reason: 'epoch_conflict', currentEpoch: 4 });
    expect(commitValues).not.toHaveBeenCalled();
  });

  it('rejects a commit for an epoch that was already applied', async () => {
    // The losing side of a two-committer race: the group moved to 5 first.
    const { commitValues } = setupCommitTx(5);

    const result = await recordCommit({ ...base, epoch: 5 });

    expect(result).toEqual({ ok: false, reason: 'epoch_conflict', currentEpoch: 5 });
    expect(commitValues).not.toHaveBeenCalled();
  });

  it('opens the added device window at the commit epoch and queues its Welcome', async () => {
    const { memberValues, welcomeValues } = setupCommitTx(4);

    await recordCommit({
      ...base,
      epoch: 5,
      addedDevices: [{ deviceId: DEVICE_B, userId: 'user-b', welcome: 'welcome-blob' }],
    });

    expect(memberValues).toHaveBeenCalledWith([
      expect.objectContaining({ deviceId: DEVICE_B, userId: 'user-b', joinedAtEpoch: 5 }),
    ]);
    expect(welcomeValues).toHaveBeenCalledWith([
      expect.objectContaining({ deviceId: DEVICE_B, epoch: 5, welcome: 'welcome-blob' }),
    ]);
  });

  it('closes the removed device window at the commit epoch', async () => {
    const { tx, removeWhere } = setupCommitTx(4);

    await recordCommit({ ...base, epoch: 5, removedDeviceIds: [DEVICE_B] });

    expect(tx.update).toHaveBeenCalled();
    expect(removeWhere).toHaveBeenCalled();
    const setArg = tx.update.mock.results[0]!.value.set.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(setArg).toEqual({ removedAtEpoch: 5 });
  });

  it('does not touch membership when the commit changes no members', async () => {
    const { tx, memberValues } = setupCommitTx(4);

    await recordCommit({ ...base, epoch: 5 });

    expect(memberValues).not.toHaveBeenCalled();
    // Only the group's currentEpoch bump.
    expect(tx.update).toHaveBeenCalledTimes(1);
  });

  it('treats a missing group as a conflict rather than throwing', async () => {
    setupCommitTx(null);

    const result = await recordCommit({ ...base, epoch: 1 });

    expect(result).toEqual({ ok: false, reason: 'epoch_conflict', currentEpoch: 0 });
  });
});

describe('getEpochWindow', () => {
  it('returns the device epoch interval', async () => {
    mockMlsGroupMemberFindFirst.mockResolvedValue({ joinedAtEpoch: 3, removedAtEpoch: null });

    expect(await getEpochWindow(GROUP_ID, DEVICE_A)).toEqual({
      joinedAtEpoch: 3,
      removedAtEpoch: null,
    });
  });

  it('returns null for a device with no leaf in the group', async () => {
    mockMlsGroupMemberFindFirst.mockResolvedValue(undefined);

    expect(await getEpochWindow(GROUP_ID, DEVICE_A)).toBeNull();
  });
});

describe('listDevicesAwaitingJoin', () => {
  it('excludes devices that already hold a leaf', async () => {
    mockMemberFindMany.mockResolvedValue([{ userId: 'user-a' }]);
    mockDeviceFindMany.mockResolvedValue([
      { id: DEVICE_A, userId: 'user-a', identityPublicKey: 'idk-a' },
      { id: DEVICE_B, userId: 'user-a', identityPublicKey: 'idk-b' },
    ]);
    mockGroupMemberFindMany.mockResolvedValue([{ deviceId: DEVICE_A }]);

    const pending = await listDevicesAwaitingJoin('conv-1', GROUP_ID);

    expect(pending).toEqual([{ deviceId: DEVICE_B, userId: 'user-a', identityPublicKey: 'idk-b' }]);
  });

  it('returns an empty list when the conversation has no members', async () => {
    mockMemberFindMany.mockResolvedValue([]);

    expect(await listDevicesAwaitingJoin('conv-1', GROUP_ID)).toEqual([]);
    expect(mockDeviceFindMany).not.toHaveBeenCalled();
  });

  it('returns an empty list when every member device is already seated', async () => {
    mockMemberFindMany.mockResolvedValue([{ userId: 'user-a' }]);
    mockDeviceFindMany.mockResolvedValue([
      { id: DEVICE_A, userId: 'user-a', identityPublicKey: 'idk-a' },
    ]);
    mockGroupMemberFindMany.mockResolvedValue([{ deviceId: DEVICE_A }]);

    expect(await listDevicesAwaitingJoin('conv-1', GROUP_ID)).toEqual([]);
  });
});

describe('claimWelcome', () => {
  function setupWelcomeTx(pending: { id: string; epoch: number; welcome: string } | null) {
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                for: vi.fn().mockResolvedValue(pending ? [pending] : []),
              }),
            }),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: updateWhere }) }),
    };
    mockTransaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx));
    return { tx, updateWhere };
  }

  it('returns the Welcome and marks it claimed in the same transaction', async () => {
    const { updateWhere } = setupWelcomeTx({ id: 'w1', epoch: 5, welcome: 'welcome-blob' });

    const claimed = await claimWelcome(GROUP_ID, DEVICE_B);

    expect(claimed).toEqual({ epoch: 5, welcome: 'welcome-blob' });
    expect(updateWhere).toHaveBeenCalled();
  });

  it('returns null and leaves nothing to update when none is pending', async () => {
    const { tx } = setupWelcomeTx(null);

    expect(await claimWelcome(GROUP_ID, DEVICE_B)).toBeNull();
    expect(tx.update).not.toHaveBeenCalled();
  });
});
