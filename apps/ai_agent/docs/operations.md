# AI agent operations guide

How to run the `ai_agent` service in production: the ASGI/uvicorn setup, what `/health` does and does not tell an orchestrator, the Weaviate dependency, scaling characteristics, and the state of cost controls on the LLM path.

This document describes the service as implemented in [apps/ai_agent/main.py](../main.py). Where the current implementation lacks an operational control, this document says so explicitly rather than describing an intended design — see [Known operational risks](#known-operational-risks).

## Overview

`ai_agent` is a single-module FastAPI application. It exposes five endpoints:

| Method | Path                   | External dependencies         |
| ------ | ---------------------- | ----------------------------- |
| `GET`  | `/health`              | none                          |
| `POST` | `/chat`                | OpenAI                        |
| `POST` | `/transfers/analyse`   | OpenAI (conditionally — see below) |
| `POST` | `/proposals/summarise` | OpenAI                        |
| `POST` | `/index/message`       | OpenAI **and** Weaviate       |
| `GET`  | `/search`              | OpenAI **and** Weaviate       |

The application object is `app`, defined at module scope in `main.py`. It holds no background tasks, no scheduler, no connection pool, and no in-process cache. Every request is fully independent, which is what makes the scaling story simple (see [Scaling characteristics](#scaling-characteristics)).

## Running the service

### The production start command

`main.py` ends with a `__main__` guard:

```python
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

Running `python main.py` therefore starts a **single-process, single-worker** uvicorn server on port 8000. This is the development path. Do not use it in production: it gives you one worker, no process supervision, and no way to set worker counts or timeouts without editing source.

For production, invoke uvicorn directly against the ASGI app path so that all server configuration lives in the command rather than in code:

```bash
uvicorn main:app \
  --host 0.0.0.0 \
  --port 8000 \
  --workers 4 \
  --timeout-keep-alive 65 \
  --no-server-header
```

`main:app` resolves to the `app` object in `main.py`, so the process must start with `apps/ai_agent` as the working directory (or that directory on `PYTHONPATH`). This mirrors the test configuration, which sets `pythonpath = ["."]` in `[tool.pytest.ini_options]` in [pyproject.toml](../pyproject.toml).

### Worker configuration

The endpoints are defined with `def`, not `async def`. FastAPI runs synchronous path operation functions in a **thread pool** rather than on the event loop, so a single worker can serve multiple concurrent requests despite the blocking OpenAI and Weaviate calls. The default thread pool is bounded (40 threads in current AnyIO defaults), which sets the practical per-worker concurrency ceiling.

Sizing guidance:

- **Workers**: start at `2 × CPU cores`. The service is I/O-bound, not CPU-bound — nearly all wall-clock time is spent waiting on OpenAI or Weaviate — so worker count is governed by memory and by upstream rate limits, not by core count.
- **Memory**: each worker is a full Python process that imports `fastapi`, `openai`, and `weaviate-client`. Budget conservatively and measure; do not assume workers are cheap.
- **Keep-alive**: set `--timeout-keep-alive` above your load balancer's idle timeout so the balancer, not the server, closes idle connections.

Because there is no shared state between requests, worker count can be changed freely without correctness consequences.

### Required environment

| Variable         | Required by                                            | Behaviour when absent                        |
| ---------------- | ------------------------------------------------------ | -------------------------------------------- |
| `OPENAI_API_KEY` | `/chat`, `/transfers/analyse`, `/proposals/summarise` | Those endpoints return `500`. `/health` still returns `200`. |
| `OPENAI_API_KEY` | `/index/message`, `/search` | Those endpoints return **`503`**, not `500` — see the note below. |

**The two Weaviate endpoints report a missing API key as `503`, even when Weaviate is healthy.** `_openai_client()` raises `HTTPException(500, ...)` as usual, but on `/index/message` and `/search` the embedding call sits inside a `try` block whose `except Exception as e` catches the `HTTPException` and re-raises it as a `503`, folding the original message into the detail. The observed response is:

```
503  {"detail": "500: OPENAI_API_KEY is not configured"}
```

The operational consequence: **a `503` from these two endpoints does not reliably mean Weaviate is down.** It may equally be an OpenAI misconfiguration. Read the `detail` string before concluding which dependency has failed — the `"500: "` prefix is the tell.

> **Correction.** [configuration.md](configuration.md#3-startup-and-missing-api-key-behaviour) states that these endpoints return `500` when Weaviate is reachable and only `503` when it is unreachable. That is not the observed behaviour: the broad `except Exception` catches `HTTPException` too, so the response is `503` in **both** cases. This was verified by exercising both endpoints with a mocked-healthy Weaviate and the key removed. The `503` is not a signal about which dependency failed.

The key is read **per request** inside `_openai_client()`, not once at import time:

```python
def _openai_client():
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not configured")
    if OpenAI is None:
        raise HTTPException(status_code=500, detail="openai package is not installed")

    return OpenAI(api_key=api_key)
```

Two operational consequences follow:

1. **The service starts successfully with no API key.** Misconfiguration is not caught at boot; it surfaces as `500`s on first LLM traffic. There is no startup validation to rely on.
2. **A new `OpenAI` client is constructed on every LLM request.** There is no shared client and therefore no connection pooling or client-level reuse across requests.

The Weaviate endpoints call `weaviate.connect_to_local()`, which targets `localhost:8080` (HTTP) and `localhost:50051` (gRPC) by default. There is no environment variable wired to override the Weaviate host in the current implementation — see [Known operational risks](#known-operational-risks).

## Health checking

```python
@app.get("/health")
def health_check():
    return {"status": "ok"}
```

`/health` returns `200` with body `{"status": "ok"}`.

### Semantics for orchestrators

**`/health` is a liveness probe, not a readiness probe.** It checks exactly one thing: that the ASGI process is running and able to serve a request. It performs no dependency checks whatsoever.

Specifically, `/health` returns `200` when:

- `OPENAI_API_KEY` is unset or invalid — the handler never calls `_openai_client()`, so the missing key is never detected. This behaviour is pinned by `test_health_works_without_api_key` in [tests/test_health.py](../tests/test_health.py).
- Weaviate is unreachable, unhealthy, or has never been started.
- The OpenAI API is down, rate-limiting the service, or the account is out of quota.

This is a deliberate property, and it is the correct behaviour for a liveness probe: an orchestrator must not restart a process because a *third-party* dependency is degraded. Restarting fixes nothing and turns a partial outage into a crash loop.

It also means **`/health` returning `200` does not mean the service can do useful work.** Do not treat it as a readiness signal, and do not gate a deploy on it alone.

Recommended orchestrator wiring:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 8000
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 3
```

Do **not** configure `/health` as a `readinessProbe` if your intent is "can this pod serve LLM traffic" — it will report ready with a missing API key and a dead Weaviate. There is no endpoint in the current implementation that verifies dependency health. Until one exists, readiness must be inferred from error-rate monitoring on the real endpoints (see [Monitoring](#monitoring)).

## The Weaviate dependency

Two endpoints depend on Weaviate: `POST /index/message` (writes) and `GET /search` (reads). The other three do not touch it at all.

Both follow the same connect/operate/close pattern:

```python
try:
    client = weaviate.connect_to_local()
except Exception:
    raise HTTPException(status_code=503, detail="Weaviate connection failed")

try:
    ...
except Exception as e:
    raise HTTPException(status_code=503, detail=str(e))
finally:
    client.close()
```

### Connection lifecycle

A **fresh Weaviate connection is opened and closed on every request**. There is no connection pool and no persistent client. `connect_to_local()` performs a startup handshake including a gRPC health check, so each request pays that setup cost. This is the single largest fixed overhead on the Weaviate path and the first thing to change if `/search` latency becomes a problem.

The `finally: client.close()` guarantees the connection is released on both the success and failure paths, so a Weaviate outage does not leak sockets.

### Behaviour when Weaviate is down

| Condition                                     | Endpoint         | Response                                                 |
| --------------------------------------------- | ---------------- | -------------------------------------------------------- |
| Weaviate unreachable (connect fails)          | `/index/message` | `503` — `{"detail": "Weaviate connection failed"}`       |
| Weaviate unreachable (connect fails)          | `/search`        | `503` — `{"detail": "Weaviate connection failed"}`       |
| Connects, then fails mid-operation            | `/index/message` | `503` — `detail` is the stringified exception            |
| Connects, then fails mid-operation            | `/search`        | `503` — `detail` is the stringified exception            |
| Connects, `Message` collection does not exist | `/search`        | `200` — `{"results": []}`                                |
| Connects, `Message` collection does not exist | `/index/message` | `200` — the collection is **created**, then written to   |

Two asymmetries are worth internalising:

**`/search` fails open on a missing collection.** If the `Message` collection does not exist, `/search` returns `200` with an empty result list rather than an error. From the caller's perspective a never-indexed corpus is indistinguishable from a genuine zero-hit query. An empty `/search` response is therefore *not* evidence that the index is healthy.

**`/index/message` creates the collection on demand.** The first successful index call after a fresh Weaviate deployment implicitly creates `Message`. There is no separate schema migration step to run, but it also means an accidental point at an empty Weaviate silently starts building a new index rather than failing loudly.

**Errors are surfaced verbatim.** On the mid-operation failure path, `detail=str(e)` returns the raw exception message to the caller. Treat `503` bodies from these endpoints as internal diagnostic data and do not render them directly in a user-facing surface.

### Blast radius

A Weaviate outage degrades search and indexing only. `/chat`, `/transfers/analyse`, and `/proposals/summarise` continue to serve normally because they never open a Weaviate connection. Availability of the two dependency groups should be tracked separately; a single aggregate error rate for the service will obscure which half is broken.

Note that both Weaviate endpoints *also* call OpenAI, for embeddings. `/index/message` and `/search` therefore need **both** dependencies healthy — and because the embedding call happens inside the broadly-caught `try` block, an OpenAI failure on these two endpoints is also reported as `503`, not `500`. The status code alone cannot tell the two dependencies apart here; only the `detail` string can.

## Scaling characteristics

**The service is stateless.** No session state, no in-process cache, no cross-request coordination, no sticky-session requirement. Scale horizontally by adding replicas behind any load balancer; scale vertically with `--workers`. Both are safe.

**Latency is dominated by upstream calls.** Per-request timeouts as configured in code:

| Endpoint               | Upstream call                    | Timeout   |
| ---------------------- | -------------------------------- | --------- |
| `/chat`                | chat completion (`gpt-4o-mini`)  | 30s       |
| `/transfers/analyse`   | chat completion (`gpt-4o-mini`)  | 10s       |
| `/proposals/summarise` | chat completion (`gpt-4o-mini`)  | 10s       |
| `/index/message`       | embedding + Weaviate write       | **none**  |
| `/search`              | embedding + Weaviate query       | **none**  |

The embedding calls in `/index/message` and `/search` pass no `timeout` argument, so they fall back to the OpenAI client default (10 minutes). Weaviate operations are likewise untimed. **A hung upstream on either Weaviate endpoint can occupy a thread-pool slot far longer than any of the chat endpoints can.** Under a partial OpenAI degradation, this is the failure mode most likely to exhaust worker capacity. Set an aggressive server-side or proxy-level request timeout in front of the service to bound it.

**Capacity is bounded by the upstream rate limit, not by the service.** Because there is no in-process concurrency limit on outbound calls, adding replicas multiplies the request rate you present to the OpenAI API. Past a certain replica count, additional capacity converts a latency problem into a `429` problem. Size replicas against your OpenAI organisation's rate limits, and note that the service does not currently retry or back off on `429` — the error propagates to the caller as a `500`.

**The rule-based short-circuit is the one free scaling win.** In `/transfers/analyse`, transfers above the threshold are resolved without an LLM call at all:

```python
_HIGH_VALUE_THRESHOLD = 10_000.0

if request.amount > _HIGH_VALUE_THRESHOLD:
    return TransferAnalyseResponse(
        flagged=True,
        reason=f"Amount {request.amount} XLM exceeds {_HIGH_VALUE_THRESHOLD} XLM threshold",
        confidence=0.99,
    )
```

These requests are pure CPU, return in microseconds, cost nothing, and cannot be affected by an OpenAI outage. `test_high_value_transfer_is_flagged_without_llm_call` in [tests/test_transfers.py](../tests/test_transfers.py) asserts the LLM is never called on this path. Note the boundary is strict `>`: an amount of exactly `10_000.0` takes the LLM path.

## Cost controls on the LLM path

**There are no rate limits, quotas, spend caps, caching, or per-caller throttling anywhere in the service.** This is a known gap, recorded here so it can be planned for rather than discovered during an incident.

What exists today:

- **Per-request timeouts** on the three chat endpoints (30s / 10s / 10s), which bound the duration of a single call but not the number of calls.
- **The `/transfers/analyse` high-value short-circuit**, which avoids an LLM call for large transfers.
- **A cheap model choice** — `gpt-4o-mini` for all chat completions and `text-embedding-3-small` for all embeddings. See [concepts-prompts-and-models.md](concepts-prompts-and-models.md) for the per-endpoint model detail and how to change it safely.
- **Bounded response size** on `/search`, which caps results at `limit=5`.

What does not exist:

- No rate limiting of any kind — no per-IP, per-caller, per-conversation, or global request cap. Any client that can reach the service can issue unbounded LLM calls.
- No authentication or authorisation on any endpoint. There is no API key check, no bearer token, and no caller identity. Combined with the absence of rate limiting, **any party with network reach to the service can spend against the OpenAI account directly.**
- No `max_tokens` on any completion call, so output length — and therefore per-call cost — is bounded only by the model's own limit.
- No cap on input size. `ChatRequest.message`, `IndexMessageRequest.content`, and the `/search` `q` parameter are unbounded strings. A large payload becomes a large token bill.
- No caching. Identical `/search` queries re-embed on every call; identical `/chat` messages re-complete on every call.
- No retry or backoff, so a `429` from OpenAI surfaces as a `500` rather than being absorbed.
- No cost or token-usage metric is recorded. `response.usage` is available on every OpenAI response and is discarded.

### Required mitigations

Until controls exist in the application, they must be enforced in the deployment:

1. **Do not expose the service to the public internet.** Bind it to an internal network and let only the backend reach it. This is the single most important control, because it is the only thing standing between an unauthenticated endpoint and an unbounded bill.
2. **Enforce rate limits at the ingress/gateway layer** — per-caller and global — since the application enforces none.
3. **Set a hard monthly spend cap and usage alerts in the OpenAI dashboard.** This is the only true backstop against runaway spend.
4. **Bound request body size at the proxy** to cap per-call token cost.
5. **Set an aggressive proxy request timeout** to cover the untimed embedding and Weaviate calls.

## Monitoring

There is no metrics endpoint, no structured logging, and no tracing in the service. Observability must come from the layer in front of it. Track at minimum:

- **Rate of `500`s on `/chat`, `/transfers/analyse`, and `/proposals/summarise`** — the signal for a missing/invalid `OPENAI_API_KEY`, an OpenAI outage, or `429` rate limiting, none of which `/health` will show.
- **Rate of `503`s on `/index/message` and `/search`** — a combined Weaviate *and* OpenAI failure signal, again invisible to `/health`. Because both dependencies collapse into the same status code here, alert on the code but triage on the `detail` string.
- **p99 latency on `/index/message` and `/search`** separately from the chat endpoints, because these are the untimed paths.
- **OpenAI spend and token usage**, from the provider dashboard, since the service records neither.

For the wider platform's metric conventions see [docs/observability.md](../../../docs/observability.md).

## Known operational risks

Recorded so they are tracked rather than rediscovered:

| # | Risk | Impact | Suggested mitigation |
| - | ---- | ------ | -------------------- |
| 1 | No authentication on any endpoint | Anyone with network reach can spend against the OpenAI account | Network isolation now; auth in the application |
| 2 | No rate limiting or spend cap in the application | Unbounded cost exposure under abuse or a client bug | Gateway rate limits + OpenAI dashboard spend cap |
| 3 | `/health` never checks dependencies | A pod reports healthy while unable to serve any real request | Treat as liveness only; add a separate readiness endpoint |
| 4 | No startup validation of `OPENAI_API_KEY` | Misconfiguration deploys cleanly and fails on first traffic | Validate at startup and fail fast |
| 5 | Weaviate host is not configurable | `connect_to_local()` hardcodes localhost; Weaviate must be co-located | Wire host/port to environment variables |
| 6 | No timeout on embedding or Weaviate calls | A hung upstream holds a worker thread for up to 10 minutes | Pass explicit timeouts; bound at the proxy |
| 7 | New `OpenAI` client and new Weaviate connection per request | Avoidable per-request setup latency | Reuse clients across requests via app lifespan |
| 8 | `503` bodies leak raw exception text | Internal detail exposed to callers | Log the exception; return a generic message |
| 8a | The broad `except Exception` on both Weaviate endpoints swallows `HTTPException`, remapping a `500` to a `503` | A missing API key is indistinguishable from a Weaviate outage by status code | Re-raise `HTTPException` unchanged; catch only Weaviate errors |
| 9 | `/search` returns `200` `{"results": []}` when the collection is missing | An unindexed corpus is indistinguishable from no matches | Distinguish the two states in the response |
| 10 | No `max_tokens` and no input size cap | Per-call cost is unbounded | Set `max_tokens`; validate input length |

## Related documents

- [Configuration reference](configuration.md) — environment variables and hardcoded settings in full (but see the correction above on the missing-key status code)
- [Prompts and model configuration](concepts-prompts-and-models.md) — models per endpoint, prompts, and output parsing
- [Testing guide](testing.md) — running the suite without a real model or vector store
- [Chat API](api-chat.md) — `POST /chat` request/response detail
- [Transfers analyse API](api-transfers-analyse.md) — `POST /transfers/analyse` detail
- [Proposals summarise API](api-proposals-summarise.md) — `POST /proposals/summarise` detail
- [Index and search API](api-index-search.md) — `POST /index/message` and `GET /search` detail
- [Weaviate schema](contracts-weaviate-schema.md) — the `Message` collection
- [RAG search architecture](concepts-rag-search-architecture.md) — how indexing and retrieval fit together
- [Operator runbook](../../../docs/runbook.md) — platform-wide failure modes and incident response
- [Observability](../../../docs/observability.md) — platform metric and dashboard conventions
