import libvirt
from fastapi import APIRouter, Depends

from app.core.libvirt_utils import ensure_default_pool, open_conn
from app.core.metrics import get_node_live
from app.core.security import get_current_user

router = APIRouter(tags=["dashboard"])


def _get_free_memory_kb():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return None


def _get_host_uptime_s():
    # /proc/uptime: "<seconds since boot> <cumulative idle seconds>"; the first
    # number is the one we want.
    try:
        with open("/proc/uptime") as f:
            return int(float(f.read().split()[0]))
    except (OSError, ValueError, IndexError):
        return None


@router.get("/dashboard")
def dashboard(user: dict = Depends(get_current_user)):
    conn = open_conn()
    try:
        hostname = conn.getHostname()
        hv_type = conn.getType()
        connected = conn.isAlive() == 1

        domains = conn.listAllDomains()
        total = len(domains)
        active = sum(1 for d in domains if d.isActive())
        inactive = total - active

        mem_available_kb = _get_free_memory_kb()

        try:
            pool = ensure_default_pool(conn)
            pool.refresh(0)
            _, capacity, _allocation, available = pool.info()
        except libvirt.libvirtError:
            capacity = available = None

        return {
            "hyperviseur": {
                "nom": hostname,
                "type": hv_type,
                "connecte": connected,
                "uptime_s": _get_host_uptime_s(),
            },
            "vms": {
                "total": total,
                "actives": active,
                "arretees": inactive,
            },
            "memoire_disponible_mo": round(mem_available_kb / 1024, 1) if mem_available_kb else None,
            "stockage": {
                "capacite_go": round(capacity / (1024**3), 2) if capacity else None,
                "disponible_go": round(available / (1024**3), 2) if available else None,
            },
            "etat_infrastructure": "ok" if connected else "degrade",
            # Latest load and identity of this host (CPU %, memory, cores, model, kernel,
            # OS, address, versions), recorded by the metrics collector.
            "live": get_node_live("local"),
        }
    finally:
        conn.close()
