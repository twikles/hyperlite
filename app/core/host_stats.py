"""Live load and identity of a node (the local host or a registered remote node).

libvirt exposes the CPU and memory of a node but neither its disk and network
throughput nor its kernel or OS name, so one small shell probe reads the same
kernel files for every node: run locally for this host, over the cluster SSH
trust for a remote node (one round trip per node and per sample). Parsing is
shared, so a remote node reports exactly what the local host reports.

Rates (CPU %, bytes/s) come from the difference between two readings of
cumulative counters: the first reading of a node returns None for them.
"""

import logging
import subprocess
import time

logger = logging.getLogger(__name__)

PROBE_TIMEOUT_S = 8

# Block devices that are not physical disks (loop files, RAM disks, device-mapper,
# ZFS zvols, optical drives...): their I/O is already counted on the disk below.
_VIRTUAL_BLOCK_PREFIXES = ("loop", "ram", "zram", "dm-", "sr", "fd", "zd", "nbd", "md")

# Every section is introduced by a stable marker so a missing command only leaves
# its own section empty.
PROBE_SCRIPT = r"""
echo '@@stat'; head -1 /proc/stat 2>/dev/null
echo '@@meminfo'; cat /proc/meminfo 2>/dev/null
echo '@@diskstats'; cat /proc/diskstats 2>/dev/null
echo '@@netdev'; cat /proc/net/dev 2>/dev/null
echo '@@uptime'; cat /proc/uptime 2>/dev/null
echo '@@blocks'; ls /sys/block 2>/dev/null
echo '@@phys'; for i in /sys/class/net/*; do [ -e "$i/device" ] && basename "$i"; done 2>/dev/null
echo '@@cpu'; nproc 2>/dev/null; grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2-
echo '@@kernel'; uname -r 2>/dev/null
echo '@@os'; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")
echo '@@addr'; ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1)}'
"""


def _sections(text):
    out, cur = {}, None
    for line in text.splitlines():
        if line.startswith("@@"):
            cur = line[2:].strip()
            out[cur] = []
        elif cur is not None:
            out[cur].append(line)
    return out


def parse_probe(text):
    """Raw counters and identity from the probe output. Every field may be None."""
    s = _sections(text)
    raw = {
        "cpu_ticks": None,
        "mem_total_kb": None,
        "mem_avail_kb": None,
        "disk_read_b": None,
        "disk_write_b": None,
        "net_rx_b": None,
        "net_tx_b": None,
        "uptime_s": None,
        "cores": None,
        "cpu_model": None,
        "kernel": None,
        "os": None,
        "address": None,
    }
    try:
        fields = [int(x) for x in (s.get("stat") or [""])[0].split()[1:]]
        if len(fields) >= 5:
            raw["cpu_ticks"] = (sum(fields), fields[3] + fields[4])  # total, idle + iowait
    except ValueError:
        pass

    mem = {}
    for line in s.get("meminfo", []):
        k, _, v = line.partition(":")
        parts = v.split()
        if parts and parts[0].isdigit():
            mem[k.strip()] = int(parts[0])
    raw["mem_total_kb"] = mem.get("MemTotal")
    raw["mem_avail_kb"] = mem.get("MemAvailable")

    blocks = {b.strip() for b in s.get("blocks", []) if b.strip()}
    physical_disks = {b for b in blocks if not b.startswith(_VIRTUAL_BLOCK_PREFIXES)}
    rd = wr = 0
    seen_disk = False
    for line in s.get("diskstats", []):
        p = line.split()
        if len(p) >= 10 and p[2] in physical_disks:
            try:
                rd += int(p[5]) * 512  # sectors read
                wr += int(p[9]) * 512  # sectors written
                seen_disk = True
            except ValueError:
                continue
    if seen_disk:
        raw["disk_read_b"], raw["disk_write_b"] = rd, wr

    phys = {i.strip() for i in s.get("phys", []) if i.strip()}
    rx = tx = 0
    seen_if = False
    for line in s.get("netdev", []):
        if ":" not in line:
            continue
        name, _, rest = line.partition(":")
        p = rest.split()
        if name.strip() in phys and len(p) >= 9:
            try:
                rx += int(p[0])
                tx += int(p[8])
                seen_if = True
            except ValueError:
                continue
    if seen_if:
        raw["net_rx_b"], raw["net_tx_b"] = rx, tx

    try:
        raw["uptime_s"] = int(float((s.get("uptime") or [""])[0].split()[0]))
    except (ValueError, IndexError):
        logger.debug("Unreadable /proc/uptime in the node probe")

    cpu = [x.strip() for x in s.get("cpu", []) if x.strip()]
    if cpu and cpu[0].isdigit():
        raw["cores"] = int(cpu[0])
    if len(cpu) > 1:
        raw["cpu_model"] = " ".join(cpu[1].split())
    raw["kernel"] = next((x.strip() for x in s.get("kernel", []) if x.strip()), None)
    raw["os"] = next((x.strip() for x in s.get("os", []) if x.strip()), None)
    raw["address"] = next((x.strip() for x in s.get("addr", []) if x.strip()), None)
    return raw


def run_probe(node=None):
    """Probe output for the local host (node None) or a registered remote node (its
    database row). Returns None when the node cannot be reached."""
    return run_probe_script(PROBE_SCRIPT, node)


def run_probe_script(script, node=None):
    """Runs a read-only shell script on the local host or, over the cluster SSH trust,
    on a registered remote node. The script is fixed code, never user input."""
    if node is None:
        cmd = ["bash", "-s"]
    else:
        from app.core.cluster import node_ssh_options

        cmd = [
            "ssh",
            *node_ssh_options(),
            "-o",
            f"ConnectTimeout={PROBE_TIMEOUT_S}",
            "-p",
            str(node["ssh_port"]),
            f"{node['ssh_user']}@{node['hostname']}",
            "bash",
            "-s",
        ]
    try:
        proc = subprocess.run(cmd, input=script, capture_output=True, text=True, timeout=PROBE_TIMEOUT_S + 4)
    except (OSError, subprocess.TimeoutExpired):
        logger.debug("Node probe failed", exc_info=True)
        return None
    if proc.returncode != 0 and not proc.stdout:
        return None
    return proc.stdout


_previous = {}  # target -> (monotonic time, raw counters)


def _delta_rate(prev, cur, key, dt):
    if prev.get(key) is None or cur.get(key) is None or cur[key] < prev[key]:
        return None  # first reading or counter reset (reboot)
    return round((cur[key] - prev[key]) / dt, 1)


def compute(target, raw, now=None):
    """Load figures of one node from two consecutive raw readings."""
    now = time.monotonic() if now is None else now
    prev_entry = _previous.get(target)
    _previous[target] = (now, raw)
    total_kb, avail_kb = raw.get("mem_total_kb"), raw.get("mem_avail_kb")
    result = {
        "cpu_pct": None,
        "mem_used_mb": round((total_kb - avail_kb) / 1024, 1) if total_kb and avail_kb is not None else None,
        "mem_total_mb": round(total_kb / 1024, 1) if total_kb else None,
        "disk_read_bps": None,
        "disk_write_bps": None,
        "net_rx_bps": None,
        "net_tx_bps": None,
    }
    if prev_entry is None:
        return result
    prev_t, prev = prev_entry
    dt = now - prev_t
    if dt <= 0:
        return result
    if prev.get("cpu_ticks") and raw.get("cpu_ticks"):
        dtotal = raw["cpu_ticks"][0] - prev["cpu_ticks"][0]
        didle = raw["cpu_ticks"][1] - prev["cpu_ticks"][1]
        if dtotal > 0:
            result["cpu_pct"] = round(max(0.0, min(100.0, (1 - didle / dtotal) * 100)), 1)
    for out_key, raw_key in (
        ("disk_read_bps", "disk_read_b"),
        ("disk_write_bps", "disk_write_b"),
        ("net_rx_bps", "net_rx_b"),
        ("net_tx_bps", "net_tx_b"),
    ):
        result[out_key] = _delta_rate(prev, raw, raw_key, dt)
    return result
