import contextlib
import re
import socket
import xml.etree.ElementTree as ET
from xml.sax import saxutils

import libvirt
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core import zfs_storage
from app.core.audit import log_action
from app.core.error_messages import describe_exception
from app.core.libvirt_utils import ensure_default_pool, get_disk_paths_in_use, open_conn
from app.core.security import get_current_user, require_role
from app.core.vm_builder import validate_name
from app.core.vm_limits import validate_vm_resources

router = APIRouter(prefix="/storage", tags=["storage"])

# This table did not match libvirt's real enumeration (virStoragePoolState,
# checked through libvirt.VIR_STORAGE_POOL_*: only 5 values, 0-4, not 6). Every
# pool, including an already active "default", was displayed as
# "en_construction". It had no visible effect while no screen displayed this
# "state" field.
POOL_STATE_NAMES = {
    0: "inactif",  # VIR_STORAGE_POOL_INACTIVE
    1: "en_construction",  # VIR_STORAGE_POOL_BUILDING
    2: "actif",  # VIR_STORAGE_POOL_RUNNING
    3: "degrade",  # VIR_STORAGE_POOL_DEGRADED
    4: "inaccessible",  # VIR_STORAGE_POOL_INACCESSIBLE
}

# Host name/IP (NFS pool): letters/digits/dots/dashes. Enough for a hostname or
# a simple IPv4/IPv6 address, and it excludes any character that could have a
# special meaning elsewhere.
NFS_HOST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.:_-]{0,253})$")
# Absolute path (server-side NFS export, or the local directory of a "dir"
# pool): no spaces or special XML/shell characters.
POOL_PATH_RE = re.compile(r"^/[A-Za-z0-9/_.-]{0,255}$")


def _pool_type(pool):
    try:
        root = ET.fromstring(pool.XMLDesc(0))
        return root.get("type", "inconnu")
    except (libvirt.libvirtError, ET.ParseError):
        return "inconnu"


def _pool_path(pool):
    try:
        return ET.fromstring(pool.XMLDesc(0)).findtext("target/path")
    except (libvirt.libvirtError, ET.ParseError):
        return None


def _pool_summary(pool):
    state, capacity, allocation, available = pool.info()
    return {
        "chemin": _pool_path(pool),
        "nom": pool.name(),
        "uuid": pool.UUIDString(),
        "type": _pool_type(pool),
        "etat": POOL_STATE_NAMES.get(state, "inconnu"),
        "autostart": bool(pool.autostart()),
        "capacite_go": round(capacity / (1024**3), 2),
        "allocation_go": round(allocation / (1024**3), 2),
        "disponible_go": round(available / (1024**3), 2),
    }


@router.get("")
def list_pools(node: str | None = None, user: dict = Depends(get_current_user)):
    """node: the same convention as GET /vms: list the pools of a registered remote
    node instead of the local host.

    ZFS pools are merged into the same list (type='zfs') for a unified display
    in the UI, but only when `node` designates the LOCAL host: unlike libvirt
    pools (dir/netfs), ZFS management is still single-node (direct `zpool`/`zfs`
    calls on THIS server, no remote management over SSH; see
    app/core/zfs_storage.py). A ZFS pool of a registered remote node is
    therefore not visible here for now."""
    conn = open_conn(node)
    try:
        ensure_default_pool(conn)
        pools = conn.listAllStoragePools()
        result = [_pool_summary(p) for p in pools]
        if not node or node == "local":
            result += zfs_storage.list_pools()
        for p in result:
            p["noeud"] = node or "local"
            p.setdefault("chemin", None)
        log_action(user["username"], "list_storage_pools", "storage", "succes")
        return result
    finally:
        conn.close()


class PoolCreate(BaseModel):
    name: str
    # "dir": a directory local to the node (like the existing "default" pool).
    # "netfs": a remote NFS export mounted by libvirt (shared storage), the
    # foundation of live migration: a disk on a netfs pool is visible identically from
    # any node that mounts the same export, so it does not need to be copied when a VM
    # is migrated.
    # "zfs": a ZFS pool managed outside libvirt (see app/core/zfs_storage.py), backed
    # for now by a loopback file (`size_gb`) rather than a dedicated disk, so the
    # mechanism can be validated without touching a node's existing LVM.
    type: str = Field(pattern="^(dir|netfs|zfs)$")
    path: str | None = None  # pool "dir" : repertoire local (defaut si omis)
    nfs_host: str | None = None  # "netfs" pool: NFS server host
    nfs_export_path: str | None = None  # pool "netfs" : chemin exporte cote serveur
    size_gb: int | None = Field(None, ge=1)  # "zfs" pool: size of the loopback file


def _build_pool_xml(payload: PoolCreate, target_path: str) -> str:
    """Build the libvirt XML with ElementTree (automatic escaping) rather than by
    string concatenation: the security audit had found an XML injection in
    bridge-mode network creation for exactly that reason, and the mistake must
    not be repeated here."""
    pool_el = ET.Element("pool", type=payload.type)
    ET.SubElement(pool_el, "name").text = payload.name
    if payload.type == "netfs":
        source_el = ET.SubElement(pool_el, "source")
        ET.SubElement(source_el, "host", name=payload.nfs_host)
        ET.SubElement(source_el, "dir", path=payload.nfs_export_path)
        ET.SubElement(source_el, "format", type="nfs")
        # NFS mount options, found by testing a real NFS share between two machines:
        #
        # 1) On a recent Debian 13 NFS client (recent nfs-utils and kernel) the mount
        # always fails with "NFS: mount program didn't pass remote address". A manual
        # mount(8) WITHOUT an explicit 'addr=' option fails the same way, and it succeeds
        # WITH it. This looks like a regression of the recent mount path (the new
        # fsconfig kernel mount API), which no longer derives the address from the given
        # host name. It is added systematically, harmless on an older NFS client that does
        # not need it. 'addr' wants an IP, not a host name; gethostbyname() on a literal
        # IP returns it unchanged (a no-op), so the case does not need to be detected
        # beforehand.
        #
        # 2) Even with 'addr=' passed correctly, the mount then fails with "NFS: Version
        # unavailable" unless the NFS version is fixed explicitly: automatic negotiation
        # fails silently on this client. 'vers=4.2' is added for the same reason.
        #
        # 3) The libvirt element is 'mount_opts' (NOT 'mountopts', which libvirt ignores
        # silently) and it lives in its OWN XML namespace (checked in
        # /usr/share/libvirt/schemas/storagepool.rng, not in the online documentation).
        # Built with ET.SubElement and a qualified '{namespace}mount_opts' tag,
        # ET.tostring() declares the namespace as a PREFIX on the root
        # (<pool xmlns:ns0="..."> then <ns0:mount_opts>). That is syntactically correct,
        # but libvirt on this version still ignores it silently (the element is absent
        # from the XML read back right after defineXML). Only the form with "xmlns=..."
        # on the element itself (a LOCAL default namespace, not a root prefix) is honoured,
        # and ElementTree never generates that exact form. The rest of the document is
        # still built with ElementTree (automatic escaping, see above); only this fragment
        # is assembled as a string, with values that are already validated (NFS_HOST_RE
        # above) or resolved through gethostbyname, never raw user text.
        try:
            addr = socket.gethostbyname(payload.nfs_host)
        except OSError:
            addr = payload.nfs_host  # resolution failed: try anyway with the value as provided
        mount_opts_xml = (
            f'<mount_opts xmlns="http://libvirt.org/schemas/storagepool/fs/1.0">'
            f'<option name="addr={saxutils.escape(addr)}"/><option name="vers=4.2"/></mount_opts>'
        )
    else:
        mount_opts_xml = ""
    target_el = ET.SubElement(pool_el, "target")
    ET.SubElement(target_el, "path").text = target_path
    pool_xml = ET.tostring(pool_el, encoding="unicode")
    if mount_opts_xml:
        pool_xml = pool_xml.replace("</source>", "</source>" + mount_opts_xml, 1)
    return pool_xml


@router.post("", status_code=201)
def create_pool(payload: PoolCreate, node: str | None = None, user: dict = Depends(require_role("admin"))):
    name_error = validate_name(payload.name)
    if name_error:
        log_action(user["username"], "create_storage_pool", payload.name, "echec", name_error)
        raise HTTPException(status_code=422, detail=name_error)

    if payload.type == "zfs":
        if node and node != "local":
            raise HTTPException(
                status_code=422,
                detail="A ZFS pool can only be created on the local host (single-node management for now)",
            )
        if not payload.size_gb:
            raise HTTPException(status_code=422, detail="size_gb is required for a ZFS pool")
        size_errors = validate_vm_resources(disk_sizes=[payload.size_gb])
        if size_errors:
            raise HTTPException(status_code=422, detail=size_errors)
        if not zfs_storage.is_available():
            raise HTTPException(
                status_code=422, detail="ZFS is not installed on this host (zfsutils-linux/zfs-dkms packages)"
            )
        try:
            pool = zfs_storage.create_pool(payload.name, payload.size_gb)
        except zfs_storage.ZfsError as e:
            log_action(user["username"], "create_storage_pool", payload.name, "echec", e.message)
            raise HTTPException(status_code=500, detail=f"ZFS pool creation error: {e.message}") from e
        log_action(user["username"], "create_storage_pool", payload.name, "succes")
        return pool

    if payload.type == "dir":
        target_path = payload.path or f"/var/lib/libvirt/hyperlite-pools/{payload.name}"
        if not POOL_PATH_RE.match(target_path):
            raise HTTPException(
                status_code=422,
                detail="Invalid pool path (must be an absolute path, without spaces or special characters)",
            )
    else:
        if not payload.nfs_host or not payload.nfs_export_path:
            raise HTTPException(status_code=422, detail="nfs_host and nfs_export_path are required for an NFS pool")
        if not NFS_HOST_RE.match(payload.nfs_host):
            raise HTTPException(status_code=422, detail="Invalid NFS host")
        if not POOL_PATH_RE.match(payload.nfs_export_path):
            raise HTTPException(status_code=422, detail="Invalid NFS export path (must be an absolute path)")
        # LOCAL mount point on the node (the NFS client side): distinct from the path
        # exported on the server side, and never supplied by the caller, to avoid any
        # collision with an existing system directory.
        target_path = f"/var/lib/libvirt/hyperlite-pools/{payload.name}"

    conn = open_conn(node)
    try:
        try:
            conn.storagePoolLookupByName(payload.name)
            log_action(user["username"], "create_storage_pool", payload.name, "echec", "Pool already exists")
            raise HTTPException(status_code=422, detail=f"A pool '{payload.name}' already exists")
        except libvirt.libvirtError:
            pass

        pool_xml = _build_pool_xml(payload, target_path)
        try:
            pool = conn.storagePoolDefineXML(pool_xml)
            # build() creates the local directory ("dir") or the mount point ("netfs"),
            # needed before create() on a brand new pool. flags=0: no destructive reformatting
            # of an existing medium.
            pool.build(0)
            pool.create(0)
            pool.setAutostart(True)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "create_storage_pool", payload.name, "echec", msg)
            # Best-effort cleanup if the definition succeeded but the start did not (e.g. an
            # unreachable NFS export): avoids a "ghost" pool that is defined but never usable
            # and would block a new attempt with the same name.
            with contextlib.suppress(libvirt.libvirtError):
                conn.storagePoolLookupByName(payload.name).undefine()
            raise HTTPException(status_code=500, detail=f"Pool creation error: {msg}") from e

        log_action(user["username"], "create_storage_pool", payload.name, "succes")
        return _pool_summary(pool)
    finally:
        conn.close()


def _vms_using_path(conn, target):
    """Names of the VMs that have a disk or CD-ROM under `target`."""
    if not target:
        return []
    prefix = target.rstrip("/") + "/"
    names = []
    for dom in conn.listAllDomains():
        try:
            xml = ET.fromstring(dom.XMLDesc(0))
        except libvirt.libvirtError:
            continue
        for src in xml.findall("devices/disk/source"):
            path = src.get("file") or src.get("dev") or ""
            if path.startswith(prefix):
                names.append(dom.name())
                break
    return names


@router.delete("/{pool_name}")
def delete_pool(
    pool_name: str,
    node: str | None = None,
    confirm: bool = False,
    detacher: bool = False,
    user: dict = Depends(require_role("admin")),
):
    if pool_name == "default":
        raise HTTPException(status_code=400, detail="The 'default' pool cannot be deleted")
    if not confirm:
        raise HTTPException(status_code=400, detail="Irreversible action: add ?confirm=true to confirm the deletion")

    # A ZFS pool is NOT a libvirt pool (see zfs_storage.py): it is routed separately
    # before any lookup on the libvirt side, which would simply fail with "not found"
    # for a name that only exists on the ZFS side.
    if (not node or node == "local") and zfs_storage.pool_exists(pool_name):
        try:
            zfs_storage.delete_pool(pool_name)
        except zfs_storage.ZfsError as e:
            log_action(user["username"], "delete_storage_pool", pool_name, "echec", e.message)
            raise HTTPException(status_code=409, detail=e.message) from e
        log_action(user["username"], "delete_storage_pool", pool_name, "succes")
        return {"message": f"ZFS pool '{pool_name}' deleted"}

    conn = open_conn(node)
    try:
        try:
            pool = conn.storagePoolLookupByName(pool_name)
        except libvirt.libvirtError:
            raise HTTPException(status_code=404, detail=f"Storage pool '{pool_name}' not found") from None

        pool.refresh(0)
        volumes = pool.listAllVolumes()
        if volumes:
            # `detacher` only removes the libvirt pool DEFINITION (destroy + undefine), NEVER
            # the files: for a dir/netfs pool that is not destructive. A real case: a dir pool
            # created automatically by virt-install on /root sees all of /root as "volumes"
            # and could therefore never be deleted.
            root = ET.fromstring(pool.XMLDesc(0))
            if not detacher or root.get("type") not in ("dir", "netfs"):
                log_action(user["username"], "delete_storage_pool", pool_name, "echec", "Pool not empty")
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Pool '{pool_name}' still contains {len(volumes)} file(s)/volume(s). To remove the pool WITHOUT deleting these files, use the \"remove without deleting the files\" option (detacher=true, dir/NFS pools only)"
                    ),
                )
            in_use = _vms_using_path(conn, root.findtext("target/path"))
            if in_use:
                log_action(user["username"], "delete_storage_pool", pool_name, "echec", "Pool used by VMs")
                raise HTTPException(
                    status_code=409,
                    detail=f"VMs use files of this pool ({', '.join(in_use)}): remove them or move their disks first",
                )

        try:
            if pool.isActive():
                # netfs: unmounts the export. dir: does not touch the content of the directory
                # (already checked empty above).
                pool.destroy()
            pool.undefine()
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "delete_storage_pool", pool_name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Pool deletion error: {msg}") from e

        log_action(user["username"], "delete_storage_pool", pool_name, "succes")
        return {"message": f"Pool '{pool_name}' deleted"}
    finally:
        conn.close()


@router.get("/{pool_name}/volumes")
def list_volumes(pool_name: str, user: dict = Depends(get_current_user)):
    conn = open_conn()
    try:
        if zfs_storage.pool_exists(pool_name):
            in_use = get_disk_paths_in_use(conn)
            result = zfs_storage.list_zvols(pool_name)
            for vol in result:
                vol["utilise"] = vol["chemin"] in in_use
            log_action(user["username"], "list_volumes", pool_name, "succes")
            return result

        try:
            pool = conn.storagePoolLookupByName(pool_name)
        except libvirt.libvirtError:
            raise HTTPException(status_code=404, detail=f"Storage pool '{pool_name}' not found") from None
        pool.refresh(0)
        in_use = get_disk_paths_in_use(conn)
        result = []
        for vol in pool.listAllVolumes():
            vol_info = vol.info()
            result.append(
                {
                    "nom": vol.name(),
                    "chemin": vol.path(),
                    "capacite_go": round(vol_info[1] / (1024**3), 3),
                    "allocation_go": round(vol_info[2] / (1024**3), 3),
                    "utilise": vol.path() in in_use,
                }
            )
        log_action(user["username"], "list_volumes", pool_name, "succes")
        return result
    finally:
        conn.close()


class VolumeCreate(BaseModel):
    name: str
    size_gb: int = Field(ge=1)


@router.post("/{pool_name}/volumes", status_code=201)
def create_volume(pool_name: str, payload: VolumeCreate, user: dict = Depends(require_role("admin"))):
    size_errors = validate_vm_resources(disk_sizes=[payload.size_gb])
    if size_errors:
        raise HTTPException(status_code=422, detail=size_errors)
    if zfs_storage.pool_exists(pool_name):
        name_error = zfs_storage.validate_zfs_name(payload.name)
        if name_error:
            log_action(user["username"], "create_volume", payload.name, "echec", name_error)
            raise HTTPException(status_code=422, detail=name_error)
        try:
            path = zfs_storage.create_zvol(pool_name, payload.name, payload.size_gb)
        except zfs_storage.ZfsError as e:
            log_action(user["username"], "create_volume", payload.name, "echec", e.message)
            raise HTTPException(status_code=500, detail=f"zvol creation error: {e.message}") from e
        log_action(user["username"], "create_volume", payload.name, "succes")
        return {"nom": payload.name, "chemin": path, "capacite_go": float(payload.size_gb)}

    conn = open_conn()
    try:
        try:
            pool = conn.storagePoolLookupByName(pool_name)
        except libvirt.libvirtError:
            log_action(user["username"], "create_volume", payload.name, "echec", "Pool not found")
            raise HTTPException(status_code=404, detail=f"Storage pool '{pool_name}' not found") from None

        base_name = payload.name[: -len(".qcow2")] if payload.name.endswith(".qcow2") else payload.name
        name_error = validate_name(base_name)
        if name_error:
            log_action(user["username"], "create_volume", payload.name, "echec", name_error)
            raise HTTPException(status_code=422, detail=name_error)
        filename = f"{base_name}.qcow2"
        try:
            pool.storageVolLookupByName(filename)
            log_action(user["username"], "create_volume", filename, "echec", "Volume already exists")
            raise HTTPException(status_code=422, detail=f"A volume '{filename}' already exists in this pool")
        except libvirt.libvirtError:
            pass

        size_bytes = payload.size_gb * (1024**3)
        vol_xml = f"""
        <volume>
          <name>{filename}</name>
          <capacity unit='bytes'>{size_bytes}</capacity>
          <target>
            <format type='qcow2'/>
          </target>
        </volume>
        """
        try:
            vol = pool.createXML(vol_xml, 0)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "create_volume", filename, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Volume creation error: {msg}") from e

        log_action(user["username"], "create_volume", filename, "succes")
        vol_info = vol.info()
        return {
            "nom": vol.name(),
            "chemin": vol.path(),
            "capacite_go": round(vol_info[1] / (1024**3), 3),
        }
    finally:
        conn.close()


@router.delete("/{pool_name}/volumes/{volume_name}")
def delete_volume(pool_name: str, volume_name: str, confirm: bool = False, user: dict = Depends(require_role("admin"))):
    if zfs_storage.pool_exists(pool_name):
        conn = open_conn()
        try:
            in_use = get_disk_paths_in_use(conn)
        finally:
            conn.close()
        if zfs_storage.device_path(pool_name, volume_name) in in_use:
            log_action(user["username"], "delete_volume", volume_name, "echec", "Volume used by a VM")
            raise HTTPException(status_code=409, detail=f"Volume '{volume_name}' is used by a VM, deletion refused")
        if not confirm:
            log_action(user["username"], "delete_volume", volume_name, "echec", "Confirmation manquante")
            raise HTTPException(
                status_code=400, detail="Irreversible action: add ?confirm=true to confirm the deletion"
            )
        try:
            zfs_storage.delete_zvol(pool_name, volume_name)
        except zfs_storage.ZfsError as e:
            log_action(user["username"], "delete_volume", volume_name, "echec", e.message)
            raise HTTPException(
                status_code=404 if isinstance(e, zfs_storage.ZfsNotFoundError) else 500, detail=e.message
            ) from e
        log_action(user["username"], "delete_volume", volume_name, "succes")
        return {"message": f"Volume '{volume_name}' deleted"}

    conn = open_conn()
    try:
        try:
            pool = conn.storagePoolLookupByName(pool_name)
        except libvirt.libvirtError:
            raise HTTPException(status_code=404, detail=f"Storage pool '{pool_name}' not found") from None
        try:
            vol = pool.storageVolLookupByName(volume_name)
        except libvirt.libvirtError:
            log_action(user["username"], "delete_volume", volume_name, "echec", "Volume not found")
            raise HTTPException(status_code=404, detail=f"Volume '{volume_name}' not found") from None

        in_use = get_disk_paths_in_use(conn)
        if vol.path() in in_use:
            log_action(user["username"], "delete_volume", volume_name, "echec", "Volume used by a VM")
            raise HTTPException(status_code=409, detail=f"Volume '{volume_name}' is used by a VM, deletion refused")

        if not confirm:
            log_action(user["username"], "delete_volume", volume_name, "echec", "Confirmation manquante")
            raise HTTPException(
                status_code=400, detail="Irreversible action: add ?confirm=true to confirm the deletion"
            )

        try:
            vol.delete(0)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "delete_volume", volume_name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Deletion error: {msg}") from e

        log_action(user["username"], "delete_volume", volume_name, "succes")
        return {"message": f"Volume '{volume_name}' deleted"}
    finally:
        conn.close()
