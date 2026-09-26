import os
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jwt import PyJWTError

from app.core.database import get_conn
from app.core.passwords import bcrypt_hash, bcrypt_verify

SECRET_KEY = os.environ.get("HYPERLITE_SECRET_KEY", "dev-" + os.urandom(16).hex())
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 240  # 4 h: a long working or testing session used to expire the token silently (60 min), e.g. an ISO upload failing at the final step with no clear message

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


def verify_password(plain, hashed):
    return bcrypt_verify(plain, hashed)


def hash_password(plain):
    return bcrypt_hash(plain)


REMEMBER_TOKEN_EXPIRE_DAYS = 7  # "Stay signed in" on the login screen


def create_access_token(data: dict, remember: bool = False):
    to_encode = data.copy()
    lifetime = (
        timedelta(days=REMEMBER_TOKEN_EXPIRE_DAYS) if remember else timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    expire = datetime.now(UTC) + lifetime
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def create_preauth_token(username: str, remember: bool = False):
    """Intermediate token issued after a correct password but BEFORE the TOTP
    code is verified. It only proves "this password is right", not "this user
    is authenticated". Short-lived (5 min, enough time to type a code) and
    explicitly marked `2fa_pending`: get_current_user() rejects that claim so
    that a stolen or intercepted intermediate token can never serve as a full
    session token."""
    to_encode = {"sub": username, "2fa_pending": True, "remember": bool(remember)}
    expire = datetime.now(UTC) + timedelta(minutes=5)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def get_user(username: str):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        return dict(row) if row else None


def authenticate_user(username: str, password: str):
    user = get_user(username)
    if not user or not verify_password(password, user["hashed_password"]):
        return None
    return user


async def get_current_user(token: str = Depends(oauth2_scheme)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except PyJWTError:
        payload = None

    if payload is not None:
        username = payload.get("sub")
        # 2fa_pending: intermediate token (see create_preauth_token). It proves the
        # password but not the second factor, and must never be accepted as a normal
        # session token.
        if username is None or payload.get("2fa_pending"):
            raise credentials_exception
        user = get_user(username)
        if user is None:
            raise credentials_exception
        return user

    # Not a valid JWT: it may be an API token instead of a session token. Same
    # Authorization: Bearer header, different format ("hlt_" prefix), so no new
    # FastAPI dependency has to be wired everywhere, just a fallback here.
    from app.core.api_tokens import (
        verify_token,  # late import: avoids a cycle (api_tokens -> database, no way back to security)
    )

    user = verify_token(token)
    if user is None:
        raise credentials_exception
    return user


def require_role(*roles):
    async def checker(user: dict = Depends(get_current_user)):
        if user["role"] not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{user['role']}' is not allowed to perform this action",
            )
        return user

    return checker


def require_vm_privilege(privilege):
    """Like require_role, but checks a privilege scoped to the target VM (see
    app/core/permissions.py) instead of a global role: an admin always passes,
    an observer keeps global vm.view access, and a user or group with an ACL on
    that VM (or on a pool containing it) gets the privileges of the scoped
    role. The path parameter must be named `name` (as on every
    /vms/{name}/... route)."""
    from app.core.permissions import has_privilege  # late import: avoids a cycle with permissions.py

    async def checker(name: str, user: dict = Depends(get_current_user)):
        if not has_privilege(user, name, privilege):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Insufficient rights on VM '{name}' (required privilege: {privilege})",
            )
        return user

    return checker


def require_container_privilege(privilege):
    """Equivalent of require_vm_privilege() for LXC containers; see
    app/core/permissions.py::has_container_privilege."""
    from app.core.permissions import has_container_privilege  # import tardif : evite un cycle

    async def checker(name: str, user: dict = Depends(get_current_user)):
        if not has_container_privilege(user, name, privilege):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Insufficient rights on container '{name}' (required privilege: {privilege})",
            )
        return user

    return checker
