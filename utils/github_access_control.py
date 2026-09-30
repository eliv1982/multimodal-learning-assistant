"""
GitHub web-login allowlist (private/invite-only production gate).

Product intent: this deployment is for the owner and a small set of
trusted people, never for arbitrary GitHub accounts. Before this module,
web/github_oauth.py treated a successful GitHub OAuth authentication as
sufficient BY ITSELF to mint an application session — any GitHub account
that could complete the OAuth dance could reach the web app, provider-
backed chat, and document storage. This module closes that gap with a
minimal, fail-closed allowlist of immutable numeric GitHub user ids,
mirroring utils.access_control's own TELEGRAM_ALLOWED_USER_IDS gate for
the Telegram adapter: same env-var-driven parsing policy, same fail-closed
default (absent/empty/fully-malformed => deny everyone, never "allow
everyone"), same "immutable numeric id only, never a mutable
login/username" identity rule (Section 4 of the review that requested
this: prefer the immutable GitHub user id over the mutable `login` when
the model exposes it cleanly — web/github_oauth.py already does, via
services/github_oauth_client.py's GET /user call).

Deliberately NOT folded into utils/access_control.py: that module's own
docstring scopes it explicitly to the Telegram adapter (env var,
"numeric user id" concept, and handler-wrapping decorator all Telegram-
specific) and is imported only by bot.py's handler dispatch — there is no
web-route analog of that decorator here. This module instead exposes a
single plain predicate that web/github_oauth.py's callback calls inline,
once, after it has a verified GitHub identity and before it creates any
github_accounts/users row or mints a session — so an unauthorized login
attempt leaves no trace in the canonical identity tables, exactly like an
unauthorized Telegram user never reaches
db.identity.resolve_or_create_user_by_telegram_id_sync().

Never changes: Telegram authorization (utils/access_control.py, untouched),
GitHub OAuth scopes/flow, or Stage 6C account-linking/merge semantics —
this is purely an additional admission gate in front of session issuance.
"""

import os
from typing import Optional

from utils.logging import logger

_ENV_VAR = "GITHUB_ALLOWED_USER_IDS"


def parse_allowed_github_user_ids(raw: Optional[str]) -> frozenset[int]:
    """
    Parse GITHUB_ALLOWED_USER_IDS. Same parsing policy as
    utils.access_control.parse_allowed_user_ids() (see that function's own
    docstring for the full rationale): comma separated, surrounding
    whitespace tolerated, duplicates collapse via the set, and a
    non-integer entry is dropped (logged as a count only, never the raw
    entry) rather than invalidating the whole configuration. An absent,
    empty, whitespace-only, or fully-malformed value denies everyone (fail
    closed) — this deployment must never become public merely because the
    allowlist was left unset or mistyped. Never logs the raw configured
    string or the resulting ids.
    """
    if raw is None or not raw.strip():
        logger.warning(
            "%s is not configured — GitHub web login is fully denied (fail closed).",
            _ENV_VAR,
        )
        return frozenset()

    valid_ids = set()
    invalid_count = 0
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            valid_ids.add(int(entry))
        except ValueError:
            invalid_count += 1

    if invalid_count:
        logger.warning(
            "%s contains invalid (non-numeric) entries — they are ignored | "
            "invalid_entry_count=%d, valid_entry_count=%d",
            _ENV_VAR, invalid_count, len(valid_ids),
        )

    if not valid_ids:
        logger.warning(
            "%s produced no valid numeric IDs — GitHub web login is fully denied (fail closed).",
            _ENV_VAR,
        )

    return frozenset(valid_ids)


# Parsed once at import time, same import-time-bound-singleton convention
# utils.access_control.TELEGRAM_ALLOWED_USER_IDS already uses. Tests
# monkeypatch this module attribute directly rather than the environment
# (see tests/conftest.py's default-authorized fixture for this module).
GITHUB_ALLOWED_USER_IDS: frozenset[int] = parse_allowed_github_user_ids(os.getenv(_ENV_VAR))

if GITHUB_ALLOWED_USER_IDS:
    logger.info(
        "GitHub web login allowlist loaded | authorized_user_count=%d",
        len(GITHUB_ALLOWED_USER_IDS),
    )


def is_github_user_authorized(github_user_id: int) -> bool:
    """Authorization is based ONLY on the immutable numeric GitHub user id
    — never the mutable `login`/username — exactly the id
    web/github_oauth.py's callback already resolves via
    services/github_oauth_client.py's GET /user call before this is ever
    consulted."""
    return github_user_id in GITHUB_ALLOWED_USER_IDS
