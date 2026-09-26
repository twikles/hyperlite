import { useCallback, useEffect, useState } from "react";
import { fetchAllBackups, deleteBackup, fetchBackupSchedules } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { confirmAction } from "../../store/useConfirmStore";
import { useT, useLangStore } from "../i18n";
import { usePolling } from "../lib/polling";
import { capabilities } from "../lib/capabilities";
import { errorMessage } from "../lib/errors";
import { formatSizeMb } from "../lib/format";
import StatusIndicator from "../components/StatusIndicator";
import { ErrorState } from "../components/States";
import { PageHeader, Empty } from "../components/ui";
import { Archive, Info, Trash2 } from "lucide-react";

const STATUS = { termine: "termine", echec: "echec" };

// Backups of every VM in one table. Failed backups can be removed here; restores stay in each VM's
// Backup tab (they need a target choice), reachable from the VM name.
export default function BackupsPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const navigateTo = useInfraStore((s) => s.navigateTo);
  const pushToast = useInfraStore((s) => s.pushToast);
  const caps = capabilities(useAuthStore((s) => s.role));
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [at, setAt] = useState(null);
  const [scheduled, setScheduled] = useState(null);
  const vms = useInfraStore((s) => s.vms);

  const load = useCallback(async () => {
    try { const r = await fetchAllBackups(); setRows(Array.isArray(r) ? r : []); setError(null); setAt(Date.now()); }
    catch (e) { setError(errorMessage(e)); }
    fetchBackupSchedules().then((r) => setScheduled(new Set((Array.isArray(r) ? r : []).map((x) => x.vm_name)))).catch(() => setScheduled(null));
  }, []);
  useEffect(() => { load(); }, [load]);
  const running = Boolean(rows?.some((b) => !STATUS[b.statut]));
  usePolling(load, running ? 4000 : 15000);
  const unprotected = scheduled ? vms.filter((v) => !scheduled.has(v.nom)).length : 0;

  async function remove(b) {
    if (!(await confirmAction({ title: t("vb.deleteTitle", { id: b.id }), message: t("bk.deleteHelp"), confirmLabel: t("vx.delete"), danger: true }))) return;
    try { await deleteBackup(b.id); pushToast({ kind: "success", title: t("bk.deleted"), message: `#${b.id}` }); load(); }
    catch (e) { pushToast({ kind: "error", title: t("stor.deleteFailed"), message: errorMessage(e) }); }
  }
  const fmt = (ts) => new Intl.DateTimeFormat(lang, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ts));

  return (
    <>
      <PageHeader title={t("tab.backups")} count={rows ? rows.length : null} desc={t("bk.desc")} fresh freshAt={at} />
      {unprotected > 0 && (
        <div className="nx-bn" data-tone="info" role="status"><Info size={16} aria-hidden="true" /><span className="nx-bn-t">{t("bk.unscheduled", { n: unprotected })}</span>
          <button type="button" className="nx-btn nx-btn--sm" onClick={() => navigateTo("datacenter", null, "vms")}>{t("bk.seeVms")}</button></div>
      )}
      <div className="nx-card2 nx-card2--flush">
        {error ? <ErrorState message={error} onRetry={load} />
          : rows == null ? <p className="nx-muted" style={{ padding: "var(--space-4)" }}>{t("loading")}</p>
          : rows.length === 0 ? <Empty icon={Archive} title={t("bk.none")} text={t("bk.noneHelp")} /> : (
            <div className="nx-tablewrap">
              <table className="nx-table">
                <thead><tr><th scope="col">{t("ns.col.state")}</th><th scope="col">{t("jr.time")}</th><th scope="col">VM</th><th scope="col">{t("bk.mode")}</th><th scope="col" className="nx-num">{t("bk.size")}</th><th scope="col">{t("bk.location")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.id}>
                      <td><StatusIndicator kind="task" wire={b.statut === "termine" ? "termine" : b.statut === "echec" ? "echec" : "en_cours"} /></td>
                      <td className="nx-mono">{fmt(b.cree_le)}</td>
                      <th scope="row"><button type="button" className="nx-lnk" onClick={() => navigateTo("vm", b.vm_name, "backup")}>{b.vm_name}</button></th>
                      <td>{b.mode === "chaud" ? t("bk.hot") : t("bk.cold")}</td>
                      <td className="nx-num nx-mono">{b.taille_octets ? formatSizeMb(b.taille_octets / 1048576, lang) : "—"}</td>
                      <td className="nx-mono nx-wrapcell">{b.erreur ? <span className="nx-tone-danger">{b.erreur}</span> : b.chemin}</td>
                      <td><div className="nx-ra">{caps.admin && b.statut === "echec" && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" aria-label={`Delete backup #${b.id}`} title={t("vx.delete")} onClick={() => remove(b)}><Trash2 size={15} aria-hidden="true" /></button>}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </>
  );
}
BackupsPage.ownHeader = true;
