import { useCallback, useEffect, useState } from "react";
import { fetchHaProtected, disableHa, recoverHa } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { confirmAction } from "../../store/useConfirmStore";
import { useT, useLangStore } from "../i18n";
import { capabilities } from "../lib/capabilities";
import { errorMessage } from "../lib/errors";
import StatusIndicator from "../components/StatusIndicator";
import { ErrorState } from "../components/States";
import { PageHeader, Empty } from "../components/ui";
import { Heart, Info, Monitor } from "lucide-react";

// High availability: protected VMs with the real status of their node. Recovery is always a manual,
// confirmed action (no fencing: recovering while the original node still runs could corrupt the disk).
export default function HaPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const caps = capabilities(useAuthStore((s) => s.role));
  const nodes = useInfraStore((s) => s.nodes);
  const pools = useInfraStore((s) => s.storagePools);
  const navigateTo = useInfraStore((s) => s.navigateTo);
  const [at, setAt] = useState(null);
  const pushToast = useInfraStore((s) => s.pushToast);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [target, setTarget] = useState({});
  const [busy, setBusy] = useState(null);

  const reload = useCallback(async () => {
    try { const r = await fetchHaProtected(); setRows(Array.isArray(r) ? r : []); setError(null); setAt(Date.now()); }
    catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { reload(); const id = setInterval(reload, 15000); return () => clearInterval(id); }, [reload]);

  async function disable(vm) {
    if (!(await confirmAction({ title: t("ha.disableTitle", { name: vm }), message: t("ha.disableMsg"), confirmLabel: t("ha.disable") }))) return;
    try { await disableHa(vm); pushToast({ kind: "success", title: t("ha.disabled"), message: vm }); reload(); }
    catch (e) { pushToast({ kind: "error", title: t("action.failed", { action: t("ha.disable") }), message: errorMessage(e) }); }
  }
  async function recover(vm) {
    const to = target[vm];
    if (!to) return;
    const toName = nodes.find((n) => n.id === to)?.nom || to;
    if (!(await confirmAction({ title: t("ha.recoverTitle", { vm, node: toName }), message: t("ha.recoverMsg"), confirmLabel: t("ha.recover"), danger: true }))) return;
    setBusy(vm);
    try { await recoverHa(vm, to); pushToast({ kind: "success", title: t("ha.recovered"), message: `${vm} → ${toName}` }); reload(); }
    catch (e) { pushToast({ kind: "error", title: t("ha.recoverFailed"), message: errorMessage(e) }); }
    finally { setBusy(null); }
  }
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString(lang, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null);

  const online = nodes.filter((n) => n.etat === "online").length;
  const shared = pools.filter((p) => p.type === "netfs").length;
  const list = rows || [];

  return (
    <>
      <PageHeader title={t("tab.ha")} count={rows ? list.length : null} desc={t("ha.desc")} fresh freshAt={at} />
      <div className="nx-bn" data-tone={online >= 2 && shared > 0 ? "success" : "info"} role="status"><Info size={16} aria-hidden="true" />
        <span className="nx-bn-t">{t("ha.prereq", { nodes: online, pools: shared })}</span></div>
      {error && rows == null ? <ErrorState message={error} onRetry={reload} /> : (
        <div className="nx-card2 nx-card2--flush">
          {rows == null ? <p className="nx-muted" role="status" style={{ padding: "var(--space-4)" }}>{t("loading")}</p> : list.length === 0 ? (
            <Empty icon={Heart} title={t("ha.none")} text={t("ha.noneHelp")} action={<button type="button" className="nx-btn" onClick={() => navigateTo("datacenter", null, "vms")}><Monitor size={15} aria-hidden="true" />{t("ha.chooseVm")}</button>} />
          ) : (
            <div className="nx-tablewrap">
              <table className="nx-table">
                <thead><tr><th scope="col">{t("ns.col.state")}</th><th scope="col">VM</th><th scope="col">{t("ha.node")}</th><th scope="col">{t("ha.sync")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
                <tbody>
                  {list.map((r) => {
                    const down = r.statut_noeud === "hors_ligne";
                    const targets = nodes.filter((n) => n.id !== r.node && n.etat === "online");
                    return (
                      <tr key={r.vm_name}>
                        <td><StatusIndicator kind="node" wire={down ? "erreur" : "online"} /></td>
                        <th scope="row"><button type="button" className="nx-lnk nx-mono" onClick={() => navigateTo("vm", r.vm_name, "summary")}>{r.vm_name}</button></th>
                        <td className="nx-mono">{nodes.find((n) => n.id === r.node)?.nom || r.node}</td>
                        <td className="nx-mono">{fmt(r.last_synced_at) || <span className="nx-muted">{t("ha.never")}</span>}</td>
                        <td><div className="nx-ra">
                          {caps.admin && down && (
                            <>
                              <select className="nx-sel" aria-label={`${t("ha.recoveryNode")} ${r.vm_name}`} value={target[r.vm_name] || ""} onChange={(e) => setTarget({ ...target, [r.vm_name]: e.target.value })}>
                                <option value="">{t("ha.recoverOn")}</option>
                                {targets.map((n) => <option key={n.id} value={n.id}>{n.nom}</option>)}
                              </select>
                              <button type="button" className="nx-btn nx-btn--danger nx-btn--sm" disabled={!target[r.vm_name] || busy === r.vm_name} aria-label={`Recover ${r.vm_name}`} onClick={() => recover(r.vm_name)}>{busy === r.vm_name ? "…" : t("ha.recover")}</button>
                            </>
                          )}
                          {caps.admin && <button type="button" className="nx-btn nx-btn--sm" aria-label={`Disable HA for ${r.vm_name}`} onClick={() => disable(r.vm_name)}>{t("ha.disable")}</button>}
                        </div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}
HaPage.ownHeader = true;
