"""Continuous metrics collection: CPU/RAM/disk/network per VM and for the host,
sampled in the background at a regular interval and persisted in the database
instead of being recomputed on demand (which GET /vms/{name}/metrics already
does; that mechanism is unchanged and remains the "instantaneous real time"
view, while this one adds the HISTORY that did not exist).

A deliberate simplification compared to vCenter's 4 statistics levels: only
two tiers.
  - "raw": one sample every `metrics_interval_s` seconds (deployment profile,
    10-30), kept RAW_RETENTION_H hours.
  - "hourly": the average of the raw samples of the elapsed hour, computed
    once an hour before the matching raw samples are purged, kept
    HOURLY_RETENTION_DAYS days.
A "1h" view reads the raw tier; "24h/week/month" read the hourly tier. There
is no additional "daily" tier (vCenter has a 3rd/4th): judged sufficient for
the size of this project, to be refined if the number of VMs grows a lot.

Alerting: fixed thresholds (not yet configurable from the UI) checked at every
tick; a threshold crossing is logged through log_action (so it is visible and
filterable in the existing Journal). There is no separate alarm subsystem with
acknowledged/active states like vCenter, on the same principle of not
over-engineering for the size of the project.

"""

import logging
import threading
import time
from datetime import UTC, datetime, timedelta

import libvirt

from app.core import deployment_profile
from app.core.database import get_conn
from app.core.libvirt_utils import open_conn

logger = logging.getLogger(__name__)

RAW_RETENTION_H = 2
HOURLY_RETENTION_DAYS = 60

ALERT_THRESHOLDS = {"cpu_pct": 90, "mem_pct": 90, "disk_pct": 90}

_last_counters = {}  # (target, dev) -> (timestamp, raw value), used to compute rates
_alert_state = {}  # (target, metric) -> bool (already alerting or not), avoids spamming the log on every tick
_stop_event = threading.Event()


def _now_iso():
    return datetime.now(UTC).isoformat()


def _rate(key, now, raw_value):
    """Rate (unit/s) since the last reading of the same cumulative counter. None on
    the very first tick (no reference point yet)."""
    prev = _last_counters.get(key)
    _last_counters[key] = (now, raw_value)
    if prev is None:
        return None
    prev_t, prev_v = prev
    dt = now - prev_t
    if dt <= 0 or raw_value < prev_v:  # counter reset (VM restarted): no negative value
        return None
    return (raw_value - prev_v) / dt


def _host_cpu_pct():
    """Host CPU usage (%) from /proc/stat (delta of cumulative counters, the same
    fields as `top`/`vmstat`)."""
    try:
        with open("/proc/stat") as f:
            fields = [int(x) for x in f.readline().split()[1:]]
    except (OSError, ValueError):
        return None
    idle_all = fields[3] + fields[4]  # idle + iowait
    total = sum(fields)
    now = time.time()
    prev = _last_counters.get(("host", "cpu_ticks"))
    _last_counters[("host", "cpu_ticks")] = (now, (total, idle_all))
    if prev is None:
        return None
    _, (prev_total, prev_idle) = prev
    dt_total = total - prev_total
    if dt_total <= 0:
        return None
    return round((1 - (idle_all - prev_idle) / dt_total) * 100, 1)


def _host_mem_mb():
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.strip().split()[0])  # kB
        total = info.get("MemTotal", 0) / 1024
        available = info.get("MemAvailable", 0) / 1024
        return round(total - available, 1), round(total, 1)
    except (OSError, ValueError):
        return None, None


def _sample_vm(domain, name, now):
    if not domain.isActive():
        return None
    try:
        info = domain.info()
        nvcpu = info[3] or 1
        cpu_time = domain.getCPUStats(True)[0]["cpu_time"]
        cpu_rate = _rate((name, "cpu_time"), now, cpu_time)
        cpu_pct = round(min(100.0, (cpu_rate / 1e9) * 100 / nvcpu), 1) if cpu_rate is not None else None

        mem_stats = domain.memoryStats()
        mem_used_mb = (
            round((mem_stats.get("actual", info[2]) - mem_stats.get("unused", 0)) / 1024, 1)
            if "unused" in mem_stats
            else None
        )
        mem_total_mb = round(info[1] / 1024, 1)

        import xml.etree.ElementTree as ET

        root = ET.fromstring(domain.XMLDesc(0))
        read_bps = write_bps = rx_bps = tx_bps = 0.0
        for disk in root.findall(".//devices/disk"):
            if disk.get("device") != "disk":
                continue
            target = disk.find("target")
            if target is None or not target.get("dev"):
                continue
            try:
                _rd_req, rd_bytes, _wr_req, wr_bytes, _err = domain.blockStats(target.get("dev"))
                r = _rate((name, f"rd:{target.get('dev')}"), now, rd_bytes)
                w = _rate((name, f"wr:{target.get('dev')}"), now, wr_bytes)
                read_bps += r or 0
                write_bps += w or 0
            except libvirt.libvirtError:
                pass
        for iface in root.findall(".//devices/interface"):
            target = iface.find("target")
            if target is None or not target.get("dev"):
                continue
            try:
                stats = domain.interfaceStats(target.get("dev"))
                rx, tx = stats[0], stats[4]
                r = _rate((name, f"rx:{target.get('dev')}"), now, rx)
                t = _rate((name, f"tx:{target.get('dev')}"), now, tx)
                rx_bps += r or 0
                tx_bps += t or 0
            except libvirt.libvirtError:
                pass

        return {
            "cpu_pct": cpu_pct,
            "mem_used_mb": mem_used_mb,
            "mem_total_mb": mem_total_mb,
            "disk_read_bps": round(read_bps, 1),
            "disk_write_bps": round(write_bps, 1),
            "net_rx_bps": round(rx_bps, 1),
            "net_tx_bps": round(tx_bps, 1),
        }
    except libvirt.libvirtError:
        return None


def _check_alert(cible, metric, value, threshold):
    key = (cible, metric)
    breached = value is not None and value >= threshold
    was_breached = _alert_state.get(key, False)
    _alert_state[key] = breached
    if breached and not was_breached:
        from app.core.audit import log_action

        log_action("system", "alert_seuil_depasse", cible, "echec", f"{metric} = {value}% (seuil {threshold}%)")


def _vm_row(cible, s):
    return (
        "vm",
        cible,
        s["cpu_pct"],
        s["mem_used_mb"],
        s["mem_total_mb"],
        s["disk_read_bps"],
        s["disk_write_bps"],
        s["net_rx_bps"],
        s["net_tx_bps"],
    )


def _check_vm_alerts(cible, s):
    if s["cpu_pct"] is not None:
        _check_alert(cible, "cpu_pct", s["cpu_pct"], ALERT_THRESHOLDS["cpu_pct"])
    if s["mem_used_mb"] and s["mem_total_mb"]:
        _check_alert(
            cible, "mem_pct", round(s["mem_used_mb"] / s["mem_total_mb"] * 100, 1), ALERT_THRESHOLDS["mem_pct"]
        )


def _pool_rows(node, conn):
    """(node, pool, capacity bytes, allocation bytes) of every libvirt pool of `conn`,
    plus the local ZFS pools (managed outside libvirt, local host only)."""
    rows = []
    try:
        for pool in conn.listAllStoragePools():
            try:
                _state, capacity, allocation, _available = pool.info()
                rows.append((node, pool.name(), capacity, allocation))
            except libvirt.libvirtError:
                continue
    except libvirt.libvirtError:
        pass
    if node == "local":
        from app.core import zfs_storage

        try:
            for z in zfs_storage.list_pools():
                rows.append(("local", z["nom"], z["capacite_go"] * 1024**3, z["allocation_go"] * 1024**3))
        except Exception:
            _log_ignored("ZFS pools could not be listed for the usage history")
    return rows


def _log_ignored(message):
    logger.debug(message, exc_info=True)


def _node_live_row(name, ts, raw, load, conn, reachable=True):
    versions = (None, None)
    if conn is not None:
        try:
            versions = (conn.getVersion(), conn.getLibVersion())
        except libvirt.libvirtError:
            logger.debug("Hypervisor versions unavailable for %s", name, exc_info=True)
    raw = raw or {}
    load = load or {}
    return (
        name,
        ts,
        1 if reachable else 0,
        load.get("cpu_pct"),
        load.get("mem_used_mb"),
        load.get("mem_total_mb"),
        raw.get("uptime_s"),
        raw.get("cores"),
        raw.get("cpu_model"),
        raw.get("kernel"),
        raw.get("os"),
        raw.get("address"),
        versions[0],
        versions[1],
    )


def _sample_remote_node(node, ts, now):
    """Load of one registered remote node (SSH probe) and of its VMs (libvirt over SSH).
    Returns (metric rows, pool rows, node_live row); an unreachable node only
    updates its node_live row, so the UI can tell "no data" from "0 %"."""
    from app.core import host_stats

    name = node["name"]
    rows, pools = [], []
    out = host_stats.run_probe(node)
    raw = host_stats.parse_probe(out) if out else None
    load = host_stats.compute(f"node:{name}", raw) if raw else None
    if load:
        rows.append(
            (
                "host",
                f"node:{name}",
                load["cpu_pct"],
                load["mem_used_mb"],
                load["mem_total_mb"],
                load["disk_read_bps"],
                load["disk_write_bps"],
                load["net_rx_bps"],
                load["net_tx_bps"],
            )
        )
    conn = None
    try:
        conn = open_conn(name)
        for domain in conn.listAllDomains():
            cible = f"{name}:{domain.name()}"
            s = _sample_vm(domain, cible, now)
            if s is not None:
                rows.append(_vm_row(cible, s))
                _check_vm_alerts(cible, s)
        pools = _pool_rows(name, conn)
        live = _node_live_row(name, ts, raw, load, conn, reachable=raw is not None)
    except Exception:
        _log_ignored(f"Remote node {name} could not be sampled")
        live = _node_live_row(name, ts, raw, load, None, reachable=raw is not None)
    finally:
        if conn is not None:
            conn.close()
    return rows, pools, live


def _collect_tick():
    from app.core import host_stats

    now = time.time()
    ts = _now_iso()
    rows, pool_rows, live_rows = [], [], []

    out = host_stats.run_probe(None)
    raw = host_stats.parse_probe(out) if out else None
    load = host_stats.compute("host", raw) if raw else None
    if load is None:  # probe unavailable (no bash?): keep the historical /proc readings for CPU and memory
        used, total = _host_mem_mb()
        load = {"cpu_pct": _host_cpu_pct(), "mem_used_mb": used, "mem_total_mb": total}
    rows.append(
        (
            "host",
            "host",
            load.get("cpu_pct"),
            load.get("mem_used_mb"),
            load.get("mem_total_mb"),
            load.get("disk_read_bps"),
            load.get("disk_write_bps"),
            load.get("net_rx_bps"),
            load.get("net_tx_bps"),
        )
    )
    if load.get("cpu_pct") is not None:
        _check_alert("host", "cpu_pct", load["cpu_pct"], ALERT_THRESHOLDS["cpu_pct"])
    if load.get("mem_used_mb") and load.get("mem_total_mb"):
        _check_alert(
            "host", "mem_pct", round(load["mem_used_mb"] / load["mem_total_mb"] * 100, 1), ALERT_THRESHOLDS["mem_pct"]
        )

    conn = open_conn()
    try:
        for domain in conn.listAllDomains():
            name = domain.name()
            s = _sample_vm(domain, name, now)
            if s is None:
                continue
            rows.append(_vm_row(name, s))
            _check_vm_alerts(name, s)
        pool_rows += _pool_rows("local", conn)
        live_rows.append(_node_live_row("local", ts, raw, load, conn))
    finally:
        conn.close()

    with get_conn() as db:
        nodes = [dict(r) for r in db.execute("SELECT * FROM nodes WHERE statut = 'en_ligne'").fetchall()]
    for node in nodes:
        r, p, live = _sample_remote_node(node, ts, now)
        rows += r
        pool_rows += p
        live_rows.append(live)

    with get_conn() as db:
        db.executemany(
            "INSERT INTO metrics_samples (ts, tier, scope, cible, cpu_pct, mem_used_mb, mem_total_mb, "
            "disk_read_bps, disk_write_bps, net_rx_bps, net_tx_bps) VALUES (?, 'raw', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(ts, scope, cible, *vals) for scope, cible, *vals in rows],
        )
        db.executemany(
            "INSERT INTO storage_samples (ts, tier, node, pool, capacity_b, allocation_b) VALUES (?, 'raw', ?, ?, ?, ?)",
            [(ts, *p) for p in pool_rows],
        )
        db.executemany(
            "INSERT OR REPLACE INTO node_live (name, ts, joignable, cpu_pct, mem_used_mb, mem_total_mb, uptime_s, "
            "cores, cpu_model, kernel, os, address, version_hyperviseur, version_libvirt) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            live_rows,
        )
        db.commit()


def _rollup_and_prune():
    """Once an hour: condense the raw samples of the elapsed hour into one average
    per target ('hourly' tier), then purge the old data: raw beyond
    RAW_RETENTION_H, hourly beyond HOURLY_RETENTION_DAYS."""
    now = datetime.now(UTC)
    hour_ago = (now - timedelta(hours=1)).isoformat()
    raw_cutoff = (now - timedelta(hours=RAW_RETENTION_H)).isoformat()
    hourly_cutoff = (now - timedelta(days=HOURLY_RETENTION_DAYS)).isoformat()

    with get_conn() as db:
        cibles = db.execute(
            "SELECT DISTINCT cible, scope FROM metrics_samples WHERE tier='raw' AND ts >= ?", (hour_ago,)
        ).fetchall()
        for row in cibles:
            avg = db.execute(
                "SELECT AVG(cpu_pct), AVG(mem_used_mb), AVG(mem_total_mb), AVG(disk_read_bps), "
                "AVG(disk_write_bps), AVG(net_rx_bps), AVG(net_tx_bps) "
                "FROM metrics_samples WHERE tier='raw' AND cible=? AND ts >= ?",
                (row["cible"], hour_ago),
            ).fetchone()
            db.execute(
                "INSERT INTO metrics_samples (ts, tier, scope, cible, cpu_pct, mem_used_mb, mem_total_mb, "
                "disk_read_bps, disk_write_bps, net_rx_bps, net_tx_bps) VALUES (?, 'hourly', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (now.isoformat(), row["scope"], row["cible"], *avg),
            )
        pools = db.execute(
            "SELECT DISTINCT node, pool FROM storage_samples WHERE tier='raw' AND ts >= ?", (hour_ago,)
        ).fetchall()
        for row in pools:
            avg = db.execute(
                "SELECT AVG(capacity_b), AVG(allocation_b) FROM storage_samples "
                "WHERE tier='raw' AND node=? AND pool=? AND ts >= ?",
                (row["node"], row["pool"], hour_ago),
            ).fetchone()
            db.execute(
                "INSERT INTO storage_samples (ts, tier, node, pool, capacity_b, allocation_b) VALUES (?, 'hourly', ?, ?, ?, ?)",
                (now.isoformat(), row["node"], row["pool"], *avg),
            )
        db.execute("DELETE FROM storage_samples WHERE tier='raw' AND ts < ?", (raw_cutoff,))
        db.execute("DELETE FROM storage_samples WHERE tier='hourly' AND ts < ?", (hourly_cutoff,))
        db.execute("DELETE FROM metrics_samples WHERE tier='raw' AND ts < ?", (raw_cutoff,))
        db.execute("DELETE FROM metrics_samples WHERE tier='hourly' AND ts < ?", (hourly_cutoff,))
        db.commit()


def get_node_live(name=None):
    """Latest live figures recorded by the collector: one node ('local' = this host)
    as a dict (or None), or every node as {name: dict} when name is None."""
    with get_conn() as db:
        if name is not None:
            row = db.execute("SELECT * FROM node_live WHERE name = ?", (name,)).fetchone()
            return _live_dict(row) if row else None
        return {r["name"]: _live_dict(r) for r in db.execute("SELECT * FROM node_live").fetchall()}


def _live_dict(row):
    d = dict(row)
    d["joignable"] = bool(d["joignable"])
    d["mesure_le"] = d.pop("ts")
    d.pop("name", None)
    return d


def _collector_loop():
    last_rollup = 0
    while not _stop_event.is_set():
        try:
            _collect_tick()
            if time.time() - last_rollup >= 3600:
                _rollup_and_prune()
                last_rollup = time.time()
        except Exception as e:  # never let the thread die because of a failed tick
            print(f"[metrics] tick failed: {e!r}", flush=True)
        _stop_event.wait(deployment_profile.settings()["metrics_interval_s"])


def start_metrics_collector():
    thread = threading.Thread(target=_collector_loop, daemon=True)
    thread.start()
    return thread
