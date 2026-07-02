"""Unit tests for POST /proposals/summarise (issue #147)."""

import json
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

_BASE_BODY = {
    "title": "Fund community outreach",
    "description": "Allocate XLM to grow the Clicked user base across Africa.",
    "amount": 500.0,
}


def _fake_openai_response(payload: dict):
    msg = MagicMock()
    msg.content = json.dumps(payload)
    choice = MagicMock()
    choice.message = msg
    resp = MagicMock()
    resp.choices = [choice]
    return resp


def _patch_openai(payload: dict):
    """Context manager: patches _openai_client and returns a configured mock."""
    patcher = patch("main._openai_client")
    mock_fn = patcher.start()
    mock_client = MagicMock()
    mock_fn.return_value = mock_client
    mock_client.chat.completions.create.return_value = _fake_openai_response(payload)
    return patcher, mock_fn


def test_happy_path_returns_summary_and_risk():
    with patch("main._openai_client") as mock_fn:
        mock_client = MagicMock()
        mock_fn.return_value = mock_client
        mock_client.chat.completions.create.return_value = _fake_openai_response(
            {"summary": "This proposal funds outreach. It is low risk.", "risk": "low"}
        )
        response = client.post("/proposals/summarise", json=_BASE_BODY)
    assert response.status_code == 200
    data = response.json()
    assert data["summary"] == "This proposal funds outreach. It is low risk."
    assert data["risk"] == "low"


def test_risk_level_low_accepted():
    with patch("main._openai_client") as mock_fn:
        mock_client = MagicMock()
        mock_fn.return_value = mock_client
        mock_client.chat.completions.create.return_value = _fake_openai_response(
            {"summary": "Short summary. Second sentence.", "risk": "low"}
        )
        response = client.post("/proposals/summarise", json={**_BASE_BODY, "amount": 10.0})
    assert response.status_code == 200
    assert response.json()["risk"] == "low"


def test_risk_level_medium_accepted():
    with patch("main._openai_client") as mock_fn:
        mock_client = MagicMock()
        mock_fn.return_value = mock_client
        mock_client.chat.completions.create.return_value = _fake_openai_response(
            {"summary": "Moderate proposal. Needs review.", "risk": "medium"}
        )
        response = client.post("/proposals/summarise", json=_BASE_BODY)
    assert response.status_code == 200
    assert response.json()["risk"] == "medium"


def test_risk_level_high_accepted():
    with patch("main._openai_client") as mock_fn:
        mock_client = MagicMock()
        mock_fn.return_value = mock_client
        mock_client.chat.completions.create.return_value = _fake_openai_response(
            {"summary": "Very large transfer proposed. High risk detected.", "risk": "high"}
        )
        response = client.post("/proposals/summarise", json={**_BASE_BODY, "amount": 1_000_000.0})
    assert response.status_code == 200
    assert response.json()["risk"] == "high"


def test_empty_summary_returns_502():
    with patch("main._openai_client") as mock_fn:
        mock_client = MagicMock()
        mock_fn.return_value = mock_client
        mock_client.chat.completions.create.return_value = _fake_openai_response(
            {"summary": "", "risk": "medium"}
        )
        response = client.post("/proposals/summarise", json=_BASE_BODY)
    assert response.status_code == 502


def test_invalid_risk_falls_back_to_medium():
    with patch("main._openai_client") as mock_fn:
        mock_client = MagicMock()
        mock_fn.return_value = mock_client
        mock_client.chat.completions.create.return_value = _fake_openai_response(
            {"summary": "Valid summary here. Two sentences total.", "risk": "critical"}
        )
        response = client.post("/proposals/summarise", json=_BASE_BODY)
    assert response.status_code == 200
    assert response.json()["risk"] == "medium"


def test_missing_risk_key_falls_back_to_medium():
    with patch("main._openai_client") as mock_fn:
        mock_client = MagicMock()
        mock_fn.return_value = mock_client
        mock_client.chat.completions.create.return_value = _fake_openai_response(
            {"summary": "Summary without risk key. Still valid."}
        )
        response = client.post("/proposals/summarise", json=_BASE_BODY)
    assert response.status_code == 200
    assert response.json()["risk"] == "medium"


def test_missing_api_key_returns_500(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    response = client.post("/proposals/summarise", json=_BASE_BODY)
    assert response.status_code == 500


def test_missing_title_returns_422():
    body = {k: v for k, v in _BASE_BODY.items() if k != "title"}
    response = client.post("/proposals/summarise", json=body)
    assert response.status_code == 422


def test_missing_amount_returns_422():
    body = {k: v for k, v in _BASE_BODY.items() if k != "amount"}
    response = client.post("/proposals/summarise", json=body)
    assert response.status_code == 422
