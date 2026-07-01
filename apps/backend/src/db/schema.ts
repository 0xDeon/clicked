import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  pgEnum,
  index,
  integer,
  serial,
  uniqueIndex,
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

// ─── Files (#231) ─────────────────────────────────────────────────────────────
//
// Tracks S3 storage objects for file-type messages. Soft-deleted when all
// referencing messages are retracted; hard-deleted by the background cleanup job.

export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  storageKey: text('storage_key').notNull().unique(),
  deletedAt: timestamp('deleted_at'),
  hardDeletedAt: timestamp('hard_deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;

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

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  senderDeviceId: uuid('sender_device_id').references(() => userDevices.id, {
    onDelete: 'set null',
  }),
  contentType: text('content_type').notNull().default('text/plain'),
  sequenceNumber: serial('sequence_number'),
  ciphertext: text('ciphertext'),
  fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
  // Edits are stored as a brand-new message linked back to the message they
  // replace (#190). Plaintext/ciphertext is never mutated in place; clients
  // resolve a thread to the newest version sharing the same original id.
  // Self-referential FK — `set null` so deleting an original doesn't cascade
  // away its edits.
  editsMessageId: uuid('edits_message_id').references((): AnyPgColumn => messages.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
});

export const messageEnvelopes = pgTable(
  'message_envelopes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    recipientDeviceId: uuid('recipient_device_id')
      .notNull()
      .references(() => userDevices.id, { onDelete: 'cascade' }),
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

// ─── Devices & prekeys (issues #158, #159, #162, #305, #302) ─────────────────
//
// Each user may register multiple devices. Each device has an Ed25519 identity
// key pair; the public key is stored here for fingerprint derivation and prekey
// signature validation.  `isRevoked` lets the server reject stale devices
// without deleting the row (preserving audit history).

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
    isRevoked: boolean('is_revoked').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('devices_user_identity_idx').on(table.userId, table.identityPublicKey)],
);

// One signed prekey per device (upserted on upload).
export const signedPreKeys = pgTable(
  'signed_pre_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    // Application-assigned integer key-id (unique per device).
    keyId: integer('key_id').notNull(),
    // Base64-encoded public key.
    publicKey: text('public_key').notNull(),
    // Base64-encoded Ed25519 signature over publicKey, signed by identityPublicKey.
    signature: text('signature').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  // Only one signed prekey per device at a time — upsert on this unique constraint.
  (table) => [uniqueIndex('spk_device_idx').on(table.deviceId)],
);

// One-time prekeys — each consumed at most once.
export const oneTimePreKeys = pgTable(
  'one_time_pre_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    keyId: integer('key_id').notNull(),
    publicKey: text('public_key').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('otp_device_keyid_idx').on(table.deviceId, table.keyId)],
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

// ─── User devices (#153) ──────────────────────────────────────────────────────
//
// Device identity registry for end-to-end encryption. Each row is one device a
// user has registered, holding its long-term identity public key. A device is
// never hard-deleted — revoking sets `revokedAt` so historical sessions stay
// auditable. `(userId, deviceId)` is unique so a client re-registering the same
// device upserts instead of duplicating, and the partial index keeps lookups of
// a user's *active* devices fast.

export const userDevices = pgTable(
  'user_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    deviceName: text('device_name').notNull(),
    platform: devicePlatformEnum('platform').notNull(),
    identityPublicKey: text('identity_public_key').notNull(),
    registrationId: integer('registration_id'),
    lastSeenAt: timestamp('last_seen_at'),
    revokedAt: timestamp('revoked_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('user_devices_user_id_device_id_unique').on(table.userId, table.deviceId),
    index('user_devices_user_id_active_idx')
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

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

export const treasuryProposals = pgTable('treasury_proposals', {
  id: serial('id').primaryKey(),
  onChainId: integer('on_chain_id').notNull(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  proposerId: uuid('proposer_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  toAddress: text('to_address').notNull(),
  tokenContract: text('token_contract').notNull(),
  amount: text('amount').notNull(),
  status: treasuryProposalStatusEnum('status').notNull().default('active'),
  approvalsCount: integer('approvals_count').notNull().default(0),
  rejectionsCount: integer('rejections_count').notNull().default(0),
  threshold: integer('threshold').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type TreasuryProposal = typeof treasuryProposals.$inferSelect;
export type NewTreasuryProposal = typeof treasuryProposals.$inferInsert;

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id')
    .notNull()
    .references(() => userDevices.id, { onDelete: 'cascade' }),
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
}));

export const walletsRelations = relations(wallets, ({ one }) => ({
  user: one(users, { fields: [wallets.userId], references: [users.id] }),
}));

export const conversationsRelations = relations(conversations, ({ many }) => ({
  members: many(conversationMembers),
  messages: many(messages),
  transfers: many(tokenTransfers),
  treasuryProposals: many(treasuryProposals),
}));

export const conversationMembersRelations = relations(conversationMembers, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationMembers.conversationId],
    references: [conversations.id],
  }),
  user: one(users, { fields: [conversationMembers.userId], references: [users.id] }),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
  senderDevice: one(userDevices, {
    fields: [messages.senderDeviceId],
    references: [userDevices.id],
  }),
  file: one(files, { fields: [messages.fileId], references: [files.id] }),
  envelopes: many(messageEnvelopes),
  // The original message this one edits (null for originals). Paired with
  // `edits` below via a shared relation name so Drizzle can disambiguate the
  // self-join (#190).
  editsMessage: one(messages, {
    fields: [messages.editsMessageId],
    references: [messages.id],
    relationName: 'message_edits',
  }),
  edits: many(messages, { relationName: 'message_edits' }),
}));

export const filesRelations = relations(files, ({ many }) => ({
  messages: many(messages),
}));

export const messageEnvelopesRelations = relations(messageEnvelopes, ({ one }) => ({
  message: one(messages, { fields: [messageEnvelopes.messageId], references: [messages.id] }),
  recipientDevice: one(userDevices, {
    fields: [messageEnvelopes.recipientDeviceId],
    references: [userDevices.id],
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
  signedPreKey: many(signedPreKeys),
  oneTimePreKeys: many(oneTimePreKeys),
}));

export const signedPreKeysRelations = relations(signedPreKeys, ({ one }) => ({
  device: one(devices, { fields: [signedPreKeys.deviceId], references: [devices.id] }),
}));

export const oneTimePreKeysRelations = relations(oneTimePreKeys, ({ one }) => ({
  device: one(devices, { fields: [oneTimePreKeys.deviceId], references: [devices.id] }),
}));

export const userDevicesRelations = relations(userDevices, ({ one, many }) => ({
  user: one(users, { fields: [userDevices.userId], references: [users.id] }),
  messages: many(messages),
  pushSubscriptions: many(pushSubscriptions),
}));

export const pushSubscriptionsRelations = relations(pushSubscriptions, ({ one }) => ({
  device: one(userDevices, { fields: [pushSubscriptions.deviceId], references: [userDevices.id] }),
}));

export const treasuryProposalsRelations = relations(treasuryProposals, ({ one }) => ({
  conversation: one(conversations, {
    fields: [treasuryProposals.conversationId],
    references: [conversations.id],
  }),
  proposer: one(users, {
    fields: [treasuryProposals.proposerId],
    references: [users.id],
  }),
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
export type MessageEnvelope = typeof messageEnvelopes.$inferSelect;
export type NewMessageEnvelope = typeof messageEnvelopes.$inferInsert;
export type TokenTransfer = typeof tokenTransfers.$inferSelect;
export type NewTokenTransfer = typeof tokenTransfers.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type SignedPreKey = typeof signedPreKeys.$inferSelect;
export type NewSignedPreKey = typeof signedPreKeys.$inferInsert;
export type OneTimePreKey = typeof oneTimePreKeys.$inferSelect;
export type NewOneTimePreKey = typeof oneTimePreKeys.$inferInsert;
export type UserDevice = typeof userDevices.$inferSelect;
export type NewUserDevice = typeof userDevices.$inferInsert;
