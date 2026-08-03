import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  pgEnum,
  index,
  integer,
  bigint,
  jsonb,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { DEFAULT_CAPABILITIES, type DeviceCapabilities } from '../lib/capabilities.js';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').unique(),
  avatarUrl: text('avatar_url'),
  presenceVisible: boolean('presence_visible').notNull().default(false),
  lastSeenVisible: boolean('last_seen_visible').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  // Privacy setting: whether the user allows sending read receipts to others
  sendReadReceipts: boolean('send_read_receipts').notNull().default(false),
  allowDirectMessages: boolean('allow_direct_messages').notNull().default(true),
  allowGroupInvites: boolean('allow_group_invites').notNull().default(false),
});

export const wallets = pgTable('wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  address: text('address').notNull().unique(),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ─── Conversations ────────────────────────────────────────────────────────────

export const conversationTypeEnum = pgEnum('conversation_type', ['dm', 'group']);

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: conversationTypeEnum('type').notNull().default('dm'),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  // Group epoch (#369). Incremented by every group-control event; the row is
  // also the serialization point for sequencing those events, so a concurrent
  // join and leave can never be assigned the same sequence number.
  epoch: integer('epoch').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const contentTypeEnum = pgEnum('content_type', [
  'text',
  'file',
  'image',
  'video',
  'audio',
  'system',
]);

export const conversationMembers = pgTable('conversation_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  lastReadMessageId: uuid('last_read_message_id').references(() => messages.id, {
    onDelete: 'set null',
  }),
  isMuted: boolean('is_muted').notNull().default(false),
  isArchived: boolean('is_archived').notNull().default(false),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
});

// ─── Uploaded files (#228, #231) ─────────────────────────────────────────────
//
// Tracks files that clients have uploaded to object storage. A file moves
// through: pending → ready (server-confirmed the bytes arrived) → deleted.
// Only `ready` files may be referenced in file messages. The `fileKey`
// (symmetric encryption key) lives exclusively inside the E2EE envelope
// ciphertext — it is NEVER stored here.
//
// `deletedAt`/`hardDeletedAt` support the background cleanup job: soft-deleted
// when all referencing messages are retracted, hard-deleted from storage once
// no live references remain.

export const fileStatusEnum = pgEnum('file_status', ['pending', 'ready', 'deleted']);

export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  uploaderId: uuid('uploader_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  status: fileStatusEnum('status').notNull().default('pending'),
  size: integer('size').notNull(),
  mimeType: text('mime_type').notNull(),
  sha256: text('sha256').notNull(),
  storageKey: text('storage_key').notNull().unique(),
  isThumbnail: boolean('is_thumbnail').notNull().default(false),
  deletedAt: timestamp('deleted_at'),
  hardDeletedAt: timestamp('hard_deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Ordering is by (createdAt, id) — a monotonic per-conversation sequence
// counter was considered (and briefly implemented) but dropped: the same
// counter can't also serve as a coherent cross-conversation cursor for
// offline sync (#137), and maintaining two separate counters for two
// separate orderings was judged not worth the complexity. `id` (uuid) is
// only a tiebreaker for same-millisecond inserts, not a chronological signal.
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    senderDeviceId: uuid('sender_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    contentType: text('content_type').notNull().default('text'),
    ciphertext: text('ciphertext'),
    // Structured, server-generated metadata for `content_type = 'system'` rows
    // (device add/revoke, membership changes). Kept separate from `ciphertext`
    // so genuine E2EE ciphertext — opaque, per-device-encrypted — is never
    // conflated with plaintext system metadata. Null for every non-system row;
    // enforced by `messages_system_payload_check` below.
    systemPayload: jsonb('system_payload').$type<{ userId: string; change: string } | null>(),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    editsMessageId: uuid('edits_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
    // MLS epoch whose secrets encrypted `ciphertext` (#372). Null for messages
    // that are not MLS group messages — DMs, system events, and anything sent
    // before the conversation adopted MLS. Devices that joined the group after
    // this epoch cannot derive the key, so the read paths surface those
    // messages as unavailable instead of handing back undecryptable bytes.
    mlsEpoch: bigint('mls_epoch', { mode: 'number' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('messages_conversation_created_idx').on(table.conversationId, table.createdAt),
    // System messages carry structured metadata, never ciphertext; everything
    // else carries ciphertext (or an envelope), never a system payload.
    // Supersedes the looser `messages_system_payload_only_on_system_type`
    // constraint (#398), which only forbade a payload on non-system rows —
    // it didn't require a system row to actually have one, or forbid a
    // system row from also carrying ciphertext.
    check(
      'messages_system_payload_check',
      sql`${table.contentType} <> 'system' OR (${table.ciphertext} IS NULL AND ${table.systemPayload} IS NOT NULL)`,
    ),
  ],
);

// Which E2EE construction produced an envelope's ciphertext (#364).
//
// `sealed_box` is the Phase-1 path: ECDH ephemeral key + HKDF + AES-256-GCM,
// one independent box per message. `signal` is the Double Ratchet.
//
// `devices.capabilities.protocols` says what a device *can* decrypt; this says
// what a given envelope actually *was* encrypted with. Both are needed: the
// capability set changes over time, so it cannot be used to interpret an
// envelope written months ago. Recording it per envelope is what lets
// pre-cutover history keep decrypting on the Phase-1 path indefinitely.
//
// Values mirror `KNOWN_PROTOCOLS` in lib/capabilities.ts so the two cannot
// drift. `mls` is included for that reason even though MLS group messages
// carry a single group ciphertext on `messages` rather than per-device
// envelopes — an envelope row for it should be representable, not a migration.
export const e2eeProtocolEnum = pgEnum('e2ee_protocol', ['sealed_box', 'signal', 'mls']);

export const messageEnvelopes = pgTable(
  'message_envelopes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    recipientDeviceId: uuid('recipient_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ciphertext: text('ciphertext').notNull(),
    // Defaults to sealed_box so every envelope written before this column
    // existed is labelled correctly by the migration's backfill.
    protocol: e2eeProtocolEnum('protocol').notNull().default('sealed_box'),
    deliveredAt: timestamp('delivered_at'),
    readAt: timestamp('read_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('me_recipient_device_created_idx').on(table.recipientDeviceId, table.createdAt),
    index('me_message_idx').on(table.messageId),
  ],
);

// ─── Devices & prekeys (issues #103, #104, #158, #159, #162) ─────────────────
//
// Each user may register multiple devices. Each device has an Ed25519 identity
// key pair; the public key is stored here for fingerprint derivation and prekey
// signature validation. This is the single canonical device registry — it also
// carries the fields the realtime/messaging/push layers need (`lastSeenAt`,
// `pushEnabled`), so `messages.senderDeviceId`, `messageEnvelopes.recipientDeviceId`,
// and `pushSubscriptions.deviceId` all FK here. `revokedAt` lets the server
// reject stale devices without deleting the row (preserving audit history) and
// records *when* revocation happened, unlike a plain boolean.

export const devicePlatformEnum = pgEnum('device_platform', ['web', 'ios', 'android']);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Base64-encoded Ed25519 public key for this device.
    identityPublicKey: text('identity_public_key').notNull(),
    // X3DH/Signal registration id published in the prekey bundle (#305).
    registrationId: integer('registration_id'),
    deviceName: text('device_name'),
    platform: devicePlatformEnum('platform'),
    lastSeenAt: timestamp('last_seen_at'),
    pushEnabled: boolean('push_enabled').notNull().default(true),
    revokedAt: timestamp('revoked_at'),
    // Set by the device-GC job once a revoked device has aged past
    // DEVICE_STALE_AFTER_DAYS. Purely informational — flags the row for
    // admin visibility/future hard-delete without destroying audit history.
    staleFlaggedAt: timestamp('stale_flagged_at'),
    // Supported protocols/ciphersuites/file-transfer versions this device
    // advertises (lib/capabilities.ts). Defaults to the sealed_box-only
    // baseline so rows written before this column existed, or clients that
    // never send it, negotiate correctly rather than erroring — see
    // lib/capabilities.ts `normalizeCapabilities`.
    capabilities: jsonb('capabilities')
      .$type<DeviceCapabilities>()
      .notNull()
      .default(DEFAULT_CAPABILITIES),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('devices_user_identity_idx').on(table.userId, table.identityPublicKey),
    index('devices_user_id_active_idx')
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

// Signed + one-time prekeys in a single table, discriminated by `keyType`
// (#104). One active signed prekey per device (enforced by the partial unique
// index below, replaced on upload); one-time prekeys are consumed at most
// once — `consumed` flips to true atomically instead of deleting the row, so
// bundle-fetch history stays auditable.
export const prekeyTypeEnum = pgEnum('prekey_type', ['signed', 'one_time']);

export const devicePrekeys = pgTable(
  'device_prekeys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    keyType: prekeyTypeEnum('key_type').notNull(),
    // Application-assigned integer key-id (unique per device + type).
    keyId: integer('key_id').notNull(),
    // Base64-encoded public key.
    publicKey: text('public_key').notNull(),
    // Base64-encoded Ed25519 signature over publicKey, signed by identityPublicKey.
    // Required when keyType='signed' — enforced below by a DB check constraint.
    signature: text('signature'),
    consumed: boolean('consumed').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('device_prekeys_device_type_keyid_idx').on(
      table.deviceId,
      table.keyType,
      table.keyId,
    ),
    // Enforces "one active signed prekey per device" at the DB level; the
    // upload endpoint upserts against this as its ON CONFLICT target.
    uniqueIndex('device_prekeys_signed_device_idx')
      .on(table.deviceId)
      .where(sql`${table.keyType} = 'signed'`),
    // Fast bundle assembly: unconsumed one-time prekeys per device.
    index('device_prekeys_one_time_available_idx')
      .on(table.deviceId)
      .where(sql`${table.keyType} = 'one_time' AND ${table.consumed} = false`),
    check(
      'device_prekeys_signed_requires_signature',
      sql`${table.keyType} <> 'signed' OR ${table.signature} IS NOT NULL`,
    ),
  ],
);

// ─── MLS group state (#372) ──────────────────────────────────────────────────
//
// Group conversations run MLS (RFC 9420). The server is a transport and an
// ordering service — it never holds group secrets. What it does hold is the
// *public* ledger every member needs to agree on: which epoch the group is at,
// which devices are in the ratchet tree, the commit that produced each epoch,
// and the Welcome messages addressed to devices being added.
//
// Epochs are the unit of membership. A device added by the commit that
// produces epoch N can decrypt messages from epoch N onwards and nothing
// before it, because the group secrets for earlier epochs were derived before
// its leaf existed. That is a property of MLS, not a gap in this schema — see
// docs/mls-group-membership.md.

export const mlsGroups = pgTable(
  'mls_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // Base64 of the MLS group id chosen by the founding client.
    groupId: text('group_id').notNull(),
    cipherSuite: integer('cipher_suite').notNull(),
    // Epoch of the most recent accepted commit. Starts at 0 for a fresh group.
    currentEpoch: bigint('current_epoch', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    // One MLS group per conversation — the conversation *is* the group.
    uniqueIndex('mls_groups_conversation_idx').on(table.conversationId),
    uniqueIndex('mls_groups_group_id_idx').on(table.groupId),
  ],
);

// Device membership, recorded as an epoch interval rather than a boolean so a
// device's decryption window is derivable: it can read epochs in
// [joinedAtEpoch, removedAtEpoch). A device that is removed and later re-added
// gets a second row with a later joinedAtEpoch, which is exactly right — it
// still cannot read the epochs it was absent for.
export const mlsGroupMembers = pgTable(
  'mls_group_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mlsGroupId: uuid('mls_group_id')
      .notNull()
      .references(() => mlsGroups.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAtEpoch: bigint('joined_at_epoch', { mode: 'number' }).notNull(),
    // Null while the device is still in the group.
    removedAtEpoch: bigint('removed_at_epoch', { mode: 'number' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    // A device can hold at most one *active* leaf in a group at a time.
    uniqueIndex('mls_group_members_active_idx')
      .on(table.mlsGroupId, table.deviceId)
      .where(sql`${table.removedAtEpoch} IS NULL`),
    index('mls_group_members_device_idx').on(table.deviceId),
  ],
);

// Append-only commit log. A device that was offline replays from its last
// known epoch to catch back up, which is what makes group state recoverable
// without the server ever seeing plaintext.
export const mlsCommits = pgTable(
  'mls_commits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mlsGroupId: uuid('mls_group_id')
      .notNull()
      .references(() => mlsGroups.id, { onDelete: 'cascade' }),
    // Epoch this commit produces (i.e. the group's epoch after applying it).
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    committerDeviceId: uuid('committer_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    // Base64 of the TLS-serialised MLSMessage carrying the Commit.
    commit: text('commit').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  // Two members committing concurrently must not both win — the unique index
  // makes the epoch race resolve in the database.
  (table) => [uniqueIndex('mls_commits_group_epoch_idx').on(table.mlsGroupId, table.epoch)],
);

// Welcome messages addressed to a device being added. Held until the device
// comes online and claims it, which is what lets a newly-linked device join
// groups it was invited to while it was offline.
export const mlsWelcomes = pgTable(
  'mls_welcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mlsGroupId: uuid('mls_group_id')
      .notNull()
      .references(() => mlsGroups.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    // Epoch the recipient joins at — the epoch the accompanying commit produced.
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    // Base64 of the TLS-serialised MLSMessage carrying the Welcome.
    welcome: text('welcome').notNull(),
    claimedAt: timestamp('claimed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('mls_welcomes_group_device_epoch_idx').on(
      table.mlsGroupId,
      table.deviceId,
      table.epoch,
    ),
    index('mls_welcomes_pending_idx')
      .on(table.deviceId)
      .where(sql`${table.claimedAt} IS NULL`),
  ],
);
// ─── MLS key packages (#365) ─────────────────────────────────────────────────
//
// Every device publishes a stock of MLS KeyPackages so any group member can add
// it to a group without the device being online. A KeyPackage is *public* key
// material only — the matching HPKE init private key never leaves the device,
// so nothing secret is stored here.
//
// A KeyPackage is single-use by spec: reusing one across two Add proposals
// breaks forward secrecy for the joining device. `consumed` therefore flips to
// true inside the same transaction that hands the package out (never deleted,
// so audit history survives), mirroring how one-time prekeys are claimed in
// `device_prekeys`.
//
// `packageHash` is the SHA-256 of the base64 package. It exists because the
// package itself can be up to 4 KiB — too large for a btree unique index — but
// idempotent re-uploads still need a conflict target for dedupe.

export const mlsKeyPackages = pgTable(
  'mls_key_packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    // IANA MLS cipher suite id (e.g. 1 = MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519).
    // A device may publish packages for several suites; group adds must match.
    cipherSuite: integer('cipher_suite').notNull(),
    // Base64 of the TLS-serialised MLS KeyPackage. Public material only.
    keyPackage: text('key_package').notNull(),
    // SHA-256 (hex) of `keyPackage` — dedupe key, see note above.
    packageHash: text('package_hash').notNull(),
    expiresAt: timestamp('expires_at'),
    consumed: boolean('consumed').notNull().default(false),
    consumedAt: timestamp('consumed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('mls_key_packages_device_hash_idx').on(table.deviceId, table.packageHash),
    // Fast claim of the next available package for a device + suite.
    index('mls_key_packages_available_idx')
      .on(table.deviceId, table.cipherSuite, table.createdAt)
      .where(sql`${table.consumed} = false`),
  ],
);

// ─── Device key history (#379 — key-transparency) ────────────────────────────
//
// Append-only log of identity-key changes per device. Written whenever a
// device's `identityPublicKey` changes (rotation or re-registration). Clients
// use this log to detect silent key swaps and display safety-number warnings.
// Never deleted — immutability is the whole point.

export const deviceKeyHistory = pgTable(
  'device_key_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    previousKey: text('previous_key'),
    newKey: text('new_key').notNull(),
    changeReason: text('change_reason'),
    recordedAt: timestamp('recorded_at').notNull().defaultNow(),
  },
  (table) => [
    index('device_key_history_device_idx').on(table.deviceId, table.recordedAt),
    index('device_key_history_user_idx').on(table.userId, table.recordedAt),
  ],
);

export type DeviceKeyHistory = typeof deviceKeyHistory.$inferSelect;
export type NewDeviceKeyHistory = typeof deviceKeyHistory.$inferInsert;

// ─── Token transfers (#46) ────────────────────────────────────────────────────
//
// One row per Soroban `transfer` event the listener (services/stellarListener.ts)
// pulls off the contract. The `txHash` is unique so reconnects + replayed event
// pages upsert cleanly instead of producing duplicates.

export const tokenTransfers = pgTable('token_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  recipientAddress: text('recipient_address').notNull(),
  amount: text('amount').notNull(),
  tokenContractId: text('token_contract_id').notNull(),
  txHash: text('tx_hash').notNull().unique(),
  memo: text('memo'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ─── Treasury Proposals (#130) ────────────────────────────────────────────────
//
// Synced from GROUP_TREASURY_CONTRACT_ID events by the Stellar listener.
// Idempotent upsert on (contractId, proposalId).

export const treasuryProposalStatusEnum = pgEnum('treasury_proposal_status', [
  'active',
  'approved',
  'rejected',
  'executed',
  'expired',
]);

export const proposalVoteTypeEnum = pgEnum('proposal_vote_type', ['approve', 'reject']);

export const treasuryProposals = pgTable(
  'treasury_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contractId: text('contract_id').notNull(),
    proposalId: text('proposal_id').notNull(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    status: treasuryProposalStatusEnum('status').notNull().default('active'),
    approvalsCount: integer('approvals_count').notNull().default(0),
    rejectionsCount: integer('rejections_count').notNull().default(0),
    recipient: text('recipient'),
    amount: text('amount'),
    token: text('token'),
    threshold: integer('threshold').notNull().default(3),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('treasury_proposals_contract_proposal_idx').on(table.contractId, table.proposalId),
  ],
);

export type TreasuryProposal = typeof treasuryProposals.$inferSelect;
export type NewTreasuryProposal = typeof treasuryProposals.$inferInsert;

export const proposalVotes = pgTable(
  'proposal_votes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    treasuryProposalId: uuid('treasury_proposal_id')
      .notNull()
      .references(() => treasuryProposals.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vote: proposalVoteTypeEnum('vote').notNull(),
    signature: text('signature'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('proposal_votes_proposal_user_unique').on(table.treasuryProposalId, table.userId),
  ],
);

export type ProposalVote = typeof proposalVotes.$inferSelect;
export type NewProposalVote = typeof proposalVotes.$inferInsert;
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id')
    .notNull()
    .references(() => devices.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  lastUsedAt: timestamp('last_used_at'),
  disabledAt: timestamp('disabled_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;

// ─── Audit log (#376) ─────────────────────────────────────────────────────────
//
// Append-only record of security-relevant events, for incident response.
// Nothing here may contain message content: an audit trail that leaks
// plaintext would undo the end-to-end encryption it exists to protect. Rows
// carry identifiers, counts and outcomes only — `services/auditLog.ts`
// strips anything content-shaped before it reaches the database.
//
// Append-only is enforced in the database itself (see the migration's
// `audit_logs_no_mutation` trigger), not just by convention, because the
// value of the log to an incident responder depends on it not being editable
// by the same application account an attacker would already have reached.
//
// `actorUserId` is who did it; `subjectUserId` is whose account it happened
// to. They differ for exactly the events that matter most — someone else's
// device fetching your key bundle, a failed sign-in against your wallet — and
// the account-scoped query indexes on the subject so a user's own history
// includes what was done *to* them, not just by them.

export const auditActionEnum = pgEnum('audit_action', [
  'device_linked',
  'device_revoked',
  'logout_everywhere',
  'key_bundle_drained',
  'auth_failed',
  'file_access_denied',
  'group_member_added',
  'group_member_removed',
]);

export type AuditAction = (typeof auditActionEnum.enumValues)[number];

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: auditActionEnum('action').notNull(),
    // Deliberately *not* foreign keys. An audit row must record what was true
    // when it was written and stay that way: a cascade would delete history
    // along with the account it incriminates, and ON DELETE SET NULL would
    // issue an UPDATE that the append-only trigger correctly refuses. Ids are
    // stored plain, and a responder resolves them (or finds them gone) at
    // read time. Nullable because a failed sign-in has no established actor.
    actorUserId: uuid('actor_user_id'),
    actorDeviceId: uuid('actor_device_id'),
    subjectUserId: uuid('subject_user_id'),
    /** Kind of thing acted on: 'device', 'file', 'conversation', 'wallet'. */
    targetType: text('target_type'),
    targetId: text('target_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** Sanitised, bounded key/value context. Never message content. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    // Account-scoped queries are the primary read path.
    index('audit_logs_subject_created_idx').on(table.subjectUserId, table.createdAt),
    index('audit_logs_actor_created_idx').on(table.actorUserId, table.createdAt),
    // "Show me every failed auth in the last hour" during an incident.
    index('audit_logs_action_created_idx').on(table.action, table.createdAt),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

// ─── Relations ────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  wallets: many(wallets),
  memberships: many(conversationMembers),
  messages: many(messages),
  transfers: many(tokenTransfers),
  devices: many(devices),
  proposalVotes: many(proposalVotes),
}));

export const walletsRelations = relations(wallets, ({ one }) => ({
  user: one(users, { fields: [wallets.userId], references: [users.id] }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  members: many(conversationMembers),
  messages: many(messages),
  transfers: many(tokenTransfers),
  treasuryProposals: many(treasuryProposals),
  files: many(files),
  mlsGroup: one(mlsGroups),
}));

export const mlsGroupsRelations = relations(mlsGroups, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [mlsGroups.conversationId],
    references: [conversations.id],
  }),
  members: many(mlsGroupMembers),
  commits: many(mlsCommits),
  welcomes: many(mlsWelcomes),
}));

export const mlsGroupMembersRelations = relations(mlsGroupMembers, ({ one }) => ({
  group: one(mlsGroups, { fields: [mlsGroupMembers.mlsGroupId], references: [mlsGroups.id] }),
  device: one(devices, { fields: [mlsGroupMembers.deviceId], references: [devices.id] }),
  user: one(users, { fields: [mlsGroupMembers.userId], references: [users.id] }),
}));

export const mlsCommitsRelations = relations(mlsCommits, ({ one }) => ({
  group: one(mlsGroups, { fields: [mlsCommits.mlsGroupId], references: [mlsGroups.id] }),
  committerDevice: one(devices, {
    fields: [mlsCommits.committerDeviceId],
    references: [devices.id],
  }),
}));

export const mlsWelcomesRelations = relations(mlsWelcomes, ({ one }) => ({
  group: one(mlsGroups, { fields: [mlsWelcomes.mlsGroupId], references: [mlsGroups.id] }),
  device: one(devices, { fields: [mlsWelcomes.deviceId], references: [devices.id] }),
  groupControlEvents: many(groupControlEvents),
}));

export const groupControlEventsRelations = relations(groupControlEvents, ({ one }) => ({
  conversation: one(conversations, {
    fields: [groupControlEvents.conversationId],
    references: [conversations.id],
  }),
  actor: one(users, { fields: [groupControlEvents.actorUserId], references: [users.id] }),
  target: one(users, { fields: [groupControlEvents.targetUserId], references: [users.id] }),
  message: one(messages, { fields: [groupControlEvents.messageId], references: [messages.id] }),
}));

export const filesRelations = relations(files, ({ one, many }) => ({
  uploader: one(users, { fields: [files.uploaderId], references: [users.id] }),
  conversation: one(conversations, {
    fields: [files.conversationId],
    references: [conversations.id],
  }),
  messages: many(messages),
}));

export const conversationMembersRelations = relations(conversationMembers, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationMembers.conversationId],
    references: [conversations.id],
  }),
  user: one(users, { fields: [conversationMembers.userId], references: [users.id] }),
  lastReadMessage: one(messages, {
    fields: [conversationMembers.lastReadMessageId],
    references: [messages.id],
  }),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
  senderDevice: one(devices, {
    fields: [messages.senderDeviceId],
    references: [devices.id],
  }),
  file: one(files, { fields: [messages.fileId], references: [files.id] }),
  envelopes: many(messageEnvelopes),
  editsMessage: one(messages, {
    fields: [messages.editsMessageId],
    references: [messages.id],
    relationName: 'message_edits',
  }),
  edits: many(messages, { relationName: 'message_edits' }),
}));

export const messageEnvelopesRelations = relations(messageEnvelopes, ({ one }) => ({
  message: one(messages, { fields: [messageEnvelopes.messageId], references: [messages.id] }),
  recipientDevice: one(devices, {
    fields: [messageEnvelopes.recipientDeviceId],
    references: [devices.id],
  }),
  recipientUser: one(users, { fields: [messageEnvelopes.recipientUserId], references: [users.id] }),
}));

export const tokenTransfersRelations = relations(tokenTransfers, ({ one }) => ({
  conversation: one(conversations, {
    fields: [tokenTransfers.conversationId],
    references: [conversations.id],
  }),
  sender: one(users, {
    fields: [tokenTransfers.senderId],
    references: [users.id],
  }),
}));

export const devicesRelations = relations(devices, ({ one, many }) => ({
  user: one(users, { fields: [devices.userId], references: [users.id] }),
  prekeys: many(devicePrekeys),
  mlsKeyPackages: many(mlsKeyPackages),
  messages: many(messages),
  pushSubscriptions: many(pushSubscriptions),
  keyHistory: many(deviceKeyHistory),
}));

export const deviceKeyHistoryRelations = relations(deviceKeyHistory, ({ one }) => ({
  device: one(devices, { fields: [deviceKeyHistory.deviceId], references: [devices.id] }),
  user: one(users, { fields: [deviceKeyHistory.userId], references: [users.id] }),
}));

export const devicePrekeysRelations = relations(devicePrekeys, ({ one }) => ({
  device: one(devices, { fields: [devicePrekeys.deviceId], references: [devices.id] }),
}));

export const mlsKeyPackagesRelations = relations(mlsKeyPackages, ({ one }) => ({
  device: one(devices, { fields: [mlsKeyPackages.deviceId], references: [devices.id] }),
}));

export const pushSubscriptionsRelations = relations(pushSubscriptions, ({ one }) => ({
  device: one(devices, { fields: [pushSubscriptions.deviceId], references: [devices.id] }),
}));

export const treasuryProposalsRelations = relations(treasuryProposals, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [treasuryProposals.conversationId],
    references: [conversations.id],
  }),
  votes: many(proposalVotes),
}));

export const proposalVotesRelations = relations(proposalVotes, ({ one }) => ({
  proposal: one(treasuryProposals, {
    fields: [proposalVotes.treasuryProposalId],
    references: [treasuryProposals.id],
  }),
  user: one(users, { fields: [proposalVotes.userId], references: [users.id] }),
}));

// ─── Types ────────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type ConversationMember = typeof conversationMembers.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
export type MessageEnvelope = typeof messageEnvelopes.$inferSelect;
export type NewMessageEnvelope = typeof messageEnvelopes.$inferInsert;
export type TokenTransfer = typeof tokenTransfers.$inferSelect;
export type NewTokenTransfer = typeof tokenTransfers.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type DevicePrekey = typeof devicePrekeys.$inferSelect;
export type NewDevicePrekey = typeof devicePrekeys.$inferInsert;
export type MlsGroup = typeof mlsGroups.$inferSelect;
export type NewMlsGroup = typeof mlsGroups.$inferInsert;
export type MlsGroupMember = typeof mlsGroupMembers.$inferSelect;
export type NewMlsGroupMember = typeof mlsGroupMembers.$inferInsert;
export type MlsCommit = typeof mlsCommits.$inferSelect;
export type NewMlsCommit = typeof mlsCommits.$inferInsert;
export type MlsWelcome = typeof mlsWelcomes.$inferSelect;
export type NewMlsWelcome = typeof mlsWelcomes.$inferInsert;
export type MlsKeyPackage = typeof mlsKeyPackages.$inferSelect;
export type NewMlsKeyPackage = typeof mlsKeyPackages.$inferInsert;
