from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
import libvirt
import re
import asyncio
import threading
from fastapi import WebSocket, WebSocketDisconnect
from app.core.libvirt_utils import ensure_vnc_graphics
import secrets
import time
from pathlib import Path
from app.routers.isos import ISOS_DIR
import subprocess
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

from app.core.libvirt_utils import open_conn, get_vm_uptime_s
from app.core.security import get_current_user, require_role, require_vm_privilege
from app.core.audit import log_action
from app.core.tasks import create_task, finish_task
from app.core.error_messages import describe_exception
from app.core.vm_builder import (
    validate_name, validate_username, create_disk, create_cloudinit_iso, create_cloudinit_reseed_iso,
    build_domain_xml, get_or_create_automation_pubkey, get_automation_private_key_path, IMAGES_DIR,
    strip_install_boot_override,
)
from app.core.unattended_install import detect_os_family, build_seed_iso, extract_casper_kernel, build_preseed_initrd
from app.core.vm_meta import (
    set_vm_ssh_user, get_vm_ssh_user, delete_vm_ssh_user, rename_vm_ssh_user,
    mark_provisioning, get_provisioning, clear_provisioning,
    set_vm_os_label, get_vm_os_label, delete_vm_os_label, rename_vm_os_label,
)
from app.core.permissions import delete_acl_for_vm, remove_vm_from_all_pools
from app.core.network_alloc import generate_mac, allocate_static_ip, release_static_ip
from xml.sax.saxutils import escape
import json
import asyncssh

router = APIRouter(prefix="/vms", tags=["vms"])

TARGET_DEV_RE = re.compile(r"^[a-z]{2,4}[0-9]{0,2}$")

STATE_NAMES = {
    libvirt.VIR_DOMAIN_NOSTATE: "inconnu",
    libvirt.VIR_DOMAIN_RUNNING: "actif",
    libvirt.VIR_DOMAIN_BLOCKED: "bloque",
    libvirt.VIR_DOMAIN_PAUSED: "en_pause",
    libvirt.VIR_DOMAIN_SHUTDOWN: "en_arret",
    libvirt.VIR_DOMAIN_SHUTOFF: "arrete",
    libvirt.VIR_DOMAIN_CRASHED: "plante",
    libvirt.VIR_DOMAIN_PMSUSPENDED: "suspendu",
}


def _get_ip(domain):
    try:
        ifaces = domain.interfaceAddresses(libvirt.VIR_DOMAIN_INTERFACE_ADDRESSES_SRC_LEASE)
        for iface in ifaces.values():
            for addr in iface.get("addrs", []):
                if addr.get("type") == 0:
                    return addr.get("addr")
    except libvirt.libvirtError:
        pass
    return None


def _domain_summary(domain):
    state, maxmem, mem, nvcpu, cputime = domain.info()
    active = domain.isActive()
    return {
        "nom": domain.name(),
        "id": domain.ID() if active else None,
        "uuid": domain.UUIDString(),
        "etat": STATE_NAMES.get(state, "inconnu"),
        "vcpu": nvcpu,
        "memoire_mo": round(maxmem / 1024, 1),
        "ip": _get_ip(domain) if active else None,
        "utilisateur_ssh": get_vm_ssh_user(domain.name()),
        "uptime_s": get_vm_uptime_s(domain.name()) if active else None,
        "os": get_vm_os_label(domain.name()),
    }


@router.get("")
def list_vms(user: dict = Depends(get_current_user)):
    conn = open_conn()
    try:
        domains = conn.listAllDomains()
        result = [_domain_summary(d) for d in domains]
        log_action(user["username"], "list_vms", "vms", "succes")
        return result
    finally:
        conn.close()


@router.get("/{name}")
def get_vm(name: str, user: dict = Depends(get_current_user)):
    conn = open_conn()
    try:
        domain = conn.lookupByName(name)
    except libvirt.libvirtError:
        log_action(user["username"], "get_vm", name, "echec", "VM introuvable")
        conn.close()
        raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")
    result = _domain_summary(domain)
    conn.close()
    log_action(user["username"], "get_vm", name, "succes")
    return result


class VMUpdate(BaseModel):
    vcpu: int | None = Field(default=None, ge=1, le=2)
    memory_mb: int | None = Field(default=None, ge=256, le=2048)


@router.patch("/{name}")
def update_vm(name: str, payload: VMUpdate, user: dict = Depends(require_vm_privilege("vm.resize"))):
    if payload.vcpu is None and payload.memory_mb is None:
        raise HTTPException(status_code=422, detail="Aucune modification demandée (vcpu ou memory_mb requis)")

    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "update_vm", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        if domain.isActive():
            log_action(user["username"], "update_vm", name, "echec", "VM active")
            raise HTTPException(status_code=409, detail="Arrêtez la VM avant de modifier ses ressources")

        try:
            if payload.vcpu is not None:
                # Le max doit etre ajuste avant (ou en meme temps que) le courant,
                # sinon libvirt refuse un "courant" superieur a l'ancien max.
                domain.setVcpusFlags(payload.vcpu, libvirt.VIR_DOMAIN_AFFECT_CONFIG | libvirt.VIR_DOMAIN_VCPU_MAXIMUM)
                domain.setVcpusFlags(payload.vcpu, libvirt.VIR_DOMAIN_AFFECT_CONFIG)
            if payload.memory_mb is not None:
                kib = payload.memory_mb * 1024
                domain.setMemoryFlags(kib, libvirt.VIR_DOMAIN_AFFECT_CONFIG | libvirt.VIR_DOMAIN_MEM_MAXIMUM)
                domain.setMemoryFlags(kib, libvirt.VIR_DOMAIN_AFFECT_CONFIG)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "update_vm", name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Erreur de mise à jour des ressources : {msg}")

        domain = conn.lookupByName(name)
        result = _domain_summary(domain)
        log_action(user["username"], "update_vm", name, "succes")
        return result
    finally:
        conn.close()


# --- Limites et reservations de ressources (chantier 6 de la roadmap
# vSphere/vCenter, 2026-09-13) -- equivalent simplifie des Resource Pools
# vSphere (reservation/limit/shares), applique via les mecanismes cgroups
# que libvirt expose directement (schedulerParametersFlags/memoryParameters -
# pas de manipulation XML manuelle necessaire, contrairement au reste du
# fichier, ces deux appels existent tels quels dans l'API libvirt).
#
# Simplifications assumees (a documenter cote utilisateur, pas de sur-
# ingenierie a la vSphere complet) :
# - CPU "shares" : priorite RELATIVE en cas de contention reelle du/des
#   coeurs hote (cgroup cpu.shares, defaut 1024) -- pas une garantie absolue,
#   n'a aucun effet tant que l'hote n'est pas sature.
# - CPU "limite" : plafond dur en % d'un coeur PAR vCPU (cgroup
#   cpu.cfs_quota_us/cfs_period_us via vcpu_quota/vcpu_period) -- une VM a 2
#   vCPU avec 50% de limite peut consommer au plus l'equivalent d'1 coeur
#   plein, jamais plus, meme si l'hote est inactif.
# - RAM : PAS de vraie "reservation garantie" ici -- libvirt expose bien
#   <memtune><min_guarantee> dans son schema XML, mais ce champ n'est
#   respecte que par l'hyperviseur Xen, c'est un no-op cote QEMU/KVM (verifie
#   dans la documentation libvirt). La seule reservation RAM reelle sur
#   KVM consiste a ne pas suralouer l'hote (verifier RAM disponible avant
#   d'augmenter memory_mb, deja fait par update_vm). Ce qui EST reellement
#   applique ici : une limite dure separee de la RAM allouee
#   (<memtune><hard_limit>, cgroup memory.limit_in_bytes) -- utile pour
#   plafonner un processus qemu qui deriverait au-dela de la RAM allouee a
#   l'invite, pas pour garantir un minimum.
UNLIMITED_KB = 9007199254740991  # sentinelle documentee par libvirt pour "pas de limite"
DEFAULT_CPU_SHARES = 1024
CPU_PERIOD_US = 100000  # periode cgroup standard (100ms), coherent avec le defaut libvirt


class ResourceLimits(BaseModel):
    cpu_shares: int = Field(DEFAULT_CPU_SHARES, ge=2, le=262144)
    cpu_limit_pct: int | None = Field(None, ge=1, le=100, description="% d'un coeur hote PAR vCPU ; null = illimité")
    mem_hard_limit_mb: int | None = Field(None, ge=64, description="Plafond dur RAM en Mo, distinct de la RAM allouée ; null = illimité")


def _limits_summary(domain):
    flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
    sched = domain.schedulerParametersFlags(flags)
    mem = domain.memoryParameters(flags)
    nvcpu = domain.info()[3] or 1
    quota = sched.get("vcpu_quota", 0)
    period = sched.get("vcpu_period", 0) or CPU_PERIOD_US
    cpu_limit_pct = None
    if quota and quota > 0:
        cpu_limit_pct = round((quota / period) / nvcpu * 100)
    hard_limit_kb = mem.get("hard_limit", UNLIMITED_KB)
    return {
        # libvirt renvoie 0 tant qu'aucune valeur explicite n'a jamais ete
        # posee (le defaut effectif cote cgroup est 1024, pas 0).
        "cpu_shares": sched.get("cpu_shares") or DEFAULT_CPU_SHARES,
        "cpu_limit_pct": cpu_limit_pct,
        "mem_hard_limit_mb": None if hard_limit_kb >= UNLIMITED_KB else round(hard_limit_kb / 1024),
    }


@router.get("/{name}/limits")
def get_vm_limits(name: str, user: dict = Depends(require_vm_privilege("vm.resize"))):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")
        return _limits_summary(domain)
    finally:
        conn.close()


@router.put("/{name}/limits")
def set_vm_limits(name: str, payload: ResourceLimits, user: dict = Depends(require_vm_privilege("vm.resize"))):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "set_vm_limits", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        nvcpu = domain.info()[3] or 1
        if payload.cpu_limit_pct is None:
            vcpu_quota = -1  # convention libvirt : illimite
        else:
            vcpu_quota = int(CPU_PERIOD_US * nvcpu * payload.cpu_limit_pct / 100)

        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if domain.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE

        try:
            domain.setSchedulerParametersFlags(
                {"cpu_shares": payload.cpu_shares, "vcpu_period": CPU_PERIOD_US, "vcpu_quota": vcpu_quota},
                flags,
            )
            hard_limit_kb = UNLIMITED_KB if payload.mem_hard_limit_mb is None else payload.mem_hard_limit_mb * 1024
            domain.setMemoryParameters({"hard_limit": hard_limit_kb}, flags)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "set_vm_limits", name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Erreur d'application des limites : {msg}")

        log_action(user["username"], "set_vm_limits", name, "succes")
        return _limits_summary(domain)
    finally:
        conn.close()


class DiskSpec(BaseModel):
    size_gb: int = Field(ge=1, le=500)


class VMCreate(BaseModel):
    name: str
    vcpu: int = Field(ge=1, le=2)
    memory_mb: int = Field(ge=256, le=2048)
    disks: list[DiskSpec] = Field(min_length=1, max_length=8)
    network: str = "default"
    # Optionnels : sans objet quand un ISO d'installation est fourni (pas de
    # cloud-init dans ce cas, voir plus bas -- l'utilisateur cree son propre
    # compte pendant l'installation manuelle de l'OS).
    username: str | None = None
    password: str | None = None
    iso: str | None = None


@router.post("", status_code=201)
def create_vm(payload: VMCreate, user: dict = Depends(require_role("admin"))):
    errors = []
    name_error = validate_name(payload.name)
    if name_error:
        errors.append(name_error)

    iso_path = None
    if payload.iso:
        candidate = ISOS_DIR / payload.iso
        if not candidate.exists():
            errors.append(f"ISO '{payload.iso}' introuvable")
        else:
            iso_path = candidate

    # Mode "installation depuis ISO" : disque systeme vierge. Si l'ISO est
    # reconnu (famille RHEL/kickstart ou Ubuntu/autoinstall, voir
    # app/core/unattended_install.py), l'installation est automatisee : un
    # petit ISO de reponses cree le compte utilisateur et y installe la cle
    # SSH d'automatisation, exactement comme le cloud-init des VM Debian. Un
    # ISO non reconnu retombe sur l'installation manuelle (l'utilisateur cree
    # son propre compte via la console VNC, pas de terminal SSH web tant que
    # l'acces n'y est pas configure a la main). Sans ISO, comportement
    # inchange : image Debian 12 preinstallee + cloud-init.
    install_mode = iso_path is not None
    os_family = detect_os_family(payload.iso) if install_mode else None
    automated_install = install_mode and os_family is not None
    needs_account = not install_mode or automated_install
    if needs_account:
        username_error = validate_username(payload.username or "")
        if username_error:
            errors.append(username_error)
        if len(payload.password or "") < 4:
            errors.append("Le mot de passe doit contenir au moins 4 caractères")

    conn = open_conn()
    task_id = create_task("create_vm", payload.name, node=conn.getHostname(), username=user["username"])
    try:
        try:
            conn.lookupByName(payload.name)
            errors.append(f"Une VM nommée '{payload.name}' existe déjà")
        except libvirt.libvirtError:
            pass

        try:
            conn.networkLookupByName(payload.network)
        except libvirt.libvirtError:
            errors.append(f"Réseau '{payload.network}' introuvable")

        if errors:
            log_action(user["username"], "create_vm", payload.name, "echec", "; ".join(errors), task_id=task_id)
            raise HTTPException(status_code=422, detail=errors)

        # IP fixe par VM (voir app/core/network_alloc.py) : reservation DHCP
        # cote reseau libvirt sur une MAC connue d'avance, aucun changement
        # dans le cloud-init/kickstart/autoinstall (toujours du DHCP normal
        # cote invite). Best-effort : un echec ici ne doit pas empecher la
        # creation de la VM, juste la priver d'IP fixe (comportement DHCP
        # habituel en repli).
        mac = generate_mac(conn)
        try:
            allocate_static_ip(conn, payload.network, mac)
        except libvirt.libvirtError:
            pass

        try:
            disk_paths = [
                create_disk(payload.name, disk.size_gb, index=i, blank=(install_mode and i == 0))
                for i, disk in enumerate(payload.disks)
            ]
            cloudinit_path = None
            seed_iso_path = None
            kernel_path = initrd_path = kernel_cmdline = None
            if not install_mode:
                ssh_pubkey = get_or_create_automation_pubkey()
                cloudinit_path = create_cloudinit_iso(
                    payload.name, username=payload.username,
                    password=payload.password, ssh_pubkey=ssh_pubkey,
                )
            elif automated_install:
                ssh_pubkey = get_or_create_automation_pubkey()
                if os_family == "preseed":
                    # Kali/debian-installer : pas d'ISO de reponses separee,
                    # le preseed complet est embarque dans un initrd modifie
                    # par VM (voir build_preseed_initrd). auto=true
                    # priority=critical supprime toute question non
                    # preseedee au lieu de rester bloque en attente d'une
                    # reponse manuelle.
                    kernel_path, initrd_path = build_preseed_initrd(
                        payload.name, iso_path,
                        username=payload.username, password=payload.password, ssh_pubkey=ssh_pubkey,
                    )
                    kernel_cmdline = "auto=true priority=critical ---"
                else:
                    seed_iso_path = build_seed_iso(
                        os_family, payload.name,
                        username=payload.username, password=payload.password, ssh_pubkey=ssh_pubkey,
                    )
                    # Ubuntu/autoinstall a besoin du mot-cle "autoinstall" sur
                    # la ligne de commande noyau pour sauter la confirmation
                    # manuelle unique de Subiquity ("Continue with
                    # autoinstall?") -- pas necessaire pour kickstart (RHEL)
                    # ni alpine (apkovl), qui n'ont jamais eu ce probleme.
                    # Retire une fois l'installation terminee, voir
                    # get_vm_provisioning plus bas (sinon reboot en boucle
                    # sur l'installeur live au lieu du systeme installe).
                    if os_family == "autoinstall":
                        kernel_path, initrd_path = extract_casper_kernel(iso_path)
                        kernel_cmdline = "autoinstall ---"
        except subprocess.CalledProcessError as e:
            msg = f"Erreur lors de la preparation du disque/cloud-init : {e.stderr or e}"
            log_action(user["username"], "create_vm", payload.name, "echec", msg, task_id=task_id)
            raise HTTPException(status_code=500, detail=msg)
        except ValueError as e:
            log_action(user["username"], "create_vm", payload.name, "echec", str(e), task_id=task_id)
            raise HTTPException(status_code=422, detail=str(e))

        xml = build_domain_xml(
            payload.name, payload.vcpu, payload.memory_mb,
            disk_paths, cloudinit_path, payload.network, iso_path=iso_path, seed_iso_path=seed_iso_path, mac=mac,
            kernel_path=kernel_path, initrd_path=initrd_path, kernel_cmdline=kernel_cmdline,
        )
        domain = conn.defineXML(xml)
        if needs_account:
            set_vm_ssh_user(payload.name, payload.username)
        if automated_install:
            # Chantier 12 : "sans aucune intervention manuelle" -- avant ce
            # correctif, create_vm ne faisait que DEFINIR le domaine, il
            # fallait cliquer "Demarrer" a la main pour que l'installation
            # kickstart/autoinstall parte reellement. Demarre automatiquement
            # ici pour de vrai. Une tache dediee ("auto_install") est creee
            # pour ce cycle install+SSH-check complet, distincte de la tache
            # "create_vm" (qui elle ne couvre que la definition du domaine,
            # deja terminee au moment ou ce bloc s'execute) -- cloturee par
            # get_vm_provisioning plus bas, succes ou echec/timeout.
            install_task_id = create_task("auto_install", payload.name, node=conn.getHostname(), username=user["username"])
            mark_provisioning(payload.name, os_family, task_id=install_task_id)
            try:
                domain.create()
            except libvirt.libvirtError as e:
                msg = describe_exception(e)
                finish_task(install_task_id, "echec", f"Démarrage automatique impossible : {msg}")
                clear_provisioning(payload.name)
                log_action(user["username"], "auto_install", payload.name, "echec", msg)
                # Ne fait pas echouer create_vm pour autant : le domaine est
                # bien defini, l'admin peut le demarrer/diagnostiquer a la
                # main -- un echec de demarrage automatique ne doit pas
                # rendre la VM invisible/perdue.
        # Libelle d'OS "declare" (voir vm_meta.py::set_vm_os_label) : deduit
        # du nom de l'ISO montee, ou "Debian 12" pour le chemin cloud-init
        # par defaut (aucune ISO, image pre-installee). Pas un vrai OS
        # "detecte" (aucun qemu-guest-agent installe dans les VM invitees
        # aujourd'hui), mais fiable : c'est Hyperlite qui a demande cet OS.
        os_label = Path(payload.iso).stem if install_mode else "Debian 12"
        set_vm_os_label(payload.name, os_label)
        log_action(user["username"], "create_vm", payload.name, "succes", task_id=task_id)
        return _domain_summary(domain)
    finally:
        conn.close()


@router.post("/{name}/start")
def start_vm(name: str, user: dict = Depends(require_vm_privilege("vm.power"))):
    conn = open_conn()
    task_id = create_task("start_vm", name, node=conn.getHostname(), username=user["username"])
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "start_vm", name, "echec", "VM introuvable", task_id=task_id)
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")
        if domain.isActive():
            log_action(user["username"], "start_vm", name, "echec", "VM déjà active", task_id=task_id)
            raise HTTPException(status_code=409, detail=f"VM '{name}' est déjà active")
        try:
            domain.create()
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "start_vm", name, "echec", msg, task_id=task_id)
            raise HTTPException(status_code=500, detail=f"Impossible de démarrer la VM : {msg}")
        log_action(user["username"], "start_vm", name, "succes", task_id=task_id)
        return _domain_summary(domain)
    finally:
        conn.close()


@router.post("/{name}/stop")
def stop_vm(name: str, force: bool = False, user: dict = Depends(require_vm_privilege("vm.power"))):
    conn = open_conn()
    action_name = "force_stop_vm" if force else "stop_vm"
    task_id = create_task(action_name, name, node=conn.getHostname(), username=user["username"])
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "stop_vm", name, "echec", "VM introuvable", task_id=task_id)
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")
        if not domain.isActive():
            log_action(user["username"], "stop_vm", name, "echec", "VM déjà arrêtée", task_id=task_id)
            raise HTTPException(status_code=409, detail=f"VM '{name}' est déjà arrêtée")
        try:
            if force:
                domain.destroy()
            else:
                domain.shutdown()
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], action_name, name, "echec", msg, task_id=task_id)
            raise HTTPException(status_code=500, detail=f"Impossible d'arrêter la VM : {msg}")
        log_action(user["username"], action_name, name, "succes", task_id=task_id)
        return _domain_summary(domain)
    finally:
        conn.close()


@router.post("/{name}/restart")
def restart_vm(name: str, force: bool = False, user: dict = Depends(require_vm_privilege("vm.power"))):
    conn = open_conn()
    task_id = create_task("restart_vm", name, node=conn.getHostname(), username=user["username"])
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "restart_vm", name, "echec", "VM introuvable", task_id=task_id)
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")
        if not domain.isActive():
            log_action(user["username"], "restart_vm", name, "echec", "VM arrêtée", task_id=task_id)
            raise HTTPException(status_code=409, detail=f"VM '{name}' est arrêtée, démarrez-la d'abord")
        try:
            if force:
                domain.destroy()
                domain.create()
            else:
                domain.reboot()
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "restart_vm", name, "echec", msg, task_id=task_id)
            raise HTTPException(status_code=500, detail=f"Impossible de redémarrer la VM : {msg}")
        log_action(user["username"], "restart_vm", name, "succes", task_id=task_id)
        return _domain_summary(domain)
    finally:
        conn.close()


@router.delete("/{name}")
def delete_vm(name: str, confirm: bool = False, user: dict = Depends(require_role("admin"))):
    conn = open_conn()
    task_id = create_task("delete_vm", name, node=conn.getHostname(), username=user["username"])
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "delete_vm", name, "echec", "VM introuvable", task_id=task_id)
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")
        if domain.isActive():
            log_action(user["username"], "delete_vm", name, "echec", "VM active, arrêt requis", task_id=task_id)
            raise HTTPException(status_code=409, detail=f"VM '{name}' est active. Arrêtez-la avant de la supprimer")
        if not confirm:
            log_action(user["username"], "delete_vm", name, "echec", "Confirmation manquante", task_id=task_id)
            raise HTTPException(status_code=400, detail="Action irréversible : ajoutez ?confirm=true pour confirmer la suppression")

        # Capture mac+reseau AVANT l'undefine (plus interrogeable apres) pour
        # liberer la reservation d'IP fixe (voir network_alloc.py) -- sinon
        # la plage DHCP se remplit d'entrees orphelines au fil des VM
        # supprimees.
        iface_mac, iface_network = None, None
        # Capture AVANT l'undefine (plus interrogeable apres) de TOUS les
        # disques et TOUTES les interfaces -- pas seulement les premiers :
        # une VM multi-disques/multi-NIC (fonctionnalites deja livrees, voir
        # roadmap) ne doit pas laisser de fichier qcow2 orphelin ni de
        # reservation DHCP fantome pour ses disques/interfaces au-dela du
        # premier. Bug reel trouve et corrige le 2026-09-13 (repere en testant
        # le clonage multi-disques du chantier 5 : le disque secondaire d'une
        # VM supprimee restait sur le disque hote, provoquant un conflit de
        # nom au clonage suivant).
        disk_paths_to_remove = []
        ifaces_to_release = []
        try:
            root = ET.fromstring(domain.XMLDesc())
            for disk_el in root.findall(".//devices/disk"):
                if disk_el.get("device") != "disk":
                    continue
                source_el = disk_el.find("source")
                if source_el is not None and source_el.get("file"):
                    disk_paths_to_remove.append(Path(source_el.get("file")))
            for iface in root.findall(".//interface[@type='network']"):
                mac_el, source_el = iface.find("mac"), iface.find("source")
                if mac_el is not None and source_el is not None and source_el.get("network"):
                    ifaces_to_release.append((source_el.get("network"), mac_el.get("address")))
        except (libvirt.libvirtError, ET.ParseError):
            pass

        try:
            # VIR_DOMAIN_UNDEFINE_SNAPSHOTS_METADATA : sans ce flag, undefine()
            # echoue purement et simplement des qu'il reste un ou plusieurs
            # snapshots ("cannot delete inactive domain with N snapshots"),
            # meme partiellement supprimes -- bug reproduit et confirme le
            # 2026-09-13 (voir chantier 4 snapshots). Sans danger ici : le
            # fichier qcow2 qui contenait les snapshots internes est de toute
            # facon supprime juste apres (unlink plus bas), la VM elle-meme
            # est deja irrevocablement confirmee supprimee (?confirm=true).
            domain.undefineFlags(libvirt.VIR_DOMAIN_UNDEFINE_SNAPSHOTS_METADATA)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "delete_vm", name, "echec", msg, task_id=task_id)
            raise HTTPException(status_code=500, detail=f"Impossible de supprimer la VM : {msg}")

        for iface_network, iface_mac in ifaces_to_release:
            try:
                release_static_ip(conn, iface_network, iface_mac)
            except libvirt.libvirtError:
                pass

        for disk_path in disk_paths_to_remove:
            disk_path.unlink(missing_ok=True)
        (IMAGES_DIR / f"{name}-cloudinit.iso").unlink(missing_ok=True)
        (IMAGES_DIR / f"{name}-oemdrv.iso").unlink(missing_ok=True)
        (IMAGES_DIR / f"{name}-autoinstall.iso").unlink(missing_ok=True)
        (IMAGES_DIR / f"{name}-preseed-initrd.gz").unlink(missing_ok=True)
        (IMAGES_DIR / f"{name}-alpine-seed.iso").unlink(missing_ok=True)
        delete_vm_ssh_user(name)
        delete_vm_os_label(name)
        clear_provisioning(name)
        delete_acl_for_vm(name)
        remove_vm_from_all_pools(name)

        log_action(user["username"], "delete_vm", name, "succes", task_id=task_id)
        return {"message": f"VM '{name}' supprimée"}
    finally:
        conn.close()


class DiskAttach(BaseModel):
    volume_name: str
    pool: str = "default"
    target_dev: str = "sdb"


# Bus libvirt a utiliser selon le prefixe du target_dev, pour rester coherent avec le
# controleur virtio-scsi (sd*) mis en place par build_domain_xml sur toutes les VMs.
DEV_BUS_PREFIXES = {"sd": "scsi", "vd": "virtio", "hd": "ide"}


@router.post("/{name}/disks", status_code=201)
def attach_disk(name: str, payload: DiskAttach, user: dict = Depends(require_vm_privilege("vm.hardware"))):
    if not TARGET_DEV_RE.match(payload.target_dev):
        log_action(user["username"], "attach_disk", name, "echec", "target_dev invalide")
        raise HTTPException(status_code=422, detail="target_dev invalide (attendu par ex. vda, vdb, sdb)")
    bus = DEV_BUS_PREFIXES.get(payload.target_dev[:2], "virtio")
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "attach_disk", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        try:
            pool = conn.storagePoolLookupByName(payload.pool)
            vol = pool.storageVolLookupByName(payload.volume_name)
        except libvirt.libvirtError:
            log_action(user["username"], "attach_disk", name, "echec", "Volume introuvable")
            raise HTTPException(status_code=404, detail=f"Volume '{payload.volume_name}' introuvable dans le pool '{payload.pool}'")

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
            raise HTTPException(status_code=500, detail=f"Erreur d'attachement du disque : {msg}")

        log_action(user["username"], "attach_disk", name, "succes")
        return {"message": f"Volume '{payload.volume_name}' attaché à '{name}' en tant que {payload.target_dev}"}
    finally:
        conn.close()


@router.delete("/{name}/disks/{target_dev}")
def detach_disk(name: str, target_dev: str, user: dict = Depends(require_vm_privilege("vm.hardware"))):
    if not TARGET_DEV_RE.match(target_dev):
        log_action(user["username"], "detach_disk", name, "echec", "target_dev invalide")
        raise HTTPException(status_code=422, detail="target_dev invalide (attendu par ex. vda, vdb, sdb)")
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "detach_disk", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        xml_desc = domain.XMLDesc(0)
        root = ET.fromstring(xml_desc)
        disk_elem = None
        for disk in root.findall(".//devices/disk"):
            target = disk.find("target")
            if target is not None and target.get("dev") == target_dev:
                disk_elem = disk
                break
        if disk_elem is None:
            log_action(user["username"], "detach_disk", name, "echec", f"Disque {target_dev} introuvable")
            raise HTTPException(status_code=404, detail=f"Disque '{target_dev}' introuvable sur la VM '{name}'")

        disk_xml = ET.tostring(disk_elem, encoding="unicode")
        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if domain.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
        try:
            domain.detachDeviceFlags(disk_xml, flags)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "detach_disk", name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Erreur de détachement : {msg}")

        log_action(user["username"], "detach_disk", name, "succes")
        return {"message": f"Disque '{target_dev}' détaché de '{name}'"}
    finally:
        conn.close()


def _get_interfaces(domain):
    xml_desc = domain.XMLDesc(0)
    root = ET.fromstring(xml_desc)
    result = []
    for iface in root.findall(".//devices/interface"):
        mac_elem = iface.find("mac")
        source_elem = iface.find("source")
        result.append({
            "mac": mac_elem.get("address") if mac_elem is not None else None,
            "reseau": source_elem.get("network") if source_elem is not None else None,
            "type_source": iface.get("type"),
        })
    return result


@router.get("/{name}/disks")
def get_vm_disks(name: str, user: dict = Depends(get_current_user)):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "get_vm_disks", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")
        xml_desc = domain.XMLDesc(0)
        root = ET.fromstring(xml_desc)
        disks = []
        for disk in root.findall(".//devices/disk"):
            target = disk.find("target")
            source = disk.find("source")
            disks.append({
                "cible": target.get("dev") if target is not None else None,
                "bus": target.get("bus") if target is not None else None,
                "type": disk.get("device"),
                "source": (source.get("file") if source is not None else None),
            })
        log_action(user["username"], "get_vm_disks", name, "succes")
        return disks
    finally:
        conn.close()


@router.get("/{name}/network")
def get_vm_network(name: str, user: dict = Depends(get_current_user)):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "get_vm_network", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")
        interfaces = _get_interfaces(domain)
        ip = _get_ip(domain) if domain.isActive() else None
        log_action(user["username"], "get_vm_network", name, "succes")
        return {"interfaces": interfaces, "ip": ip}
    finally:
        conn.close()


class NetworkUpdate(BaseModel):
    network: str
    vlan_tag: int | None = Field(None, ge=1, le=4094, description="Tag 802.1Q -- effectif seulement si le réseau/pont sous-jacent gère le trunking (Open vSwitch) ; ignoré silencieusement sur un pont Linux standard")


@router.put("/{name}/network")
def set_vm_network(name: str, payload: NetworkUpdate, user: dict = Depends(require_vm_privilege("vm.hardware"))):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "set_vm_network", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        try:
            conn.networkLookupByName(payload.network)
        except libvirt.libvirtError:
            log_action(user["username"], "set_vm_network", name, "echec", "Réseau introuvable")
            raise HTTPException(status_code=404, detail=f"Réseau '{payload.network}' introuvable")

        xml_desc = domain.XMLDesc(0)
        root = ET.fromstring(xml_desc)
        iface = root.find(".//devices/interface")
        if iface is None:
            log_action(user["username"], "set_vm_network", name, "echec", "Aucune interface")
            raise HTTPException(status_code=404, detail="Aucune interface réseau trouvée sur cette VM")

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
            raise HTTPException(status_code=500, detail=f"Erreur de mise à jour du réseau : {msg}")

        log_action(user["username"], "set_vm_network", name, "succes")
        return {"message": f"VM '{name}' associée au réseau '{payload.network}'"}
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
            log_action(user["username"], "attach_interface", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        try:
            conn.networkLookupByName(payload.network)
        except libvirt.libvirtError:
            log_action(user["username"], "attach_interface", name, "echec", "Réseau introuvable")
            raise HTTPException(status_code=404, detail=f"Réseau '{payload.network}' introuvable")

        vlan_xml = f"<vlan><tag id='{payload.vlan_tag}'/></vlan>" if payload.vlan_tag is not None else ""
        iface_xml = f"""
        <interface type='network'>
          <source network='{payload.network}'/>
          {vlan_xml}
          <model type='virtio'/>
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
            raise HTTPException(status_code=500, detail=f"Erreur d'attachement de l'interface : {msg}")

        log_action(user["username"], "attach_interface", name, "succes")
        return {"message": f"Interface ajoutée sur le réseau '{payload.network}' pour '{name}'"}
    finally:
        conn.close()


@router.delete("/{name}/interfaces/{mac}")
def detach_interface(name: str, mac: str, user: dict = Depends(require_vm_privilege("vm.hardware"))):
    if not MAC_RE.match(mac):
        log_action(user["username"], "detach_interface", name, "echec", "MAC invalide")
        raise HTTPException(status_code=422, detail="Adresse MAC invalide")
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "detach_interface", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        xml_desc = domain.XMLDesc(0)
        root = ET.fromstring(xml_desc)
        interfaces = root.findall(".//devices/interface")
        if len(interfaces) <= 1:
            log_action(user["username"], "detach_interface", name, "echec", "Dernière interface")
            raise HTTPException(status_code=422, detail="Impossible de détacher la dernière interface réseau d'une VM")

        iface_elem = None
        for iface in interfaces:
            mac_elem = iface.find("mac")
            if mac_elem is not None and mac_elem.get("address", "").lower() == mac.lower():
                iface_elem = iface
                break
        if iface_elem is None:
            log_action(user["username"], "detach_interface", name, "echec", f"Interface {mac} introuvable")
            raise HTTPException(status_code=404, detail=f"Interface '{mac}' introuvable sur la VM '{name}'")

        iface_xml = ET.tostring(iface_elem, encoding="unicode")
        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if domain.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
        try:
            domain.detachDeviceFlags(iface_xml, flags)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "detach_interface", name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Erreur de détachement : {msg}")

        log_action(user["username"], "detach_interface", name, "succes")
        return {"message": f"Interface '{mac}' détachée de '{name}'"}
    finally:
        conn.close()


# --- Pare-feu par VM (chantier 9 de la roadmap vSphere/vCenter, 2026-09-13)
# ---
# Implemente via le sous-systeme nwfilter de libvirt (VIR_NWFilter*), pas des
# regles nftables/iptables generees a la main : nwfilter est deja le
# mecanisme natif de libvirt pour ca, applique automatiquement par le
# pilote QEMU sur chaque (re)demarrage de la VM sans script externe a
# maintenir. Un filtre par VM ("hyperlite-vm-<nom>"), reference par
# <filterref> sur chaque interface de la VM.

_FIREWALL_PROTOCOLS = {"tcp", "udp", "icmp", "all"}
_FIREWALL_ACTIONS = {"accept", "drop"}
_FIREWALL_DIRECTIONS = {"in", "out", "inout"}


class FirewallRule(BaseModel):
    action: str
    direction: str
    protocol: str
    port: int | None = Field(None, ge=1, le=65535)


class FirewallConfig(BaseModel):
    default_policy: str = "accept"
    rules: list[FirewallRule] = []


def _firewall_filter_name(vm_name):
    return f"hyperlite-vm-{vm_name}"


def _build_nwfilter_xml(vm_name, config):
    rules_xml = ""
    priority = 300
    for rule in config.rules:
        port_attr = f" dstportstart='{rule.port}'" if rule.port and rule.protocol in ("tcp", "udp") else ""
        rules_xml += f"<rule action='{rule.action}' direction='{rule.direction}' priority='{priority}'><{rule.protocol}{port_attr}/></rule>"
        priority += 1
    default_action = "accept" if config.default_policy == "accept" else "drop"
    rules_xml += f"<rule action='{default_action}' direction='inout' priority='999'><all/></rule>"
    return f"<filter name='{_firewall_filter_name(vm_name)}' chain='root'>{rules_xml}</filter>"


def _parse_nwfilter_xml(xml_desc):
    root = ET.fromstring(xml_desc)
    rules = []
    default_policy = "accept"
    for rule_el in root.findall("rule"):
        proto_el = None
        for candidate in ("tcp", "udp", "icmp", "all"):
            proto_el = rule_el.find(candidate)
            if proto_el is not None:
                break
        if proto_el is None:
            continue
        protocol = proto_el.tag
        port = proto_el.get("dstportstart")
        direction = rule_el.get("direction", "inout")
        action = rule_el.get("action", "accept")
        if protocol == "all" and direction == "inout" and int(rule_el.get("priority", 0)) >= 999:
            default_policy = action  # la regle catch-all ajoutee par _build_nwfilter_xml
            continue
        rules.append({"action": action, "direction": direction, "protocol": protocol, "port": int(port) if port else None})
    return {"default_policy": default_policy, "rules": rules}


@router.get("/{name}/firewall")
def get_vm_firewall(name: str, user: dict = Depends(require_vm_privilege("vm.hardware"))):
    conn = open_conn()
    try:
        try:
            conn.lookupByName(name)
        except libvirt.libvirtError:
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")
        try:
            nwf = conn.nwfilterLookupByName(_firewall_filter_name(name))
            return _parse_nwfilter_xml(nwf.XMLDesc(0))
        except libvirt.libvirtError:
            return {"default_policy": "accept", "rules": []}  # aucune regle definie -- tout autorise, comportement par defaut
    finally:
        conn.close()


@router.put("/{name}/firewall")
def set_vm_firewall(name: str, payload: FirewallConfig, user: dict = Depends(require_vm_privilege("vm.hardware"))):
    if payload.default_policy not in _FIREWALL_ACTIONS:
        raise HTTPException(status_code=422, detail="default_policy doit être 'accept' ou 'drop'")
    for rule in payload.rules:
        if rule.action not in _FIREWALL_ACTIONS or rule.direction not in _FIREWALL_DIRECTIONS or rule.protocol not in _FIREWALL_PROTOCOLS:
            raise HTTPException(status_code=422, detail=f"Règle invalide : {rule}")

    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "set_vm_firewall", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        filter_name = _firewall_filter_name(name)
        try:
            conn.nwfilterDefineXML(_build_nwfilter_xml(name, payload))
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "set_vm_firewall", name, "echec", msg)
            raise HTTPException(status_code=500, detail=f"Erreur de définition du pare-feu : {msg}")

        # Reference le filtre sur CHAQUE interface de la VM (pas seulement la
        # premiere) -- sans quoi une VM multi-NIC laisserait une interface
        # non filtree, silencieusement, ce qui a ete precisement le type de
        # bug corrige au chantier 5 pour les disques/interfaces au clonage.
        root = ET.fromstring(domain.XMLDesc(0))
        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if domain.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
        applied = 0
        for iface in root.findall(".//devices/interface"):
            existing_ref = iface.find("filterref")
            if existing_ref is not None:
                iface.remove(existing_ref)
            ET.SubElement(iface, "filterref", {"filter": filter_name})
            try:
                domain.updateDeviceFlags(ET.tostring(iface, encoding="unicode"), flags)
                applied += 1
            except libvirt.libvirtError as e:
                msg = describe_exception(e)
                log_action(user["username"], "set_vm_firewall", name, "echec", msg)
                raise HTTPException(status_code=500, detail=f"Filtre créé mais non appliqué à l'interface : {msg}")

        log_action(user["username"], "set_vm_firewall", name, "succes", f"{len(payload.rules)} règle(s), {applied} interface(s)")
        return {"message": f"Pare-feu appliqué à {applied} interface(s)", **payload.model_dump()}
    finally:
        conn.close()


# --- Snapshots (10.8, reecrit le 2026-09-13 -- chantier 4 de la roadmap
# vSphere/vCenter) ---
#
# Un snapshot capture l'etat d'une VM (disque, et memoire si elle tourne) a un
# instant T, stocke DANS le fichier qcow2 lui-meme (snapshot "interne") : c'est
# rapide a creer/restaurer mais ce n'est PAS une sauvegarde independante (si le
# disque qcow2 est perdu/corrompu, tous ses snapshots le sont aussi). Une
# vraie sauvegarde (backup) est une copie complete et autonome des donnees,
# stockee ailleurs, qui survit a la perte du disque source - c'est plus lent
# et plus lourd, mais c'est la seule protection contre une panne de stockage.
# Le snapshot sert a revenir en arriere rapidement (avant une mise a jour
# risquee, par exemple) ; le backup sert a la reprise apres sinistre.
#
# Diagnostic (reproduit et confirme sur ce host le 2026-09-13, voir le journal
# de session) : le code precedent (flags=0, XML minimal, synchrone) creait et
# restaurait correctement des snapshots internes -- CE N'ETAIT PAS le probleme
# principal. Le vrai bug reproductible : delete_vm() appelait domain.undefine()
# SANS flag, qui echoue purement et simplement des qu'un ou plusieurs
# snapshots existent encore ("cannot delete inactive domain with N snapshots")
# -- corrige plus haut (VIR_DOMAIN_UNDEFINE_SNAPSHOTS_METADATA). Concretement :
# une VM sur laquelle un snapshot avait deja ete pris devenait indelebile
# depuis l'interface, ce qui explique tres probablement le ressenti "les
# snapshots ne marchent pas".
#
# Option ecartee deliberement : un snapshot "sans memoire" sur une VM ACTIVE
# est en realite un snapshot EXTERNE cote libvirt (nouveau fichier overlay,
# chaine de "backing files"), teste et confirme fonctionnel a la creation --
# mais `revertToSnapshot()` renvoie "revert to external snapshot not
# supported yet" sur ce driver QEMU/libvirt : on ne peut PAS le restaurer.
# Proposer une case "inclure la memoire" qui produirait des snapshots
# irrecuperables aurait ete un nouveau piege, pas une correction. Le choix
# memoire/pas-memoire n'est donc PAS expose : memoire incluse automatiquement
# si la VM tourne (seul mode fiable a la restauration), disque seul si elle
# est arretee (rien d'autre a capturer).
#
# Duree reelle : creer/restaurer un snapshot avec memoire peut prendre
# plusieurs secondes (le temps de serialiser toute la RAM de la VM dans le
# qcow2). Verifie sur ce host : libvirt n'expose AUCUNE statistique de
# progression exploitable pour cette operation (domain.jobStats() renvoie
# {'type': VIR_DOMAIN_JOB_NONE} du debut a la fin) -- afficher un pourcentage
# serait invente. Le create/restore tournent donc en arriere-plan (thread
# dedie + connexion libvirt separee) pendant que l'endpoint HTTP renvoie
# immediatement un task_id (voir app.core.tasks, chantier 1) : le front
# affiche une barre de progression indeterminee + le temps ecoule reel en
# suivant GET /tasks/{id}, plutot que de bloquer la requete ou d'afficher un
# faux pourcentage.

def _snapshot_summary(snap):
    xml_desc = snap.getXMLDesc()
    root = ET.fromstring(xml_desc)
    desc_elem = root.find("description")
    creation_elem = root.find("creationTime")
    state_elem = root.find("state")
    try:
        parent_nom = snap.getParent().getName()
    except libvirt.libvirtError:
        parent_nom = None
    return {
        "nom": snap.getName(),
        "description": desc_elem.text if desc_elem is not None else None,
        "date_creation": creation_elem.text if creation_elem is not None else None,
        "etat_vm": state_elem.text if state_elem is not None else None,
        "actuel": snap.isCurrent() == 1,
        "parent": parent_nom,
    }


@router.get("/{name}/snapshots")
def list_snapshots(name: str, user: dict = Depends(get_current_user)):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "list_snapshots", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")
        snaps = domain.listAllSnapshots()
        result = [_snapshot_summary(s) for s in snaps]
        log_action(user["username"], "list_snapshots", name, "succes")
        return result
    finally:
        conn.close()


class SnapshotCreate(BaseModel):
    name: str
    description: str | None = None


def _create_snapshot_job(task_id, username, vm_name, snap_name, snap_xml):
    """Tourne dans un thread separe (voir create_snapshot) avec sa PROPRE
    connexion libvirt -- ne jamais partager un objet Domain/Connect entre
    threads, les bindings Python de libvirt ne le garantissent pas. Le
    log_action definitif (succes/echec) est pose ici, a la fin reelle du
    travail -- pas au moment de la soumission synchrone, qui ne sait pas
    encore si ça va marcher."""
    conn = open_conn()
    try:
        domain = conn.lookupByName(vm_name)
        domain.snapshotCreateXML(snap_xml, 0)
        finish_task(task_id, "termine")
        log_action(username, "create_snapshot", snap_name, "succes")
    except libvirt.libvirtError as e:
        msg = describe_exception(e)
        finish_task(task_id, "echec", msg)
        log_action(username, "create_snapshot", snap_name, "echec", msg)
    finally:
        conn.close()


@router.post("/{name}/snapshots", status_code=202)
def create_snapshot(name: str, payload: SnapshotCreate, user: dict = Depends(require_vm_privilege("vm.snapshot"))):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "create_snapshot", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        name_error = validate_name(payload.name)
        if name_error:
            log_action(user["username"], "create_snapshot", payload.name, "echec", name_error)
            raise HTTPException(status_code=422, detail=name_error)

        try:
            domain.snapshotLookupByName(payload.name)
            log_action(user["username"], "create_snapshot", payload.name, "echec", "Snapshot déjà existant")
            raise HTTPException(status_code=422, detail=f"Un snapshot '{payload.name}' existe déjà pour cette VM")
        except libvirt.libvirtError:
            pass

        desc_xml = f"<description>{escape(payload.description)}</description>" if payload.description else ""
        snap_xml = f"""
        <domainsnapshot>
          <name>{escape(payload.name)}</name>
          {desc_xml}
        </domainsnapshot>
        """
        # flags=0 : interne, memoire incluse automatiquement si la VM tourne,
        # disque seul si elle est arretee -- voir la note de conception
        # au-dessus de _snapshot_summary pour pourquoi aucune autre option
        # n'est proposee.
        task_id = create_task("create_snapshot", payload.name, node=conn.getHostname(), username=user["username"])
        threading.Thread(
            target=_create_snapshot_job,
            args=(task_id, user["username"], name, payload.name, snap_xml),
            daemon=True,
        ).start()

        return {"task_id": task_id, "nom": payload.name, "statut": "en_cours"}
    finally:
        conn.close()


def _restore_snapshot_job(task_id, username, vm_name, snapshot_name):
    conn = open_conn()
    try:
        domain = conn.lookupByName(vm_name)
        snap = domain.snapshotLookupByName(snapshot_name)
        domain.revertToSnapshot(snap, 0)
        finish_task(task_id, "termine")
        log_action(username, "restore_snapshot", snapshot_name, "succes")
    except libvirt.libvirtError as e:
        msg = describe_exception(e)
        finish_task(task_id, "echec", msg)
        log_action(username, "restore_snapshot", snapshot_name, "echec", msg)
    finally:
        conn.close()


@router.post("/{name}/snapshots/{snapshot_name}/restore", status_code=202)
def restore_snapshot(name: str, snapshot_name: str, confirm: bool = False, user: dict = Depends(require_vm_privilege("vm.snapshot"))):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "restore_snapshot", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        try:
            domain.snapshotLookupByName(snapshot_name)
        except libvirt.libvirtError:
            log_action(user["username"], "restore_snapshot", snapshot_name, "echec", "Snapshot introuvable")
            raise HTTPException(status_code=404, detail=f"Snapshot '{snapshot_name}' introuvable")

        if not confirm:
            log_action(user["username"], "restore_snapshot", snapshot_name, "echec", "Confirmation manquante")
            raise HTTPException(status_code=400, detail="Action irréversible : ajoutez ?confirm=true pour confirmer la restauration")

        task_id = create_task("restore_snapshot", snapshot_name, node=conn.getHostname(), username=user["username"])
        threading.Thread(
            target=_restore_snapshot_job,
            args=(task_id, user["username"], name, snapshot_name),
            daemon=True,
        ).start()

        return {"task_id": task_id, "statut": "en_cours", "message": f"Restauration de '{name}' vers '{snapshot_name}' en cours"}
    finally:
        conn.close()


@router.delete("/{name}/snapshots/{snapshot_name}")
def delete_snapshot(name: str, snapshot_name: str, user: dict = Depends(require_vm_privilege("vm.snapshot"))):
    # Reste synchrone (pas de thread/tache en arriere-plan) : contrairement a
    # create/restore, supprimer un snapshot interne est quasi-instantane meme
    # avec un enfant (libvirt reparente l'enfant automatiquement), teste et
    # confirme sur ce host le 2026-09-13.
    conn = open_conn()
    task_id = create_task("delete_snapshot", snapshot_name, node=conn.getHostname(), username=user["username"])
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "delete_snapshot", name, "echec", "VM introuvable", task_id=task_id)
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        try:
            snap = domain.snapshotLookupByName(snapshot_name)
        except libvirt.libvirtError:
            log_action(user["username"], "delete_snapshot", snapshot_name, "echec", "Snapshot introuvable", task_id=task_id)
            raise HTTPException(status_code=404, detail=f"Snapshot '{snapshot_name}' introuvable")

        try:
            snap.delete(0)
        except libvirt.libvirtError as e:
            msg = describe_exception(e)
            log_action(user["username"], "delete_snapshot", snapshot_name, "echec", msg, task_id=task_id)
            raise HTTPException(status_code=500, detail=f"Erreur de suppression : {msg}")

        log_action(user["username"], "delete_snapshot", snapshot_name, "succes", task_id=task_id)
        return {"message": f"Snapshot '{snapshot_name}' supprimé"}
    finally:
        conn.close()


class CloneRequest(BaseModel):
    new_name: str


@router.post("/{name}/clone", status_code=201)
def clone_vm(name: str, payload: CloneRequest, user: dict = Depends(require_vm_privilege("vm.clone"))):
    # Reecrit le 2026-09-13 (chantier 5 de la roadmap vSphere/vCenter) apres
    # audit du code precedent. Bugs reels trouves et corriges ici :
    # 1. SECURITE : aucune verification de droit avant (juste get_current_user,
    #    donc n'importe quel compte -- meme "observateur", lecture seule
    #    partout ailleurs -- pouvait cloner et creer une nouvelle VM). Gate
    #    maintenant par un privilege ACL dedie ("vm.clone", voir permissions.py),
    #    pas accorde par defaut a aucun role predefini : un admin doit l'ajouter
    #    explicitement a un role personnalise s'il veut deleguer le clonage.
    # 2. CORRUPTION DE DONNEES : seul le PREMIER disque (device='disk') etait
    #    copie -- une VM multi-disques se retrouvait avec le clone et
    #    l'original pointant sur le MEME fichier qcow2 pour les disques
    #    suivants (deux VM ecrivant sur le meme fichier des que les deux
    #    tournent). Tous les disques sont maintenant clones individuellement.
    # 3. FUITE ENTRE ORIGINAL ET CLONE : le disque clone est une copie bit a
    #    bit du disque source -- meme hostname, meme machine-id, memes CLES
    #    HOTE SSH que l'original tant que rien ne force une reconfiguration.
    #    Pour les VM crees via le chemin cloud-init par defaut (verifiable :
    #    un fichier <nom>-cloudinit.iso existe), un nouvel ISO cloud-init
    #    minimal (nouveau hostname + nouvel instance-id, PAS le mot de passe
    #    -- jamais conserve nulle part par Hyperlite, meme pas possible de le
    #    reinjecter) est fourni au clone : cloud-init detecte une "nouvelle
    #    instance" au premier boot et regenere de lui-meme hostname + cles
    #    hote SSH. Pour les VM installees depuis un ISO (kickstart/autoinstall
    #    ou manuel), aucune personnalisation invite n'est possible -- meme
    #    limite qu'un hyperviseur sans agent invite, documentee dans la reponse
    #    plutot que silencieusement ignoree.
    conn = open_conn()
    task_id = create_task("clone_vm", name, node=conn.getHostname(), username=user["username"])
    new_disk_paths = []
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "clone_vm", name, "echec", "VM source introuvable", task_id=task_id)
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        try:
            validate_name(payload.new_name)
        except ValueError as exc:
            log_action(user["username"], "clone_vm", name, "echec", f"nom invalide : {payload.new_name}", task_id=task_id)
            raise HTTPException(status_code=422, detail=str(exc))

        try:
            conn.lookupByName(payload.new_name)
            log_action(user["username"], "clone_vm", name, "echec", f"'{payload.new_name}' existe déjà", task_id=task_id)
            raise HTTPException(status_code=409, detail=f"Une VM '{payload.new_name}' existe déjà")
        except libvirt.libvirtError:
            pass

        if domain.isActive():
            log_action(user["username"], "clone_vm", name, "echec", "VM active", task_id=task_id)
            raise HTTPException(status_code=409, detail="Arrêtez la VM avant de la cloner")

        root = ET.fromstring(domain.XMLDesc(0))

        disk_els = [d for d in root.findall(".//devices/disk") if d.get("device") == "disk"]
        if not disk_els:
            log_action(user["username"], "clone_vm", name, "echec", "disque source introuvable", task_id=task_id)
            raise HTTPException(status_code=500, detail="Disque source introuvable")

        # Clone TOUS les disques (pas seulement le premier -- voir note ci-dessus).
        for i, disk_el in enumerate(disk_els):
            source_el = disk_el.find("source")
            source_path = source_el.get("file") if source_el is not None else None
            if not source_path:
                for p in new_disk_paths:
                    Path(p).unlink(missing_ok=True)
                log_action(user["username"], "clone_vm", name, "echec", "chemin du disque source introuvable", task_id=task_id)
                raise HTTPException(status_code=500, detail="Chemin du disque source introuvable")

            suffix = "" if i == 0 else f"-{i + 1}"
            new_disk_path = IMAGES_DIR / f"{payload.new_name}{suffix}.qcow2"
            if new_disk_path.exists():
                for p in new_disk_paths:
                    Path(p).unlink(missing_ok=True)
                log_action(user["username"], "clone_vm", name, "echec", f"'{new_disk_path.name}' existe déjà", task_id=task_id)
                raise HTTPException(status_code=409, detail=f"Un fichier disque '{new_disk_path.name}' existe déjà")

            try:
                subprocess.run(
                    ["qemu-img", "convert", "-O", "qcow2", source_path, str(new_disk_path)],
                    check=True, capture_output=True, text=True,
                )
            except subprocess.CalledProcessError as exc:
                for p in new_disk_paths:
                    Path(p).unlink(missing_ok=True)
                msg = f"copie disque : {exc.stderr or exc}"
                log_action(user["username"], "clone_vm", name, "echec", msg, task_id=task_id)
                raise HTTPException(status_code=500, detail="Échec de la copie du disque")

            new_disk_paths.append(str(new_disk_path))
            source_el.set("file", str(new_disk_path))

        name_el = root.find("name")
        if name_el is not None:
            name_el.text = payload.new_name

        uuid_el = root.find("uuid")
        if uuid_el is not None:
            root.remove(uuid_el)  # libvirt en genere un nouveau, distinct, a defineXML

        devices_el = root.find(".//devices")
        if devices_el is not None:
            for disk in list(devices_el.findall("disk")):
                if disk.get("device") == "cdrom":
                    devices_el.remove(disk)

        # MAC explicite (plutot que laisser libvirt en tirer un au hasard) :
        # permet de reserver tout de suite une IP fixe pour le clone, comme a
        # la creation d'une VM (voir create_vm / network_alloc.py). Best-effort :
        # un echec de reservation ne bloque pas le clonage, juste l'IP fixe.
        new_ip_reservations = []
        for iface in root.findall(".//devices/interface"):
            old_mac = iface.find("mac")
            if old_mac is not None:
                iface.remove(old_mac)
            new_mac = generate_mac(conn)
            ET.SubElement(iface, "mac", {"address": new_mac})
            source_el = iface.find("source")
            iface_network = source_el.get("network") if source_el is not None else None
            if iface_network:
                try:
                    allocate_static_ip(conn, iface_network, new_mac)
                    new_ip_reservations.append((iface_network, new_mac))
                except libvirt.libvirtError:
                    pass

        # Personnalisation invite (hostname + cles hote SSH) : seulement pour
        # le chemin cloud-init par defaut, detectable par la presence de son
        # ISO -- voir note de conception au-dessus de la fonction.
        reseed_iso = None
        if (IMAGES_DIR / f"{name}-cloudinit.iso").exists():
            try:
                reseed_iso = create_cloudinit_reseed_iso(payload.new_name)
                ET.SubElement(devices_el, "disk", {"type": "file", "device": "cdrom"}).extend([
                    ET.fromstring(f"<driver name='qemu' type='raw'/>"),
                    ET.fromstring(f"<source file='{reseed_iso}'/>"),
                    ET.fromstring("<target dev='hdc' bus='ide'/>"),
                    ET.fromstring("<readonly/>"),
                ])
            except subprocess.CalledProcessError:
                reseed_iso = None  # tant pis pour la personnalisation, le clone reste fonctionnel

        new_xml = ET.tostring(root, encoding="unicode")

        try:
            new_domain = conn.defineXML(new_xml)
        except libvirt.libvirtError as exc:
            for p in new_disk_paths:
                Path(p).unlink(missing_ok=True)
            if reseed_iso:
                Path(reseed_iso).unlink(missing_ok=True)
            for iface_network, mac in new_ip_reservations:
                try:
                    release_static_ip(conn, iface_network, mac)
                except libvirt.libvirtError:
                    pass
            msg = describe_exception(exc)
            log_action(user["username"], "clone_vm", name, "echec", msg, task_id=task_id)
            raise HTTPException(status_code=500, detail=f"Échec de la définition du clone : {msg}")

        rename_vm_ssh_user(name, payload.new_name)
        rename_vm_os_label(name, payload.new_name)
        log_action(user["username"], "clone_vm", name, "succes", f"clone -> {payload.new_name}", task_id=task_id)
        return {
            "source": name, "clone": new_domain.name(), "etat": "arretee",
            "personnalisation_invite": reseed_iso is not None,
        }
    finally:
        conn.close()


class CdromRequest(BaseModel):
    iso: str


@router.put("/{name}/cdrom")
def set_vm_cdrom(name: str, payload: CdromRequest, user: dict = Depends(require_vm_privilege("vm.hardware"))):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "set_vm_cdrom", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        iso_filename = Path(payload.iso).name
        if not iso_filename.lower().endswith(".iso"):
            raise HTTPException(status_code=422, detail="Nom d'ISO invalide")
        iso_path = ISOS_DIR / iso_filename
        if not iso_path.exists():
            raise HTTPException(status_code=404, detail=f"ISO '{iso_filename}' introuvable")

        root = ET.fromstring(domain.XMLDesc(0))
        devices_el = root.find(".//devices")
        cdrom = None
        if devices_el is not None:
            for disk in devices_el.findall("disk"):
                if disk.get("device") == "cdrom":
                    cdrom = disk
                    break

        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if domain.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE

        try:
            if cdrom is not None:
                source = cdrom.find("source")
                if source is None:
                    source = ET.SubElement(cdrom, "source")
                source.set("file", str(iso_path))
                new_xml = ET.tostring(cdrom, encoding="unicode")
                domain.updateDeviceFlags(new_xml, flags)
            else:
                new_cdrom_xml = (
                    '<disk type="file" device="cdrom">'
                    '<driver name="qemu" type="raw"/>'
                    f'<source file="{escape(str(iso_path))}"/>'
                    '<target dev="hdc" bus="ide"/>'
                    '<readonly/>'
                    '</disk>'
                )
                domain.attachDeviceFlags(new_cdrom_xml, flags)
        except libvirt.libvirtError as exc:
            log_action(user["username"], "set_vm_cdrom", name, "echec", str(exc))
            raise HTTPException(status_code=500, detail=f"Échec du montage : {exc}")

        log_action(user["username"], "set_vm_cdrom", name, "succes", iso_filename)
        return {"vm": name, "iso": iso_filename}
    finally:
        conn.close()


@router.delete("/{name}/cdrom")
def eject_vm_cdrom(name: str, user: dict = Depends(require_vm_privilege("vm.hardware"))):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "eject_vm_cdrom", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        root = ET.fromstring(domain.XMLDesc(0))
        devices_el = root.find(".//devices")
        cdrom = None
        if devices_el is not None:
            for disk in devices_el.findall("disk"):
                if disk.get("device") == "cdrom":
                    cdrom = disk
                    break
        if cdrom is None:
            raise HTTPException(status_code=404, detail="Aucun lecteur CD sur cette VM")

        source = cdrom.find("source")
        if source is not None:
            cdrom.remove(source)

        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if domain.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE

        try:
            new_xml = ET.tostring(cdrom, encoding="unicode")
            domain.updateDeviceFlags(new_xml, flags)
        except libvirt.libvirtError as exc:
            log_action(user["username"], "eject_vm_cdrom", name, "echec", str(exc))
            raise HTTPException(status_code=500, detail=f"Échec de l'éjection : {exc}")

        log_action(user["username"], "eject_vm_cdrom", name, "succes")
        return {"vm": name, "ejecte": True}
    finally:
        conn.close()


@router.get("/{name}/metrics")
def get_vm_metrics(name: str, user: dict = Depends(get_current_user)):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "get_vm_metrics", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        if not domain.isActive():
            return {
                "etat": "arrete",
                "cpu_pourcent": None,
                "memoire_allouee_mo": None,
                "memoire_utilisee_mo": None,
                "disques": [],
                "reseaux": [],
            }

        root = ET.fromstring(domain.XMLDesc(0))
        disk_devs = []
        for disk in root.findall(".//devices/disk"):
            if disk.get("device") != "disk":
                continue
            target = disk.find("target")
            if target is not None and target.get("dev"):
                disk_devs.append(target.get("dev"))
        iface_devs = []
        for iface in root.findall(".//devices/interface"):
            target = iface.find("target")
            if target is not None and target.get("dev"):
                iface_devs.append(target.get("dev"))

        def sample():
            cpu_time = domain.getCPUStats(True)[0]["cpu_time"]
            disk_samples = {}
            for dev in disk_devs:
                try:
                    disk_samples[dev] = domain.blockStats(dev)
                except libvirt.libvirtError:
                    pass
            net_samples = {}
            for dev in iface_devs:
                try:
                    net_samples[dev] = domain.interfaceStats(dev)
                except libvirt.libvirtError:
                    pass
            return cpu_time, disk_samples, net_samples

        cpu1, disk1, net1 = sample()
        t1 = time.time()
        time.sleep(0.4)
        cpu2, disk2, net2 = sample()
        t2 = time.time()
        elapsed = max(t2 - t1, 0.001)

        info = domain.info()
        nvcpu = info[3] or 1
        cpu_pourcent = round(max(0.0, min(100.0, ((cpu2 - cpu1) / (elapsed * 1e9)) * 100 / nvcpu)), 1)
        memoire_allouee_mo = round(info[2] / 1024, 1)

        memoire_utilisee_mo = None
        try:
            mem_stats = domain.memoryStats()
            if "available" in mem_stats and "unused" in mem_stats:
                memoire_utilisee_mo = round((mem_stats["available"] - mem_stats["unused"]) / 1024, 1)
            elif "rss" in mem_stats:
                memoire_utilisee_mo = round(mem_stats["rss"] / 1024, 1)
        except libvirt.libvirtError:
            pass

        disques = []
        for dev in disk_devs:
            if dev in disk1 and dev in disk2:
                rd_rate = max(0, (disk2[dev][1] - disk1[dev][1]) / elapsed)
                wr_rate = max(0, (disk2[dev][3] - disk1[dev][3]) / elapsed)
                disques.append({
                    "cible": dev,
                    "lecture_ko_s": round(rd_rate / 1024, 1),
                    "ecriture_ko_s": round(wr_rate / 1024, 1),
                })

        reseaux = []
        for dev in iface_devs:
            if dev in net1 and dev in net2:
                rx_rate = max(0, (net2[dev][0] - net1[dev][0]) / elapsed)
                tx_rate = max(0, (net2[dev][4] - net1[dev][4]) / elapsed)
                reseaux.append({
                    "interface": dev,
                    "reception_ko_s": round(rx_rate / 1024, 1),
                    "emission_ko_s": round(tx_rate / 1024, 1),
                })

        log_action(user["username"], "get_vm_metrics", name, "succes")
        return {
            "etat": "actif",
            "cpu_pourcent": cpu_pourcent,
            "memoire_allouee_mo": memoire_allouee_mo,
            "memoire_utilisee_mo": memoire_utilisee_mo,
            "disques": disques,
            "reseaux": reseaux,
        }
    finally:
        conn.close()


# Chantier 12 : au-dela de ce delai sans SSH fonctionnel, on arrete de
# poller passivement pour toujours et on declare l'installation en echec --
# avant ce correctif, un install cassee (ISO incompatible, erreur de
# partitionnement, panne reseau pendant l'installation...) restait "en
# cours" indefiniment, sans jamais remonter d'erreur exploitable (constate
# en pratique : plusieurs tentatives "ubuntu-autoinstall-fix" dans le
# journal d'audit, jamais nettoyees). 30 minutes est large pour les familles
# gerees (kickstart/autoinstall), meme sur un disque lent.
PROVISIONING_TIMEOUT_S = 1800


@router.get("/{name}/provisioning")
def get_vm_provisioning(name: str, user: dict = Depends(get_current_user)):
    """Etat d'une installation automatisee (Kickstart/autoinstall) en cours,
    pour la barre de progression du dashboard. Signal utilise : une vraie
    authentification SSH avec la cle d'automatisation Hyperlite reussit-elle
    -- PAS juste "le port 22 repond" (constate en test sur Ubuntu : l'ISO
    live-server fait tourner son propre sshd des le tout debut de
    l'installation, bien avant que le systeme final n'existe, donc le port
    est joignable tres tot sans que notre cle y soit pour autant autorisee
    -- ca donnait un faux "termine" premature)."""
    prov = get_provisioning(name)
    if not prov:
        return {"provisioning": False}

    task_id = prov.get("task_id")

    def _fail(reason):
        clear_provisioning(name)
        if task_id:
            finish_task(task_id, "echec", reason)
        log_action(user["username"], "auto_install", name, "echec", reason)
        return {"provisioning": False, "failed": True, "erreur": reason}

    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            return _fail("La VM a disparu pendant l'installation automatisée (supprimée ?)")

        started = datetime.fromisoformat(prov["started_at"])
        elapsed_s = int((datetime.now(timezone.utc) - started).total_seconds())

        if elapsed_s > PROVISIONING_TIMEOUT_S:
            return _fail(f"Timeout : SSH toujours inaccessible après {elapsed_s // 60} minutes")

        if not domain.isActive():
            if prov["os_family"] == "preseed":
                # Contrairement a kickstart/autoinstall, l'installeur Debian
                # (Kali) est configure pour ETEINDRE la VM en fin
                # d'installation plutot que la redemarrer (voir
                # unattended_install.py, d-i debian-installer/exit/
                # poweroff) : un vrai redemarrage materiel rebondirait sur
                # le MEME noyau/initrd d'installeur (l'override <kernel>/
                # <initrd>, voir build_preseed_initrd) au lieu du systeme
                # installe sur le disque, et reinstallerait en boucle depuis
                # le tout debut -- constate en test reel (deuxieme ecran
                # "Configuring the network with DHCP" apres un premier
                # passage jusqu'a l'installation de GRUB). On retire donc
                # l'override ICI, avant de redemarrer nous-memes le domaine
                # -- cette fois via le <boot order> normal, sur le disque.
                # Idempotent : si l'override est deja retire et/ou le
                # domaine deja reparti (course avec un autre appel de ce
                # meme endpoint), domain.create() echoue silencieusement
                # sans consequence.
                try:
                    current_xml = domain.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE)
                    new_xml = strip_install_boot_override(current_xml)
                    if new_xml != current_xml:
                        conn.defineXML(new_xml)
                except (libvirt.libvirtError, ET.ParseError):
                    pass
                try:
                    domain.create()
                except libvirt.libvirtError:
                    pass
                return {"provisioning": True, "phase": "demarrage", "os_family": prov["os_family"], "elapsed_s": elapsed_s}
            return {"provisioning": True, "phase": "arretee", "os_family": prov["os_family"], "elapsed_s": elapsed_s}

        ip = _get_ip(domain)
        if not ip:
            return {"provisioning": True, "phase": "demarrage", "os_family": prov["os_family"], "elapsed_s": elapsed_s}

        username = get_vm_ssh_user(name)
        key_path = get_automation_private_key_path()
        try:
            result = subprocess.run(
                [
                    "ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
                    "-o", "BatchMode=yes", "-o", "ConnectTimeout=3",
                    "-i", str(key_path), f"{username}@{ip}", "true",
                ],
                capture_output=True, timeout=6,
            )
        except subprocess.TimeoutExpired:
            return {"provisioning": True, "phase": "installation", "os_family": prov["os_family"], "elapsed_s": elapsed_s, "ip": ip}

        if result.returncode == 0:
            clear_provisioning(name)
            # Ubuntu/autoinstall a demarre sur un noyau/initrd extrait de
            # l'ISO (voir create_vm, extract_casper_kernel) pour ajouter
            # "autoinstall" a la ligne de commande -- ce n'est plus
            # necessaire une fois l'OS installe sur le disque, et le laisser
            # ferait rebooter la VM indefiniment sur l'installeur live au
            # lieu du systeme installe (le <boot order> normal, sur le
            # disque, n'est jamais consulte tant que <kernel>/<initrd> sont
            # presents). On retire l'override du XML PERSISTANT uniquement :
            # la VM continue de tourner sans interruption avec sa
            # configuration live actuelle jusqu'au prochain redemarrage.
            if prov["os_family"] in ("autoinstall", "preseed"):
                try:
                    current_xml = domain.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE)
                    new_xml = strip_install_boot_override(current_xml)
                    if new_xml != current_xml:
                        conn.defineXML(new_xml)
                except (libvirt.libvirtError, ET.ParseError):
                    pass
            if task_id:
                finish_task(task_id, "termine")
            log_action(user["username"], "provisioning_complete", name, "succes")
            return {"provisioning": False, "just_finished": True}
        return {"provisioning": True, "phase": "installation", "os_family": prov["os_family"], "elapsed_s": elapsed_s, "ip": ip}
    finally:
        conn.close()


CONSOLE_TICKETS = {}
CONSOLE_TICKET_TTL = 30


@router.post("/{name}/console-ticket")
def create_console_ticket(name: str, user: dict = Depends(require_vm_privilege("vm.console"))):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "create_console_ticket", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        root = ET.fromstring(domain.XMLDesc(0))
        devices_el = root.find(".//devices")
        graphics = devices_el.find("graphics[@type='vnc']") if devices_el is not None else None

        if graphics is None:
            if domain.isActive():
                log_action(user["username"], "create_console_ticket", name, "echec", "pas de VNC (VM active)")
                raise HTTPException(
                    status_code=409,
                    detail="Cette VM a été créée avant l'ajout de la console. Arrêtez-la puis redémarrez-la une fois pour activer la console.",
                )
            ensure_vnc_graphics(conn, domain)
            log_action(user["username"], "create_console_ticket", name, "echec", "VNC ajouté, VM arrêtée")
            raise HTTPException(status_code=409, detail="Console activée sur cette VM : démarrez-la puis réessayez.")

        if not domain.isActive():
            log_action(user["username"], "create_console_ticket", name, "echec", "VM arrêtée")
            raise HTTPException(status_code=409, detail="La VM doit être démarrée pour ouvrir une console")

        port = graphics.get("port")
        if not port or port == "-1":
            log_action(user["username"], "create_console_ticket", name, "echec", "port VNC indisponible")
            raise HTTPException(status_code=500, detail="Port VNC indisponible pour le moment")

        now = time.time()
        for old_ticket, (old_vm, old_port, old_expiry) in list(CONSOLE_TICKETS.items()):
            if old_expiry < now:
                CONSOLE_TICKETS.pop(old_ticket, None)

        ticket = secrets.token_urlsafe(24)
        CONSOLE_TICKETS[ticket] = (name, int(port), now + CONSOLE_TICKET_TTL)
        log_action(user["username"], "create_console_ticket", name, "succes")
        return {"ticket": ticket, "expire_dans_s": CONSOLE_TICKET_TTL}
    finally:
        conn.close()


@router.websocket("/{name}/console")
async def vm_console(websocket: WebSocket, name: str):
    ticket = websocket.query_params.get("ticket")
    entry = CONSOLE_TICKETS.pop(ticket, None) if ticket else None
    if entry is None:
        await websocket.close(code=4401)
        return

    vm_name, port, expiry = entry
    if vm_name != name or time.time() > expiry:
        await websocket.close(code=4401)
        return

    await websocket.accept()

    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
    except OSError:
        await websocket.close(code=1011)
        return

    async def ws_to_tcp():
        try:
            while True:
                data = await websocket.receive_bytes()
                writer.write(data)
                await writer.drain()
        except (WebSocketDisconnect, RuntimeError):
            pass
        except Exception:
            pass
        finally:
            writer.close()

    async def tcp_to_ws():
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                await websocket.send_bytes(data)
        except Exception:
            pass

    task1 = asyncio.ensure_future(ws_to_tcp())
    task2 = asyncio.ensure_future(tcp_to_ws())
    done, pending = await asyncio.wait({task1, task2}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    try:
        await websocket.close()
    except RuntimeError:
        pass


# --- Terminal SSH web (xterm.js + shell distant via la cle d'automatisation) ---
# Reserve au role admin : la cle d'automatisation se connecte a l'utilisateur cloud-init
# de la VM, qui a un sudo NOPASSWD complet - ouvrir ce terminal equivaut a un acces root.

TERMINAL_TICKETS = {}
TERMINAL_TICKET_TTL = 30


@router.post("/{name}/terminal-ticket")
def create_terminal_ticket(name: str, user: dict = Depends(require_vm_privilege("vm.console"))):
    conn = open_conn()
    try:
        try:
            domain = conn.lookupByName(name)
        except libvirt.libvirtError:
            log_action(user["username"], "create_terminal_ticket", name, "echec", "VM introuvable")
            raise HTTPException(status_code=404, detail=f"VM '{name}' introuvable")

        if not domain.isActive():
            log_action(user["username"], "create_terminal_ticket", name, "echec", "VM arrêtée")
            raise HTTPException(status_code=409, detail="La VM doit être démarrée pour ouvrir un terminal")

        ip = _get_ip(domain)
        if not ip:
            log_action(user["username"], "create_terminal_ticket", name, "echec", "IP inconnue")
            raise HTTPException(status_code=409, detail="Adresse IP de la VM inconnue pour le moment (pas encore de bail DHCP ?)")

        ssh_user = get_vm_ssh_user(name)
        if not ssh_user:
            log_action(user["username"], "create_terminal_ticket", name, "echec", "utilisateur SSH inconnu")
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Aucun utilisateur SSH connu pour '{name}' (VM créée avant cette fonctionnalité). "
                    "Déployez la clé d'automatisation avec un ssh-copy-id manuel puis réessayez."
                ),
            )

        now = time.time()
        for old_ticket, (old_vm, old_ip, old_user, old_expiry) in list(TERMINAL_TICKETS.items()):
            if old_expiry < now:
                TERMINAL_TICKETS.pop(old_ticket, None)

        ticket = secrets.token_urlsafe(24)
        TERMINAL_TICKETS[ticket] = (name, ip, ssh_user, now + TERMINAL_TICKET_TTL)
        log_action(user["username"], "create_terminal_ticket", name, "succes")
        return {"ticket": ticket, "utilisateur": ssh_user, "expire_dans_s": TERMINAL_TICKET_TTL}
    finally:
        conn.close()


@router.websocket("/{name}/terminal")
async def vm_terminal(websocket: WebSocket, name: str):
    ticket = websocket.query_params.get("ticket")
    entry = TERMINAL_TICKETS.pop(ticket, None) if ticket else None
    if entry is None:
        await websocket.close(code=4401)
        return

    vm_name, ip, ssh_user, expiry = entry
    if vm_name != name or time.time() > expiry:
        await websocket.close(code=4401)
        return

    await websocket.accept()

    private_key = get_automation_private_key_path()
    try:
        ssh_conn = await asyncssh.connect(
            ip, username=ssh_user, client_keys=[str(private_key)],
            known_hosts=None, connect_timeout=10,
        )
    except (asyncssh.Error, OSError) as e:
        await websocket.send_text(f"\r\n\x1b[31m[hyperlite] Échec de connexion SSH à {ip} : {e}\x1b[0m\r\n")
        await websocket.close(code=1011)
        return

    try:
        process = await ssh_conn.create_process(term_type="xterm-256color", term_size=(80, 24))
    except asyncssh.Error as e:
        await websocket.send_text(f"\r\n\x1b[31m[hyperlite] Échec d'ouverture du shell : {e}\x1b[0m\r\n")
        ssh_conn.close()
        await websocket.close(code=1011)
        return

    async def ws_to_ssh():
        try:
            while True:
                msg = await websocket.receive_text()
                if msg.startswith("\x00"):
                    try:
                        dims = json.loads(msg[1:])
                        process.change_terminal_size(int(dims["cols"]), int(dims["rows"]))
                    except (ValueError, KeyError, TypeError):
                        pass
                else:
                    process.stdin.write(msg)
        except (WebSocketDisconnect, RuntimeError):
            pass
        except Exception:
            pass
        finally:
            try:
                process.stdin.write_eof()
            except Exception:
                pass

    async def ssh_to_ws():
        try:
            while True:
                data = await process.stdout.read(65536)
                if not data:
                    break
                await websocket.send_text(data)
        except Exception:
            pass

    task1 = asyncio.ensure_future(ws_to_ssh())
    task2 = asyncio.ensure_future(ssh_to_ws())
    done, pending = await asyncio.wait({task1, task2}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    try:
        process.close()
    except Exception:
        pass
    ssh_conn.close()
    try:
        await websocket.close()
    except (RuntimeError, WebSocketDisconnect):
        pass
