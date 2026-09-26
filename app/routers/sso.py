"""OIDC SSO endpoints. All the logic lives in app/core/sso.py; this file only
does the HTTP wiring: the redirects of the Authorization Code flow, and turning
errors (IdP unreachable, invalid token, incomplete configuration...) into a
redirect to the login screen with a clear message rather than a raw 500 that
nobody would see (these are BROWSER redirects, not API calls consumed by the JS
frontend)."""

from datetime import UTC, datetime
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from jwt import PyJWTError
from pydantic import BaseModel

from app.core import sso
from app.core.audit import log_action
from app.core.database import get_conn
from app.core.error_messages import describe_exception
from app.core.security import create_access_token, require_role

router = APIRouter(prefix="/auth/sso", tags=["sso"])


class SSOConfigIn(BaseModel):
    enabled: bool
    issuer: str = ""
    client_id: str = ""
    # None = do not change the existing secret: it avoids forcing it to be re-entered
    # at every edit of the other fields (the UI never displays it in clear text again,
    # see GET /config below).
    client_secret: str | None = None
    redirect_uri: str = ""
    scope: str = "openid profile email groups"
    group_claim: str = "groups"
    admin_groups: str = ""


def _redirect_error(message):
    return RedirectResponse("/?" + urlencode({"sso_error": message}))


@router.get("/status")
def sso_status():
    """Public, WITHOUT authentication: the login screen must know whether to show the
    SSO button before anyone is signed in. It never returns the configuration
    itself (see /config, admin-only)."""
    config = sso.get_config()
    enabled = bool(config and config["enabled"] and config["issuer"] and config["client_id"])
    return {"enabled": enabled}


@router.get("/config")
def get_sso_config(user: dict = Depends(require_role("admin"))):
    config = sso.get_config() or {}
    config = dict(config)
    has_secret = bool(config.pop("client_secret", None))
    config["client_secret_set"] = has_secret
    return config


@router.put("/config")
def put_sso_config(payload: SSOConfigIn, user: dict = Depends(require_role("admin"))):
    fields = payload.model_dump(exclude={"client_secret"})
    fields["enabled"] = int(payload.enabled)
    if payload.client_secret:  # None ou "" -> secret existant conserve
        fields["client_secret"] = payload.client_secret
    sso.set_config(**fields)
    log_action(user["username"], "update_sso_config", "sso", "succes")
    return {"message": "SSO configuration updated"}


class SSOTestIn(BaseModel):
    issuer: str


@router.post("/test")
def test_sso(payload: SSOTestIn, user: dict = Depends(require_role("admin"))):
    """Reads the provider's OIDC discovery document without saving anything, so the
    admin can check the issuer before enabling SSO (a wrong issuer would otherwise
    only show up as a failed sign-in)."""
    try:
        doc = sso.discover(payload.issuer.strip())
    except Exception as e:
        log_action(user["username"], "test_sso", "sso", "echec", describe_exception(e))
        return {"ok": False, "detail": describe_exception(e)}
    missing = [k for k in ("authorization_endpoint", "token_endpoint", "jwks_uri") if not doc.get(k)]
    ok = not missing
    log_action(user["username"], "test_sso", "sso", "succes" if ok else "echec")
    return {
        "ok": ok,
        "issuer": doc.get("issuer"),
        "authorization_endpoint": doc.get("authorization_endpoint"),
        "detail": None if ok else f"Discovery document incomplete: missing {', '.join(missing)}",
    }


@router.get("/login")
def sso_login():
    config = sso.get_config()
    if not config or not config["enabled"]:
        raise HTTPException(status_code=400, detail="SSO is not enabled")
    if not (config["issuer"] and config["client_id"] and config["client_secret"] and config["redirect_uri"]):
        raise HTTPException(status_code=400, detail="Incomplete SSO configuration")
    try:
        doc = sso.discover(config["issuer"])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"IdP unreachable: {e}") from e
    state, nonce = sso.create_state()
    return RedirectResponse(sso.build_authorize_url(config, doc, state, nonce))


@router.get("/callback")
def sso_callback(
    code: str | None = None, state: str | None = None, error: str | None = None, error_description: str | None = None
):
    if error:
        log_action("system", "login", "auth", "echec", f"SSO refused by the IdP: {error_description or error}")
        return _redirect_error(error_description or error)
    if not code or not state:
        return _redirect_error("Incomplete response from the IdP")

    nonce = sso.consume_state(state)
    if nonce is None:
        return _redirect_error("Login session expired, try again")

    config = sso.get_config()
    if not config or not config["enabled"]:
        return _redirect_error("SSO is disabled")

    try:
        doc = sso.discover(config["issuer"])
        tokens = sso.exchange_code(config, doc, code)
        id_token = tokens["id_token"]
        claims = sso.validate_id_token(config, doc, id_token, nonce)
    except (PyJWTError, KeyError) as e:
        log_action("system", "login", "auth", "echec", f"SSO: invalid identity token ({e})")
        return _redirect_error("Invalid identity token")
    except Exception as e:
        log_action("system", "login", "auth", "echec", f"SSO: IdP unreachable or invalid response ({e})")
        return _redirect_error("Unable to contact the IdP")

    username = sso.resolve_username(claims)
    if not username:
        return _redirect_error("The IdP provided no usable identifier")
    role = sso.resolve_role(config, claims)

    try:
        db_user = sso.provision_user(username, role)
    except sso.LocalAccountConflict:
        log_action(username, "login", "auth", "echec", "SSO: this name already matches a local account")
        return _redirect_error("This username already matches a local account")

    token = create_access_token({"sub": db_user["username"], "role": db_user["role"]})
    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET last_login_at = ? WHERE username = ?",
            (datetime.now(UTC).isoformat(), db_user["username"]),
        )
        conn.commit()
    log_action(db_user["username"], "login", "auth", "succes", "SSO login")
    return RedirectResponse(f"/?sso_token={token}")
