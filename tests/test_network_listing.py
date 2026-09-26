"""The network list must survive a network that disappears while it is being read."""

import libvirt

from app.routers import network


class _Net:
    def __init__(self, name, gone=False):
        self._name, self._gone = name, gone

    def XMLDesc(self, _flags):
        if self._gone:
            raise libvirt.libvirtError("Network not found")
        return f'<network><name>{self._name}</name><bridge name="br0"/></network>'

    def name(self):
        return self._name

    def UUIDString(self):
        return "uuid-" + self._name

    def isActive(self):
        return 1

    def autostart(self):
        return 0


class _Conn:
    def __init__(self, nets):
        self._nets = nets

    def listAllNetworks(self):
        return self._nets

    def listAllDomains(self):
        return []

    def close(self):
        pass


def test_a_network_deleted_during_listing_is_skipped_not_a_500(monkeypatch):
    conn = _Conn([_Net("kept"), _Net("vanished", gone=True), _Net("also-kept")])
    monkeypatch.setattr(network, "open_conn", lambda: conn)
    monkeypatch.setattr(network, "ensure_isolated_network", lambda _c: None)
    monkeypatch.setattr(network, "log_action", lambda *a, **k: None)
    result = network.list_networks(user={"username": "tester"})
    assert [n["nom"] for n in result] == ["kept", "also-kept"]
