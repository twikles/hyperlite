import hashlib
import re
import xml.etree.ElementTree as ET

import libvirt
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.audit import log_action
from app.core.error_messages import describe_exception
from app.core.libvirt_utils import ensure_isolated_network, open_conn
from app.core.network_firewall import apply_network_firewall, get_network_firewall, remove_network_firewall
from app.core.security import get_current_user, require_role
from app.core.vm_builder import validate_name
from app.routers.vms.firewall import _FIREWALL_ACTIONS, _FIREWALL_DIRECTIONS, _FIREWALL_PROTOCOLS, FirewallConfig

router = APIRouter(prefix="/networks", tags=["networks"])

# One IPv4 address octet (0-255), reused 4 times to validate a user-supplied
# address before inserting it into libvirt XML.
_IPV4_RE = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")

# Valid Linux interface name (alphanumeric/dash/underscore/dot, at most 15
# characters, the kernel IFNAMSIZ limit). Found during the security audit:
# bridge_name went as is into libvirt XML built with an f-string
# (<bridge name='{bridge_name}'/>) without validation, a possible XML injection
# for anyone able to reach this endpoint (admins only today, so not exploitable
# by a third party, but fixed anyway since it is not a practice to leave in).
_IFACE_NAME_RE = re.compile(r"^[a-zA-Z0-9_.-]{1,15}$")


def _valid_ipv4(addr):
    m = _IPV4_RE.match(addr or "")
    return bool(m) and all(0 <= int(g) <= 255 for g in m.groups())


FORWARD_MODE_LABELS = {
    "nat": "nat",
    "route": "route",
    "bridge": "bridge",
    "open": "ouvert",
    "private": "prive",
    "vepa": "vepa",
    "passthrough": "passthrough",
    "hostdev": "hostdev",
}


def _vm_count_by_network(conn):
    """Number of VMs (running or not) with at least one interface on each libvirt network."""
    counts = {}
    try:
        domains = conn.listAllDomains()
    except libvirt.libvirtError:
        return counts
    for dom in domains:
        try:
            root = ET.fromstring(dom.XMLDesc(0))
        except (libvirt.libvirtError, ET.ParseError):
            continue
        names = {src.get("network") for src in root.findall(".//devices/interface/source") if src.get("network")}
        for n in names:
            counts[n] = counts.get(n, 0) + 1
    return counts


def _network_summary(net):
    xml_desc = net.XMLDesc(0)
    root = ET.fromstring(xml_desc)
    forward = root.find("forward")
    mode = forward.get("mode") if forward is not None else None
    bridge = root.find("bridge")
    bridge_name = bridge.get("name") if bridge is not None else None
    ip_elem = root.find("ip")
    dhcp = ip_elem is not None and ip_elem.find("dhcp") is not None
    subnet = None
    if ip_elem is not None:
        subnet = {"adresse": ip_elem.get("address"), "masque": ip_elem.get("netmask")}
    return {
        "nom": net.name(),
        "uuid": net.UUIDString(),
        "actif": net.isActive() == 1,
        "autostart": bool(net.autostart()),
        "pont": bridge_name,
        "type": FORWARD_MODE_LABELS.get(mode, "isole" if mode is None else mode),
        "reseau": subnet,
        "dhcp": dhcp,
    }


@router.get("")
def list_networks(user: dict = Depends(get_current_user)):
    conn = open_conn()
    try:
        ensure_isolated_network(conn)
        result = []
        vm_counts = _vm_count_by_network(conn)
        for net in conn.listAllNetworks():
            try:
                summary = _network_summary(net)
            except libvirt.libvirtError:
                continue  # deleted between the listing and the read: it is simply no longer there
            summary["vms"] = vm_counts.get(summary["nom"], 0)
            result.append(summary)
        log_action(user["username"], "list_networks", "networks", "succes")
        return result
    finally:
        conn.close()


@router.get("/{name}")
def get_network(name: str, user: dict = Depends(get_current_user)):
    conn = open_conn()
    try:
        try:
            net = conn.networkLookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "get_network", name, "echec", "Network not found")
            raise HTTPException(status_code=404, detail=f"Network '{name}' not found") from None

        summary = _network_summary(net)
        leases = []
        if net.isActive():
            try:
                for lease in net.DHCPLeases():
                    leases.append(
                        {
                            "mac": lease.get("mac"),
                            "ip": lease.get("ipaddr"),
                            "hostname": lease.get("hostname"),
                        }
                    )
            except libvirt.libvirtError:
                pass
        summary["baux_dhcp"] = leases
        log_action(user["username"], "get_network", name, "succes")
        return summary
    finally:
        conn.close()


# --- NETWORK-level firewall: distinct from the PER-VM firewall
# (app/routers/vms.py, nwfilter subsystem). This one applies to the bridge of the
# whole network (the kernel FORWARD chain); see app/core/network_firewall.py for
# the detail and for why nwfilter cannot be used at this level (checked against
# libvirt's RNG schemas). It deliberately reuses the same FirewallConfig and
# FirewallRule as the per-VM firewall: same UI, same validation, only the target
# differs. Admin-only (it touches iptables at the host level, not an individual
# VM).


@router.get("/{name}/firewall")
def get_network_firewall_route(name: str, user: dict = Depends(get_current_user)):
    conn = open_conn()
    try:
        try:
            conn.networkLookupByName(name)
        except libvirt.libvirtError:
            raise HTTPException(status_code=404, detail=f"Network '{name}' not found") from None
        return get_network_firewall(name)
    finally:
        conn.close()


@router.put("/{name}/firewall")
def set_network_firewall(name: str, payload: FirewallConfig, user: dict = Depends(require_role("admin"))):
    if payload.default_policy not in _FIREWALL_ACTIONS:
        raise HTTPException(status_code=422, detail="default_policy must be 'accept' or 'drop'")
    for rule in payload.rules:
        if (
            rule.action not in _FIREWALL_ACTIONS
            or rule.direction not in _FIREWALL_DIRECTIONS
            or rule.protocol not in _FIREWALL_PROTOCOLS
        ):
            raise HTTPException(status_code=422, detail=f"Invalid rule: {rule}")

    conn = open_conn()
    try:
        try:
            conn.networkLookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "set_network_firewall", name, "echec", "Network not found")
            raise HTTPException(status_code=404, detail=f"Network '{name}' not found") from None

        try:
            result = apply_network_firewall(conn, name, payload.model_dump())
        except ValueError as e:
            log_action(user["username"], "set_network_firewall", name, "echec", str(e))
            raise HTTPException(status_code=422, detail=str(e)) from e
        except RuntimeError as e:
            log_action(user["username"], "set_network_firewall", name, "echec", str(e))
            raise HTTPException(status_code=500, detail=str(e)) from e

        log_action(
            user["username"],
            "set_network_firewall",
            name,
            "succes",
            f"{len(payload.rules)} rule(s), bridge {result['pont']}",
        )
        return {"message": f"Firewall applied to network '{name}' (bridge {result['pont']})", **payload.model_dump()}
    finally:
        conn.close()


# --- Creation/deletion of virtual networks: a simplified equivalent of vSwitches
# and Port Groups. A libvirt network is the equivalent of a port group attached
# to a NAT, isolated or bridged vSwitch. Admin-only (creating a network changes
# the host's own network configuration, not just a VM). ---


class NetworkCreate(BaseModel):
    name: str
    mode: str = Field(description="'nat' | 'isole' | 'bridge'")
    bridge_name: str | None = Field(
        None, description="Existing host bridge (required if mode='bridge', ignored otherwise)"
    )
    subnet_address: str | None = Field(None, description="Gateway address, e.g. '192.168.150.1' (nat/isolated)")
    subnet_netmask: str = "255.255.255.0"
    dhcp_start: str | None = None
    dhcp_end: str | None = None


@router.post("", status_code=201)
def create_network(payload: NetworkCreate, user: dict = Depends(require_role("admin"))):
    name_error = validate_name(payload.name)
    if name_error:
        log_action(user["username"], "create_network", payload.name, "echec", name_error)
        raise HTTPException(status_code=422, detail=name_error)

    if payload.mode not in ("nat", "isole", "bridge"):
        raise HTTPException(status_code=422, detail="mode must be 'nat', 'isole' or 'bridge'")

    conn = open_conn()
    try:
        try:
            conn.networkLookupByName(payload.name)
            log_action(user["username"], "create_network", payload.name, "echec", "already exists")
            raise HTTPException(status_code=409, detail=f"A network '{payload.name}' already exists")
        except libvirt.libvirtError:
            pass

        if payload.mode == "bridge":
            if not payload.bridge_name or not _IFACE_NAME_RE.match(payload.bridge_name):
                raise HTTPException(
                    status_code=422,
                    detail="Invalid bridge_name (a Linux interface name is expected: letters/digits/-/_/. , 15 characters max)",
                )
            net_xml = f"""
            <network>
              <name>{payload.name}</name>
              <forward mode='bridge'/>
              <bridge name='{payload.bridge_name}'/>
            </network>
            """
        else:
            if not payload.subnet_address or not _valid_ipv4(payload.subnet_address):
                raise HTTPException(
                    status_code=422, detail="Invalid subnet_address (an IPv4 address is expected, e.g. '192.168.150.1')"
                )
            forward_xml = "<forward mode='nat'/>" if payload.mode == "nat" else ""
            dhcp_xml = ""
            if payload.dhcp_start and payload.dhcp_end:
                if not (_valid_ipv4(payload.dhcp_start) and _valid_ipv4(payload.dhcp_end)):
                    raise HTTPException(status_code=422, detail="Invalid dhcp_start/dhcp_end")
                dhcp_xml = f"<dhcp><range start='{payload.dhcp_start}' end='{payload.dhcp_end}'/></dhcp>"
            # The bridge name is derived from the network name: a short prefix (4
            # characters, for a bit of readability) plus a SHA-1 hash of the FULL name (5 hex
            # characters). Kernel interface names are limited to 15 usable characters
            # (IFNAMSIZ=16 including the terminating NUL), so a plain truncation of the name
            # either overflows the limit (libvirt then fails with "Numerical result out of
            # range") or makes two networks with a common prefix collide (e.g. "guest-wifi-1"
            # and "guest-wifi-2" would generate the same bridge). Two networks can only
            # collide if their full names are identical, which is rejected earlier ("already
            # exists").
            bridge_dev = (
                f"virbr-{payload.name[:4]}{hashlib.sha1(payload.name.encode(), usedforsecurity=False).hexdigest()[:5]}"
            )
            net_xml = f"""
            <network>
              <name>{payload.name}</name>
              {forward_xml}
              <bridge name='{bridge_dev}' stp='on' delay='0'/>
              <ip address='{payload.subnet_address}' netmask='{payload.subnet_netmask}'>
                {dhcp_xml}
              </ip>
            </network>
            """

        try:
            net = conn.networkDefineXML(net_xml)
            net.create()
            net.setAutostart(True)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "create_network", payload.name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Network creation error: {msg}") from e

        log_action(user["username"], "create_network", payload.name, "succes")
        return _network_summary(net)
    finally:
        conn.close()


@router.delete("/{name}")
def delete_network(name: str, confirm: bool = False, user: dict = Depends(require_role("admin"))):
    if name in ("default", "hyperlite-isolated"):
        raise HTTPException(status_code=403, detail=f"Network '{name}' is a system network and cannot be deleted")

    conn = open_conn()
    try:
        try:
            net = conn.networkLookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "delete_network", name, "echec", "Network not found")
            raise HTTPException(status_code=404, detail=f"Network '{name}' not found") from None

        # Refuse if a VM (running or not) still has an interface on this network:
        # deleting it from under the VM would break its connectivity at the next start
        # with no clear error message for the user.
        attached_vms = []
        for domain in conn.listAllDomains():
            try:
                root = ET.fromstring(domain.XMLDesc(0))
            except libvirt.libvirtError:
                continue
            for source in root.findall(".//devices/interface[@type='network']/source"):
                if source.get("network") == name:
                    attached_vms.append(domain.name())
                    break
        if attached_vms:
            log_action(user["username"], "delete_network", name, "echec", f"in use by {attached_vms}")
            raise HTTPException(
                status_code=409,
                detail=f"Network in use by: {', '.join(attached_vms)}. Detach these interfaces before deleting it",
            )

        if not confirm:
            log_action(user["username"], "delete_network", name, "echec", "Confirmation manquante")
            raise HTTPException(status_code=400, detail="Add ?confirm=true to confirm the deletion")

        # Clean up the network firewall BEFORE destroying the network:
        # remove_network_firewall needs to read the bridge from the libvirt XML that is
        # still in place to cleanly remove the jump from HYPERLITENETFW.
        try:
            remove_network_firewall(conn, name)
        except Exception as e:
            print(f"[network_firewall] cleanup failed for '{name}' (deletion continues): {e!r}", flush=True)

        try:
            if net.isActive():
                net.destroy()
            net.undefine()
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "delete_network", name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Deletion error: {msg}") from e

        log_action(user["username"], "delete_network", name, "succes")
        return {"message": f"Network '{name}' deleted"}
    finally:
        conn.close()
