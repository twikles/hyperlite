import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, Copy, Plus, Trash2 } from "lucide-react";
import { fetchClusterPubkey, addRemoteNode, deleteRemoteNode, testNodeConnection } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { confirmAction } from "../../store/useConfirmStore";
import { useT, useLangStore } from "../i18n";
import { capabilities } from "../lib/capabilities";
import { errorMessage } from "../lib/errors";
import { formatSizeMb, formatUptimeLong, formatVersionInt } from "../lib/format";
import { refreshInventory } from "../lib/inventory";
import { useIntent } from "../lib/intents";
import StatusIndicator from "../components/StatusIndicator";
import { PageHeader, Meter, Chip, SideDrawer, Field } from "../components/ui";

const EMPTY = { name: "", hostname: "", ssh_user: "root", ssh_port: "22" };
const pct = (used, total) => (used != null && total ? (used / total) * 100 : null);

// The add-node drawer: authorize the cluster key, fill the address, test the connection, then add.
function AddNodeDrawer({ open, onClose, onAdded }) {
  const t = useT();
  const pushToast = useInfraStore((s) => s.pushToast);
  const [pubkey, setPubkey] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);
  useEffect(() => { if (open) fetchClusterPubkey().then((r) => setPubkey(r.public_key)).catch(() => setPubkey(null)); }, [open]);
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setTest(null); };
  const port = Number(form.ssh_port);
  const valid = form.name && form.hostname && Number.isInteger(port) && port >= 1 && port <= 65535;

  async function copyKey() {
    try { await navigator.clipboard.writeText(pubkey); pushToast({ kind: "success", title: t("nd.keyCopied"), message: t("nd.keyCopiedHelp") }); }
    catch { pushToast({ kind: "error", title: t("nd.copyFailed"), message: t("nd.copyManual") }); }
  }
  async function runTest() {
    setBusy(true); setTest(null);
    try { const r = await testNodeConnection({ hostname: form.hostname, ssh_user: form.ssh_user, ssh_port: port }); setTest(r); }
    catch (e) { setTest({ ok: false, detail: errorMessage(e) }); }
    finally { setBusy(false); }
  }
  async function add() {
    setBusy(true);
    try {
      await addRemoteNode({ ...form, ssh_port: port || 22 });
      pushToast({ kind: "success", title: t("nd.added"), message: form.name });
      setForm(EMPTY); setTest(null); onAdded(); onClose();
    } catch (err) { pushToast({ kind: "error", title: t("nd.connFailed"), message: errorMessage(err) }); }
    finally { setBusy(false); }
  }
  return (
    <SideDrawer open={open} title={t("nd.drawerTitle")} onClose={onClose} busy={busy} footer={<>
      <button type="button" className="nx-btn" disabled={busy || !valid} onClick={runTest}>{t("nd.test")}</button>
      <button type="button" className="nx-btn nx-btn--primary" disabled={busy || !valid} onClick={add}>{busy ? t("nd.testing") : t("nd.testAdd")}</button>
    </>}>
      <ol className="nx-steps-list">
        <li>{t("nd.s1")}</li>
        <li>{t("nd.s2")}</li>
        <li>{t("nd.s3")}</li>
      </ol>
      {pubkey && (
        <div className="nx-f">
          <span className="nx-f-label">{t("nd.pubkey")}</span>
          <div className="nx-keybox2"><code className="nx-mono">{pubkey}</code><button type="button" className="nx-btn nx-btn--sm" onClick={copyKey}><Copy size={14} aria-hidden="true" />{t("action.copy")}</button></div>
          <span className="nx-f-h">{t("nd.pubkeyHint")} <code className="nx-mono">~/.ssh/authorized_keys</code></span>
        </div>
      )}
      <div className="nx-fg">
        <Field label={t("nd.name")}>{(p) => <input {...p} className="nx-inp" aria-label={t("a11y.name")} required value={form.name} onChange={set("name")} placeholder="node-2" />}</Field>
        <Field label={t("nd.host")}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.ip_address_or_hostname")} required value={form.hostname} onChange={set("hostname")} placeholder="192.168.1.20" />}</Field>
        <Field label={t("nd.sshUser")}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.ssh_user")} value={form.ssh_user} onChange={set("ssh_user")} />}</Field>
        <Field label={t("nd.sshPort")}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.ssh_port")} type="number" min={1} max={65535} value={form.ssh_port} onChange={set("ssh_port")} />}</Field>
      </div>
      {test && (
        <div className="nx-bn" data-tone={test.ok ? "success" : "danger"} role="status">
          <span className="nx-bn-t">{test.ok ? t("nd.testOk", { host: test.detail }) : t("nd.testKo", { error: test.detail })}</span>
        </div>
      )}
    </SideDrawer>
  );
}

// Nodes: this host plus the registered remote nodes (libvirt over SSH, no agent), with their live load
// recorded by the backend collector.
export default function NodesPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const caps = capabilities(useAuthStore((s) => s.role));
  const { nodes, vms, pushToast, navigateTo } = useInfraStore(useShallow((s) => ({ nodes: s.nodes, vms: s.vms, pushToast: s.pushToast, navigateTo: s.navigateTo })));
  const [adding, setAdding] = useState(false);
  useIntent("node", () => caps.admin && setAdding(true));

  async function remove(n) {
    if (!(await confirmAction({ title: t("nd.removeTitle", { name: n.nom }), message: t("nd.removeMsg"), confirmLabel: t("nd.remove"), danger: true }))) return;
    try { await deleteRemoteNode(n.nom); pushToast({ kind: "success", title: t("nd.removed"), message: n.nom }); await refreshInventory(); }
    catch (err) { pushToast({ kind: "error", title: t("action.failed", { action: t("nd.remove") }), message: errorMessage(err) }); }
  }

  return (
    <>
      <PageHeader title={t("tab.nodes")} count={nodes.length} help={t("nd.intro")}
        actions={caps.admin && <button type="button" className="nx-btn nx-btn--primary" onClick={() => setAdding(true)}><Plus size={15} aria-hidden="true" />{t("nd.add")}</button>} />
      <div className="nx-card2 nx-card2--flush">
        <div className="nx-tablewrap">
          <table className="nx-table">
            <thead><tr>
              <th scope="col">{t("ns.col.state")}</th><th scope="col">{t("nd.node")}</th><th scope="col">{t("nd.connection")}</th>
              <th scope="col">{t("ns.cpu")}</th><th scope="col">{t("ns.memory")}</th><th scope="col">{t("ns.storage")}</th>
              <th scope="col" className="nx-num">{t("nd.vms")}</th><th scope="col">{t("nd.version")}</th><th scope="col">{t("ns.uptime")}</th>
              <th scope="col"><span className="nx-sr">{t("actions")}</span></th>
            </tr></thead>
            <tbody>
              {nodes.map((n) => {
                const local = n.id === "local";
                const nodeVms = vms.filter((v) => v.node === n.id);
                const run = nodeVms.length ? nodeVms.filter((v) => v.etat === "actif").length : n.vms_actives ?? 0;
                const total = nodeVms.length || (n.vms_actives ?? 0) + (n.vms_arretees ?? 0);
                const lib = formatVersionInt(n.version_libvirt);
                return (
                  <tr key={n.id}>
                    <td><StatusIndicator kind="node" wire={n.etat} /></td>
                    <th scope="row" className="nx-nm">
                      <button type="button" className="nx-lnk" onClick={() => navigateTo("node", n.id, "summary")}>{n.nom}</button>
                      <small>{[n.cpu_coeurs && t("nd.cores", { n: n.cpu_coeurs }), n.memoire_totale_mo && formatSizeMb(n.memoire_totale_mo, lang)].filter(Boolean).join(" · ") || (local ? t("nd.thisHost") : "")}</small>
                    </th>
                    <td>
                      <Chip tone={local ? "accent" : undefined}>{local ? t("node.roleLocal") : t("node.roleMember")}</Chip>{" "}
                      <span className="nx-mono nx-muted">{local ? t("nd.localConn") : `${n.ssh_user || "root"}@${n.ip}:${n.ssh_port || 22}`}</span>
                    </td>
                    <td><Meter value={n.cpu_utilisation} label={`${t("ns.cpu")} ${n.nom}`} /></td>
                    <td><Meter value={pct(n.memoire_utilisee_mo, n.memoire_totale_mo)} label={`${t("ns.memory")} ${n.nom}`} /></td>
                    <td><Meter value={pct(n.stockage_utilise_go, n.stockage_total_go)} label={`${t("ns.storage")} ${n.nom}`} /></td>
                    <td className="nx-num nx-mono">{run} / {total}</td>
                    <td className="nx-mono">{lib ? `libvirt ${lib}` : <span className="nx-muted">—</span>}</td>
                    <td className="nx-mono nx-muted">{formatUptimeLong(n.uptime_s, lang) || "—"}</td>
                    <td><div className="nx-ra">
                      {caps.admin && !local && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" aria-label={t("a11y.remove_node_x", { v: n.nom })} title={t("nd.remove")} onClick={() => remove(n)}><Trash2 size={15} aria-hidden="true" /></button>}
                      <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" aria-label={t("nd.open", { name: n.nom })} onClick={() => navigateTo("node", n.id, "summary")}><ChevronRight size={15} aria-hidden="true" /></button>
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <AddNodeDrawer open={adding} onClose={() => setAdding(false)} onAdded={() => refreshInventory()} />
    </>
  );
}
NodesPage.ownHeader = true;
