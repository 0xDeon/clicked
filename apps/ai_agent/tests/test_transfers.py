import json
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


# Helper to build a fake OpenAI response
def _fake_openai_response(payload: dict):
    msg = MagicMock()
    msg.content = json.dumps(payload)
    choice = MagicMock()
    choice.message = msg
    resp = MagicMock()
    resp.choices = [choice]
    return resp


def test_llm_path_flagged_transfer():
    with patch("main._openai_client") as mock_client_fn:
        mock_client = MagicMock()
        mock_client_fn.return_value = mock_client
        mock_client.chat.completions.create.return_value = _fake_openai_response(
            {"flagged": True, "reason": "Suspicious memo", "confidence": 0.9}
        )
        response = client.post(
            "/transfers/analyse",
            json={"amount": 100.0, "sender": "GABC", "recipient": "GDEF", "memo": "test"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["flagged"] is True
        assert data["confidence"] == 0.9


def test_llm_path_clean_transfer():
    with patch("main._openai_client") as mock_client_fn:
        mock_client = MagicMock()
        mock_client_fn.return_value = mock_client
        mock_client.chat.completions.create.return_value = _fake_openai_response(
            {"flagged": False, "reason": None, "confidence": 0.1}
        )
        response = client.post(
            "/transfers/analyse",
            json={"amount": 500.0, "sender": "GABC", "recipient": "GDEF", "memo": "payment"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["flagged"] is False
        assert isinstance(data["confidence"], float)


def test_llm_path_missing_confidence_defaults_to_zero():
    with patch("main._openai_client") as mock_client_fn:
        mock_client = MagicMock()
        mock_client_fn.return_value = mock_client
        mock_client.chat.completions.create.return_value = _fake_openai_response(
            {"flagged": False, "reason": None}
        )
        response = client.post(
            "/transfers/analyse",
            json={"amount": 200.0, "sender": "GABC", "recipient": "GDEF", "memo": "normal"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["confidence"] == 0.0


def test_llm_path_missing_flagged_defaults_to_false():
    with patch("main._openai_client") as mock_client_fn:
        mock_client = MagicMock()
        mock_client_fn.return_value = mock_client
        mock_client.chat.completions.create.return_value = _fake_openai_response(
            {"reason": None, "confidence": 0.5}
        )
        response = client.post(
            "/transfers/analyse",
            json={"amount": 300.0, "sender": "GABC", "recipient": "GDEF", "memo": "salary"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["flagged"] is False


def test_llm_path_missing_api_key_returns_500(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    response = client.post(
        "/transfers/analyse",
        json={"amount": 100.0, "sender": "GABC", "recipient": "GDEF", "memo": "test"},
    )
    assert response.status_code == 500


# ── Rule-based path (issue #145) ──────────────────────────────────────────────


def test_high_value_transfer_is_flagged_without_llm_call():
    """High-value path bypasses the LLM — mandatory security property."""
    with patch("main._openai_client") as mock_openai:
        response = client.post(
            "/transfers/analyse",
            json={
                "amount": 10_001.0,
                "sender": "GABC",
                "recipient": "GDEF",
                "memo": "large payment",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["flagged"] is True
        assert data["confidence"] == 0.99
        mock_openai.assert_not_called()


def test_high_value_reason_mentions_threshold():
    """The flagging reason must reference the threshold value."""
    with patch("main._openai_client"):
        response = client.post(
            "/transfers/analyse",
            json={
                "amount": 50_000.0,
                "sender": "GABC",
                "recipient": "GDEF",
                "memo": "bulk transfer",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["flagged"] is True
        reason = data["reason"] or ""
        assert "10000" in reason or "threshold" in reason.lower()


def test_amount_exactly_at_threshold_takes_llm_path():
    """amount == threshold is NOT above it; should route to LLM."""
    with patch("main._openai_client") as mock_openai_fn:
        mock_client = MagicMock()
        mock_openai_fn.return_value = mock_client
        mock_client.chat.completions.create.return_value = _fake_openai_response(
            {"flagged": False, "reason": None, "confidence": 0.1}
        )
        response = client.post(
            "/transfers/analyse",
            json={
                "amount": 10_000.0,
                "sender": "GABC",
                "recipient": "GDEF",
                "memo": "exactly at threshold",
            },
        )
        assert response.status_code == 200
        mock_openai_fn.assert_called_once()


def test_missing_fields_return_422():
    response = client.post(
        "/transfers/analyse",
        json={"sender": "GABC", "recipient": "GDEF", "memo": "no amount"},
    )
    assert response.status_code == 422
