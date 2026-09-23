"""Bearer tokens (hashed) and HTTP Basic for the admin UI."""

from __future__ import annotations

import hmac
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from .store import hash_token

_basic = HTTPBasic(realm="r1cord-admin", auto_error=False)
_PROXY_HEADERS = ("cf-connecting-ip", "x-forwarded-for", "x-real-ip")
_LOOPBACK_NAMES = {"127.0.0.1", "localhost", "::1"}
_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _deny(message: str) -> HTTPException:
    # Logged once, with the reason, by the app's HTTPException handler.
    return HTTPException(
        status_code=401,
        detail={"error": "unauthorized", "message": message},
    )


def _forbidden(message: str) -> HTTPException:
    return HTTPException(status_code=403, detail={"error": "forbidden", "message": message})


def _host_name(host: str) -> str:
    """"127.0.0.1:8765" -> "127.0.0.1", "[::1]:8765" -> "::1", "localhost" -> "localhost"."""
    host = host.strip().lower()
    if host.startswith("["):
        return host[1 : host.find("]")] if "]" in host else host
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def check_browser_request(request: Request) -> None:
    """Refuse what a web page on another site could make this PC's browser do to the admin.

    - DNS rebinding: a page on evil.example whose name resolves to 127.0.0.1 reaches the loopback
      listener with `Host: evil.example`. A local request must name this PC (127.0.0.1/localhost).
    - Cross-site forms: a page elsewhere can POST to http://127.0.0.1:8765/admin/... (and a browser
      re-sends tunnel Basic credentials). A state-changing request that says where it came from
      (Origin, Sec-Fetch-Site) must come from the admin's own origin. Clients that send neither
      (curl, scripts) are not browsers and are unaffected.
    """
    host = request.headers.get("host", "")
    if is_local_direct(request) and _host_name(host) not in _LOOPBACK_NAMES:
        raise _forbidden("the admin answers only as 127.0.0.1 or localhost on this PC")
    if request.method not in _UNSAFE_METHODS:
        return
    origin = request.headers.get("origin")
    if origin is not None and (origin == "null" or urlsplit(origin).netloc.lower() != host.strip().lower()):
        raise _forbidden("cross-site request refused")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise _forbidden("cross-site request refused")


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
    check_browser_request(request)
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
