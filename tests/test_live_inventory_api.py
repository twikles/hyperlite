"""Data the redesigned dashboard shows that the API did not provide before: node load
and identity, host and pool history, disk sizes, interface details, audit source
addresses, last logins and "stay signed in" sessions."""

from datetime import UTC, datetime, timedelta

import jwt
import libvirt

from app.core import host_stats, node_hardware

PASSWORD = "correct horse battery"

PROBE_A = """@@stat
cpu  100 0 100 700 100 0 0 0 0 0
@@meminfo
MemTotal:       8000000 kB
MemAvailable:   6000000 kB
@@diskstats
 259       0 nvme0n1 10 0 2000 0 5 0 1000 0 0 0 0
   7       0 loop0 10 0 999999 0 5 0 999999 0 0 0 0
@@netdev
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 1 0 0 0 0 0 0 5000 1 0 0 0 0 0 0
enp3s0: 10000 1 0 0 0 0 0 0 4000 1 0 0 0 0 0 0
virbr0: 90000 1 0 0 0 0 0 0 90000 1 0 0 0 0 0 0
@@uptime
3600.5 100.0
@@blocks
loop0
nvme0n1
@@phys
enp3s0
@@cpu
8
 Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz
@@kernel
6.8.0-45-generic
@@os
Ubuntu 24.04 LTS
@@addr
192.0.2.10
"""

PROBE_B = (
    PROBE_A.replace("cpu  100 0 100 700 100", "cpu  200 0 200 1300 100")
    .replace("nvme0n1 10 0 2000 0 5 0 1000", "nvme0n1 10 0 4000 0 5 0 3000")
    .replace("enp3s0: 10000 1 0 0 0 0 0 0 4000", "enp3s0: 30000 1 0 0 0 0 0 0 5000")
)


def test_the_node_probe_reports_identity_and_only_physical_devices():
    raw = host_stats.parse_probe(PROBE_A)
    assert raw["cores"] == 8 and raw["kernel"] == "6.8.0-45-generic" and raw["os"] == "Ubuntu 24.04 LTS"
    assert raw["cpu_model"].startswith("Intel(R) Core(TM) i7-6700") and raw["address"] == "192.0.2.10"
    assert raw["uptime_s"] == 3600
    # loop devices and bridges are not counted: their traffic is already counted on the disk / NIC below
    assert raw["disk_read_b"] == 2000 * 512 and raw["net_rx_b"] == 10000


def test_node_rates_come_from_two_readings_and_the_first_one_has_none():
    host_stats._previous.clear()
    first = host_stats.compute("n1", host_stats.parse_probe(PROBE_A), now=100.0)
    assert first["cpu_pct"] is None and first["disk_read_bps"] is None
    assert first["mem_total_mb"] == round(8000000 / 1024, 1) and first["mem_used_mb"] == round(2000000 / 1024, 1)
    second = host_stats.compute("n1", host_stats.parse_probe(PROBE_B), now=110.0)
    assert second["cpu_pct"] == 25.0  # 800 ticks elapsed, 600 of them idle
    assert second["disk_read_bps"] == 2000 * 512 / 10 and second["disk_write_bps"] == 2000 * 512 / 10
    assert second["net_rx_bps"] == 2000.0 and second["net_tx_bps"] == 100.0


def test_a_counter_reset_gives_no_rate_instead_of_a_negative_one():
    host_stats._previous.clear()
    host_stats.compute("n2", host_stats.parse_probe(PROBE_B), now=1.0)
    after_reboot = host_stats.compute("n2", host_stats.parse_probe(PROBE_A), now=2.0)
    assert after_reboot["disk_read_bps"] is None and after_reboot["net_rx_bps"] is None


HARDWARE = """@@links
enp3s0|up|3c:7c:3f:1a:22:09|1500|1000|physique
virbr0|up|52:54:00:9e:2b:11|1500|-1|pont
@@addr
[{"ifname":"enp3s0","addr_info":[{"local":"192.0.2.10","prefixlen":24}]},{"ifname":"virbr0","addr_info":[]}]
@@lsblk
{"blockdevices":[{"name":"nvme0n1","model":"Samsung SSD 970 ","size":500107862016,"rota":false,"tran":"nvme","type":"disk","mountpoint":null,
 "children":[{"name":"nvme0n1p2","model":null,"size":1,"rota":false,"tran":null,"type":"part","mountpoint":"/"}]},
 {"name":"loop0","model":null,"size":1,"rota":false,"tran":null,"type":"loop","mountpoint":null}]}
@@smart
nvme0n1|PASSED
@@lscpu
{"lscpu":[{"field":"Model name:","data":"Intel(R) Core(TM) i7-6700"},{"field":"Socket(s):","data":"1"},
 {"field":"Core(s) per socket:","data":"4"},{"field":"Thread(s) per core:","data":"2"},{"field":"CPU(s):","data":"8"},
 {"field":"Virtualization:","data":"VT-x"}]}
@@end
"""


def test_the_hardware_probe_lists_interfaces_disks_and_cpu_topology():
    hw = node_hardware.parse(HARDWARE)
    nic, bridge = hw["interfaces"]
    assert nic == {
        "nom": "enp3s0",
        "etat": "up",
        "type": "physique",
        "mac": "3c:7c:3f:1a:22:09",
        "mtu": 1500,
        "debit_mbps": 1000,
        "adresses": ["192.0.2.10/24"],
    }
    assert bridge["debit_mbps"] is None  # the kernel reports -1 for a bridge
    assert hw["disques"] == [
        {
            "nom": "nvme0n1",
            "modele": "Samsung SSD 970",
            "type": "NVMe",
            "taille_go": 465.8,
            "sante": "ok",
            "points_montage": ["/"],
        }
    ]
    assert hw["cpu"]["sockets"] == 1 and hw["cpu"]["threads"] == 8 and hw["cpu"]["virtualisation"] == "VT-x"


def _login(client, username, **extra):
    return client.post("/auth/login", data={"username": username, "password": PASSWORD, **extra}).json()


def test_stay_signed_in_issues_a_longer_session(client, make_user):
    make_user("alice")
    short = jwt.decode(_login(client, "alice")["access_token"], options={"verify_signature": False})
    long = jwt.decode(_login(client, "alice", remember="true")["access_token"], options={"verify_signature": False})
    assert long["exp"] - short["exp"] > 24 * 3600


def test_the_user_list_shows_the_last_login_and_the_2fa_state(client, make_user):
    make_user("alice")
    token = _login(client, "alice")["access_token"]
    users = client.get("/auth/users", headers={"Authorization": f"Bearer {token}"}).json()
    alice = next(u for u in users if u["username"] == "alice")
    assert alice["totp_enabled"] is False
    assert datetime.fromisoformat(alice["last_login_at"]) > datetime.now(UTC) - timedelta(minutes=1)


def test_audit_entries_record_the_source_address_and_can_be_counted(client, make_user, database):
    from app.core import audit

    make_user("alice")
    token = _login(client, "alice")["access_token"]
    audit._AUDIT_QUEUE.join()
    headers = {"Authorization": f"Bearer {token}"}
    entries = client.get("/audit", params={"action": "login"}, headers=headers).json()
    assert entries and entries[0]["ip"] == "testclient"
    assert client.get("/audit/count", params={"action": "login"}, headers=headers).json()["total"] == len(entries)


def test_every_backup_schedule_can_be_listed(client, make_user, database):
    make_user("alice")
    token = _login(client, "alice")["access_token"]
    with database.get_conn() as conn:
        conn.execute(
            "INSERT INTO backup_jobs (vm_name, frequence, heure, cible_dir, retention_count, actif, prochaine_execution) "
            "VALUES ('web', 'quotidien', '02:00', '/tmp', 3, 1, '2030-01-01T02:00:00+00:00')"
        )
        conn.commit()
    rows = client.get("/backup-schedules", headers={"Authorization": f"Bearer {token}"}).json()
    assert [r["vm_name"] for r in rows] == ["web"]


def test_node_and_storage_history_are_served_per_node_and_pool(client, make_user, database):
    make_user("alice")
    headers = {"Authorization": f"Bearer {_login(client, 'alice')['access_token']}"}
    now = datetime.now(UTC).isoformat()
    with database.get_conn() as conn:
        conn.executemany(
            "INSERT INTO metrics_samples (ts, tier, scope, cible, cpu_pct) VALUES (?, 'raw', 'host', ?, ?)",
            [(now, "host", 10.0), (now, "node:n2", 46.0)],
        )
        conn.execute(
            "INSERT INTO metrics_samples (ts, tier, scope, cible, cpu_pct) VALUES (?, 'raw', 'vm', 'n2:web', 7.0)",
            (now,),
        )
        conn.executemany(
            "INSERT INTO storage_samples (ts, tier, node, pool, capacity_b, allocation_b) VALUES (?, 'raw', ?, ?, ?, ?)",
            [(now, "local", "default", 100.0, 23.0), (now, "n2", "ssd", 200.0, 142.0)],
        )
        conn.commit()
    assert client.get("/nodes/local/metrics/history", headers=headers).json()[0]["cpu_pct"] == 10.0
    assert client.get("/nodes/n2/metrics/history", headers=headers).json()[0]["cpu_pct"] == 46.0
    assert client.get("/vms/web/metrics/history", params={"node": "n2"}, headers=headers).json()[0]["cpu_pct"] == 7.0
    pools = client.get("/storage/history", params={"range": "1h"}, headers=headers).json()
    assert {(p["node"], p["pool"]) for p in pools} == {("local", "default"), ("n2", "ssd")}
    only_n2 = client.get("/storage/history", params={"range": "1h", "node": "n2"}, headers=headers).json()
    assert only_n2 == [
        {"node": "n2", "pool": "ssd", "points": [{"ts": now, "capacity_b": 200.0, "allocation_b": 142.0}]}
    ]


class _Dom:
    def __init__(self, xml):
        self._xml = xml

    def XMLDesc(self, _flags):
        return self._xml

    def blockInfo(self, dev):
        if dev == "hda":
            raise libvirt.libvirtError("no medium")
        return (60 * 1024**3, 12 * 1024**3, 12 * 1024**3)


class _Vol:
    def storagePoolLookupByVolume(self):
        return type("P", (), {"name": lambda self: "default"})()


class _Conn:
    def storageVolLookupByPath(self, path):
        if path.endswith(".qcow2"):
            return _Vol()
        raise libvirt.libvirtError("not in a pool")


def test_disk_size_and_pool_are_reported_and_missing_parts_stay_empty():
    from app.routers.vms.devices import _disk_size

    dom = _Dom("<domain/>")
    assert _disk_size(dom, _Conn(), "sda", "/var/lib/libvirt/images/a.qcow2") == {
        "taille_go": 60.0,
        "alloue_go": 12.0,
        "pool": "default",
    }
    assert _disk_size(dom, _Conn(), "hda", "/data/isos/x.iso") == {"taille_go": None, "alloue_go": None, "pool": None}


def test_interfaces_report_model_vlan_and_firewall_filter():
    from app.routers.vms.devices import _get_interfaces

    dom = _Dom(
        "<domain><devices><interface type='network'><mac address='52:54:00:00:00:01'/><source network='lan'/>"
        "<model type='e1000e'/><vlan><tag id='42'/></vlan><filterref filter='hl-fw-web'/></interface></devices></domain>"
    )
    assert _get_interfaces(dom) == [
        {
            "mac": "52:54:00:00:00:01",
            "reseau": "lan",
            "type_source": "network",
            "modele": "e1000e",
            "vlan": 42,
            "pare_feu": "hl-fw-web",
        }
    ]


def test_networks_report_dhcp_and_how_many_vms_use_them():
    from app.routers import network

    class _Net:
        def XMLDesc(self, _f):
            return "<network><forward mode='nat'/><bridge name='virbr1'/><ip address='192.168.100.1' netmask='255.255.255.0'><dhcp/></ip></network>"

        def name(self):
            return "lan"

        def UUIDString(self):
            return "u"

        def isActive(self):
            return 1

        def autostart(self):
            return 1

    class _C:
        def listAllDomains(self):
            return [
                _Dom(
                    "<domain><devices><interface><source network='lan'/></interface><interface><source network='lan'/></interface></devices></domain>"
                ),
                _Dom("<domain><devices><interface><source network='other'/></interface></devices></domain>"),
            ]

    assert network._network_summary(_Net())["dhcp"] is True
    assert network._vm_count_by_network(_C()) == {"lan": 1, "other": 1}
