# Documentation Index

Every document in this repository, grouped by what you are trying to do rather than by
where the file happens to live. Each entry has a one-line description so you can pick the
right document without opening several first.

If you are new here, follow [Start here](#start-here) and ignore the rest until you need it.

> **Maintenance:** this index must be updated whenever a document is added, moved, or
> removed. A new `.md` file that is not listed here is effectively invisible — the whole
> point of this file is that it is exhaustive. See [Keeping this index honest](#keeping-this-index-honest).

---

## Start here

A first-time contributor should read these four, in this order. It is roughly an hour and
it is enough to make a scoped change and open a pull request.

1. [Root README](../README.md) — what Clicked is, the tech stack, and how to install and
   run the whole monorepo locally with `pnpm` and `docker compose`.
2. [System architecture overview](architecture-overview.md) — one diagram showing how the
   four apps and the external services fit together, plus two end-to-end request traces.
3. The one app doc for the area you are touching — pick your entry point from
   [By role](#by-role) below.
4. [Contributing guidelines](../README.md#-contributing) — branch naming, commit style,
   and the pull request process.

> **Note:** the contribution guidelines currently live in the "Contributing" section of the
> root README rather than in a top-level `CONTRIBUTING.md`. If a dedicated `CONTRIBUTING.md`
> is added later, this step and the link above should point at it instead.

---

## By role

### New contributor

You want orientation and the shortest path to a working local environment.

| Document | What it gives you |
| --- | --- |
| [Root README](../README.md) | Project pitch, tech stack, prerequisites, install, run, and test commands. |
| [System architecture overview](architecture-overview.md) | The single diagram of all four apps and every external service, with two traced end-to-end paths. |
| [Runbook](runbook.md) | Day-two operations: what to do when a service is unhealthy, and how to restart pieces safely. |
| [Observability](observability.md) | Which metrics, logs, and traces exist and where they are emitted, so you can see what your change did. |

### Backend developer

The Node.js gateway in `apps/backend`: REST, WebSockets, Postgres, Redis, and the chain
listener.

**Architecture and concepts**

| Document | What it gives you |
| --- | --- |
| [Gateway architecture](../apps/backend/docs/concepts-gateway-architecture.md) | Socket.IO connection lifecycle, room semantics, and how the gateway scales horizontally over Redis pub/sub. |
| [Delivery fan-out and receipts](../apps/backend/docs/concepts-delivery-fanout.md) | How one sent message reaches every recipient device, how receipts flow back, and which services are not actually wired into the live path. |
| [Storage and push jobs](../apps/backend/docs/concepts-storage-push-jobs.md) | Object storage layout and the background jobs that expire files, devices, and envelopes. |

**API reference**

| Document | What it gives you |
| --- | --- |
| [Auth API](../apps/backend/docs/api-auth.md) | Wallet-signature login, JWT issuance, and session refresh endpoints. |
| [Users API](../apps/backend/docs/api-users.md) | User profile read and update routes. |
| [Devices and prekeys API](../apps/backend/docs/api-devices.md) | Every `/devices` and `/user-devices` route: ownership checks, prekey upload contract, and revocation side effects. |
| [Conversations API](../apps/backend/docs/api-conversations.md) | Creating conversations, managing membership, and reading history. |
| [Messages and sync API](../apps/backend/docs/api-messages-sync.md) | Message history pagination and the cross-device sync cursor. |
| [Files and uploads API](../apps/backend/docs/api-files-uploads.md) | Encrypted attachment upload, download, and lifecycle. |
| [Push API](../apps/backend/docs/api-push.md) | Push subscription registration and notification dispatch. |
| [Treasury API](../apps/backend/docs/api-treasury.md) | REST routes for treasury proposals and votes, plus how they relate to the on-chain contracts. |
| [WebSocket events](../apps/backend/docs/api-websocket-events.md) | Every Socket.IO event the gateway emits and accepts, with direction and payload. |

**Contracts and schemas**

| Document | What it gives you |
| --- | --- |
| [JWT auth contract](../apps/backend/docs/contracts-jwt-auth.md) | Token claim shape, signing algorithm, and expiry rules. |
| [REST schemas](../apps/backend/docs/contracts-rest-schemas.md) | Request and response body schemas shared across the REST surface. |
| [WebSocket payloads](../apps/backend/docs/contracts-websocket-payloads.md) | Payload shapes for each WebSocket event, as validated on the wire. |

**Encryption and migrations**

| Document | What it gives you |
| --- | --- |
| [E2EE onboarding](../apps/backend/docs/e2ee-onboarding.md) | Device registration and prekey upload flow for first-contact DM setup. |
| [MLS key packages](../apps/backend/docs/mls-key-packages.md) | Key package publication, consumption, and replenishment. |
| [MLS group membership](../apps/backend/docs/mls-group-membership.md) | Adding and removing members from an MLS group and the resulting epoch changes. |
| [MLS group files](../apps/backend/docs/mls-group-files.md) | How file keys are distributed to an MLS group. |
| [Message encryption migration](../apps/backend/docs/message-encryption-migration.md) | Migrating stored messages onto the current encryption scheme. |
| [Signal migration](../apps/backend/docs/signal-migration.md) | Moving the double-ratchet implementation onto the Signal protocol. |
| [Backend security hardening](../apps/backend/docs/security-hardening.md) | Backend-specific hardening measures and the threats each one closes. |

### Frontend developer

The Next.js client in `apps/web`. It holds the private keys, so most of its documentation
is about encryption and local state.

**Concepts**

| Document | What it gives you |
| --- | --- |
| [Web app README](../apps/web/README.md) | Running the Next.js client on its own, its scripts, and its environment variables. |
| [E2EE architecture](../apps/web/docs/concepts-e2ee-architecture.md) | Where keys live in the browser, how sessions are established, and what never leaves the device. |
| [Message pipeline](../apps/web/docs/concepts-message-pipeline.md) | The client-side path from typed text to an encrypted envelope on the wire, and back. |
| [Auth and device lifecycle](../apps/web/docs/concepts-auth-device-lifecycle.md) | Wallet connection, device registration, session persistence, and revocation handling. |
| [File encryption](../apps/web/docs/concepts-file-encryption.md) | How attachments are encrypted client-side before upload. |
| [Local search](../apps/web/docs/concepts-local-search.md) | The on-device search index over decrypted message content. |
| [Push subscription](../apps/web/docs/concepts-push-subscription.md) | Service worker registration and push permission handling. |
| [Wallet and treasury UI](../apps/web/docs/concepts-wallet-treasury-ui.md) | How the wallet and treasury screens are composed and what they read from chain versus the backend. |

**Client APIs and types**

| Document | What it gives you |
| --- | --- |
| [REST client](../apps/web/docs/api-rest-client.md) | The typed wrapper around the backend REST surface. |
| [WebSocket client](../apps/web/docs/api-websocket-client.md) | Socket lifecycle, reconnection, and event subscription on the client. |
| [Soroban client](../apps/web/docs/api-soroban-client.md) | How the web app builds, signs, and submits Soroban contract invocations. |
| [Auth session contract](../apps/web/docs/contracts-auth-session.md) | The shape of the persisted session and what invalidates it. |
| [IndexedDB schemas](../apps/web/docs/contracts-indexeddb-schemas.md) | Every IndexedDB object store, its keys, and its migration history. |
| [Response types](../apps/web/docs/contracts-response-types.md) | Shared TypeScript response types used across the client. |
| [MLS integration notes](../apps/web/src/lib/mls-integration.md) | Implementation notes co-located with the MLS integration code. |
| [Search module README](../apps/web/src/lib/search/README.md) | Implementation notes for the local search module. |

### Contract developer

The Soroban workspace in `contracts/`: `token_transfer`, `group_treasury`, and `proposals`.

| Document | What it gives you |
| --- | --- |
| [Contracts README](../contracts/README.md) | Workspace layout, toolchain, and how to build and test the contracts. |
| [Deployment and invocation](../contracts/docs/api-deployment-invocation.md) | Deploying each contract, initialising it, and invoking it from the CLI, including required environment variables. |
| [Contract events reference](../contracts/docs/contracts-events.md) | Every published event across all three contracts, its topic and data shape, the state change it signals, and whether the backend listener consumes it. |
| [Proposals API](../contracts/docs/api-proposals.md) | The `proposals` contract surface: creating, voting, finalising, and executing. |
| [Token transfer API](../contracts/docs/api-token-transfer.md) | The `token_transfer` contract surface, including the memo field used to correlate a transfer with a chat message. |
| [Proposal lifecycle](../contracts/docs/concepts-proposal-lifecycle.md) | Every proposal status, the transitions between them, and what triggers each one. |
| [Token transfer flow](../contracts/docs/concepts-token-transfer-flow.md) | The end-to-end flow of an in-chat payment through the contract. |
| [Token transfer storage](../contracts/docs/contracts-token-transfer-storage.md) | Storage keys and value types used by `token_transfer`. |
| [WASM size and resource budget](../contracts/docs/concepts-resource-budget.md) | The 100 KB per-contract CI gate, current sizes and headroom, and the levers available when a contract approaches the limit. |

### Operator

Running and monitoring a deployment.

| Document | What it gives you |
| --- | --- |
| [Runbook](runbook.md) | Operational procedures: health checks, restarts, and incident response steps. |
| [Observability](observability.md) | Metrics, logs, and traces exposed by the services, and how to reach them. |
| [Deployment and invocation](../contracts/docs/api-deployment-invocation.md) | Contract deployment steps and the environment variables the backend needs to watch the chain. |
| [Storage and push jobs](../apps/backend/docs/concepts-storage-push-jobs.md) | The background jobs that run on a schedule and the storage they clean up. |

### Security reviewer

Threat model, hardening, and the crypto protocol documents.

| Document | What it gives you |
| --- | --- |
| [Threat model](threat-model.md) | Assets, adversaries, trust boundaries, and the mitigations claimed for each threat. |
| [Security fixes summary](../SECURITY_FIXES_SUMMARY.md) | A log of security issues found and the fixes applied for each. |
| [Audit logging](security/audit-logging.md) | What is audit-logged, in what format, and what is deliberately excluded. |
| [Rate limits](security/rate-limits.md) | Every rate limit in the system, its scope, and its threshold. |
| [TLS and pinning](security/tls-and-pinning.md) | Transport security requirements and certificate pinning behaviour. |
| [Backend security hardening](../apps/backend/docs/security-hardening.md) | Backend hardening measures and the threats each one closes. |
| [Signal integration](signal-integration.md) | How the Signal protocol is integrated and which guarantees it provides. |
| [Group epoch sync](group-epoch-sync.md) | How MLS group epochs stay synchronised across devices and what happens when they diverge. |
| [E2EE architecture](../apps/web/docs/concepts-e2ee-architecture.md) | The client-side key model — the basis for any claim that the server cannot read messages. |

### AI / data developer

The FastAPI service in `apps/ai_agent`.

| Document | What it gives you |
| --- | --- |
| [AI agent README](../apps/ai_agent/README.md) | Running the service locally with `uv`, and its environment variables. |
| [Chat API](../apps/ai_agent/docs/api-chat.md) | The assistant chat endpoint: request, response, and system prompt behaviour. |
| [Index and search API](../apps/ai_agent/docs/api-index-search.md) | Indexing documents into the vector store and querying them. |
| [Proposals summarise API](../apps/ai_agent/docs/api-proposals-summarise.md) | Summarising a governance proposal into a short digest. |
| [Transfers analyse API](../apps/ai_agent/docs/api-transfers-analyse.md) | Risk-scoring a transfer and the flagging threshold. |
| [RAG search architecture](../apps/ai_agent/docs/concepts-rag-search-architecture.md) | Retrieval-augmented search design: chunking, embedding, and retrieval. |
| [Transfer risk analysis](../apps/ai_agent/docs/concepts-transfer-risk-analysis.md) | The heuristics behind transfer risk scoring. |
| [Pydantic models](../apps/ai_agent/docs/contracts-pydantic-models.md) | Request and response model definitions for the service. |
| [Weaviate schema](../apps/ai_agent/docs/contracts-weaviate-schema.md) | The vector store collection schema and its properties. |

---

## Repository meta

Documents about the repository itself rather than about the product.

| Document | What it gives you |
| --- | --- |
| [Pull request template](../.github/pull_request_template.md) | The checklist every pull request is opened against. |
| [PR notes](../pr.md) | Scratch notes for an in-flight pull request; not a reference document. |

---

## Keeping this index honest

This file is the only entry point into the documentation, which means a document missing
from it is a document nobody will find.

- **Adding a document:** add a row to the section matching the *reader* who needs it, not
  the directory it lives in. If two roles need it, list it under both — duplication across
  role sections is intentional, since each section is meant to be read on its own.
- **Moving or deleting a document:** update or remove its row in the same commit. A broken
  link here is worse than no link.
- **Adding a new area:** if a new app or subsystem arrives with its own `docs/` directory,
  give it its own role section rather than appending to an existing one.

The scope of this index is every `.md` file in the repository except generated output and
dependency directories (`node_modules/`, `target/`, `.venv/`, build artefacts).
