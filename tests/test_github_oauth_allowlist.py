"""
Regression tests: the GitHub web-login allowlist gate end to end (Section
6 of the pre-deployment corrective-pass review, ahead of Stage 8C) —
actual FastAPI app (web.app.create_app()) + Starlette TestClient + a REAL
disposable PostgreSQL container (tests/conftest.py's postgres_db) + GitHub
HTTP mocked at the httpx transport layer, exactly mirroring
tests/test_stage6b_github_oauth_routes.py's own setup.

Proves the requirements the review specified:
  - an unauthorized GitHub id never receives an authenticated session;
  - an unauthorized GitHub id never gets a github_accounts/users row
    created (the gate runs BEFORE identity resolution);
  - an authorized GitHub id keeps working exactly as before (full login,
    /api/me, repeat login);
  - a missing/empty allowlist fails closed (denies), never opens the app
    to the public;
  - the denied callback still terminates its OAuth transaction (no
    replay window left open by a denial).
"""

import random
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from starlette.testclient import TestClient

import db.auth_sessions as db_auth_sessions
import db.github_identity as db_github_identity
import services.github_oauth_client as github_oauth_client
import utils.github_access_control as github_access_control
import web_config
from web.app import create_app
from web.github_oauth import _oauth_state_cookie_name

LOGIN_PATH = "/api/auth/github/login"
CALLBACK_PATH = "/api/auth/github/callback"


@pytest.fixture(autouse=True)
def _default_fake_preferences():
    """Shadows conftest.py's same-named autouse fixture — this module
    needs REAL `users`/`github_accounts`/`web_sessions` rows, never the
    offline in-memory fake (see tests/test_stage6b_github_oauth_routes.py,
    which this mirrors)."""
    yield


@pytest.fixture(autouse=True)
def _default_test_github_access_allowed():
    """Shadows conftest.py's same-named autouse fixture (which defaults
    every other test module to "authorized" for this gate) — this module
    tests the gate itself against the real route, so each test controls
    GITHUB_ALLOWED_USER_IDS explicitly via monkeypatch."""
    yield


@pytest.fixture(autouse=True)
def _insecure_posture_for_testing(monkeypatch, postgres_db):
    monkeypatch.setattr(web_config, "COOKIE_SECURE", False)
    db_auth_sessions.apply_startup_posture_sync(requested_secure=False)
    yield


def _install_mock_github(monkeypatch, *, github_id: int) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/login/oauth/access_token":
            return httpx.Response(200, json={"access_token": "gho_faketoken123", "token_type": "bearer"})
        if request.url.path == "/user":
            return httpx.Response(200, json={"id": github_id, "login": "octocat"})
        raise AssertionError(f"unexpected outbound GitHub request: {request.url}")

    def _client():
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), trust_env=False)

    monkeypatch.setattr(github_oauth_client, "_client", _client)


def _do_login(client: TestClient) -> str:
    response = client.get(LOGIN_PATH, follow_redirects=False)
    assert response.status_code == 302
    state = parse_qs(urlparse(response.headers["location"]).query)["state"][0]
    assert client.cookies.get(_oauth_state_cookie_name(secure=False)) == state
    return state


def _random_github_id() -> int:
    return random.randint(10 ** 8, 10 ** 9 - 1)


# ---------------------------------------------------------------------------
# Unauthorized: no session, no identity row, transaction still consumed
# ---------------------------------------------------------------------------


def test_unauthorized_github_id_gets_no_session(monkeypatch):
    github_id = _random_github_id()
    monkeypatch.setattr(github_access_control, "GITHUB_ALLOWED_USER_IDS", frozenset())
    _install_mock_github(monkeypatch, github_id=github_id)
    client = TestClient(create_app())

    state = _do_login(client)
    response = client.get(CALLBACK_PATH, params={"code": "c", "state": state}, follow_redirects=False)

    assert response.status_code == 403
    assert client.cookies.get(web_config.session_cookie_name()) is None


def test_unauthorized_github_id_creates_no_identity_row(monkeypatch):
    """The gate runs BEFORE app.github_identity.resolve_user_uuid_for_oauth()
    — an unauthorized login attempt must leave no github_accounts/users row
    behind, exactly like an unauthorized Telegram id never reaches
    db.identity.resolve_or_create_user_by_telegram_id_sync()."""
    github_id = _random_github_id()
    monkeypatch.setattr(github_access_control, "GITHUB_ALLOWED_USER_IDS", frozenset())
    _install_mock_github(monkeypatch, github_id=github_id)
    client = TestClient(create_app())

    state = _do_login(client)
    client.get(CALLBACK_PATH, params={"code": "c", "state": state}, follow_redirects=False)

    assert db_github_identity.lookup_user_by_github_id_sync(github_id) is None


def test_unauthorized_github_id_denied_even_with_unrelated_nonempty_allowlist(monkeypatch):
    """Fail closed is per-id, not merely 'allowlist is non-empty'."""
    github_id = _random_github_id()
    other_id = _random_github_id()
    monkeypatch.setattr(github_access_control, "GITHUB_ALLOWED_USER_IDS", frozenset({other_id}))
    _install_mock_github(monkeypatch, github_id=github_id)
    client = TestClient(create_app())

    state = _do_login(client)
    response = client.get(CALLBACK_PATH, params={"code": "c", "state": state}, follow_redirects=False)

    assert response.status_code == 403
    assert client.cookies.get(web_config.session_cookie_name()) is None
    assert db_github_identity.lookup_user_by_github_id_sync(github_id) is None


def test_denied_callback_still_consumes_its_transaction(monkeypatch):
    """A denial must not leave a still-claimable transaction behind —
    replaying the same state after a denial fails exactly like any other
    already-consumed transaction (see
    tests/test_stage6b_github_oauth_routes.py's own replay coverage)."""
    github_id = _random_github_id()
    monkeypatch.setattr(github_access_control, "GITHUB_ALLOWED_USER_IDS", frozenset())
    _install_mock_github(monkeypatch, github_id=github_id)
    client = TestClient(create_app())

    state = _do_login(client)
    first = client.get(CALLBACK_PATH, params={"code": "c", "state": state}, follow_redirects=False)
    assert first.status_code == 403

    second = client.get(CALLBACK_PATH, params={"code": "c", "state": state}, follow_redirects=False)
    assert second.status_code == 400


# ---------------------------------------------------------------------------
# Authorized: existing behavior fully preserved
# ---------------------------------------------------------------------------


def test_authorized_github_id_completes_full_login_flow(monkeypatch):
    github_id = _random_github_id()
    monkeypatch.setattr(github_access_control, "GITHUB_ALLOWED_USER_IDS", frozenset({github_id}))
    _install_mock_github(monkeypatch, github_id=github_id)
    client = TestClient(create_app())

    state = _do_login(client)
    response = client.get(CALLBACK_PATH, params={"code": "c", "state": state}, follow_redirects=False)

    assert response.status_code == 302
    assert response.headers["location"] == "/"
    assert client.cookies.get(web_config.session_cookie_name()) is not None

    me_response = client.get("/api/me")
    assert me_response.status_code == 200
    assert db_github_identity.lookup_user_by_github_id_sync(github_id) is not None


def test_authorized_github_id_can_repeat_login(monkeypatch):
    github_id = _random_github_id()
    monkeypatch.setattr(github_access_control, "GITHUB_ALLOWED_USER_IDS", frozenset({github_id}))
    _install_mock_github(monkeypatch, github_id=github_id)
    client = TestClient(create_app())

    state1 = _do_login(client)
    client.get(CALLBACK_PATH, params={"code": "c1", "state": state1}, follow_redirects=False)
    first_user = client.get("/api/me").json()["id"]

    state2 = _do_login(client)
    client.get(CALLBACK_PATH, params={"code": "c2", "state": state2}, follow_redirects=False)
    second_user = client.get("/api/me").json()["id"]

    assert first_user == second_user


# ---------------------------------------------------------------------------
# Fail closed: missing/empty configuration denies, never opens the app
# ---------------------------------------------------------------------------


def test_missing_allowlist_denies_every_github_id(monkeypatch):
    """The production posture this gate exists for: GITHUB_ALLOWED_USER_IDS
    left unset must deny everyone, never silently allow everyone."""
    github_id = _random_github_id()
    monkeypatch.setattr(
        github_access_control,
        "GITHUB_ALLOWED_USER_IDS",
        github_access_control.parse_allowed_github_user_ids(None),
    )
    _install_mock_github(monkeypatch, github_id=github_id)
    client = TestClient(create_app())

    state = _do_login(client)
    response = client.get(CALLBACK_PATH, params={"code": "c", "state": state}, follow_redirects=False)

    assert response.status_code == 403
    assert client.cookies.get(web_config.session_cookie_name()) is None
