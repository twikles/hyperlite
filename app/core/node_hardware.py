"""Hardware inventory of a node: network interfaces, physical disks and CPU topology.

Read on demand (the node's System, Network and Storage pages), with the same
single shell probe for the local host and for a remote node over the cluster
SSH trust (see app/core/host_stats.py). Every tool is optional: `smartctl`
missing only leaves the disk health empty.
"""

import json
import logging

logger = logging.getLogger(__name__)

PROBE_SCRIPT = r"""
echo '@@links'
for i in /sys/class/net/*; do
  n=$(basename "$i"); [ "$n" = lo ] && continue
  kind=virtuel
  [ -e "$i/device" ] && kind=physique
  [ -d "$i/bridge" ] && kind=pont
  [ -d "$i/wireless" ] && kind=wifi
  [ -e "/proc/net/vlan/$n" ] && kind=vlan
  echo "$n|$(cat "$i/operstate" 2>/dev/null)|$(cat "$i/address" 2>/dev/null)|$(cat "$i/mtu" 2>/dev/null)|$(cat "$i/speed" 2>/dev/null)|$kind"
done
echo '@@addr'; ip -j addr 2>/dev/null
echo '@@lsblk'; lsblk -J -b -o NAME,MODEL,SIZE,ROTA,TRAN,TYPE,MOUNTPOINT 2>/dev/null
echo '@@smart'
if command -v smartctl >/dev/null 2>&1; then
  for d in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print $1}'); do
    echo "$d|$(smartctl -H "/dev/$d" 2>/dev/null | grep -Ei 'overall-health|SMART Health Status' | head -1 | cut -d: -f2- | xargs)"
  done
fi
echo '@@lscpu'; lscpu -J 2>/dev/null
echo '@@end'
"""


def _sections(text):
    out, cur = {}, None
    for line in text.splitlines():
        if line.startswith("@@"):
            cur = line[2:].strip()
            out[cur] = []
        elif cur is not None:
            out[cur].append(line)
    return {k: "\n".join(v) for k, v in out.items()}


def _json(text):
    try:
        return json.loads(text) if text.strip() else None
    except ValueError:
        return None


def _mounts(dev):
    found = [dev["mountpoint"]] if dev.get("mountpoint") else []
    for child in dev.get("children") or []:
        found += _mounts(child)
    return found


def parse(text):
    s = _sections(text)

    addresses = {}
    for entry in _json(s.get("addr", "")) or []:
        addresses[entry.get("ifname")] = [
            f"{a.get('local')}/{a.get('prefixlen')}" for a in entry.get("addr_info", []) if a.get("local")
        ]
    interfaces = []
    for line in s.get("links", "").splitlines():
        parts = line.split("|")
        if len(parts) != 6:
            continue
        name, state, mac, mtu, speed, kind = parts
        interfaces.append(
            {
                "nom": name,
                "etat": state or "inconnu",
                "type": kind,
                "mac": mac or None,
                "mtu": int(mtu) if mtu.isdigit() else None,
                # The kernel reports -1 (or nothing) when the link is down or the driver does not know.
                "debit_mbps": int(speed) if speed.isdigit() and int(speed) > 0 else None,
                "adresses": addresses.get(name, []),
            }
        )

    health = {}
    for line in s.get("smart", "").splitlines():
        name, _, verdict = line.partition("|")
        v = verdict.strip().upper()
        health[name] = "ok" if v in ("PASSED", "OK") else ("echec" if v else None)
    disks = []
    for dev in (_json(s.get("lsblk", "")) or {}).get("blockdevices", []):
        if dev.get("type") != "disk":
            continue
        tran = (dev.get("tran") or "").lower()
        kind = "NVMe" if tran == "nvme" else ("HDD" if dev.get("rota") in (True, 1, "1") else "SSD")
        size = dev.get("size")
        disks.append(
            {
                "nom": dev.get("name"),
                "modele": (dev.get("model") or "").strip() or None,
                "type": kind,
                "taille_go": round(int(size) / 1024**3, 1) if size is not None and str(size).isdigit() else None,
                "sante": health.get(dev.get("name")),
                "points_montage": sorted(set(_mounts(dev))),
            }
        )

    cpu = {}
    fields = {f.get("field", "").rstrip(":"): f.get("data") for f in (_json(s.get("lscpu", "")) or {}).get("lscpu", [])}
    if fields:

        def _int(key):
            v = fields.get(key)
            return int(v) if v and str(v).isdigit() else None

        cpu = {
            "modele": fields.get("Model name"),
            "sockets": _int("Socket(s)"),
            "coeurs_par_socket": _int("Core(s) per socket"),
            "threads_par_coeur": _int("Thread(s) per core"),
            "threads": _int("CPU(s)"),
            "virtualisation": fields.get("Virtualization"),
        }
    return {"interfaces": interfaces, "disques": disks, "cpu": cpu}


def get_hardware(node=None):
    """Inventory of the local host (node None) or of a registered remote node (its
    database row). Raises RuntimeError when the node cannot be reached."""
    from app.core.host_stats import run_probe_script

    out = run_probe_script(PROBE_SCRIPT, node)
    if out is None:
        raise RuntimeError("the node did not answer the hardware probe")
    return parse(out)
