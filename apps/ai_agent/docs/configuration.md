# AI agent configuration & environment reference

Every setting the `ai_agent` service reads, what happens when one is missing, and
which settings are not configurable at all.

The headline is short, and it is deliberately stated up front because it is the
opposite of what most services look like: **the service reads exactly one
environment variable, `OPENAI_API_KEY`.** Everything else — the model, the
Weaviate connection, the bind host and port — is hardcoded in
[`apps/ai_agent/main.py`](../main.py). Changing any of them is a code change, not
a deployment setting.

---

## 1. Environment variables

| Variable         | Required | Default | Read at                                                                | Effect when unset                                                                                                                                       |
| ---------------- | -------- | ------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY` | Yes\*    | _none_  | Per request, inside `_openai_client()` — not at import and not at boot | The process still starts and `/health` still returns 200; every OpenAI-backed endpoint returns 500. See [§3](#3-startup-and-missing-api-key-behaviour). |

\* Required for the service to do anything useful. It is _not_ required for the
process to start, and that distinction is the single most important thing in this
document.

It is the same key the backend uses — it is declared once in the repo-root
[`.env.example`](../../../.env.example) under `# AI Service`:

```bash
# AI Service
OPENAI_API_KEY=
```

There is no `.env` loading in `main.py` — no `python-dotenv`, no
`pydantic-settings`. The variable must be present in the process environment. In
local development that is whatever your shell or process manager exports; in
Docker or Kubernetes it is the container environment.

### Variables the service does **not** read

Worth stating explicitly, because their absence is easy to mistake for a bug:

| Variable                                           | Status                                                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_MODEL` (or any model-selection variable)   | Not read. Models are hardcoded — see [§2](#2-hardcoded-settings).                                                                               |
| `WEAVIATE_URL` / `WEAVIATE_HOST` / `WEAVIATE_PORT` | Not read. The connection is `weaviate.connect_to_local()` — see [§4](#4-weaviate-connection).                                                   |
| `WEAVIATE_API_KEY`                                 | Not read. The client connects unauthenticated.                                                                                                  |
| `HOST` / `PORT`                                    | Not read. See [§2](#2-hardcoded-settings).                                                                                                      |
| `OPENAI_BASE_URL`                                  | Not read. `OpenAI(api_key=...)` is constructed with no base URL override, so the SDK's own environment handling is the only way to redirect it. |

Setting any of these has no effect on this service.

---

## 2. Hardcoded settings

| Setting              | Value                                                  | Where                                                |
| -------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| Chat model           | `gpt-4o-mini`                                          | `chat`, `analyse_transfer`, `summarise_proposal`     |
| Embedding model      | `text-embedding-3-small`                               | `index_message`, `search_messages`                   |
| Bind host            | `0.0.0.0`                                              | `uvicorn.run(...)` under `if __name__ == "__main__"` |
| Bind port            | `8000`                                                 | same                                                 |
| Weaviate collection  | `Message`                                              | `index_message`, `search_messages`                   |
| Search result limit  | `5`                                                    | `search_messages`                                    |
| High-value threshold | `10_000.0` XLM                                         | `_HIGH_VALUE_THRESHOLD`, used by `analyse_transfer`  |
| Request timeouts     | 30 s for `/chat`, 10 s for the two JSON-mode endpoints | passed per call as `timeout=`                        |
| System prompt        | `_SYSTEM_PROMPT`                                       | module level                                         |

Two consequences:

- **Model changes require a code change and a deploy.** There is no way to move
  to a different model, or to run two environments on different models, through
  configuration.
- **The host and port literals only apply to `python main.py`.** Running the
  module directly executes the `__main__` block and binds `0.0.0.0:8000`. Under
  any ASGI server invoked against the app object — which is how the repo README
  runs it (`uv run fastapi dev main.py`) and how a container normally runs it —
  the `__main__` block never executes and the host/port come from that command:

  ```bash
  # __main__ block runs: binds 0.0.0.0:8000
  python main.py

  # __main__ block does NOT run: fastapi/uvicorn decides the bind address
  uv run fastapi dev main.py                        # defaults to 127.0.0.1:8000
  uv run uvicorn main:app --host 0.0.0.0 --port 9000
  ```

  So the port is effectively set by the launch command, and the `8000` in
  `main.py` is a default only for the direct-execution path. A deployment that
  needs a different port sets it on the server command line.

---

## 3. Startup and missing-API-key behaviour

`OPENAI_API_KEY` is read **per request**, inside the `_openai_client()` helper:

```python
def _openai_client():
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not configured")
    if OpenAI is None:
        raise HTTPException(status_code=500, detail="openai package is not installed")

    return OpenAI(api_key=api_key)
```

Nothing validates it at import time or at startup. The service therefore **starts
successfully with no API key at all** and fails only when an OpenAI-backed
endpoint is called.

### The exact behaviour, endpoint by endpoint

| Endpoint                    | With no `OPENAI_API_KEY`                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`               | **200** `{"status": "ok"}`                                                                                                                                                                                                                  |
| `POST /chat`                | **500** `{"detail": "OPENAI_API_KEY is not configured"}`                                                                                                                                                                                    |
| `POST /transfers/analyse`   | **500** — unless `amount > 10000`, which is answered by the rule-based branch **before** any OpenAI client is constructed, and still returns **200**                                                                                        |
| `POST /proposals/summarise` | **500**                                                                                                                                                                                                                                     |
| `POST /index/message`       | **500** if Weaviate is reachable (the embedding call needs the key); **503** if Weaviate is unreachable, because the connection is attempted first                                                                                          |
| `GET /search`               | Same as above — **503** on a Weaviate failure, **500** on the missing key when Weaviate is up, and **200** with `{"results": []}` when the `Message` collection does not exist, because that path returns before any embedding is requested |

### This is deliberate, and it is load-balancer-visible

`/health` is a liveness probe: it answers whether the process is up and serving,
not whether every downstream dependency is configured. Because it does not touch
`_openai_client()`, a misconfigured deployment presents as:

- **healthy** to any load balancer, orchestrator probe, or uptime monitor
  pointed at `/health`, and
- **completely broken** to every real caller, with a 500 on each request.

That combination is the failure mode to watch for. An instance rolled out with a
missing or misspelled key will pass its health check, be added to the pool, and
serve nothing but 500s. Kubernetes will not restart it; a load balancer will not
drain it.

The test suite pins this behaviour rather than leaving it incidental —
`apps/ai_agent/tests/test_health.py::test_health_works_without_api_key` asserts
the 200, and `apps/ai_agent/tests/test_chat.py::test_missing_api_key_returns_500`
asserts the 500. Changing either is a deliberate contract change.

**Operational recommendation.** Do not rely on `/health` to catch a
misconfiguration. Either:

- assert the key is present at deploy time (a startup check in your orchestration,
  or a required secret rather than an optional env var), or
- monitor the 5xx rate on `/chat` separately from the liveness probe, or
- add a readiness endpoint that checks configuration — deliberately distinct from
  `/health`, which should keep its current semantics.

### Related failure: the `openai` package missing

`main.py` imports `openai` inside a `try/except ImportError` and sets
`OpenAI = None` when it is absent, so an environment without the dependency also
starts cleanly and fails per-request with **500**
`{"detail": "openai package is not installed"}`. Same shape of problem, same
`/health`-still-green consequence.

---

## 4. Weaviate connection

### How it connects

```python
client = weaviate.connect_to_local()
```

No host, no port, no API key, no gRPC configuration. `connect_to_local()` from
`weaviate-client` (pinned at 4.22.0 in [`uv.lock`](../uv.lock), declared as
`>=4.0.0` in [`pyproject.toml`](../pyproject.toml)) uses its own defaults —
HTTP on `localhost:8080` and gRPC on `localhost:50051` — and this service
overrides none of them.

A connection is opened **per request** on `POST /index/message` and `GET /search`,
and closed in a `finally` block. There is no pooled or long-lived client, and no
connection is attempted at startup.

**There is no Weaviate service in [`infra/docker-compose.yml`](../../../infra/docker-compose.yml).**
That file brings up Postgres, Redis, and MinIO only. A Weaviate instance must be
run separately, and it must be reachable on the loopback defaults above from the
perspective of the `ai_agent` process — which means a containerised `ai_agent`
talking to a Weaviate in another container will not connect without host
networking or a code change, since `localhost` inside the container is the
container itself.

### Failure mode when Weaviate is unreachable

Both Weaviate-backed endpoints wrap the connection in `try/except` and translate
any failure to **503**:

```python
try:
    client = weaviate.connect_to_local()
except Exception:
    raise HTTPException(status_code=503, detail="Weaviate connection failed")
```

| Condition                                 | Response                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Weaviate down / unreachable               | **503** `{"detail": "Weaviate connection failed"}`                                                                               |
| Weaviate up, later operation fails        | **503** with the underlying exception text as `detail` — the second `except Exception as e` block re-raises as 503 with `str(e)` |
| Weaviate up, `Message` collection missing | `GET /search` → **200** `{"results": []}`; `POST /index/message` creates the collection and proceeds                             |
| Weaviate up, `OPENAI_API_KEY` missing     | **500** — the embedding call fails after the connection succeeds                                                                 |

Two points that matter operationally:

- **`/health` does not check Weaviate either.** A deployment with no Weaviate
  reachable is green on its liveness probe and serves 503s on `/search` and
  `/index/message`, exactly as with a missing API key. Chat and proposal
  summarisation are unaffected.
- **The 503 detail can leak internals.** The second handler passes `str(e)`
  straight into the response body, so a client can see raw client-library error
  text. Treat that as an internal-facing detail, not a stable contract.

`apps/ai_agent/tests/test_search.py::test_weaviate_connection_failure_returns_503`
pins the 503 behaviour, and `test_missing_collection_returns_empty_results` pins
the empty-result path, including that no query is issued. Note that the
equivalent failure on `POST /index/message` has no test of its own — the coverage
is on the `/search` side only.

### Collection schema

The collection is created on demand by `POST /index/message` with
`client.collections.create(name="Message")` — no property schema and no
vectoriser, because vectors are supplied explicitly from OpenAI embeddings.
Properties written per object are `conversationId`, `messageId`, `senderId`, and
`content`; searches filter on `conversationId` and return the top 5 by vector
similarity. See
[`contracts-weaviate-schema.md`](./contracts-weaviate-schema.md) for the full
shape and [`concepts-rag-search-architecture.md`](./concepts-rag-search-architecture.md)
for how it is used.

---

## 5. Running the service

From the repo root, as documented in the [main README](../../../README.md):

```bash
cd apps/ai_agent && uv run fastapi dev main.py
```

With the API key set for the process:

```bash
OPENAI_API_KEY=sk-... uv run fastapi dev main.py
```

Tests (Python 3.12+, per `requires-python` in `pyproject.toml`):

```bash
cd apps/ai_agent
uv sync --group dev
uv run pytest
```

The suite sets `OPENAI_API_KEY=test-key` for every test through an autouse
fixture in [`tests/conftest.py`](../tests/conftest.py) and mocks both `OpenAI`
and `weaviate.connect_to_local`, so **no network access and no real key are
needed** — and, as a corollary, a real misconfiguration will never be caught by
running the tests.

CI runs ruff, ruff format, mypy, and pytest with coverage via
[`.github/workflows/ai-agent-ci.yml`](../../../.github/workflows/ai-agent-ci.yml).

---

## 6. Configuration checklist for a deployment

- [ ] `OPENAI_API_KEY` is present in the process environment — verified by something other than `/health`.
- [ ] The `openai` package is installed in the runtime image (`uv sync`), or every request 500s.
- [ ] If `/search` or `/index/message` are used: a Weaviate instance is running and reachable at the client's local defaults **from the ai_agent process's own network namespace**.
- [ ] Bind host and port set on the server command line, not expected from env.
- [ ] Monitoring watches the 5xx rate on `/chat` and the 503 rate on `/search`, not just liveness.
- [ ] Model choice reviewed as a code change — `gpt-4o-mini` and `text-embedding-3-small` are compiled in.

---

## 7. Related documents

- [Repo-wide environment reference](../../../.env.example) — the single place every service's variables are declared, including the `OPENAI_API_KEY` this service shares with the backend. There is no separate env-reference document; `.env.example` is it.
- [Main README](../../../README.md) — how the AI service is started alongside the web and backend apps
- [`POST /chat`](./api-chat.md), [`POST /transfers/analyse`](./api-transfers-analyse.md), [`POST /proposals/summarise`](./api-proposals-summarise.md), [`/index` & `/search`](./api-index-search.md) — per-endpoint request/response contracts
- [Weaviate schema contract](./contracts-weaviate-schema.md) — the `Message` collection this service creates and queries
- [RAG search architecture](./concepts-rag-search-architecture.md) — how indexing and search fit together
- [Pydantic model contracts](./contracts-pydantic-models.md) — request/response models referenced above
