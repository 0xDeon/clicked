# Security audit logging

An append-only record of security-relevant events, written for an incident
responder reconstructing a compromise after the fact: which device was linked,
when the account was locked down, who fetched whose key bundle, where the
failed sign-ins came from.

Implementation: `apps/backend/src/services/auditLog.ts`, `audit_logs` table,
migration `0001_audit_logs.sql`.

## Recorded events

| Action                 | Written when                                                     | Actor           | Subject           |
| ---------------------- | ---------------------------------------------------------------- | --------------- | ----------------- |
| `device_linked`        | `POST /devices` registers or re-activates a device               | linking user    | same              |
| `device_revoked`       | `DELETE /devices/:id`, and once per device in log-out-everywhere | revoking user   | same              |
| `logout_everywhere`    | `POST /devices/logout-everywhere`, including a zero-device run   | requesting user | same              |
| `key_bundle_drained`   | a one-time prekey is consumed by a bundle fetch                  | fetching user   | **device owner**  |
| `auth_failed`          | bad nonce, bad signature, or a revoked device presenting a token | none / device   | wallet or account |
| `file_access_denied`   | `GET /files/:fileId` by a non-member of the conversation         | requesting user | same              |
| `group_member_added`   | `POST /conversations/:id/members`                                | requester       | **added member**  |
| `group_member_removed` | `DELETE /conversations/:id/leave`                                | leaving user    | same              |

Every row carries the actor's user and device ids, the subject account, a
target type and id, the client IP, the user agent and a timestamp.

### Actor versus subject

`actorUserId` is who did it; `subjectUserId` is whose account it happened to.
They differ for exactly the events that matter most — someone else's device
draining your key bundle, a failed sign-in against your wallet, being added to
a group. The account-scoped query matches on **either**, so a user's history
includes what was done _to_ them, not only what they did.

### What is not recorded

Malformed or expired bearer tokens are not audited. Any internet scanner
produces them by the thousand, so recording them would hand an unauthenticated
caller a write amplification into the audit table. A token with a _valid
signature_ whose device has been revoked or deleted is a different matter — a
real credential being replayed after losing its authorisation — and that is
recorded.

## No message content, ever

An audit trail that leaks plaintext would undo the encryption it exists to
protect. `sanitizeMetadata` therefore runs on every write, not merely by
convention at the call sites:

- Keys matching `ciphertext`, `plaintext`, `content`, `message`, `body`,
  `text`, `envelope`, `payload`, `token`, `secret`, `password`, `signature`,
  `privateKey` or `prekey` are replaced with `[redacted]`. Matching is
  case-insensitive and ignores `_`/`-`, so `cipher_text` and `messageBody` are
  caught too.
- Strings are truncated at 256 characters, arrays at 20 entries, objects at 20
  keys, and nesting stops after one level — nested objects are where a whole
  request body would otherwise sneak in.
- Functions, symbols and `undefined` are dropped.

Metadata is meant for identifiers, counts and outcomes: `remainingActiveDevices`,
`oneTimePreKeysRemaining`, `reason: 'device_revoked'`, `conversationDeleted`.

## Append-only

Enforced by a database trigger, not convention:

```sql
CREATE TRIGGER audit_logs_no_mutation
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_reject_mutation();
```

The log is only worth having if the application account an attacker has already
reached cannot rewrite or erase it. For the same reason the actor and subject
columns carry **no foreign keys**: a cascade would delete the history along with
the account it incriminates, and `ON DELETE SET NULL` would issue an `UPDATE`
that the trigger correctly refuses. Ids are stored plain and resolved at read
time.

Retention pruning is consequently a deliberate, privileged operation: drop the
trigger, prune, recreate it. That is the intended friction.

## Recording never breaks the action

A failed audit write is logged to stderr and swallowed. Failing a device
revocation because the audit table is unavailable would make the security
control less reliable than the thing it observes. `recordAuditEvent` never
throws and never rejects, so call sites can `void` it safely.

## Querying

```
GET /audit-logs?action=<action>&cursor=<cursor>&limit=<n>
```

Scoped to the authenticated caller — there is no parameter for whose log to
read, so a stolen token cannot enumerate anyone else's security events. Returns
newest first, cursor-paginated on `(createdAt, id)` so the cursor is stable when
several events share a millisecond. Page size defaults to 50 and is clamped to 200. An unknown `action` filter is a 400 rather than a silently ignored
parameter.

Each event carries a `direction` of `performed` or `received`, so a client can
present "you did this" separately from "this was done to your account".
