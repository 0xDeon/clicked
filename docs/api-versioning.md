# API versioning & deprecation policy

The backend's REST routes and socket events are consumed by a web client that
ships on its own schedule. Once a user has a tab open, or a service worker
cached, the client talking to production is not necessarily the client that was
built alongside the running server. This document states where the API stands on
compatibility today, what counts as a breaking change, and the procedure for
retiring a field, route, or event.

---

## 1. Current position

**REST routes are unversioned.** There is no `/v1` prefix, no `Accept` header
negotiation, and no version query parameter. Every router in
[`apps/backend/src/app.ts`](../apps/backend/src/app.ts) mounts at a bare path:

```ts
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
app.use('/security', securityRouter);
```

**Socket events are unversioned too.** Events are addressed by bare name
(`send_message`, `new_message`, `read_receipt`, …) with no version field in the
payload and none in the handshake. The `dispatch` envelope carries `type`,
`payload`, and `eventId` — no schema version.

**There is no deprecation machinery.** The string `deprecat` does not appear
anywhere in `apps/backend/src`. No route sets a `Deprecation` or `Sunset` header,
no response carries a warning field, and no sunset dates are recorded anywhere.

**Breaking changes have already shipped without a policy.** Three that are
visible in the current tree and its history:

| Change                                                       | What broke for an older client                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sequenceNumber` removed from `GET /sync` envelopes          | A client ordering an offline catch-up by `sequenceNumber` gets `undefined` on every envelope. `apps/backend/src/__tests__/sync.routes.test.ts` asserts the field's absence, so the removal is deliberate and enforced. The field still exists on socket receipt payloads, so it is gone from one surface and present on another. |
| `device` became **required** on `POST /auth/verify`          | `VerifySchema` moved from `device: DeviceSchema.partial().optional()` to `device: DeviceSchema`. A client that authenticated without a device block now gets a 400 at login — the hardest possible failure, because it locks the user out entirely rather than degrading a feature.                                              |
| `POST /devices` retired in favour of the link-challenge flow | JWT-only device registration is gone; devices must complete `POST /devices/link/challenge` then `POST /devices/link/verify`.                                                                                                                                                                                                     |

The third of those is the one that was handled well, and it is the model this
policy generalises — see [§4.1](#41-the-existing-precedent-post-devices).

Note also that `VerifySchema` and the message schemas are `.strict()`: an
unrecognised field in a request body is rejected outright rather than ignored.
That is a deliberate safety property for key material (a client bug that sends
private state should be surfaced, not silently dropped) but it means **adding an
optional field to a strict request body is a breaking change for any client that
sends it to an older server**. Request bodies and response bodies do not follow
the same compatibility rules here.

### The intended policy going forward

1. **Additive-by-default.** New behaviour ships as new fields, new events, or new
   routes. Existing shapes keep working.
2. **No silent removals.** Anything removed goes through the deprecation
   procedure in [§4](#4-deprecation-procedure), with an announced sunset.
3. **Negotiate rather than version, where the change is in the protocol.** The
   device capability mechanism ([§5](#5-capability-negotiation-the-working-precedent))
   already ships protocol changes without breaking older clients, and it is the
   preferred tool.
4. **Version the path only as a last resort.** Introducing `/v2/<route>` beside
   the existing route is reserved for a change that cannot be made additive or
   negotiated. When it happens, the unprefixed route remains the v1 route — it is
   not retroactively moved — and it is deprecated on the normal schedule.

The policy applies to what the server promises going forward. It does not
retroactively re-open the three changes above.

---

## 2. What counts as a breaking change

### 2.1 REST responses

Breaking:

- Removing a field, or making a previously always-present field optional.
- Renaming a field. (This is a removal plus an addition, and it is the most
  common accidental break.)
- Changing a field's type or its representation — `number` → `string`, an ISO
  timestamp → epoch millis, a bare id → an object.
- Narrowing an enum-like value set, or adding a new value to one that clients
  switch on exhaustively.
- Changing a success status code (`200` → `204`), or turning a previously
  successful request into an error.
- Changing pagination semantics — cursor format, page size limits, ordering.
  `GET /sync` encodes its cursor as `<millis>:<id>`; a client persists that
  string across sessions, so changing the format strands every stored cursor.
- Moving a route to a different path, or adding a newly required parameter.
- Tightening validation on an existing field so previously accepted input is
  rejected.

Not breaking:

- Adding a new optional field to a response.
- Adding a new route.
- Adding a new optional field to a **non-strict** request body.
- Making a previously required request field optional.
- Loosening validation.
- Changing an error _message_ string while the status code and error shape hold.

### 2.2 Socket event payloads

The same field-level rules apply, plus:

Breaking:

- Removing an outbound event, or renaming one. A client listening for the old
  name simply never fires — there is no error, so this fails silently and is
  worse than a REST break.
- Removing a field from an outbound payload, or changing its type.
- Requiring a new field on an inbound event.
- Changing which room or audience an event is broadcast to, so a client that
  used to receive it no longer does.
- Changing the ack/response contract of an inbound event.
- Changing the handshake requirements. Auth already rejects tokens without
  `deviceId` — `verifyToken` throws `Token missing deviceId — re-authentication
required` — which is a hard break for any pre-device-auth token.

Not breaking:

- Adding a new event.
- Adding an optional field to an outbound payload.
- Accepting a new optional field on an inbound event.

Socket breaks deserve extra caution for two reasons: a long-lived connection
means an old client can be attached to a new server for hours, and a missing
event produces no error the client can detect or report.

### 2.3 Database-backed shapes

Some response shapes are the database schema in a thin wrapper, so a migration
can break the API without anybody editing a route. Treat a migration as an API
change whenever the column is reachable from a response:

- Dropping or renaming a column that a route serialises is a **response-breaking
  change**, even though the diff touches only `apps/backend/drizzle/`.
- Changing a column's type or nullability changes the response's type or
  optionality.
- Changing a default changes what clients observe for existing rows.
- Removing an enum value from a column constraint narrows a value set clients may
  already be switching on.

Two rules follow:

1. **Expand, migrate, contract.** Add the new column, dual-write, migrate readers,
   and only then drop the old column — with the drop treated as a deprecation
   under [§4](#4-deprecation-procedure) rather than as a schema tidy-up.
2. **Never serialise a table row directly.** Route handlers should map explicitly
   to a response shape, so that a column rename is a compile error rather than a
   silent contract change. `apps/backend/src/lib/messages.ts` already does this
   deliberately for `content`, destructuring it out so a legacy plaintext column
   can never reach a serialised response.

---

## 3. Compatibility windows

| Consumer                     | Assume it can be stale for                                                |
| ---------------------------- | ------------------------------------------------------------------------- |
| Open browser tab             | Hours to days — until reload                                              |
| Cached service worker        | Until the next activation                                                 |
| Device with queued envelopes | The envelope retention window, `ENVELOPE_TTL_SECONDS` (7 days by default) |

The retention window is a floor, not a ceiling: a device offline for the whole
window reconnects, syncs, and immediately starts speaking whatever protocol it
knew a week ago. **Minimum support window for a deprecated field, event, or
route: 90 days** from the announcement in [§4.2](#42-procedure). Shorten it only
for a security fix, and say so explicitly when you do.

---

## 4. Deprecation procedure

### 4.1 The existing precedent: `POST /devices`

When JWT-only device registration was retired, the route was not deleted. It was
left mounted, returning an explicit, actionable error:

```ts
// ─── POST /devices — retired (#333) ──────────────────────────────────────────
// Kept only to return an explicit, actionable error: bare JWT-only device
// registration is gone. Clients must complete the link challenge instead.

devicesRouter.post('/', (_req: AuthRequest, res) => {
  res.status(403).json({
    error:
      'Device registration requires a fresh wallet signature. Use POST /devices/link/challenge then POST /devices/link/verify.',
  });
});
```

An old client hitting it gets a status it can branch on and a message naming its
replacement, instead of a 404 that is indistinguishable from a typo or an outage.
That is the standard for every retirement: **the removed thing keeps answering,
and its answer says what to do instead.**

### 4.2 Procedure

1. **Announce.** Open an issue describing the change, the reason, the
   replacement, and the sunset date (≥ 90 days out). Record it in the
   [deprecation register](#6-deprecation-register) in this file.
2. **Mark it.** How depends on what is being deprecated:

   | Surface      | How it is marked                                                                                                                                          |
   | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | REST route   | Respond with `Deprecation: true` and `Sunset: <HTTP-date>` headers, plus a `Link: <url>; rel="deprecation"` pointing at the issue. Keep serving normally. |
   | REST field   | Keep returning it, populated. Document it as deprecated in the route's doc under `apps/backend/docs/` and note the replacement field.                     |
   | Socket event | Keep emitting it alongside its replacement. There is no header channel on a socket, so the register in this file and the event catalog are the notice.    |
   | Socket field | Keep populating it alongside the replacement field in the same payload.                                                                                   |
   | DB column    | Stop reading it, keep writing it, and mark it deprecated in the schema.                                                                                   |

3. **Ship the replacement first.** The new field, event, or route must be live and
   documented before the old one is marked, so a client can migrate the moment it
   sees the notice.
4. **Notify.** Update the relevant doc under `apps/backend/docs/` (the
   [WebSocket event catalog](../apps/backend/docs/api-websocket-events.md) for
   events, the matching `api-*.md` for routes), add the register entry here, and
   flag it in the PR description. There is no runtime client-notification channel
   today; adding a deprecation array to `GET /health` would be the natural place
   if one is wanted.
5. **Wait out the window.** Both paths work for the full period.
6. **Retire.** Replace the implementation with an explicit error in the style of
   §4.1 — a `410 Gone` for a removed route, `403` where a different flow must be
   used — naming the replacement. Do not delete the handler. Move the register
   entry to _Retired_.

### 4.3 Emergency changes

A security fix may skip the window. It must still: ship an explicit error rather
than a silent removal, get a register entry recording that the window was
skipped and why, and state what a stranded client should do. `verifyToken`
rejecting tokens without `deviceId` is an example of this class — the break is
deliberate and the error message tells the client to re-authenticate.

---

## 5. Capability negotiation: the working precedent

For protocol-level changes, the codebase already has a mechanism that ships
breaking protocol work without breaking older clients:
[`apps/backend/src/lib/capabilities.ts`](../apps/backend/src/lib/capabilities.ts).

Each device advertises a small JSON document at registration, and can update it
later without re-registering its identity key:

```ts
protocols; // e.g. ["sealed_box", "signal", "mls"] — schemes this device can decrypt
ciphersuites; // MLS/Signal ciphersuite identifiers, meaningful when "mls" is present
fileTransfer; // file-encryption scheme versions, e.g. ["file-v1"]
```

The properties that make it work are worth naming, because they are what any
future negotiation mechanism should copy:

- **A universal baseline.** `sealed_box` is the scheme every device in the
  codebase implements, and it is the floor of every negotiation.
- **Absence is a valid answer.** A device that never advertised capabilities —
  including rows written before the column existed — normalises to the
  sealed_box-only baseline instead of erroring. `normalizeCapabilities` returns
  the baseline for `null`, `undefined`, and malformed input alike.
- **Unknown values are preserved and ignored.** `selectProtocol` walks a known
  priority list rather than rejecting names it does not recognise, so an older
  server meeting a newer client's advertisement degrades instead of failing.
- **Negotiation is pairwise and per-message.** `selectProtocol(a, b)` picks the
  strongest scheme _both_ sides support, so a rollout proceeds device by device
  with no flag day.
- **Advertising is a non-breaking addition.** `capabilities` is optional on
  `DeviceSchema`; omitting it is well-defined.

The same shape applies beyond encryption. `fileTransfer` already carries versioned
scheme identifiers (`file-v1`) checked by `supportsFileTransfer`, which is exactly
how a versioned payload format should be gated.

**Use this first.** A protocol or payload-format change that can be expressed as
a capability should be, rather than as a versioned route: it needs no client
coordination, no sunset date, and no dual-serving window.

Its limit is that it is scoped to devices and to encryption/file-transfer
concerns. It says nothing about REST response shapes, and there is no equivalent
negotiation for a client's understanding of a JSON field. Those still need the
deprecation procedure in [§4](#4-deprecation-procedure).

A second, narrower precedent lives in the socket layer: the
[envelope-wrapper vs. legacy-raw-emit](../apps/backend/docs/api-websocket-events.md#envelope-wrapper-vs-legacy-raw-emit)
split, where both emission styles are supported concurrently and new client code
is directed at the envelope. That is the dual-serving half of §4.2 already in
practice — what it lacks is an announced sunset for the legacy style.

---

## 6. Deprecation register

The canonical list of what is deprecated, what replaces it, and when it goes.
Every deprecation adds a row here as step 1 of [§4.2](#42-procedure).

### Active deprecations

| Surface         | Deprecated | Replacement | Announced | Sunset |
| --------------- | ---------- | ----------- | --------- | ------ |
| _none recorded_ |            |             |           |        |

Legacy-raw-emit on the socket is a candidate for the first entry: it is already
dual-served and already documented as non-preferred, but has no announced sunset.

### Retired

| Surface                              | Retired                                           | Replacement                                                        | Behaviour now                                                              |
| ------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `POST /devices`                      | JWT-only device registration (#333)               | `POST /devices/link/challenge` → `POST /devices/link/verify`       | `403` naming the replacement flow                                          |
| `GET /sync` → `sequenceNumber`       | Per-conversation sequence number as a sync cursor | Opaque `nextCursor` (`<millis>:<id>`), stable across conversations | Field absent; asserted by `sync.routes.test.ts`                            |
| `POST /auth/verify` without `device` | Deviceless authentication                         | `device` block required on every verify                            | `400` from schema validation                                               |
| JWT without `deviceId`               | Pre-device-aware tokens                           | Re-authenticate                                                    | `verifyToken` throws `Token missing deviceId — re-authentication required` |

---

## 7. Checklist for a change that touches the API

- [ ] Diff reviewed against [§2](#2-what-counts-as-a-breaking-change) — response fields, socket payloads, and any migration.
- [ ] If breaking: can it be additive instead? Can it be a capability instead?
- [ ] If it must break: replacement shipped and documented first.
- [ ] Register row added with a sunset date ≥ 90 days out.
- [ ] Route doc under `apps/backend/docs/` updated; event catalog updated for socket changes.
- [ ] Retirement returns an explicit error naming the replacement — never a bare 404 or a silently missing event.
- [ ] Migrations reviewed as API changes, not just schema changes.

---

## 8. Related documents

- [WebSocket event catalog](../apps/backend/docs/api-websocket-events.md) — every event, its payload, and the envelope/legacy split
- [REST schemas](../apps/backend/docs/contracts-rest-schemas.md) — request/response shapes this policy governs
- [WebSocket payload contracts](../apps/backend/docs/contracts-websocket-payloads.md)
- [Devices & prekeys API](../apps/backend/docs/api-devices.md) — the routes carrying the retired `POST /devices` and the link flow that replaced it
- [Message sync API](../apps/backend/docs/api-messages-sync.md) — the cursor contract referenced in §2.1
- [Message encryption migration](../apps/backend/docs/message-encryption-migration.md) and [Signal migration](../apps/backend/docs/signal-migration.md) — capability negotiation applied to a live protocol rollout
