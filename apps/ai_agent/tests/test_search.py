"""Unit tests for GET /search (issue #149)."""

from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

_BASE_PARAMS = {"q": "payment to Alice", "conversationId": "conv-abc"}


def _make_weaviate_client(*, exists: bool = True, objects=None):
    """Build a mock weaviate client."""
    mock_client = MagicMock()
    mock_client.collections.exists.return_value = exists

    if objects is not None:
        mock_result = MagicMock()
        mock_result.objects = objects
        mock_client.collections.get.return_value.query.near_vector.return_value = mock_result

    return mock_client


def _make_openai_embedding():
    """Build a mock OpenAI client that returns a dummy embedding."""
    mock_openai = MagicMock()
    embed_data = MagicMock()
    embed_data.embedding = [0.1] * 1536
    embed_result = MagicMock()
    embed_result.data = [embed_data]
    mock_openai.embeddings.create.return_value = embed_result
    return mock_openai


def test_weaviate_connection_failure_returns_503():
    with patch("main.weaviate.connect_to_local", side_effect=Exception("connection refused")):
        response = client.get("/search", params=_BASE_PARAMS)
    assert response.status_code == 503


def test_missing_collection_returns_empty_results():
    """When collection doesn't exist, return empty results without querying Weaviate."""
    mock_wv = _make_weaviate_client(exists=False)
    with patch("main.weaviate.connect_to_local", return_value=mock_wv):
        response = client.get("/search", params=_BASE_PARAMS)
    assert response.status_code == 200
    assert response.json() == {"results": []}
    # Weaviate query must NOT have been called
    mock_wv.collections.get.return_value.query.near_vector.assert_not_called()


def test_returns_results_with_correct_shape():
    obj = MagicMock()
    obj.properties = {
        "messageId": "msg-1",
        "conversationId": "conv-abc",
        "senderId": "user-1",
        "content": "send 50 XLM to Alice",
    }
    mock_wv = _make_weaviate_client(exists=True, objects=[obj])

    with (
        patch("main.weaviate.connect_to_local", return_value=mock_wv),
        patch("main._openai_client", return_value=_make_openai_embedding()),
    ):
        response = client.get("/search", params=_BASE_PARAMS)

    assert response.status_code == 200
    data = response.json()
    assert "results" in data
    assert len(data["results"]) == 1
    hit = data["results"][0]
    assert hit["messageId"] == "msg-1"
    assert hit["conversationId"] == "conv-abc"
    assert hit["senderId"] == "user-1"
    assert hit["content"] == "send 50 XLM to Alice"


def test_filters_by_conversation_id():
    obj = MagicMock()
    obj.properties = {
        "messageId": "msg-2",
        "conversationId": "conv-xyz",
        "senderId": "user-2",
        "content": "transfer 100 XLM",
    }
    mock_wv = _make_weaviate_client(exists=True, objects=[obj])

    with (
        patch("main.weaviate.connect_to_local", return_value=mock_wv),
        patch("main._openai_client", return_value=_make_openai_embedding()),
    ):
        response = client.get("/search", params={"q": "transfer", "conversationId": "conv-xyz"})

    assert response.status_code == 200
    # Verify the near_vector call was made (filter is passed inside it)
    mock_wv.collections.get.return_value.query.near_vector.assert_called_once()
    call_kwargs = mock_wv.collections.get.return_value.query.near_vector.call_args[1]
    # The filter argument must be present
    assert "filters" in call_kwargs


def test_close_called_on_success():
    mock_wv = _make_weaviate_client(exists=True, objects=[])
    mock_wv.collections.get.return_value.query.near_vector.return_value.objects = []

    with (
        patch("main.weaviate.connect_to_local", return_value=mock_wv),
        patch("main._openai_client", return_value=_make_openai_embedding()),
    ):
        response = client.get("/search", params=_BASE_PARAMS)

    assert response.status_code == 200
    mock_wv.close.assert_called_once()


def test_missing_q_returns_422():
    response = client.get("/search", params={"conversationId": "conv-abc"})
    assert response.status_code == 422


def test_missing_conversation_id_returns_422():
    response = client.get("/search", params={"q": "hello"})
    assert response.status_code == 422
