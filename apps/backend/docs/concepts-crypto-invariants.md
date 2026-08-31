# Server-side crypto invariants

This note documents the guards that keep the backend from ever accepting or storing material it must not hold: [src/lib/ciphertextInvariant.ts](../src/lib/ciphertextInvariant.ts), [src/lib/signalInvariants.ts](../src/lib/signalInvariants.ts), the `.strict()` Zod schemas that enforce the same rule on the REST surface, and the [Security CI](../../../.github/workflows/security-ci.yml) job that regression-tests all of it.

## 1. The invariants

The backend is a relay and a durable queue for material it cannot read. Two rules follow from that, and both are enforced in code rather than left as a convention:

1. **The server stores ciphertext only.** Message bodies are persisted as opaque ciphertext plus per-device envelopes. There is no column, schema field, or code path that accepts a plaintext message body.
2. **The server never accepts session state, ratchet state, or private keys on any inbound payload.** Double-Ratchet session state, root/chain/sender keys, and private key halves are client-local. Every client derives its own session state; the only key material that crosses the wire is _public_ — identity keys, prekeys, signed prekeys, and MLS key packages.

The second rule is deliberately stronger than "we don't read it". Accepting a private key and ignoring it would still put it in a request log, an error report, or a crash dump. The guards reject the request outright so the value never reaches anything that persists.

Related reading: [E2EE onboarding](e2ee-onboarding.md), [Signal migration](signal-migration.md), [Security hardening](security-hardening.md), and the repository [threat model](../../../docs/threat-model.md).

## 2. `lib/signalInvariants.ts`

### `FORBIDDEN_SESSION_STATE_FIELDS`

The rejected field names are:

| Field                  | Why it is forbidden                                      |
| ---------------------- | -------------------------------------------------------- |
| `sessionState`         | Serialized Signal session — client-local, never uploaded |
| `ratchetState`         | Double-Ratchet state, including message-key chains       |
| `rootKey`              | Ratchet root key                                         |
| `chainKey`             | Sending or receiving chain key                           |
| `senderKey`            | Group sender key                                         |
| `privateKey`           | Any private key half                                     |
| `identityPrivateKey`   | Long-term identity private key                           |
| `signedPreKeyPrivate`  | Private half of a signed prekey                          |
| `oneTimePreKeyPrivate` | Private half of a one-time prekey                        |

The list is exported as a `const` tuple and `ForbiddenSessionStateField` is its union type, so adding a name to the list is the only change needed to extend the guard.

### `findForbiddenSessionStateField(payload)`

Returns the name of the first forbidden field found, or `null` when the payload is clean. It checks two levels:

- the top level of `payload`, and
- every entry of `payload.envelopes` when that is an array, because the per-device envelope array is the other place a client could attach key material.

Two details matter:

- It uses `Object.prototype.hasOwnProperty` rather than `in` or a truthiness check. Only own-enumerable keys are user-controlled input, and a field that is present but set to `null` or `""` is still a rejection — the presence of the key is the signal, not its value.
- It returns the field _name_, which the caller echoes back in the error so a client bug stays diagnosable without the server ever logging the value.

### Where it runs, and when

The guard is the enforcement point for the WebSocket paths, which parse the raw socket payload by hand rather than through Zod. It runs as the **first statement** of both handlers in [src/socket/messaging.ts](../src/socket/messaging.ts):

- `send_message` — [messaging.ts:117](../src/socket/messaging.ts#L117)
- `edit_message` — [messaging.ts:321](../src/socket/messaging.ts#L321)

```ts
dispatcher.register('send_message', async (payload) => {
  const forbiddenField = findForbiddenSessionStateField(payload);
  if (forbiddenField) {
    socket.emit('error', {
      event: 'send_message',
      code: 400,
      message: `Field "${forbiddenField}" is not permitted: the server never stores session or private-key state`,
    });
    return;
  }
  // ... destructure payload, check membership, write to the database
});
```

**Rejection happens before any database lookup.** The handler returns before it destructures the payload, before the conversation-membership check, and before any `db.query` call. This ordering is intentional and is asserted by [signalInvariants.socket.test.ts](../src/__tests__/signalInvariants.socket.test.ts). It matters for three reasons:

- A forbidden payload never touches the database, so a rejected request cannot be used as an oracle for whether a conversation or a message id exists.
- Rejection cost is constant and independent of database state.
- Nothing partially validated is written, so there is no window in which a forbidden field is held inside a transaction.

The client sees a `400` socket `error` event naming the offending field. There is no partial-accept mode: the message is not stored, not fanned out, and not acknowledged.

## 3. `lib/ciphertextInvariant.ts`

A second, broader list covering _stored or uploaded_ payloads — `FORBIDDEN_PERSISTED_OR_UPLOADED_FIELDS`. It extends the session-state list with plaintext body names (`content`, `body`, `plaintext`), MLS secrets (`mlsSecret`, `mlsSecrets`), and message keys (`messageKey`, `messageKeys`), and it carries both camelCase and snake_case spellings.

Field names are compared after normalization — `field.replace(/[-_]/g, '').toLowerCase()` — so `ratchet_state`, `ratchetState`, `Ratchet-State`, and `RATCHETSTATE` all match the same entry. The explicit snake_case entries in the exported list keep the list itself readable; normalization is what makes the check spelling-insensitive.

Two functions:

- `findForbiddenCiphertextFields(payload): string[]` — returns every offending key on a plain object. Non-objects, `null`, and arrays return `[]`.
- `assertCiphertextOnlyPayload(payload): void` — throws when that list is non-empty, with the offending field names (not values) in the message.

Covered by [ciphertextInvariant.test.ts](../src/__tests__/ciphertextInvariant.test.ts).

## 4. Why the Zod schemas are `.strict()`

REST endpoints do not call the guard functions directly. They get the same protection from Zod, but **only because the schemas are `.strict()`** — and this is the single most important detail in this document.

Zod's default object mode **strips** unknown keys. A non-strict schema handed a payload carrying `ratchetState` would parse successfully, silently drop the field, and return a clean object. The request would be accepted, the client would receive `200`, and nobody would learn that a client had just tried to upload ratchet state. A regression that reintroduced a plaintext or key-bearing field would be invisible, because the schema would quietly absorb it forever.

`.strict()` inverts that: an unrecognized key is a validation failure, and the request is rejected with `400` before the handler runs. Silent stripping hides a client bug; strict rejection surfaces it.

The strict schemas that gate crypto-relevant input:

| Schema                    | File                                                            | Gates                                                           |
| ------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| `EnvelopeSchema`          | [schemas/message.schemas.ts](../src/schemas/message.schemas.ts) | Each per-device message envelope                                |
| `SendMessageSchema`       | [schemas/message.schemas.ts](../src/schemas/message.schemas.ts) | `POST /messages` body                                           |
| `VerifySchema`            | [schemas/auth.schemas.ts](../src/schemas/auth.schemas.ts)       | `POST /auth/verify` sign-in body                                |
| `DeviceLinkVerifySchema`  | [schemas/auth.schemas.ts](../src/schemas/auth.schemas.ts)       | `POST /devices/link/verify` — the only device-registration path |
| `PreKeyEntrySchema`       | [lib/keys.ts](../src/lib/keys.ts)                               | Uploaded one-time prekeys                                       |
| `SignedPreKeyEntrySchema` | [lib/keys.ts](../src/lib/keys.ts)                               | Uploaded signed prekeys                                         |

Note that `SendMessageSchema` has no plaintext field at all: the body carries `ciphertext` and `envelopes`, never a readable message. Content-type rules beyond the schema shape live in [lib/validateMessagePayload.ts](../src/lib/validateMessagePayload.ts), which rejects a text message that has no per-device envelopes.

**When adding a schema that accepts client input touching keys, messages, or devices, make it `.strict()`.** Building a composite with `.extend()` produces a new schema whose strictness must be re-declared, which is why `SignedPreKeyEntrySchema` and `DeviceLinkVerifySchema` both re-apply `.strict()` explicitly.

## 5. The Security CI regression job

[.github/workflows/security-ci.yml](../../../.github/workflows/security-ci.yml) runs on every pull request and on every push to `main`. It has two jobs.

### Job `regression` — "Ciphertext-only guard + secret-field scan"

Runs [src/\_\_tests\_\_/security.regression.test.ts](../src/__tests__/security.regression.test.ts) from `apps/backend` with `pnpm test -- security.regression.test.ts`. Two suites:

**Ciphertext-only guard.** Drives `validateMessagePayload` and asserts that a text message carrying a `plaintext` field is rejected, that ciphertext without per-device envelopes is rejected, that a message with envelopes is accepted, and that `SendMessageSchema.shape` contains neither `plaintext` nor `plainText`.

**Secret-field source scan.** Walks every `.ts` file under `apps/backend/src` (skipping `__tests__` and `node_modules`) and fails if any file _declares_ a field named `plaintext`, `plainText`, `privateKey`, `private_key`, `sessionState`, `session_state`, `signalSession`, `identityPrivateKey`, or `preKeyPrivate`. The match pattern is `(^|[^A-Za-z0-9_])<name>\s*[:?]\s*[^,]`, which catches Zod object keys and TypeScript interface or type members while leaving prose in comments alone.

This scan is what makes the invariant durable. The unit tests prove the guards work on the paths that call them; the scan fails the build the moment _any_ schema, route, type, or service anywhere in the backend grows a field that could carry a private key or a session blob — including on a path nobody remembered to guard.

Two supporting suites also live in the tree and run under the normal backend test job: [signalInvariants.messages.test.ts](../src/__tests__/signalInvariants.messages.test.ts) and [signalInvariants.devices.test.ts](../src/__tests__/signalInvariants.devices.test.ts) cover the REST message and device paths, and [signalInvariants.socket.test.ts](../src/__tests__/signalInvariants.socket.test.ts) covers the WebSocket handlers described above.

### Job `dependency-audit` — "Crypto dependency CVE audit"

Runs [scripts/audit-crypto-deps.mjs](../../../scripts/audit-crypto-deps.mjs), which scopes `pnpm audit` to the crypto-relevant backend dependencies (`ioredis`, `jsonwebtoken`, `web-push`, `@stellar/stellar-sdk`, `drizzle-orm`, `socket.io`) so CVEs in those surface without the job failing on advisories in unrelated transitive packages.

### Changing the invariants

If a change legitimately requires touching this surface:

1. Update `FORBIDDEN_SESSION_STATE_FIELDS` or `FORBIDDEN_PERSISTED_OR_UPLOADED_FIELDS` rather than adding an ad-hoc check at a call site.
2. Keep new client-input schemas `.strict()`.
3. Expect the source scan to fail loudly on a new forbidden field name. That failure is the feature working — treat it as a design question, not as a test to relax.
