import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  pgEnum,
  index,
  integer,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').unique(),
  avatarUrl: text('avatar_url'),
  presenceVisible: boolean('presence_visible').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  // Privacy setting: whether the user allows sending read receipts to others
  sendReadReceipts: boolean('send_read_receipts').notNull().default(true),
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
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    editsMessageId: uuid('edits_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [index('messages_conversation_created_idx').on(table.conversationId, table.createdAt)],
);

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

export const conversationsRelations = relations(conversations, ({ many }) => ({
  members: many(conversationMembers),
  messages: many(messages),
  transfers: many(tokenTransfers),
  treasuryProposals: many(treasuryProposals),
  files: many(files),
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
export type MlsKeyPackage = typeof mlsKeyPackages.$inferSelect;
export type NewMlsKeyPackage = typeof mlsKeyPackages.$inferInsert;
