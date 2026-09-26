import logging
import re
import xml.etree.ElementTree as ET

import libvirt
from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.audit import log_action
from app.core.error_messages import describe_exception
from app.core.libvirt_utils import (
    open_conn,
)
from app.core.security import get_current_user, require_vm_privilege
from app.routers.vms._shared import TARGET_DEV_RE, _get_ip, router

logger = logging.getLogger(__name__)


class DiskAttach(BaseModel):
    volume_name: str
    pool: str = "default"
    target_dev: str = "sdb"


# Default buses for older guests; SATA guests inherit their existing disk bus.
DEV_BUS_PREFIXES = {"sd": "scsi", "vd": "virtio", "hd": "ide"}


@router.post("/{name}/disks", status_code=201)
def attach_disk(name: str, payload: DiskAttach, user: dict = Depends(require_vm_privilege("vm.hardware"))):
    if not TARGET_DEV_RE.match(payload.target_dev):
        log_action(user["username"], "attach_disk", name, "echec", "Invalid target_dev")
        raise HTTPException(status_code=422, detail="Invalid target_dev (expected e.g. vda, vdb, sdb)")
    bus = DEV_BUS_PREFIXES.get(payload.target_dev[:2], "virtio")
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "attach_disk", name, "echec", "VM not found")
            raise HTTPException(status_code=404, detail=f"VM '{name}' not found") from None

        if payload.target_dev.startswith("sd"):
            root = ET.fromstring(domain.XMLDesc(0))
            if any(t.get("bus") == "sata" for t in root.findall("./devices/disk[@device='disk']/target")):
                bus = "sata"
                if domain.isActive():
                    raise HTTPException(status_code=409, detail="Shut down the VM before adding a SATA disk")

        try:
            pool = conn.storagePoolLookupByName(payload.pool)
            vol = pool.storageVolLookupByName(payload.volume_name)
        except libvirt.libvirtError:
            log_action(user["username"], "attach_disk", name, "echec", "Volume not found")
            raise HTTPException(
                status_code=404, detail=f"Volume '{payload.volume_name}' not found in pool '{payload.pool}'"
            ) from None

        disk_xml = f"""
        <disk type='file' device='disk'>
          <driver name='qemu' type='qcow2'/>
          <source file='{vol.path()}'/>
          <target dev='{payload.target_dev}' bus='{bus}'/>
        </disk>
        """
        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if domain.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
        try:
            domain.attachDeviceFlags(disk_xml, flags)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "attach_disk", name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Disk attach error: {msg}") from e

        log_action(user["username"], "attach_disk", name, "succes")
        return {"message": f"Volume '{payload.volume_name}' attached to '{name}' as {payload.target_dev}"}
    finally:
        conn.close()


@router.delete("/{name}/disks/{target_dev}")
def detach_disk(name: str, target_dev: str, user: dict = Depends(require_vm_privilege("vm.hardware"))):
    if not TARGET_DEV_RE.match(target_dev):
        log_action(user["username"], "detach_disk", name, "echec", "Invalid target_dev")
        raise HTTPException(status_code=422, detail="Invalid target_dev (expected e.g. vda, vdb, sdb)")
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "detach_disk", name, "echec", "VM not found")
            raise HTTPException(status_code=404, detail=f"VM '{name}' not found") from None

        xml_desc = domain.XMLDesc(0)
        root = ET.fromstring(xml_desc)
        disk_elem = None
        for disk in root.findall(".//devices/disk"):
            target = disk.find("target")
            if target is not None and target.get("dev") == target_dev:
                disk_elem = disk
                break
        if disk_elem is None:
            log_action(user["username"], "detach_disk", name, "echec", f"Disk {target_dev} not found")
            raise HTTPException(status_code=404, detail=f"Disk '{target_dev}' not found on VM '{name}'")

        disk_xml = ET.tostring(disk_elem, encoding="unicode")
        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if domain.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
        try:
            domain.detachDeviceFlags(disk_xml, flags)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "detach_disk", name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Detach error: {msg}") from e

        log_action(user["username"], "detach_disk", name, "succes")
        return {"message": f"Disk '{target_dev}' detached from '{name}'"}
    finally:
        conn.close()


def _get_interfaces(domain):
    xml_desc = domain.XMLDesc(0)
    root = ET.fromstring(xml_desc)
    result = []
    for iface in root.findall(".//devices/interface"):
        mac_elem = iface.find("mac")
        source_elem = iface.find("source")
        model_elem = iface.find("model")
        vlan_elem = iface.find("vlan/tag")
        filter_elem = iface.find("filterref")
        result.append(
            {
                "mac": mac_elem.get("address") if mac_elem is not None else None,
                "reseau": source_elem.get("network") if source_elem is not None else None,
                "type_source": iface.get("type"),
                "modele": model_elem.get("type") if model_elem is not None else None,
                "vlan": int(vlan_elem.get("id"))
                if vlan_elem is not None and (vlan_elem.get("id") or "").isdigit()
                else None,
                # The per-VM firewall is an nwfilter referenced by the interface.
                "pare_feu": filter_elem.get("filter") if filter_elem is not None else None,
            }
        )
    return result


def _disk_size(domain, conn, target, source):
    """Virtual size, space used on the host and pool of one disk. Each part is
    best-effort: an empty CD drive or a path outside any pool only lacks that part."""
    out = {"taille_go": None, "alloue_go": None, "pool": None}
    if target:
        try:
            capacity, allocation, _physical = domain.blockInfo(target)
            out["taille_go"] = round(capacity / 1024**3, 2)
            out["alloue_go"] = round(allocation / 1024**3, 2)
        except libvirt.libvirtError:
            logger.debug("No block info for %s", target, exc_info=True)
    if source:
        try:
            out["pool"] = conn.storageVolLookupByPath(source).storagePoolLookupByVolume().name()
        except libvirt.libvirtError:
            logger.debug("No pool for %s", source, exc_info=True)
    return out


@router.get("/{name}/disks")
def get_vm_disks(name: str, node: str | None = None, user: dict = Depends(get_current_user)):
    conn = open_conn(node)
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "get_vm_disks", name, "echec", "VM not found")
            raise HTTPException(status_code=404, detail=f"VM '{name}' not found") from None
        xml_desc = domain.XMLDesc(0)
        root = ET.fromstring(xml_desc)
        disks = []
        for disk in root.findall(".//devices/disk"):
            target = disk.find("target")
            source = disk.find("source")
            dev = target.get("dev") if target is not None else None
            path = (source.get("file") or source.get("dev")) if source is not None else None
            disks.append(
                {
                    "cible": dev,
                    "bus": target.get("bus") if target is not None else None,
                    "type": disk.get("device"),
                    "source": path,
                    **(
                        _disk_size(domain, conn, dev, path)
                        if path
                        else {"taille_go": None, "alloue_go": None, "pool": None}
                    ),
                }
            )
        log_action(user["username"], "get_vm_disks", name, "succes")
        return disks
    finally:
        conn.close()


@router.get("/{name}/network")
def get_vm_network(name: str, node: str | None = None, user: dict = Depends(get_current_user)):
    conn = open_conn(node)
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "get_vm_network", name, "echec", "VM not found")
            raise HTTPException(status_code=404, detail=f"VM '{name}' not found") from None
        interfaces = _get_interfaces(domain)
        ip = _get_ip(domain) if domain.isActive() else None
        log_action(user["username"], "get_vm_network", name, "succes")
        return {"interfaces": interfaces, "ip": ip}
    finally:
        conn.close()


class NetworkUpdate(BaseModel):
    network: str
    vlan_tag: int | None = Field(
        None,
        ge=1,
        le=4094,
        description="802.1Q tag: only effective if the underlying network/bridge handles trunking (Open vSwitch); silently ignored on a standard Linux bridge",
    )


@router.put("/{name}/network")
def set_vm_network(name: str, payload: NetworkUpdate, user: dict = Depends(require_vm_privilege("vm.hardware"))):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "set_vm_network", name, "echec", "VM not found")
            raise HTTPException(status_code=404, detail=f"VM '{name}' not found") from None

        try:
            conn.networkLookupByName(payload.network)
        except libvirt.libvirtError:
            log_action(user["username"], "set_vm_network", name, "echec", "Network not found")
            raise HTTPException(status_code=404, detail=f"Network '{payload.network}' not found") from None

        xml_desc = domain.XMLDesc(0)
        root = ET.fromstring(xml_desc)
        iface = root.find(".//devices/interface")
        if iface is None:
            log_action(user["username"], "set_vm_network", name, "echec", "No interface")
            raise HTTPException(status_code=404, detail="No network interface found on this VM")

        source = iface.find("source")
        if source is None:
            source = ET.SubElement(iface, "source")
        for k in list(source.attrib):
            del source.attrib[k]
        source.set("network", payload.network)

        vlan_el = iface.find("vlan")
        if vlan_el is not None:
            iface.remove(vlan_el)
        if payload.vlan_tag is not None:
            vlan_el = ET.SubElement(iface, "vlan")
            ET.SubElement(vlan_el, "tag", {"id": str(payload.vlan_tag)})

        iface_xml = ET.tostring(iface, encoding="unicode")
        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if domain.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
        try:
            domain.updateDeviceFlags(iface_xml, flags)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "set_vm_network", name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Network update error: {msg}") from e

        log_action(user["username"], "set_vm_network", name, "succes")
        return {"message": f"VM '{name}' attached to network '{payload.network}'"}
    finally:
        conn.close()


MAC_RE = re.compile(r"^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")


class InterfaceAttach(BaseModel):
    network: str
    vlan_tag: int | None = Field(None, ge=1, le=4094)


@router.post("/{name}/interfaces", status_code=201)
def attach_interface(name: str, payload: InterfaceAttach, user: dict = Depends(require_vm_privilege("vm.hardware"))):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "attach_interface", name, "echec", "VM not found")
            raise HTTPException(status_code=404, detail=f"VM '{name}' not found") from None

        try:
            conn.networkLookupByName(payload.network)
        except libvirt.libvirtError:
            log_action(user["username"], "attach_interface", name, "echec", "Network not found")
            raise HTTPException(status_code=404, detail=f"Network '{payload.network}' not found") from None

        vlan_xml = f"<vlan><tag id='{payload.vlan_tag}'/></vlan>" if payload.vlan_tag is not None else ""
        root = ET.fromstring(domain.XMLDesc(0))
        model = root.find("./devices/interface/model")
        interface_model = "e1000e" if model is not None and model.get("type") == "e1000e" else "virtio"
        iface_xml = f"""
        <interface type='network'>
          <source network='{payload.network}'/>
          {vlan_xml}
          <model type='{interface_model}'/>
        </interface>
        """
        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if domain.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
        try:
            domain.attachDeviceFlags(iface_xml, flags)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "attach_interface", name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Interface attach error: {msg}") from e

        log_action(user["username"], "attach_interface", name, "succes")
        return {"message": f"Interface added on network '{payload.network}' for '{name}'"}
    finally:
        conn.close()


@router.delete("/{name}/interfaces/{mac}")
def detach_interface(name: str, mac: str, user: dict = Depends(require_vm_privilege("vm.hardware"))):
    if not MAC_RE.match(mac):
        log_action(user["username"], "detach_interface", name, "echec", "Invalid MAC")
        raise HTTPException(status_code=422, detail="Invalid MAC address")
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "detach_interface", name, "echec", "VM not found")
            raise HTTPException(status_code=404, detail=f"VM '{name}' not found") from None

        xml_desc = domain.XMLDesc(0)
        root = ET.fromstring(xml_desc)
        interfaces = root.findall(".//devices/interface")
        if len(interfaces) <= 1:
            log_action(user["username"], "detach_interface", name, "echec", "Last interface")
            raise HTTPException(status_code=422, detail="Cannot detach the last network interface of a VM")

        iface_elem = None
        for iface in interfaces:
            mac_elem = iface.find("mac")
            if mac_elem is not None and mac_elem.get("address", "").lower() == mac.lower():
                iface_elem = iface
                break
        if iface_elem is None:
            log_action(user["username"], "detach_interface", name, "echec", f"Interface {mac} not found")
            raise HTTPException(status_code=404, detail=f"Interface '{mac}' not found on VM '{name}'")

        iface_xml = ET.tostring(iface_elem, encoding="unicode")
        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if domain.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
        try:
            domain.detachDeviceFlags(iface_xml, flags)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "detach_interface", name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Detach error: {msg}") from e

        log_action(user["username"], "detach_interface", name, "succes")
        return {"message": f"Interface '{mac}' detached from '{name}'"}
    finally:
        conn.close()


# --- Per-VM firewall ---
# Implemented through libvirt's nwfilter subsystem (VIR_NWFilter*) rather than
# hand-generated nftables/iptables rules: nwfilter is already libvirt's native
# mechanism for this, applied automatically by the QEMU driver at every VM
# (re)start with no external script to maintain. One filter per VM
# ("hyperlite-vm-<name>"), referenced by a <filterref> on each interface of the VM.
