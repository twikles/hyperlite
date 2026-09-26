import { Fragment, useCallback, useEffect, useState } from "react";
import { fetchNetworks, fetchNetworkDetail, createNetwork, deleteNetwork, fetchNetworkFirewall, setNetworkFirewall } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { confirmAction } from "../../store/useConfirmStore";
import { useT } from "../i18n";
import { capabilities } from "../lib/capabilities";
import { errorMessage } from "../lib/errors";
import { useIntent } from "../lib/intents";
import StatusIndicator from "../components/StatusIndicator";
import { PageHeader, Chip, Empty, SideDrawer, Field } from "../components/ui";
import { Network, Plus, Trash2 } from "lucide-react";
import FirewallCard from "../components/FirewallCard";

const PROTECTED = ["default", "hyperlite-isolated"];
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
// "192.168.100.1" + "255.255.255.0" -> "192.168.100.1/24"
function cidr(r) {
  if (!r?.adresse) return "—";
  const bits = (r.masque || "").split(".").reduce((a, o) => a + (Number(o) >>> 0).toString(2).split("1").length - 1, 0);
  return r.masque ? `${r.adresse}/${bits}` : r.adresse;
}
const EMPTY = { name: "", mode: "isole", subnet_address: "192.168.150.1", dhcp_start: "192.168.150.10", dhcp_end: "192.168.150.100", bridge_name: "" };

function FirewallSection({ name, isAdmin }) {
  const fetchConfig = useCallback(() => fetchNetworkFirewall(name), [name]);
  const saveConfig = useCallback((config) => setNetworkFirewall(name, config), [name]);
  const t = useT();
  return <FirewallCard title={t("net.firewall")} fetchConfig={fetchConfig} saveConfig={saveConfig} isAdmin={isAdmin} />;
}

// Virtual networks: list, details (subnet, DHCP leases, firewall), create and delete, with the same API
// calls and protections as the historical screen.
export default function NetworkPage() {
  const t = useT();
  const pushToast = useInfraStore((s) => s.pushToast);
  const caps = capabilities(useAuthStore((s) => s.role));
  const [nets, setNets] = useState(null);
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const reload = useCallback(async () => {
    try { const r = await fetchNetworks(); setNets(Array.isArray(r) ? r : []); }
    catch (e) { pushToast({ kind: "error", title: t("net.error"), message: errorMessage(e) }); setNets([]); }
  }, [pushToast, t]);
  useEffect(() => { reload(); }, [reload]);

  async function toggle(name) {
    if (open === name) { setOpen(null); return; }
    setOpen(name); setDetail(null);
    try { setDetail(await fetchNetworkDetail(name)); } catch (e) { pushToast({ kind: "error", title: t("net.detailError"), message: errorMessage(e) }); }
  }

  const bridge = form.mode === "bridge";
  const problems = {
    name: !form.name.trim() ? t("net.nameRequired") : "",
    subnet_address: !bridge && !IPV4.test(form.subnet_address) ? t("net.ipInvalid") : "",
    dhcp_start: !bridge && !IPV4.test(form.dhcp_start) ? t("net.ipInvalid") : "",
    dhcp_end: !bridge && !IPV4.test(form.dhcp_end) ? t("net.ipInvalid") : "",
    bridge_name: bridge && !form.bridge_name.trim() ? t("net.bridgeRequired") : "",
  };
  const invalid = Object.values(problems).some(Boolean);

  async function create(e) {
    e?.preventDefault();
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    try {
      await createNetwork({ name: form.name, mode: form.mode, subnet_address: bridge ? undefined : form.subnet_address, dhcp_start: bridge ? undefined : form.dhcp_start, dhcp_end: bridge ? undefined : form.dhcp_end, bridge_name: bridge ? form.bridge_name : undefined });
      pushToast({ kind: "success", title: t("net.created"), message: form.name });
      setFormOpen(false); setForm(EMPTY); setTouched(false); await reload();
    } catch (err) { pushToast({ kind: "error", title: t("stor.createFailed"), message: errorMessage(err) }); }
    finally { setBusy(false); }
  }

  useIntent("network", () => caps.admin && setFormOpen(true));

  async function remove(name) {
    if (!(await confirmAction({ title: t("net.deleteTitle", { name }), message: t("net.deleteHelp"), confirmLabel: t("vx.delete"), danger: true }))) return;
    try { await deleteNetwork(name); pushToast({ kind: "success", title: t("net.deleted"), message: name }); await reload(); }
    catch (err) { pushToast({ kind: "error", title: t("stor.deleteFailed"), message: errorMessage(err) }); }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const field = (k, label, aria, placeholder) => (
    <Field label={label} error={touched ? problems[k] : null}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={aria} value={form[k]} onChange={set(k)} placeholder={placeholder} />}</Field>
  );
  const close = () => { setFormOpen(false); setTouched(false); };

  return (
    <>
      <PageHeader title={t("tab.reseau")} count={nets ? nets.length : null} desc={t("net.desc")}
        actions={caps.admin && <button type="button" className="nx-btn nx-btn--primary" onClick={() => setFormOpen(true)}><Plus size={15} aria-hidden="true" />{t("net.create")}</button>} />
      <div className="nx-card2 nx-card2--flush">
        {nets == null ? <p className="nx-muted" style={{ padding: "var(--space-4)" }}>{t("loading")}</p> : nets.length === 0 ? <Empty icon={Network} title={t("net.none")} text={t("net.noneHelp")} /> : (
          <div className="nx-tablewrap">
            <table className="nx-table">
              <thead><tr><th scope="col">{t("ns.col.state")}</th><th scope="col">{t("net.network")}</th><th scope="col">{t("net.mode")}</th><th scope="col">{t("net.bridge")}</th><th scope="col">{t("net.subnet")}</th><th scope="col">DHCP</th><th scope="col" className="nx-num">{t("nd.vms")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
              <tbody>
                {nets.map((n) => (
                  <Fragment key={n.nom}>
                    <tr>
                      <td><StatusIndicator override={{ key: n.actif ? "state.active" : "state.inactive", shape: n.actif ? "dot" : "square", tone: n.actif ? "success" : "offline" }} /></td>
                      <th scope="row" className="nx-nm">{n.nom}<small>{n.autostart ? t("net.autostart") : t("net.manualStart")}</small></th>
                      <td><Chip>{t(`net.mode.${n.type}`)}</Chip></td>
                      <td className="nx-mono">{n.pont || "—"}</td>
                      <td className="nx-mono">{cidr(n.reseau)}</td>
                      <td>{n.dhcp ? t("net.on") : <span className="nx-muted">{t("net.off")}</span>}</td>
                      <td className="nx-num nx-mono">{n.vms ?? "—"}</td>
                      <td><div className="nx-ra">
                        <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" aria-expanded={open === n.nom} aria-label={t("net.detailsOf", { name: n.nom })} onClick={() => toggle(n.nom)}>{t("net.details")}</button>
                        {caps.admin && !PROTECTED.includes(n.nom) && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" aria-label={t("a11y.delete_network_x", { v: n.nom })} title={t("vx.delete")} onClick={() => remove(n.nom)}><Trash2 size={15} aria-hidden="true" /></button>}
                      </div></td>
                    </tr>
                    {open === n.nom && (
                      <tr><td colSpan={8} className="nx-detailcell">
                        {!detail ? <span className="nx-muted">{t("loading")}</span> : (
                          <div className="nx-ns">
                            <div><strong>{t("net.leases")}</strong>
                              {(detail.baux_dhcp || []).length === 0 ? <p className="nx-muted" style={{ margin: "4px 0 0" }}>{t("net.noLeases")}</p> : (
                                <ul className="nx-list nx-list--vols">{detail.baux_dhcp.map((b, i) => <li key={i}><span className="nx-mono">{b.ip}</span><span className="nx-mono nx-muted">{b.mac}</span><span className="nx-muted">{b.hostname || ""}</span></li>)}</ul>
                              )}
                            </div>
                            <FirewallSection name={n.nom} isAdmin={caps.admin} />
                          </div>
                        )}
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <SideDrawer open={formOpen} title={t("net.create")} onClose={close} busy={busy} footer={<>
        <button type="button" className="nx-btn nx-btn--ghost" onClick={close} disabled={busy}>{t("action.cancel")}</button>
        <button type="button" className="nx-btn nx-btn--primary" disabled={busy} onClick={create}>{t("net.create")}</button>
      </>}>
        {field("name", t("ns.col.name"), "Name", "isolated-lab")}
        <Field label={t("net.mode")}>{(p) => (
          <select {...p} className="nx-inp" aria-label={t("a11y.network_mode")} value={form.mode} onChange={set("mode")}>
            <option value="isole">{t("net.modeIsolated")}</option>
            <option value="nat">{t("net.modeNat")}</option>
            <option value="bridge">{t("net.modeBridge")}</option>
          </select>
        )}</Field>
        {bridge ? field("bridge_name", t("net.bridge"), "Host bridge name (e.g. br0)", "br0") : (<>
          {field("subnet_address", t("net.gateway"), "Gateway (e.g. 192.168.150.1)", "192.168.150.1")}
          <div className="nx-fg">
            {field("dhcp_start", t("net.dhcpStart"), "DHCP start", "192.168.150.10")}
            {field("dhcp_end", t("net.dhcpEnd"), "DHCP end", "192.168.150.100")}
          </div>
        </>)}
      </SideDrawer>
    </>
  );
}
NetworkPage.ownHeader = true;
