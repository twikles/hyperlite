"""Multi-node management endpoints. The remote connection logic lives in
app/core/cluster.py."""

import logging
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import cluster_compat
from app.core.audit import log_action
from app.core.cluster import get_cluster_pubkey, node_summary, register_node, remove_node, test_node_connection
from app.core.database import get_conn
from app.core.error_messages import describe_exception
from app.core.host_capabilities import get_remote_capabilities
from app.core.libvirt_utils import open_conn
from app.core.metrics import get_node_live
from app.core.security import get_current_user, require_role

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/nodes", tags=["nodes"])

NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9.-]{1,62}$")
# A host name or an IPv4/IPv6 address, and a Unix user name: nothing that ssh could read as an option.
HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.:_-]{0,253}$")
USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")


@router.get("")
def list_nodes(user: dict = Depends(get_current_user)):
    """Registered remote nodes, each with its latest live figures ("live", None until the
    metrics collector has reached it once)."""
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM nodes ORDER BY name").fetchall()
    live = get_node_live()
    return [{**dict(r), "live": live.get(r["name"])} for r in rows]


class NodeTest(BaseModel):
    hostname: str
    ssh_user: str = "root"
    ssh_port: int = Field(22, ge=1, le=65535)


@router.post("/test")
def test_node(payload: NodeTest, user: dict = Depends(require_role("admin"))):
    """Check that a machine can be registered (SSH trust plus a QEMU/KVM libvirt) without
    registering it, so the add-node form can say what is wrong before submitting."""
    if not HOST_RE.match(payload.hostname) or not USER_RE.match(payload.ssh_user):
        raise HTTPException(status_code=422, detail="Invalid address or SSH user")
    ok, detail = test_node_connection(payload.hostname, payload.ssh_user, payload.ssh_port)
    log_action(user["username"], "test_node", payload.hostname, "succes" if ok else "echec", None if ok else detail)
    return {"ok": ok, "detail": detail}


@router.get("/cluster-pubkey")
def get_cluster_key(user: dict = Depends(require_role("admin"))):
    """Public key to install in ~/.ssh/authorized_keys of the remote node before
    registering it, displayed in the UI so it can be copied and pasted."""
    return {"public_key": get_cluster_pubkey()}


class NodeCreate(BaseModel):
    name: str
    hostname: str
    ssh_user: str = "root"
    ssh_port: int = Field(22, ge=1, le=65535)


@router.post("", status_code=201)
def add_node(payload: NodeCreate, user: dict = Depends(require_role("admin"))):
    if not NAME_RE.match(payload.name):
        raise HTTPException(status_code=422, detail="Invalid node name (letters/digits/-/., 2-63 characters)")
    try:
        node = register_node(payload.name, payload.hostname, payload.ssh_user, payload.ssh_port, user["username"])
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    # Compatibility diagnostic from the local host to the new node: informational, it
    # never cancels the registration.
    try:
        node = {**node, "compatibilite": _compat_with_local(payload.name)}
    except Exception:
        logger.warning("Compatibility diagnostic for the new node is unavailable", exc_info=True)
    return node


@router.get("/{name}/summary")
def get_node_summary(name: str, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        node = conn.execute("SELECT id FROM nodes WHERE name = ?", (name,)).fetchone()
    if not node:
        raise HTTPException(status_code=404, detail=f"Node '{name}' not found")
    try:
        return {**node_summary(name), "live": get_node_live(name)}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Node unreachable: {e}") from e


def _compat_with_local(name):
    local, remote = open_conn(None), open_conn(name)
    try:
        return cluster_compat.report(cluster_compat.check_pair(local, remote))
    finally:
        local.close()
        remote.close()


@router.get("/{name}/compatibility")
def get_node_compatibility(name: str, user: dict = Depends(require_role("admin"))):
    """Compatibility from the LOCAL host (source) to this node (destination). See
    app/core/cluster_compat.py."""
    with get_conn() as conn:
        if not conn.execute("SELECT id FROM nodes WHERE name = ?", (name,)).fetchone():
            raise HTTPException(status_code=404, detail=f"Node '{name}' not found")
    try:
        return _compat_with_local(name)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Node unreachable: {describe_exception(e)}") from e


@router.get("/{name}/capabilities")
def get_node_capabilities(name: str, user: dict = Depends(get_current_user)):
    """Capability profile of a registered REMOTE node: the equivalent of GET
    /host/capabilities for the local host. See
    app/core/host_capabilities.py::get_remote_capabilities for the known limits
    (some OS information needs the cluster SSH trust to be already established,
    and is degraded to `null` otherwise rather than failing)."""
    with get_conn() as conn:
        node = conn.execute("SELECT id FROM nodes WHERE name = ?", (name,)).fetchone()
    if not node:
        raise HTTPException(status_code=404, detail=f"Node '{name}' not found")
    try:
        return get_remote_capabilities(name)
    except Exception as e:
        msg = describe_exception(e)
        raise HTTPException(status_code=502, detail=f"Node unreachable: {msg}") from e


@router.get("/{name}/hardware")
def get_node_hardware(name: str, user: dict = Depends(get_current_user)):
    """Network interfaces, physical disks and CPU topology of a node ('local' = this host)."""
    from app.core.cluster import get_node
    from app.core.node_hardware import get_hardware

    node = None
    if name != "local":
        node = get_node(name)
        if not node:
            raise HTTPException(status_code=404, detail=f"Node '{name}' not found")
    try:
        return get_hardware(node)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=f"Node unreachable: {e}") from e


@router.delete("/{name}")
def delete_node(name: str, user: dict = Depends(require_role("admin"))):
    with get_conn() as conn:
        node = conn.execute("SELECT id FROM nodes WHERE name = ?", (name,)).fetchone()
    if not node:
        raise HTTPException(status_code=404, detail=f"Node '{name}' not found")
    remove_node(name, user["username"])
    return {"message": f"Node '{name}' removed"}
