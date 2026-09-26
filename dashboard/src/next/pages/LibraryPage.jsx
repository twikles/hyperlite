import { useCallback, useEffect, useRef, useState } from "react";
import { Disc3, Trash2, Upload } from "lucide-react";
import { fetchIsoTemplates, deleteIso, fetchTemplates } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { confirmAction } from "../../store/useConfirmStore";
import { useT, useLangStore } from "../i18n";
import { capabilities } from "../lib/capabilities";
import { formatSizeMb, formatDateTime } from "../lib/format";
import { errorMessage } from "../lib/errors";
import { PageHeader, Empty } from "../components/ui";
import IsoUploadDropzone from "../../components/IsoUploadDropzone";
import TemplatesPanel from "./TemplatesPage";

// Library: the ISO images (moved from Storage) and the templates, in two tabs. The historical ?tab=templates
// link opens the Templates tab.
export default function LibraryPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const caps = capabilities(useAuthStore((s) => s.role));
  const pushToast = useInfraStore((s) => s.pushToast);
  const activeTab = useInfraStore((s) => s.activeTab);
  const [tab, setTab] = useState(activeTab === "templates" ? "tpl" : "iso");
  const [isos, setIsos] = useState(null);
  const [tplCount, setTplCount] = useState(null);
  const drop = useRef(null);

  const loadIsos = useCallback(async () => {
    try { const r = await fetchIsoTemplates(); setIsos(Array.isArray(r) ? r : []); }
    catch (e) { pushToast({ kind: "error", title: t("stor.isoError"), message: errorMessage(e) }); setIsos([]); }
  }, [pushToast, t]);
  useEffect(() => { loadIsos(); }, [loadIsos]);
  useEffect(() => { fetchTemplates().then((r) => setTplCount(Array.isArray(r) ? r.length : 0)).catch(() => setTplCount(null)); }, [tab]);

  async function removeIso(nom) {
    if (!(await confirmAction({ title: t("lib.isoDeleteTitle", { name: nom }), message: t("stor.isoConfirm"), confirmLabel: t("vx.delete"), danger: true }))) return;
    try { await deleteIso(nom); pushToast({ kind: "success", title: t("stor.isoDeleted"), message: nom }); loadIsos(); }
    catch (err) { pushToast({ kind: "error", title: t("stor.deleteFailed"), message: errorMessage(err) }); }
  }
  const tabs = [["iso", t("lib.iso"), isos?.length], ["tpl", t("lib.templates"), tplCount]];
  const upload = () => drop.current?.querySelector("input[type=file]")?.click();

  return (
    <>
      <PageHeader title={t("tab.library")}
        actions={tab === "iso" && caps.admin && <button type="button" className="nx-btn nx-btn--primary" onClick={upload}><Upload size={15} aria-hidden="true" />{t("lib.upload")}</button>} />
      <div className="nx-tabs nx-tabs--page" role="tablist" aria-label={t("tab.library")}>
        {tabs.map(([id, label, n]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} id={`lib-${id}`} aria-controls="lib-panel" onClick={() => setTab(id)}>{label}{n != null && <span className="nx-n">{n}</span>}</button>
        ))}
      </div>
      <div id="lib-panel" role="tabpanel" aria-labelledby={`lib-${tab}`} className="nx-stack">
        {tab === "iso" ? (
          <>
            {caps.admin && <div ref={drop}><IsoUploadDropzone onDone={loadIsos} labels={{ drop: t("up.dropIso"), done: t("up.done"), eta: t("up.eta") }} /></div>}
            <div className="nx-card2 nx-card2--flush">
              {isos == null ? <p className="nx-muted" role="status" style={{ padding: "var(--space-4)" }}>{t("loading")}</p> : isos.length === 0 ? <Empty icon={Disc3} title={t("stor.noIso")} text={t("lib.isoNoneHelp")} /> : (
                <div className="nx-tablewrap">
                  <table className="nx-table">
                    <thead><tr><th scope="col">{t("lib.image")}</th><th scope="col" className="nx-num">{t("lib.size")}</th><th scope="col">{t("lib.location")}</th><th scope="col">{t("lib.added")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
                    <tbody>
                      {isos.map((iso) => (
                        <tr key={iso.nom}>
                          <th scope="row" className="nx-mono" style={{ fontWeight: 500 }}>{iso.nom}</th>
                          <td className="nx-num nx-mono">{formatSizeMb(iso.taille_mo, lang)}</td>
                          <td className="nx-mono nx-muted">{iso.emplacement || "—"}</td>
                          <td className="nx-mono nx-muted">{iso.ajoutee_le ? formatDateTime(iso.ajoutee_le, lang) : "—"}</td>
                          <td><div className="nx-ra">{caps.admin && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" aria-label={`Delete ISO ${iso.nom}`} title={t("vx.delete")} onClick={() => removeIso(iso.nom)}><Trash2 size={15} aria-hidden="true" /></button>}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : <TemplatesPanel />}
      </div>
    </>
  );
}
LibraryPage.ownHeader = true;
