# Backend Structured Logging Conventions

This document covers [`lib/logger.ts`](../src/lib/logger.ts) — the structured logger for
the encrypted pipeline (issue #393): its configuration, log levels, standard fields, and,
most importantly, the rule that message content, ciphertext, and key material never
appear in a log line.

## Contents

- [Configuration](#configuration)
- [Levels, and how level is set per environment](#levels-and-how-level-is-set-per-environment)
- [The no-content rule](#the-no-content-rule)
- [Standard correlation fields](#standard-correlation-fields)
- [Current adoption: `console.*` is still the norm](#current-adoption-console-is-still-the-norm)

## Configuration

`lib/logger.ts` exports a single shared [pino](https://getpino.io/) instance:

```ts
export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  redact: {
    paths: [
      'ciphertext', '*.ciphertext',
      'envelopes', '*.envelopes',
      'payload', '*.payload',
      'plaintext', '*.plaintext',
    ],
    censor: '[redacted]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: { service: 'clicked-backend' },
});
```

- **`level`** — read from `LOG_LEVEL`, defaulting to `'info'`. See
  [below](#levels-and-how-level-is-set-per-environment).
- **`redact`** — a fixed list of field-name paths (`ciphertext`, `envelopes`, `payload`,
  `plaintext`, each matched both at the top level and one level deep via the `*.`
  wildcard) that pino will replace with the literal string `[redacted]` if they ever
  appear in a logged object. The paths line up directly with the shapes actually flowing
  through the system: `payload` is the field on `EventEnvelope`
  (`lib/eventEnvelope.ts`'s `EventEnvelopeSchema`), `envelopes` is the array of
  per-recipient-device ciphertext blobs on a `send_message` call, and
  `ciphertext`/`plaintext` are the raw content fields on an individual envelope. This is
  a **backstop**, not the primary guarantee — see the [no-content rule](#the-no-content-rule)
  below for why you can't rely on it alone.
- **`formatters.level`** — pino's default is to log the numeric level; this overrides it
  to log the string label (`"info"`, `"warn"`, etc.) instead, so log lines are readable
  without a lookup table.
- **`base: { service: 'clicked-backend' }`** — every line this logger emits carries
  `service: "clicked-backend"`, so log lines from this process are identifiable in a
  shared/aggregated log stream (e.g. alongside the AI agent or other services) without
  extra configuration at every call site.

There is no per-request or per-socket child-logger factory defined yet — see
[Standard correlation fields](#standard-correlation-fields) for what's available to attach
manually, and [Current adoption](#current-adoption-console-is-still-the-norm) for why this
matters less today than it will once call sites migrate to it.

## Levels, and how level is set per environment

pino's standard level ordering applies: `fatal` > `error` > `warn` > `info` > `debug` >
`trace` (plus `silent` to disable entirely) — set `level` to a name and every level at or
above it (i.e. more severe or equal) is emitted; everything below it is a no-op with
near-zero overhead (pino checks the level before serializing).

**Per-environment control is entirely via the `LOG_LEVEL` env var** — there's no
hardcoded environment-name branch (`if (NODE_ENV === 'production')` etc.) in
`lib/logger.ts` itself:

- Unset → defaults to **`info`**. This is what local dev and any environment that doesn't
  explicitly set `LOG_LEVEL` gets.
- Set `LOG_LEVEL=debug` (or `trace`) locally or in a staging environment to see verbose
  output while debugging a specific issue — remember to unset it again rather than
  leaving a deployment running at `debug` indefinitely, since `debug`/`trace` volume adds
  up quickly on a busy gateway.
- Set `LOG_LEVEL=warn` (or stricter) in an environment where you only want actionable
  signal and want to cut `info`-level noise (e.g. a high-throughput environment where
  per-connection `info` lines aren't worth the log volume).
- `LOG_LEVEL` is read once at module load (`pino({ level: process.env['LOG_LEVEL'] ??
  'info'] ... })`), so changing it requires a process restart — it is not something a
  running process picks up live.

## The no-content rule

**Message content, ciphertext, and key material never appear in a log line — this is a
hard rule, not a style preference.** The whole point of the encrypted pipeline is that the
server never has plaintext to leak in the first place, but ciphertext, key material
(prekeys, signed prekeys, MLS `KeyPackage`s, session keys), and full envelope objects are
exactly as sensitive from a logging standpoint: they should never be the value of a
logged field, truncated preview or not, redacted-and-hope or not.

**The redact list in `lib/logger.ts` is a backstop, not the mechanism you should rely on.**
It only fires if a call site accidentally passes a *whole object* that happens to contain
one of the redacted field names — it does nothing for a raw string interpolated into a
message (`` logger.info(`sending ${ciphertext}`) `` bypasses `redact` entirely, because
`redact` only inspects the structured fields of a log object, not free-text message
strings) and nothing for a field passed under a name the list doesn't happen to cover.
The actual guarantee has to come from what you choose to log in the first place.

**The safe way to log about a message: ids and counts, never bodies.**

```ts
// ❌ Never — even though `redact` will catch some of this, don't rely on it,
// and the string-interpolation case isn't caught at all.
logger.info(`delivering message ${JSON.stringify(envelope)}`);
console.log('sending', { ciphertext: envelope.ciphertext });

// ✅ Ids, counts, sizes, durations — never the content itself.
logger.info({ messageId, conversationId, recipientDeviceCount: envelopes.length },
  'message fanout dispatched');
logger.debug({ deviceId, eventId, envelopeByteLength: envelope.ciphertext.length },
  'envelope accepted');
logger.warn({ subscriptionId, statusCode }, 'push send failed, backing off');
```

Concretely, safe fields to log about a message/envelope/key include: `messageId`,
`conversationId`, `deviceId`, `userId`, `eventId`, counts (`recipientDeviceCount`,
`prunedCount`), sizes/lengths (`envelopeByteLength`, never the bytes themselves), status
codes, durations, and timestamps. Never log: `ciphertext`, `plaintext`, the raw
`payload`/`envelopes` object, key material (`identityPublicKey`, prekey bytes, MLS
`KeyPackage` bytes), auth tokens, or `p256dh`/`auth` push subscription keys. When in
doubt, log the *shape* (a count, a length, a boolean) rather than the *value*.

## Standard correlation fields

There is no dedicated request-id/correlation-id middleware in this backend today — HTTP
access logging goes through `morgan('dev')` (`app.ts`), which logs method, path, status,
and response time, with no generated request id attached, and is separate from
`lib/logger.ts` entirely. For tracing a specific request or socket event through
structured log lines, use the identifiers already available at each call site:

- **`deviceId`** — available on every authenticated socket via `socket.auth.deviceId`
  (set by `socketAuthMiddleware`) and on every REST request via the equivalent JWT-derived
  auth context. The most useful single field for tracing one device's activity across
  connect/disconnect/send/receive.
- **`userId`** — `socket.auth.userId` / the REST auth context; ties multiple devices
  belonging to the same account together.
- **`eventId`** — present on every dispatched socket envelope (`EventEnvelopeSchema.eventId`,
  `lib/eventEnvelope.ts`), generated client-side or via `createEnvelope()`. This is what
  the existing replay-protection debug log already keys on
  (`dispatcher.ts`: `{ deviceId, eventId, type }`) — follow that shape for any new
  per-event log line.
- **`conversationId`** / **`messageId`** — attach whichever is relevant to the operation;
  both are safe to log (they're routing/addressing metadata, not content).
- **`socket.id`** — Socket.IO's own per-connection id; useful for correlating multiple
  events from the same physical connection within one session, but don't use it as a
  stand-in for `deviceId` across reconnects — a new connection gets a new `socket.id`.

None of these are enforced by a shared child-logger or middleware yet — attach the
relevant subset by hand at each call site (as the redact-list field names already imply
you should for `payload`/`envelopes`/`ciphertext`/`plaintext`), following the pattern
shown in [the no-content rule](#the-no-content-rule) above.

## Current adoption: `console.*` is still the norm

**`lib/logger.ts` has no import sites anywhere else in `apps/backend/src` today.** Every
current log line in the backend — startup/shutdown messages in `index.ts`, the GC job
services (`deviceGc.ts`, `envelopeGc.ts`, `fileCleanup.ts`), the socket dispatcher and
messaging handlers, push notification hygiene, presence, backpressure, rate limiting, and
so on — goes through bare `console.log`/`console.warn`/`console.error`/`console.debug`
instead (roughly 60 call sites across the backend as of this writing). Even
`services/stellarListener.ts`, whose own doc comment says it "logs errors via the standard
backend logger," actually defaults its optional `log` dependency to a small hand-rolled
`consoleLogger` wrapper around `console.*`, not to `lib/logger.ts`.

Practical implications:

- **None of the level control, redaction backstop, or `service` base field described
  above currently applies to the backend's actual log output** — `console.*` calls bypass
  all of it. `LOG_LEVEL` has no effect on anything printed via `console.log`.
- **New code should use `lib/logger.ts`, not add more `console.*` calls.** The existing
  ~60 call sites are the migration backlog, not the target state — don't grow that number.
  When you're already touching a file that logs via `console.*`, prefer converting the
  lines you touch to `logger` rather than leaving new logic logging through the old path.
- When you do add a `logger.*` call, follow the [no-content rule](#the-no-content-rule)
  and attach the [correlation fields](#standard-correlation-fields) relevant to that
  call site, the same way the codebase's existing `console.*` calls already do at their
  best (e.g. `dispatcher.ts`'s `{ deviceId, eventId, type }` shape) — the goal is to bring
  that same discipline under the structured logger, not to reinvent it.
