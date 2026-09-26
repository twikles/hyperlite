import { useCallback, useEffect, useState } from "react";
import { fetchTemplates, deployTemplate, deleteTemplate } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { confirmAction } from "../../store/useConfirmStore";
import { promptText } from "../../store/usePromptStore";
import { useT, useLangStore } from "../i18n";
import { capabilities } from "../lib/capabilities";
import { errorMessage } from "../lib/errors";
import { formatSizeMb } from "../lib/format";
import { ErrorState } from "../components/States";
import { Empty } from "../components/ui";
import { LayoutTemplate, Trash2 } from "lucide-react";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}$/;

// Templates: VMs converted to read-only sources. Converting a stopped VM is done from its own page
// (Actions ▸ Convert to template); here a copy is deployed under a validated name, or the template deleted.
export default function TemplatesPanel() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const caps = capabilities(useAuthStore((s) => s.role));
  const pushToast = useInfraStore((s) => s.pushToast);
  const refreshAll = useInfraStore((s) => s.refreshAll);
  const vms = useInfraStore((s) => s.vms);
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const reload = useCallback(async () => {
    try { const r = await fetchTemplates(); setItems(Array.isArray(r) ? r : []); setError(null); }
    catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function deploy(tpl) {
    const taken = new Set(vms.map((v) => v.nom));
    const name = await promptText({
      title: t("tp.deployTitle", { name: tpl.nom }), label: t("tp.newName"), defaultValue: `${tpl.nom}-01`, confirmLabel: t("tp.deploy"),
      validate: (v) => (!NAME_RE.test(v) ? t("ct.nameRule") : taken.has(v) ? t("tp.nameTaken") : ""),
    });
    if (!name || !name.trim()) return;
    setBusy(tpl.nom);
    try { await deployTemplate(tpl.nom, name.trim()); pushToast({ kind: "success", title: t("tp.deployed"), message: name.trim() }); await refreshAll(); }
    catch (e) { pushToast({ kind: "error", title: t("tp.deployFailed"), message: errorMessage(e) }); }
    finally { setBusy(null); }
  }
  async function remove(tpl) {
    if (!(await confirmAction({ title: t("tp.deleteTitle", { name: tpl.nom }), message: t("tp.deleteMsg"), confirmLabel: t("menu.delete").replace("…", ""), danger: true }))) return;
    setBusy(tpl.nom);
    try { await deleteTemplate(tpl.nom); pushToast({ kind: "success", title: t("tp.deleted"), message: tpl.nom }); await reload(); }
    catch (e) { pushToast({ kind: "error", title: t("tp.deleteFailed"), message: errorMessage(e) }); }
    finally { setBusy(null); }
  }

  if (error && items == null) return <ErrorState message={error} onRetry={reload} />;
  const list = items || [];
  return (
    <div className="nx-card2 nx-card2--flush">
      {items == null ? <p className="nx-muted" role="status" style={{ padding: "var(--space-4)" }}>{t("loading")}</p> : list.length === 0 ? <Empty icon={LayoutTemplate} title={t("tp.none")} text={t("tp.noneHelp")} /> : (
        <div className="nx-tablewrap">
          <table className="nx-table">
            <thead><tr><th scope="col">{t("ct.name")}</th><th scope="col">{t("tp.source")}</th><th scope="col" className="nx-num">vCPU</th><th scope="col" className="nx-num">{t("ct.memory")}</th><th scope="col">{t("tp.created")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
            <tbody>
              {list.map((tpl) => (
                <tr key={tpl.nom}>
                  <th scope="row" className="nx-mono">{tpl.nom}</th>
                  <td className="nx-mono">{tpl.vm_source}</td>
                  <td className="nx-num nx-mono">{tpl.vcpu}</td>
                  <td className="nx-num nx-mono">{formatSizeMb(tpl.memoire_mo, lang)}</td>
                  <td>{tpl.cree_par} · <span className="nx-mono">{tpl.cree_le}</span></td>
                  <td><div className="nx-ra">
                    {caps.admin && <button type="button" className="nx-btn nx-btn--sm" disabled={busy === tpl.nom} aria-label={`Deploy template ${tpl.nom}`} onClick={() => deploy(tpl)}>{t("tp.deploy")}</button>}
                    {caps.admin && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" disabled={busy === tpl.nom} aria-label={`Delete template ${tpl.nom}`} title={t("menu.delete").replace("…", "")} onClick={() => remove(tpl)}><Trash2 size={15} aria-hidden="true" /></button>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
