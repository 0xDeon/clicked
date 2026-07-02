"""Shared pytest fixtures for the ai_agent test suite."""

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def set_openai_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure OPENAI_API_KEY is always set so _openai_client() doesn't 500."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")


@pytest.fixture()
def client() -> TestClient:
    """FastAPI TestClient for the main app."""
    from main import app

    return TestClient(app)


@pytest.fixture()
def mock_openai(mocker):
    """Patch the OpenAI client used inside main.py."""
    return mocker.patch("main.OpenAI")


@pytest.fixture()
def mock_weaviate(mocker):
    """Patch weaviate.connect_to_local used inside main.py."""
    return mocker.patch("main.weaviate.connect_to_local")
