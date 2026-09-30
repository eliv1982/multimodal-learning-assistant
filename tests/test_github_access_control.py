"""
Regression tests: utils/github_access_control.py — the fail-closed GitHub
web-login allowlist (pre-deployment corrective pass ahead of Stage 8C).

Mirrors tests/test_stage1c_access_control.py's own "configuration parsing"
coverage (section H there) for the Telegram allowlist: same parsing policy,
same fail-closed guarantee, applied here to GITHUB_ALLOWED_USER_IDS /
is_github_user_authorized() instead of TELEGRAM_ALLOWED_USER_IDS /
is_authorized(). Unit-level only — tests/test_github_oauth_allowlist.py
covers the real callback route end to end.
"""

import pytest

import utils.github_access_control as github_access_control

AUTHORIZED_ID = 111111111
UNAUTHORIZED_ID = 222222222


@pytest.fixture(autouse=True)
def _default_test_github_access_allowed():
    """Shadows conftest.py's same-named autouse fixture (which defaults
    every other test module to "authorized" so unrelated tests don't need
    to know about this gate) — this module tests the gate itself, so it
    must leave the real is_github_user_authorized() in place."""
    yield


# ---------------------------------------------------------------------------
# Parsing policy (parse_allowed_github_user_ids)
# ---------------------------------------------------------------------------


def test_parse_single_valid_id():
    assert github_access_control.parse_allowed_github_user_ids("123456789") == frozenset({123456789})


def test_parse_multiple_valid_ids():
    assert github_access_control.parse_allowed_github_user_ids("111,222,333") == frozenset({111, 222, 333})


def test_parse_tolerates_surrounding_whitespace():
    assert github_access_control.parse_allowed_github_user_ids("  111 , 222 ,333  ") == frozenset({111, 222, 333})


def test_parse_collapses_duplicates():
    assert github_access_control.parse_allowed_github_user_ids("111,111,222,111") == frozenset({111, 222})


@pytest.mark.parametrize("raw", [None, "", "   ", ",, ,"])
def test_parse_empty_or_whitespace_only_denies_all(raw):
    assert github_access_control.parse_allowed_github_user_ids(raw) == frozenset()


def test_parse_keeps_valid_entries_and_drops_malformed_ones():
    """Same Option-B policy as Telegram's parser: a mix of valid and
    malformed entries keeps the valid ones rather than invalidating the
    whole configuration, so one typo can't lock out every
    correctly-configured id."""
    assert github_access_control.parse_allowed_github_user_ids("111,abc,222,") == frozenset({111, 222})
    assert github_access_control.parse_allowed_github_user_ids("not-a-number") == frozenset()


def test_parse_fully_malformed_input_denies_all():
    assert github_access_control.parse_allowed_github_user_ids("abc,def,xyz") == frozenset()


# ---------------------------------------------------------------------------
# is_github_user_authorized — immutable numeric id only, no coercion
# ---------------------------------------------------------------------------


def test_is_github_user_authorized_uses_only_numeric_id(monkeypatch):
    monkeypatch.setattr(github_access_control, "GITHUB_ALLOWED_USER_IDS", frozenset({AUTHORIZED_ID}))
    assert github_access_control.is_github_user_authorized(AUTHORIZED_ID) is True
    assert github_access_control.is_github_user_authorized(UNAUTHORIZED_ID) is False
    assert github_access_control.is_github_user_authorized(str(AUTHORIZED_ID)) is False  # no type coercion


def test_is_github_user_authorized_fails_closed_with_empty_allowlist(monkeypatch):
    monkeypatch.setattr(github_access_control, "GITHUB_ALLOWED_USER_IDS", frozenset())
    assert github_access_control.is_github_user_authorized(AUTHORIZED_ID) is False


def test_is_github_user_authorized_denies_ids_not_on_an_unrelated_allowlist(monkeypatch):
    """A non-empty but unrelated allowlist still denies an id not on it —
    fail closed is per-id, not merely 'allowlist is non-empty'."""
    monkeypatch.setattr(github_access_control, "GITHUB_ALLOWED_USER_IDS", frozenset({AUTHORIZED_ID}))
    assert github_access_control.is_github_user_authorized(UNAUTHORIZED_ID) is False
