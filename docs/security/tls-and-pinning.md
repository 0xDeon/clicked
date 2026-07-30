# TLS enforcement and certificate pinning

This document describes the transport-security guarantees the Clicked gateway
makes, and what a client — web today, iOS and Android later — is expected to do
on its side of the connection.

Everything here is enforced by `apps/backend/src/lib/transportSecurity.ts` and
its two middlewares (`middleware/transportSecurity.ts` for HTTP,
`middleware/socketSecurity.ts` for the Socket.IO handshake).

## 1. Transport policy

| Environment                                 | HTTP            | WebSocket   |
| ------------------------------------------- | --------------- | ----------- |
| `NODE_ENV`/`APP_ENV` = `development`/`test` | `http`, `https` | `ws`, `wss` |
| anything else (staging, production)         | `https` only    | `wss` only  |

Outside development:

- A plaintext HTTP request is answered `403 { "error": "tls_required" }`. It is
  refused rather than redirected: a redirect would still have leaked the bearer
  token in the request that triggered it.
- A plaintext WebSocket handshake is rejected during the Socket.IO middleware
  chain, before the token is parsed, with `Insecure transport: connect over wss://`.
- `GET /health` remains reachable over plaintext. Load balancers and container
  orchestrators probe the pod directly, upstream of TLS termination, and a
  healthy gateway must not be pulled from rotation for answering them.

`ENFORCE_TLS` overrides the decision in both directions. Setting it to `true`
lets you exercise the production posture locally; setting it to `false` outside
development is the _only_ way to run a plaintext non-dev deployment — plaintext
is never reached by omission — and it logs a warning on every boot.

The boot check does refuse one combination outright: TLS enforced while
`ALLOWED_ORIGINS` contains an `http://` origin. That says a plaintext page is
expected to drive the API, which readmits through the side door exactly what the
policy exists to prevent, so the operator has to resolve the contradiction.

### Terminating TLS at the edge

TLS is normally terminated by a load balancer, so the gateway decides whether a
request was secure from `X-Forwarded-Proto`. That header is only trustworthy
for hops you control, so `TRUST_PROXY` (default `1`) sets how many proxy hops
Express will believe. **Set `TRUST_PROXY=0` when the gateway is exposed
directly** — otherwise any client can forge `X-Forwarded-Proto: https` and walk
straight past the check.

## 2. Response headers

Every response carries:

| Header                      | Value                                          | Why                                                                        |
| --------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | A browser that has seen one response never attempts plaintext again.       |
| `X-Content-Type-Options`    | `nosniff`                                      | Ciphertext blobs are never re-interpreted as an executable content type.   |
| `X-Frame-Options`           | `DENY`                                         | The API is not framable, so a downgrade cannot be staged inside an iframe. |
| `Referrer-Policy`           | `no-referrer`                                  | Presigned object-storage URLs never leak through the `Referer` header.     |

HSTS is only emitted when TLS is enforced — sending it from a dev server would
poison `localhost` for every other project on the machine. `HSTS_MAX_AGE=0`
disables it, and `HSTS_PRELOAD=false` drops the `preload` directive if you are
not ready to submit the domain.

## 3. Origin and cookie checks on the WebSocket handshake

`Origin` is attacker-controlled for non-browser clients, but for browsers it is
the one signal that identifies the page driving the socket. The handshake:

1. Rejects an `Origin` outside `ALLOWED_ORIGINS` (comma-separated, exact
   match, trailing slashes ignored). With no allowlist configured, non-dev
   deployments still require the origin to be an `https://` one, so a plaintext
   page can never drive the socket.
2. Accepts a **missing** `Origin`. Native mobile clients and server-to-server
   callers do not send one; they are protected by pinning (§4), not by Origin.
3. Rejects any handshake that carries a `Cookie` header over a non-secure
   transport. The gateway authenticates with a bearer token in
   `handshake.auth.token` and sets no cookies of its own, so a cookie here is
   either a reverse-proxy session or a future cookie-based client — neither may
   travel in the clear.

Should the service ever set a cookie, it must use
`secureCookieOptions()` from `lib/transportSecurity.ts`, which pins
`HttpOnly`, `SameSite=Strict`, `Path=/` and `Secure` (whenever TLS is
enforced). Do not hand-roll cookie attributes.

The same origin allowlist backs the CORS policy for the REST API, and a
disallowed origin is rejected with `403 origin_not_allowed` rather than merely
having its `Access-Control-Allow-Origin` header withheld — withholding the
header only stops the browser from _reading_ the response, after the request
has already run.

## 4. Certificate pinning for mobile clients

The gateway cannot pin its own certificate; pinning is a client-side control.
What it does provide is a machine-readable policy document so that **rotating a
pin is a server config change, not an app release**:

```
GET /security/transport-policy        (unauthenticated)

{
  "tls": {
    "required": true,
    "minimumVersion": "TLSv1.2",
    "hsts": "max-age=31536000; includeSubDomains; preload"
  },
  "pinning": {
    "enforced": true,
    "hosts": ["api.clicked.app"],
    "pins": ["sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="],
    "backupPins": ["sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB="],
    "maxAgeSeconds": 5184000,
    "reportUri": "https://api.clicked.app/security/pin-reports"
  }
}
```

The endpoint is deliberately unauthenticated: a client must be able to read it
before it holds a token, and SPKI hashes of public keys are already public.

### Expectations for the mobile clients

1. **Pin the SPKI, not the certificate.** Pin the SHA-256 of the Subject Public
   Key Info, base64-encoded in the `sha256/<base64>` form used by TrustKit and
   OkHttp. A certificate pin breaks on every renewal even when the key is
   unchanged.

2. **Ship a pin set, never a single pin.** The app binary must embed at least
   one current pin _and_ one backup pin for a key that is generated and stored
   offline but not yet served. A single-pin build bricks every installation the
   moment that key is lost or must be rotated after an incident. The gateway
   enforces this rule at the source: `enforced` is only `true` when both
   `TLS_PINNED_SPKI_SHA256` and `TLS_BACKUP_SPKI_SHA256` are populated, so a
   backup-less configuration can never instruct clients to hard-fail.

3. **Refresh from the policy endpoint, but never trust it alone.** Cache the
   document for at most `maxAgeSeconds` and use it to _widen_ the trusted set
   during a rotation. A pin fetched over a connection that the built-in pin set
   already validated is trustworthy; a pin fetched over an unvalidated
   connection is not, and must never replace the embedded set. In other words:
   the endpoint may add pins for an upcoming rotation, it may not remove the
   ones compiled into the app.

4. **Fail closed, with an escape hatch.** When `enforced` is `true`, a pin
   mismatch must abort the connection — do not fall back to system trust. Ship
   a remotely-togglable kill switch for the pinning check so a
   mis-configuration can be recovered without an App Store review cycle.

5. **Report failures.** POST validation failures to `reportUri` when present.
   A spike in reports is the earliest signal of a mis-issued certificate or a
   botched rotation.

Platform notes:

- **iOS** — keep App Transport Security at its defaults (no
  `NSAllowsArbitraryLoads`) and add pinning with TrustKit, or implement
  `URLSession`'s `didReceive challenge:` delegate and compare the SPKI hash
  yourself. ATS already requires TLS 1.2+ and forward secrecy, which matches
  the policy above.
- **Android** — declare the pin set in `res/xml/network_security_config.xml`
  with `<pin-set expiration="…">` containing both pins, and set
  `cleartextTrafficPermitted="false"`. Note that `network_security_config` pins
  are ignored for `WebView`, so any WebView traffic needs its own handling.
  Give the `pin-set` an expiration so an abandoned build degrades to system
  trust instead of failing shut forever.

### Rotation runbook

1. Generate the next key pair offline; compute its SPKI hash.
2. Publish it as `TLS_BACKUP_SPKI_SHA256` and ship an app release that embeds
   both the current and backup pins.
3. Wait for adoption to exceed the fleet threshold (the policy `maxAgeSeconds`
   is the floor, not the target).
4. Deploy the certificate for the backup key; move its hash to
   `TLS_PINNED_SPKI_SHA256` and generate a new backup.

Malformed pins are dropped with a warning rather than served, so a typo cannot
lock the fleet out.

## 5. Configuration reference

| Variable                  | Default             | Meaning                                                        |
| ------------------------- | ------------------- | -------------------------------------------------------------- |
| `APP_ENV` / `NODE_ENV`    | `development`       | `development`/`test` permit plaintext; anything else does not. |
| `ENFORCE_TLS`             | on outside dev      | Explicit override in either direction.                         |
| `TRUST_PROXY`             | `1`                 | Trusted reverse-proxy hops for `X-Forwarded-Proto`.            |
| `HSTS_MAX_AGE`            | `31536000`          | HSTS lifetime in seconds; `0` disables the header.             |
| `HSTS_PRELOAD`            | `true`              | Whether to include the `preload` directive.                    |
| `ALLOWED_ORIGINS`         | _(empty)_           | Comma-separated origin allowlist for CORS and the handshake.   |
| `TLS_PINNED_HOSTS`        | _(empty)_           | Hostnames the published pin set applies to.                    |
| `TLS_PINNED_SPKI_SHA256`  | _(empty)_           | Current pins, `sha256/<base64>`, comma-separated.              |
| `TLS_BACKUP_SPKI_SHA256`  | _(empty)_           | Backup pins. Required before clients will hard-fail.           |
| `TLS_PIN_MAX_AGE_SECONDS` | `5184000` (60 days) | How long a client may cache the policy document.               |
| `TLS_PIN_REPORT_URI`      | _(empty)_           | Where clients report pin-validation failures.                  |
