# Nonce and challenge store lifecycle

This note documents [src/lib/nonce.ts](../src/lib/nonce.ts): how challenge nonces are minted, stored, consumed, and expired, for both the wallet sign-in challenge and the separate device-link challenge.

Both flows follow the same shape — the server mints a random value, the client proves wallet ownership by signing a message containing it, and the server burns the value while verifying. What differs is the keyspace, the TTL, and what a successful verification grants.

See also: [Auth API](api-auth.md), [Devices & Prekeys API](api-devices.md), [JWT auth contract](contracts-jwt-auth.md), and [Rate limits](../../../docs/security/rate-limits.md).

## 1. The two nonce kinds at a glance

|                       | Sign-in challenge                    | Device-link challenge                   |
| --------------------- | ------------------------------------ | --------------------------------------- |
| Mint                  | `createNonce(walletAddress)`         | `createDeviceLinkNonce(userId)`         |
| Consume               | `consumeNonce(walletAddress, nonce)` | `consumeDeviceLinkNonce(userId, nonce)` |
| Store                 | `store` map                          | `deviceLinkStore` map                   |
| Key                   | Wallet address (`G...`)              | `userId`                                |
| TTL                   | 5 minutes (`TTL_MS`)                 | 2 minutes (`DEVICE_LINK_TTL_MS`)        |
| Issued by             | `POST /auth/challenge`               | `POST /devices/link/challenge`          |
| Burned by             | `POST /auth/verify`                  | `POST /devices/link/verify`             |
| Caller authenticated? | No — this is the pre-login step      | Yes — requires a valid JWT              |
| Grants on success     | A session (JWT)                      | Registration of one new device          |

## 2. Creation

Both kinds are minted by the same internal helper:

```ts
function issue(target, key, ttlMs) {
  const nonce = randomBytes(16).toString('hex');
  target.set(key, { nonce, expiresAt: Date.now() + ttlMs });
  return nonce;
}
```

- **Value.** 16 bytes from Node's `crypto.randomBytes`, hex-encoded to a 32-character string. 128 bits of CSPRNG output — guessing a live nonce is not a practical attack, and collisions between concurrently outstanding nonces are not a concern.
- **Storage.** One entry per key, holding the nonce and an absolute `expiresAt` timestamp in epoch milliseconds.
- **Overwrite semantics.** `Map.set` replaces any existing entry for that key. Requesting a second challenge for the same wallet (or the same user) invalidates the first — only the most recently issued nonce for a key is live. A client that fires two challenge requests and then signs the first will fail verification.

### Sign-in

`POST /auth/challenge` ([routes/auth.ts](../src/routes/auth.ts)) takes a wallet address, mints a nonce, and returns it embedded in the message the client must sign:

```text
Sign in to Clicked
Wallet: <walletAddress>
Nonce: <nonce>
```

The endpoint is unauthenticated — the wallet address is the only identity available at this point, and it is a public value. It is rate-limited per IP (`auth_challenge`: 10/minute).

### Device link

`POST /devices/link/challenge` ([routes/devices.ts](../src/routes/devices.ts)) requires a valid JWT, resolves the account's primary wallet, and mints a nonce keyed by `userId`:

```text
Link device to Clicked
User: <userId>
Nonce: <nonce>
```

The response carries the message, the nonce, and the wallet address the signature must come from. Rate-limited as `device_link_challenge` (10/minute).

This is a re-authentication step, not a login: the caller already holds a session. The point is to prove wallet ownership _now_, because a JWT alone must not be enough to add a device to an account.

## 3. Consumption

Both kinds are burned by the same helper:

```ts
function consume(target, key, nonce) {
  const entry = target.get(key);
  if (!entry) return false;
  target.delete(key); // burned on read, valid or not
  if (Date.now() > entry.expiresAt) return false;
  return entry.nonce === nonce;
}
```

Three properties follow, and all three are deliberate:

- **Single use.** The entry is deleted on read, whether or not it turns out to be valid. A second `consume` for the same key returns `false` because there is nothing left to read.
- **Burned even on failure.** A wrong nonce still deletes the stored entry. This is what stops an attacker from guessing repeatedly against one live challenge: each attempt destroys the target, so a guessing run must interleave a fresh `/challenge` call for every attempt, which puts it under the challenge rate limit rather than the (much cheaper) verify path.
- **Expiry checked after deletion.** An expired entry is removed and rejected in the same call.

`consume` returns a plain boolean; the routes translate a `false` into `401` without revealing whether the nonce was missing, wrong, or expired.

### Ordering at the call sites

Both verify routes consume the nonce **before** doing any signature work:

- `POST /auth/verify` calls `consumeNonce(walletAddress, nonce)` first, records an `auth_failed` audit event with reason `invalid_or_expired_nonce` on failure, and returns `401` before touching `Keypair.verify` or the database.
- `POST /devices/link/verify` calls `consumeDeviceLinkNonce(userId, body.nonce)` first, before resolving the wallet, before verifying the signature, and before any device lookup.

Consuming first means a replayed request always fails on its second submission, and a caller cannot use the endpoint to run signature verifications against a nonce it keeps alive.

## 4. Why device linking uses a separate namespace

The two stores are separate maps, keyed differently on purpose. The header comment in `nonce.ts` states it directly: sharing the login store would let a device-link challenge and a login challenge for the same wallet silently overwrite each other.

Concretely, with a shared store:

- A user signed in on device A requests a device-link challenge. If that challenge landed in the sign-in store under the same key, a concurrent sign-in attempt from device B would overwrite it — and vice versa. Whichever flow finished second would fail with "invalid or expired nonce" for reasons the user could not see or fix.
- Because `Map.set` overwrites unconditionally and `consume` burns on any read, an attacker who can reach the unauthenticated `/auth/challenge` endpoint for a known wallet address could repeatedly overwrite the victim's outstanding device-link nonce, making device linking permanently fail. Separate namespaces mean the unauthenticated flow has no handle on the authenticated flow's state at all.

The separation is reinforced by the key type: the sign-in store is keyed by wallet address, the device-link store by `userId`. Even a string that happens to be valid as both cannot cross over. [nonce.test.ts](../src/__tests__/nonce.test.ts) pins this with a test that issues both kinds under the identical key string and asserts that neither nonce satisfies the other's `consume`.

The same "separate buckets" reasoning is applied one layer up, in [config/rateLimits.ts](../src/config/rateLimits.ts): `device_link_challenge` and `device_link_verify` mirror the `auth_challenge` and `auth_verify` limits but count in their own buckets, so hammering the device-link flow cannot exhaust a user's sign-in budget, and hammering sign-in cannot lock out device linking. Namespace isolation at the store level and bucket isolation at the rate-limit level are two halves of the same guarantee.

## 5. TTLs

- **Sign-in: 5 minutes.** Long enough to cover a wallet-extension prompt the user has to find, unlock, and approve — possibly on a phone.
- **Device link: 2 minutes.** Tighter, because the caller is already signed in and actively performing the flow; there is no unlock-from-cold path to accommodate. A shorter window narrows the period in which a captured challenge could be replayed after a signature is obtained by other means.

Expiry is lazy. There is no sweeper: an entry sits in the map until someone calls `consume` for that key, at which point it is deleted and rejected. The practical consequences:

- An abandoned challenge (user requests one and never verifies) leaves a ~90-byte entry in memory until the same key is used again.
- Memory is bounded in practice by the challenge rate limits and by the fact that there is at most one entry per key. It is not bounded by the TTL. On a long-running node under sustained challenge traffic from many distinct wallet addresses, the map grows with the number of distinct keys seen, not with the number of live nonces. If that ever becomes a concern, it is an argument for moving the stores to Redis with native key expiry rather than for adding a sweeper.

## 6. Where nonces live: restarts and multi-node deployments

Both stores are **in-process `Map` instances in the Node heap**. They are not in Postgres and not in Redis, unlike the rate-limit counters, which do use Redis so budgets are shared across gateway nodes.

Two consequences follow, and both are operationally important:

### Across a restart

Every outstanding nonce is lost when the process restarts, is redeployed, or crashes. Any client that has a challenge in flight gets `401 Invalid or expired nonce` when it submits the signature. This fails safe — no nonce survives to be replayed against a new process — but it is user-visible: a deploy during a sign-in attempt makes that attempt fail. Clients should treat a nonce rejection as "request a fresh challenge and retry", not as a terminal auth error.

### Across multiple nodes

**The challenge and the verification must be served by the same process.** A nonce minted on node A does not exist on node B. In a multi-node deployment this means one of the following must hold:

- the load balancer pins a client's `/auth/challenge` and `/auth/verify` (and the two `/devices/link/*` calls) to the same backend instance — sticky sessions or connection reuse; or
- the deployment runs a single gateway instance; or
- the stores are moved to a shared backend before scaling out.

If none holds, sign-in and device linking fail intermittently at a rate that rises with the node count, and the failures look like spurious "invalid or expired nonce" errors rather than like a routing problem. This is the first thing to check when nonce rejections appear after a horizontal scale-out.

Migrating the stores to Redis (see [lib/redis.ts](../src/lib/redis.ts)) would remove both limitations: `SET key value NX PX <ttl>` for `issue` and an atomic `GETDEL`-style consume preserve exactly the burn-on-read semantics described above, with expiry handled natively.

## 7. Replay resistance: what this buys, and what it does not

### What it provides

- **Signature replay is prevented within a flow.** A captured `/auth/verify` body cannot be resubmitted: the nonce it carries was burned by the first submission. The same holds for `/devices/link/verify`.
- **Cross-flow replay is prevented.** The signed messages differ in prefix (`Sign in to Clicked` vs `Link device to Clicked`) and in body (wallet address vs user id), and the nonces live in separate keyspaces, so a signature captured from one flow is not valid for the other.
- **Freshness is bounded.** A signature is only useful inside the nonce's TTL — 5 minutes for sign-in, 2 for device linking.
- **Online guessing is expensive.** 128 bits of entropy, burn-on-read on a wrong guess, and rate limits on both the challenge and the verify endpoints.
- **Wallet signatures cannot be harvested for other purposes.** The signed string is scoped to this application and to a server-issued value, so a signature obtained elsewhere for a different message does not verify here.

### What it does not provide

- **No protection against an attacker who controls the wallet.** The nonce proves _freshness_ of a signature, not that the signer is the legitimate account holder. A compromised or malicious wallet passes every check here. Device linking is the mitigation for the account-level version of this: linking a new device requires a fresh wallet signature and is audited, and existing devices can be revoked.
- **No protection against a same-session in-flight attacker.** Anyone who can read the challenge response _and_ get the user to sign it (a malicious page, a compromised client, an attacker holding the wallet unlock) can complete the flow once. Single-use only stops the _second_ use.
- **Nothing is bound to a transport or a client.** The nonce is not tied to an IP, a TLS session, or a device fingerprint. A nonce obtained by client X can be verified by client Y if Y can produce the signature. Transport-level binding is handled separately — see [Transport security and pinning](../../../docs/security/tls-and-pinning.md).
- **No cross-node or cross-restart guarantee**, per section 6. The replay guarantee is per-process. It is not weakened by a restart (state is lost, not duplicated), but availability is.
- **The device-link nonce does not prove the new device is trustworthy.** It proves the wallet approved adding _a_ device at that moment. Verifying the identity of the device itself is the safety-number / fingerprint job — see [E2EE onboarding](e2ee-onboarding.md).

## 8. Tests

[src/\_\_tests\_\_/nonce.test.ts](../src/__tests__/nonce.test.ts) covers both stores: format (`/^[0-9a-f]{32}$/`), successful consume, single-use, wrong-nonce rejection, unknown-key rejection, cross-user rejection, keyspace separation between the two stores, and TTL boundaries on both sides using fake timers (just-before-expiry accepted, just-after rejected).
