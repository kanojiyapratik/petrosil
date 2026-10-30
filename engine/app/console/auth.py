"""Sign-in for the console.

Passwords are scrypt-hashed and sessions are HMAC-signed cookies. No session
store: the module runs as one process, and a signed cookie carrying the email
and an expiry is enough to know who is asking without keeping server-side
state.

The trade-off is named rather than hidden: a signed cookie cannot be revoked
before it expires. Sessions are therefore short, and changing CONSOLE_SECRET
invalidates every one of them at once.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass

SCRYPT_N = 16384
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_KEYLEN = 64
DEFAULT_TTL_SECONDS = 12 * 60 * 60

SESSION_COOKIE = "petrosil_console"


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = os.urandom(16) if salt is None else salt
    derived = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_KEYLEN
    )

    return f"scrypt:{salt.hex()}:{derived.hex()}"


def verify_password(password: str, stored: str) -> bool:
    parts = stored.split(":")

    if len(parts) != 3 or parts[0] != "scrypt":
        return False

    try:
        salt = bytes.fromhex(parts[1])
        expected = bytes.fromhex(parts[2])
    except ValueError:
        return False

    actual = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=len(expected) or SCRYPT_KEYLEN,
    )

    return hmac.compare_digest(actual, expected)


def authenticate(users, email: str, password: str):
    """Finds the user and checks the password.

    An unknown email still costs a password hash, so a wrong address and a
    wrong password take the same time to reject and the response cannot be
    used to find out who has an account.
    """
    wanted = email.strip().lower()
    user = next((candidate for candidate in users if candidate.email == wanted), None)

    if user is None:
        verify_password(password, f"scrypt:{'00' * 16}:{'00' * SCRYPT_KEYLEN}")
        return None

    return user if verify_password(password, user.password_hash) else None


@dataclass(frozen=True)
class Session:
    email: str
    expires_at: int  # unix seconds


def new_session(email: str, ttl_seconds: int = DEFAULT_TTL_SECONDS, now: float | None = None) -> Session:
    now = time.time() if now is None else now

    return Session(email=email, expires_at=int(now) + ttl_seconds)


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _sign(payload: str, secret: str) -> str:
    return _b64(hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).digest())


def sign_session(session: Session, secret: str) -> str:
    payload = _b64(
        json.dumps({"email": session.email, "expiresAt": session.expires_at}).encode("utf-8")
    )

    return f"{payload}.{_sign(payload, secret)}"


def read_session(token: str | None, secret: str, now: float | None = None) -> Session | None:
    """Returns None for anything tampered with, malformed, or past its expiry."""
    if not token or "." not in token:
        return None

    payload, _, signature = token.partition(".")

    if not payload or not signature:
        return None

    if not hmac.compare_digest(signature, _sign(payload, secret)):
        return None

    try:
        data = json.loads(_unb64(payload).decode("utf-8"))
    except Exception:  # noqa: BLE001 - any malformed payload is simply not a session
        return None

    email = data.get("email")
    # The key is camelCase because the TypeScript version wrote it that way,
    # and a cookie issued before the port must still be readable after it.
    expires_at = data.get("expiresAt")

    if not isinstance(email, str) or not isinstance(expires_at, (int, float)):
        return None

    now = time.time() if now is None else now

    return Session(email=email, expires_at=int(expires_at)) if expires_at > now else None
