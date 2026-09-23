"""Bearer tokens (hashed) and HTTP Basic for the admin UI."""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from .store import hash_token

_basic = HTTPBasic(realm="r1cord-admin", auto_error=False)
_PROXY_HEADERS = ("cf-connecting-ip", "x-forwarded-for", "x-real-ip")


def _deny(message: str) -> HTTPException:
    # Logged once, with the reason, by the app's HTTPException handler.
    return HTTPException(
        status_code=401,
        detail={"error": "unauthorized", "message": message},
    )


def is_local_direct(request: Request) -> bool:
    """True for a request that arrived on the loopback listener without passing through a proxy.

    The server never binds beyond 127.0.0.1 by default, so such a request can only come from a
    process on this PC — which already owns the datastore. A tunnel (cloudflared) also connects
    from loopback but marks the hop with CF-Connecting-IP / X-Forwarded-For; those keep Basic auth.
    """
    client = request.client.host if request.client else ""
    if client not in ("127.0.0.1", "::1"):
        return False
    return not any(h in request.headers for h in _PROXY_HEADERS)


def require_token(request: Request) -> str:
    header = request.headers.get("authorization")
    if not header:
        raise _deny("missing bearer token")
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise _deny("missing bearer token")
    raw = parts[1].strip()
    if not request.app.state.store.token_valid(raw):
        # Touch the digest so a missing token still does a compare.
        hmac.compare_digest(hash_token(raw), "0" * 64)
        raise _deny("invalid bearer token")
    return raw


def require_admin(
    request: Request,
    credentials: Annotated[HTTPBasicCredentials | None, Depends(_basic)],
) -> str:
    if is_local_direct(request):
        return "admin"
    config = request.app.state.config
    if credentials is None:
        raise _challenge()
    user_ok = hmac.compare_digest(credentials.username.encode("utf-8"), b"admin")
    expected = str(config.admin_password).encode("utf-8")
    presented = credentials.password.encode("utf-8")
    if len(presented) != len(expected):
        # compare_digest still runs on equal-length dummy to keep the branch boring
        hmac.compare_digest(presented[:1] or b"x", b"y")
        pass_ok = False
    else:
        pass_ok = hmac.compare_digest(presented, expected)
    if not (user_ok and pass_ok):
        raise _challenge()
    return credentials.username


def _challenge() -> HTTPException:
    return HTTPException(
        status_code=401,
        detail={"error": "unauthorized", "message": "invalid admin credentials"},
        headers={"WWW-Authenticate": 'Basic realm="r1cord-admin"'},
    )
