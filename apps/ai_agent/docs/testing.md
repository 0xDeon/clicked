# AI agent testing guide

How the `ai_agent` pytest suite is configured, what each fixture in [tests/conftest.py](../tests/conftest.py) patches, and how to add a test for a new endpoint without ever calling a real model or vector store.

## Running the suite

All commands run from `apps/ai_agent`.

```bash
# install dev dependencies (pytest, pytest-mock, pytest-cov, httpx)
uv sync --extra dev

# run everything
uv run pytest

# one module
uv run pytest tests/test_chat.py

# one test
uv run pytest tests/test_chat.py::test_correct_model_used

# quieter, stop on first failure
uv run pytest -q -x
```

The suite is fully hermetic: **no test makes a network call, and none requires a running Weaviate or a real OpenAI key.** Every external dependency is patched. A test that hangs or hits the network is a bug in that test, not a missing service.

## Test configuration

From [pyproject.toml](../pyproject.toml):

```toml
[tool.pytest.ini_options]
pythonpath = ["."]
testpaths = ["tests"]
addopts = "--cov=. --cov-report=term-missing --cov-config=pyproject.toml"

[tool.coverage.run]
omit = ["tests/*"]
```

What each line does:

- **`pythonpath = ["."]`** puts `apps/ai_agent` on `sys.path`, which is what makes the bare `from main import app` import work. Without it every test module fails at import. It is also why pytest must be invoked from `apps/ai_agent` rather than the repo root.
- **`testpaths = ["tests"]`** scopes collection to `tests/`, so a bare `pytest` never wanders into other packages.
- **`addopts`** applies coverage flags automatically — plain `pytest` already produces a coverage report; you never pass `--cov` by hand.

Dev dependencies that matter to the suite: `pytest`, `pytest-mock` (provides the `mocker` fixture the conftest fixtures are built on), `pytest-cov`, and `httpx` (required by FastAPI's `TestClient`).

## Fixtures

[tests/conftest.py](../tests/conftest.py) defines four fixtures, available to every test module without import.

### `set_openai_key` — autouse

```python
@pytest.fixture(autouse=True)
def set_openai_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure OPENAI_API_KEY is always set so _openai_client() doesn't 500."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
```

- **Patches**: the `OPENAI_API_KEY` environment variable.
- **Default**: the literal string `"test-key"`.
- **Autouse**: applies to **every test in the suite** — you never request it by name.

This exists because `_openai_client()` reads the key on every call and raises `HTTPException(500, "OPENAI_API_KEY is not configured")` when it is absent. Without this fixture, every LLM endpoint test would return `500` on a developer machine with no key set, and results would differ between local runs and CI. The value is never used to authenticate — the OpenAI client is always patched out — it only has to be non-empty.

`monkeypatch` reverts the variable after each test, so there is no leakage between tests.

**To test the missing-key path, delete the variable inside the test**, which overrides the autouse fixture for that test only:

```python
def test_missing_api_key_returns_500(monkeypatch, client):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    response = client.post("/chat", json=_BASE_BODY)
    assert response.status_code == 500
```

`raising=False` keeps the call safe when the variable is already gone.

### `client`

```python
@pytest.fixture()
def client() -> TestClient:
    """FastAPI TestClient for the main app."""
    from main import app

    return TestClient(app)
```

- **Patches**: nothing. It constructs a real `TestClient` around the real `app`.
- **Returns**: a `fastapi.testclient.TestClient` bound to the app from `main.py`.

`TestClient` dispatches requests in-process through the ASGI app — no socket is opened and no server is started. Routing, Pydantic request validation, `response_model` validation, and `HTTPException` handling all run exactly as in production, so status codes and bodies are trustworthy.

The `from main import app` import is deliberately *inside* the fixture body rather than at module top level, so the app is imported when the fixture first runs rather than at conftest collection time.

Note this fixture is function-scoped: each test gets a fresh `TestClient` over the same module-level `app` object.

### `mock_openai`

```python
@pytest.fixture()
def mock_openai(mocker):
    """Patch the OpenAI client used inside main.py."""
    return mocker.patch("main.OpenAI")
```

- **Patches**: the `OpenAI` **class** as bound in `main`'s namespace (`main.OpenAI`).
- **Returns**: the `MagicMock` that replaced the class.

The patch target is `main.OpenAI`, not `openai.OpenAI`, because `main.py` does `from openai import OpenAI` — the name must be patched where it is *used*, not where it is defined.

Because the class is patched, `_openai_client()` still runs for real: it still checks `OPENAI_API_KEY` (supplied by the autouse fixture), still checks `OpenAI is None`, and then calls `OpenAI(api_key=api_key)` — which now returns `mock_openai.return_value`. **That means the instance your endpoint uses is `mock_openai.return_value`**, and that is the object to configure:

```python
def test_valid_request_returns_reply(mock_openai, client):
    mock_client = mock_openai.return_value
    mock_client.chat.completions.create.return_value = _fake_chat_reply("Hello from Clicked AI!")
```

By default — with nothing configured — every attribute access returns a fresh `MagicMock`. That is enough to prove no real call was made, but not enough for an endpoint that reads `response.choices[0].message.content`: a bare `MagicMock` there fails `ChatResponse` validation. Configure a return value whenever the handler reads the response.

The mock also records calls, which is how the suite asserts on prompts and model IDs without a real request:

```python
call_args = mock_client.chat.completions.create.call_args
assert call_args[1]["model"] == "gpt-4o-mini"
messages = call_args[1]["messages"]
assert messages[0]["role"] == "system"
```

### `mock_weaviate`

```python
@pytest.fixture()
def mock_weaviate(mocker):
    """Patch weaviate.connect_to_local used inside main.py."""
    return mocker.patch("main.weaviate.connect_to_local")
```

- **Patches**: the `connect_to_local` function on the `weaviate` module as seen from `main`.
- **Returns**: the `MagicMock` that replaced the function.

`main.py` does `import weaviate` and calls `weaviate.connect_to_local()`, so the attribute on the module object is the correct target. The connected client your endpoint receives is `mock_weaviate.return_value`.

By default it returns a `MagicMock`, so `client.collections.exists(...)` returns a truthy `MagicMock` rather than a real boolean. For `/search`, whose branch on `collections.exists("Message")` decides between an empty result and a query, set it explicitly:

```python
def test_search_returns_empty_when_collection_missing(mock_weaviate, mock_openai, client):
    mock_weaviate.return_value.collections.exists.return_value = False
    ...
```

To simulate an outage, give the mock a `side_effect` so the `try`/`except` around `connect_to_local()` fires:

```python
mock_weaviate.side_effect = Exception("connection refused")
# endpoint now returns 503 {"detail": "Weaviate connection failed"}
```

The default `MagicMock` also satisfies the `finally: client.close()` in both Weaviate endpoints, so no extra setup is needed for teardown.

### A note on existing modules

The fixtures above are the intended approach for new tests, but **the suite is not uniform today**. Only [tests/test_chat.py](../tests/test_chat.py) uses `client` and `mock_openai` throughout. [tests/test_search.py](../tests/test_search.py), [tests/test_transfers.py](../tests/test_transfers.py), and [tests/test_health.py](../tests/test_health.py) instead build a module-level `TestClient(app)` and use `unittest.mock.patch` inline — often patching `main._openai_client` (the helper) rather than `main.OpenAI` (the class).

Both styles work. Patching `main._openai_client` bypasses the real helper entirely, which is why `test_transfers.py` can assert `mock_openai.assert_not_called()` to prove the high-value rule never reaches the LLM. Prefer the conftest fixtures in new code — they are shorter and consistent — but do not treat the older modules as broken.

## Worked example: adding a test for a new endpoint

Suppose a `POST /proposals/classify` endpoint is added to `main.py`, calling `gpt-4o-mini` in JSON mode and returning a typed `category` plus `confidence`, with `category` clamped to `"treasury"` when the model returns something invalid.

Create `tests/test_classify.py`. There is no fixture import and no conftest boilerplate — fixtures are injected by name.

```python
"""Unit tests for POST /proposals/classify."""

import json
from unittest.mock import MagicMock

_BASE_BODY = {
    "title": "Fund the Q3 audit",
    "description": "Engage an external auditor for the treasury contracts.",
    "amount": 2500.0,
}


def _fake_json_response(payload: dict):
    """Shape a MagicMock like an OpenAI chat completion carrying `payload` as JSON."""
    msg = MagicMock()
    msg.content = json.dumps(payload)
    choice = MagicMock()
    choice.message = msg
    resp = MagicMock()
    resp.choices = [choice]
    return resp


def test_returns_classification(mock_openai, client):
    mock_client = mock_openai.return_value
    mock_client.chat.completions.create.return_value = _fake_json_response(
        {"category": "treasury", "confidence": 0.87}
    )

    response = client.post("/proposals/classify", json=_BASE_BODY)

    assert response.status_code == 200
    data = response.json()
    assert data["category"] == "treasury"
    assert data["confidence"] == 0.87


def test_uses_expected_model_and_json_mode(mock_openai, client):
    mock_client = mock_openai.return_value
    mock_client.chat.completions.create.return_value = _fake_json_response(
        {"category": "treasury", "confidence": 0.5}
    )

    client.post("/proposals/classify", json=_BASE_BODY)

    kwargs = mock_client.chat.completions.create.call_args[1]
    assert kwargs["model"] == "gpt-4o-mini"
    assert kwargs["response_format"] == {"type": "json_object"}


def test_prompt_includes_proposal_fields(mock_openai, client):
    mock_client = mock_openai.return_value
    mock_client.chat.completions.create.return_value = _fake_json_response(
        {"category": "treasury", "confidence": 0.5}
    )

    client.post("/proposals/classify", json=_BASE_BODY)

    prompt = mock_client.chat.completions.create.call_args[1]["messages"][0]["content"]
    assert "Fund the Q3 audit" in prompt
    assert "2500.0" in prompt


def test_invalid_category_is_clamped(mock_openai, client):
    """A category outside the allowed set must degrade, not leak through."""
    mock_client = mock_openai.return_value
    mock_client.chat.completions.create.return_value = _fake_json_response(
        {"category": "nonsense", "confidence": 0.4}
    )

    response = client.post("/proposals/classify", json=_BASE_BODY)

    assert response.status_code == 200
    assert response.json()["category"] == "treasury"


def test_missing_confidence_defaults_to_zero(mock_openai, client):
    mock_client = mock_openai.return_value
    mock_client.chat.completions.create.return_value = _fake_json_response(
        {"category": "treasury"}
    )

    response = client.post("/proposals/classify", json=_BASE_BODY)

    assert response.status_code == 200
    assert response.json()["confidence"] == 0.0


def test_missing_title_returns_422(client):
    """Pydantic rejects the body before any model call — no mock needed."""
    response = client.post(
        "/proposals/classify",
        json={"description": "no title", "amount": 100.0},
    )
    assert response.status_code == 422


def test_missing_api_key_returns_500(monkeypatch, client):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    response = client.post("/proposals/classify", json=_BASE_BODY)
    assert response.status_code == 500
```

The pattern generalises to any endpoint:

1. **Request `mock_openai` and/or `mock_weaviate`** for endpoints with external calls. Omit both for pure-validation tests — `test_missing_title_returns_422` never reaches a client, so mocking it would be noise.
2. **Never request `set_openai_key`** — it is autouse.
3. **Shape the mock response to what the handler reads.** For chat completions that is `response.choices[0].message.content`; for embeddings it is `response.data[0].embedding`. A local helper like `_fake_json_response` keeps this in one place.
4. **Assert on `call_args`** to pin the model, JSON mode, and prompt contents without a real call.
5. **Cover the degradation paths, not just the happy path.** Missing keys, invalid enum values, and malformed JSON are where the parsing layer earns its keep — see [concepts-prompts-and-models.md](concepts-prompts-and-models.md#output-parsing-and-validation) for what each endpoint does with bad output.
6. **Cover the `422` and `500` boundaries** — Pydantic rejection and missing API key.

For a Weaviate-backed endpoint, add `mock_weaviate` and shape the embedding response too:

```python
def test_search_returns_hits(mock_weaviate, mock_openai, client):
    embedding = MagicMock()
    embedding.embedding = [0.1] * 1536
    embed_result = MagicMock()
    embed_result.data = [embedding]
    mock_openai.return_value.embeddings.create.return_value = embed_result

    obj = MagicMock()
    obj.properties = {
        "messageId": "msg-1",
        "conversationId": "conv-abc",
        "senderId": "user-1",
        "content": "payment sent",
    }
    query_result = MagicMock()
    query_result.objects = [obj]

    wv = mock_weaviate.return_value
    wv.collections.exists.return_value = True
    wv.collections.get.return_value.query.near_vector.return_value = query_result

    response = client.get("/search", params={"q": "payment", "conversationId": "conv-abc"})

    assert response.status_code == 200
    assert response.json()["results"][0]["messageId"] == "msg-1"
```

## Coverage

Coverage runs automatically on every invocation via `addopts`:

```toml
addopts = "--cov=. --cov-report=term-missing --cov-config=pyproject.toml"
```

- **`--cov=.`** measures everything under `apps/ai_agent` — in practice `main.py`, since it is the only application module.
- **`--cov-report=term-missing`** prints the report to the terminal *and* lists the specific line numbers not executed. This is the useful part: it names the untested lines rather than just a percentage.
- **`--cov-config=pyproject.toml`** reads coverage settings from `[tool.coverage.run]`, which sets `omit = ["tests/*"]` so the test files do not inflate their own numbers.

### Reading the report

Output appears after the test results. This is the report from the suite as it currently stands:

```
...................................                                      [100%]
=============================== tests coverage ================================
_______________ coverage: platform win32, python 3.12.5-final-0 _______________

Name      Stmts   Miss  Cover   Missing
---------------------------------------
main.py     120     22    82%   83, 183-228, 267-268, 274
---------------------------------------
TOTAL       120     22    82%
35 passed
```

- **`Stmts`** — executable statements measured (not physical lines; blanks, comments, and most `def` bodies-as-declarations are excluded).
- **`Miss`** — statements never executed by any test.
- **`Cover`** — `(Stmts - Miss) / Stmts`.
- **`Missing`** — the line numbers that were missed, as individual lines and ranges. Open `main.py` at those lines to see exactly what is untested.

Reading the current report: **`183-228` is the entire body of `index_message`**, which is the coverage gap described below. The rest is minor — `83` is the `OpenAI is None` guard in `_openai_client()` (unreachable while the package is installed), `267-268` is the exception branch in `/search`, and `274` is the `uvicorn.run(...)` line under `if __name__ == "__main__"`, which never executes under pytest.

Closing the `/index/message` gap is worth roughly 38 statements, taking the module from 82% to around 97%.

A useful additional report when hunting gaps interactively:

```bash
uv run pytest --cov-report=html
open htmlcov/index.html
```

This renders each source line green (covered) or red (missed), which is faster to scan than a line-number list.

Note that coverage is measured but **not enforced** — there is no `fail_under` setting, so a drop in coverage will not fail the build. Read the `Missing` column rather than relying on a gate.

## Known gap: `/index/message` has no test module

The `tests/` directory contains `test_chat.py`, `test_health.py`, `test_proposals.py`, `test_search.py`, and `test_transfers.py`. **There is no `test_index.py`, and no test anywhere in the suite exercises `POST /index/message`.**

This is the single largest coverage gap in the service, and it is a good first contribution — the fixtures needed already exist, and `test_search.py` provides a close template since it patches the same two dependencies.

`/index/message` is also the most complex endpoint to test properly, because it is the only one that both embeds *and* writes, with a branch on whether the object already exists. The cases worth covering:

| Case | Setup | Expected |
| ---- | ----- | -------- |
| Weaviate unreachable | `mock_weaviate.side_effect = Exception(...)` | `503`, `{"detail": "Weaviate connection failed"}` |
| `Message` collection missing | `collections.exists.return_value = False` | Collection is **created** via `collections.create(name="Message")`, then written |
| New message (insert path) | `collection.data.exists.return_value = False` | `collection.data.insert` called; `replace` not called |
| Existing message (upsert path) | `collection.data.exists.return_value = True` | `collection.data.replace` called; `insert` not called |
| Correct embedding model | any success path | `embeddings.create` called with `model="text-embedding-3-small"` |
| Properties written correctly | any success path | `properties` carries `messageId`, `conversationId`, `senderId`, `content`; `uuid` is `messageId` |
| Mid-operation failure | make `data.insert` raise | `503` with the stringified exception as `detail` |
| Connection always closed | any path, success or failure | `mock_weaviate.return_value.close.assert_called_once()` |
| Missing required field | post a body without `content` | `422` |
| Missing API key | `monkeypatch.delenv("OPENAI_API_KEY", ...)` | **`503`**, not `500` — see below |

Watch the last row: it is the one case here that does not behave the way the other endpoints do. `_openai_client()` raises `HTTPException(500, ...)`, but on this endpoint that call sits inside the `try` whose `except Exception as e` re-raises everything as `503`, with the original message carried through as `detail`. The assertion to write is:

```python
def test_missing_api_key_returns_503(monkeypatch, mock_weaviate, client):
    """The broad except on this endpoint remaps the helper's 500 to a 503."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    mock_weaviate.return_value.collections.exists.return_value = True

    response = client.post("/index/message", json=_BODY)

    assert response.status_code == 503
    assert "OPENAI_API_KEY" in response.json()["detail"]
```

`GET /search` has the identical structure and the identical behaviour.

The `close()` assertion is worth including on both a success and a failure case — it is the only guard against a Weaviate outage leaking connections, and it is currently unverified. See [operations.md](operations.md#the-weaviate-dependency) for the connection lifecycle this protects.

## Related documents

- [Operations guide](operations.md) — running the service, health checks, dependencies
- [Prompts and model configuration](concepts-prompts-and-models.md) — prompts, models, and the parsing behaviour these tests pin
- [Pydantic models](contracts-pydantic-models.md) — request/response shapes driving the `422` cases
- [Weaviate schema](contracts-weaviate-schema.md) — the `Message` collection the index tests would assert against
- [Index and search API](api-index-search.md) — the endpoint behaviour behind the coverage gap
- [Chat API](api-chat.md) · [Transfers analyse API](api-transfers-analyse.md) · [Proposals summarise API](api-proposals-summarise.md)
