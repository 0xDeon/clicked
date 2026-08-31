# Security Policy

Clicked is an end-to-end encrypted messaging product that also moves funds on-chain. A
vulnerability here can expose private conversations or drain a treasury, and in the on-chain
case the damage may be irreversible. We take reports seriously and we would much rather hear
about a problem from you than from an incident.

---

## Reporting a vulnerability

**Report privately, through GitHub's private vulnerability reporting:**

> **<https://github.com/codebestia/clicked/security/advisories/new>**

That form is private between you and the maintainers. It creates a draft security advisory,
gives us a place to discuss the issue and share a fix with you before it is public, and lets
us credit you when the advisory is published.

If the form is unavailable to you for any reason, contact the maintainer
([@codebestia](https://github.com/codebestia)) directly on GitHub and ask for a private
channel. Do not include vulnerability details in that first message.

### Do not report vulnerabilities publicly

**Do not open a public issue, a public pull request, or a public discussion for a security
vulnerability, and do not post details on social media, in a chat channel, or in a commit
message before a fix has shipped.**

A public issue is a working exploit advertisement. The report is visible to everyone the
moment it is filed, while a fix takes days to write, review, and deploy — and in the case of
a non-upgradeable contract it may not be deployable at all. A pull request is worse: the diff
itself explains the bug, and anyone watching the repository is notified.

This applies even when the issue seems minor or you are not sure it is exploitable. Let us
make that call in private. If you are unsure whether something counts as a security issue,
report it privately anyway — a misfiled private report costs us nothing.

### What to include

The more of this you can supply, the faster we can triage:

- Which component is affected (backend, web client, contracts, AI agent) and the commit,
  branch, or deployed contract ID you tested against.
- A description of the vulnerability and the security property it breaks — for example
  "the server can recover message plaintext", "device A can read device B's envelopes",
  "a non-admin can withdraw from a treasury".
- Reproduction steps, ideally a minimal proof of concept: a failing test, a `curl` sequence,
  or a Soroban invocation.
- Your assessment of the impact and of any preconditions (does it need an authenticated
  session, a compromised device, a specific group state?).
- Whether you have disclosed this to anyone else, and any disclosure deadline you intend to
  hold us to.

### What to expect

| Stage                                                               | Target                     |
| ------------------------------------------------------------------- | -------------------------- |
| Acknowledgement that we received the report                         | **3 business days**        |
| Initial triage: severity, in scope or not, whether we can reproduce | **10 business days**       |
| Status updates while a fix is in progress                           | At least every **14 days** |
| Fix or documented mitigation for a confirmed high-severity issue    | **90 days** from triage    |

If you do not hear from us within the acknowledgement window, please ping the maintainer on
GitHub referencing the advisory — assume the notification was missed rather than ignored.

We aim to publish an advisory once a fix is available, crediting you by the name or handle
you ask for (or keeping you anonymous, if you prefer). Please give us a chance to ship the
fix before disclosing publicly; if you have a fixed disclosure deadline, say so in your first
message so we can plan against it.

There is no paid bug bounty for this project today.

---

## Scope

### In scope

**Backend gateway and API** (`apps/backend`)

- Authentication and session handling: wallet-signature challenge/verify, JWT issuance,
  claim validation, session or device binding bypass.
- Authorization: reading or writing a conversation, message, device, file, or treasury record
  you are not a member of or do not own.
- Anything that lets the server, or an attacker with server access, obtain message plaintext
  or private key material — the ciphertext-only invariants are load-bearing for every claim
  this product makes.
- Injection into the database, the object store, or the Socket.IO event path; envelope
  validation or idempotency bypass on the `dispatch` event.
- Rate-limit bypass that enables credential stuffing, prekey exhaustion, or resource
  exhaustion of the gateway.
- Presigned upload/download URL flaws: forgery, scope escalation, or access to another
  conversation's blobs.

**Web client cryptography** (`apps/web`)

- Flaws in the E2EE implementation: X3DH, the double ratchet, MLS group operations, session
  or epoch handling, safety-number computation.
- Key generation, storage, or lifetime bugs — weak randomness, a private key leaving the
  device, keys surviving a revocation, keys readable from another origin.
- File encryption: key reuse, nonce reuse, unauthenticated ciphertext, a file key reaching
  the wrong recipient.
- Identity-trust bugs: accepting an unverified identity key change, or failing to surface one.
- Client-side XSS or a content-injection path that reaches decrypted message content or
  IndexedDB.

**Smart contracts** (`contracts/`: `token_transfer`, `group_treasury`, `proposals`)

- Any path that moves funds without correct authorization, or that lets a caller bypass
  `require_auth`.
- Treasury multisig or voting logic that can be subverted: double-voting, quorum manipulation,
  replaying or re-executing a proposal, executing a proposal that did not pass.
- Arithmetic overflow/underflow, accounting errors, and storage-key collisions.
- Abuse of the admin-gated `upgrade` entrypoint on `token_transfer`.

**AI agent** (`apps/ai_agent`) — in scope where a flaw exposes user data or is reachable from
untrusted input; prompt-quality complaints are not security issues.

**Repository and supply chain** — leaked credentials committed to the repository, a
compromised or typosquatted dependency, or a CI workflow that can be made to execute
attacker-controlled code.

### Out of scope

- **Denial of service through raw volume.** Load-testing a deployment, traffic floods, or
  resource exhaustion that requires attacker bandwidth rather than an application flaw.
- **Automated scanner output with no demonstrated impact** — a CVE in a transitive dependency
  on a code path this project does not reach, or a "missing header" report with no exploit.
- **Missing hardening that is not itself a vulnerability**: absent security headers, cookie
  flags on endpoints that set no cookies, verbose non-sensitive error messages, TLS
  configuration of a deployment we do not control.
- **Social engineering, phishing, or physical attacks** against maintainers or users.
- **Vulnerabilities requiring a fully compromised device or a malicious OS/browser
  extension.** The threat model assumes the endpoint is trusted; an attacker with the user's
  device already has their keys.
- **Third-party services** — the Stellar network itself, a wallet extension such as Freighter,
  browser push providers, the LLM or vector-store vendors. Report those to their owners.
- **Anything already documented as an accepted residual risk** — see below.
- Findings in a fork, a stale branch, or code that was never merged to `dev` or `main`.

### Testing rules

Test against your own local deployment and your own accounts. Do not test against another
person's account or data, do not exfiltrate data beyond the minimum needed to demonstrate the
issue, and do not degrade a shared environment. For contracts, use **testnet** — see
[Contract-specific reporting](#contract-specific-reporting) below.

---

## Known and accepted residual risk

Before reporting, please read the **[threat model](docs/threat-model.md)**. It states exactly
what the server can and cannot see, and its "Residual metadata risk" section lists risks that
are inherent to operating a centralized delivery service and are **known and accepted**,
including:

- the **social graph** — conversation membership reveals who talks to whom,
- **traffic analysis** — message timing and ciphertext size leak coarse signals,
- **presence and activity patterns**,
- **device fingerprinting** via device name, platform, and prekey consumption rate.

A report that these are observable is not a vulnerability report; it is a restatement of the
documented design. A report that some _content_, _key material_, or _session state_ is
observable when the threat model says it is not — that is exactly what we want to hear about,
and it is a high-severity finding.

Related reading, all of which describes intended behaviour rather than bugs:

- [Threat model](docs/threat-model.md) — trust boundaries and what the server sees.
- [Backend security hardening](apps/backend/docs/security-hardening.md) — measures already in
  place and the threats each closes.
- [Rate limits](docs/security/rate-limits.md) — every bucket and its threshold.
- [Audit logging](docs/security/audit-logging.md) — what is logged and what is deliberately
  excluded.
- [TLS and pinning](docs/security/tls-and-pinning.md) — transport security expectations.
- [E2EE architecture](apps/web/docs/concepts-e2ee-architecture.md) — the client-side key model.

---

## Contract-specific reporting

**Treat an on-chain finding as more urgent than an equivalent server-side one, and be more
careful with it.** A backend bug is fixed by a deploy; an on-chain bug frequently is not.

- **Most of this system's contracts cannot be patched in place.** Only `token_transfer` has an
  `upgrade` entrypoint (admin-gated `update_current_contract_wasm`). `group_treasury` and
  `proposals` expose **no upgrade function at all** — their deployed WASM is immutable for the
  life of the contract instance. Fixing a bug in either one means deploying a _new_ contract,
  migrating state, and repointing every consumer at the new contract ID. See
  [Contract upgrades and versioning](contracts/docs/concepts-upgrades.md).
- **Funds already in a vulnerable contract may not be recoverable.** Because a redeploy does
  not move existing balances or proposal state, a live exploit can be unfixable after the
  fact. Time between report and mitigation matters much more than usual, and mitigation may
  have to start with pausing usage and moving funds rather than with a code change.
- **Never test a contract vulnerability against mainnet or against a deployed instance holding
  real funds.** Reproduce it in the Soroban test environment (`cargo test` against
  `Env::default()`) or on testnet with your own deployment. A proof of concept executed
  against a live treasury is an exploit, not research, regardless of intent.
- **The strongest proof of concept for a contract finding is a failing Rust test.** Add a
  `#[test]` against the contract in question and send us the test — it removes all ambiguity
  about preconditions and cannot be mistaken for an attack. See the
  [contract testing guide](contracts/docs/testing.md).
- **Include the contract ID and network** you tested against, and say explicitly whether the
  issue affects an already-deployed instance or only the current source.
- **If the finding involves the `upgrade` entrypoint or the admin key**, flag that in the first
  line of your report. Admin compromise on `token_transfer` is the highest-severity class of
  finding in this repository, because it converts an upgradeable contract into an
  attacker-controlled one.

---

## Supported versions

This project is pre-1.0 and under active development. Security fixes are applied to the
`dev` branch and flow to `main`; there are no maintained release branches and no backports to
older tags. Run a current checkout of `main`.

| Version         | Supported |
| --------------- | --------- |
| `main` (latest) | Yes       |
| `dev` (latest)  | Yes       |
| Anything older  | No        |
