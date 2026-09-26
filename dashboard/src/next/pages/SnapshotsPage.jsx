import { useEffect, useState } from "react";
import { fetchSnapshots } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useT, useLangStore } from "../i18n";
import { formatDateTime } from "../lib/format";
import { PageHeader, Empty } from "../components/ui";
import { Camera } from "lucide-react";

const MAX_VMS = 60; // one request per VM (the API has no cross-VM listing)

// Snapshots of every local VM in one place; restore/delete stay in each VM's Snapshots tab.
export default function SnapshotsPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const vms = useInfraStore((s) => s.vms);
  const navigateTo = useInfraStore((s) => s.navigateTo);
  const [rows, setRows] = useState(null);
  const local = vms.filter((v) => v.node === "local").slice(0, MAX_VMS);
  const key = local.map((v) => v.nom).join("|");

  useEffect(() => {
    let cancelled = false;
    Promise.all(local.map((v) => fetchSnapshots(v.nom).then((s) => (Array.isArray(s) ? s.map((x) => ({ ...x, vm: v.nom })) : [])).catch(() => [])))
      .then((all) => { if (!cancelled) setRows(all.flat()); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <>
      <PageHeader title={t("tab.snapshots")} count={rows ? rows.length : null} desc={t("snap.desc")} />
      {vms.length > local.length && <p className="nx-muted" style={{ margin: 0 }}>{t("snap.localOnly")}</p>}
      <div className="nx-card2 nx-card2--flush">
        {rows == null ? <p className="nx-muted" style={{ padding: "var(--space-4)" }}>{t("loading")}</p> : rows.length === 0 ? <Empty icon={Camera} title={t("snap.none")} text={t("snap.noneHelp")} /> : (
          <div className="nx-tablewrap">
            <table className="nx-table">
              <thead><tr><th scope="col">VM</th><th scope="col">{t("ns.col.name")}</th><th scope="col">{t("snap.created")}</th><th scope="col">{t("snap.description")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={`${s.vm}:${s.nom}`}>
                    <th scope="row"><button type="button" className="nx-lnk" onClick={() => navigateTo("vm", s.vm, "summary")}>{s.vm}</button></th>
                    <td className="nx-mono">{s.nom}{s.actuel ? ` · ${t("snap.current")}` : ""}</td>
                    <td className="nx-mono">{formatDateTime(s.date_creation, lang) || "—"}</td>
                    <td>{s.description || <span className="nx-muted">—</span>}</td>
                    <td><div className="nx-ra"><button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => navigateTo("vm", s.vm, "snapshots")}>{t("snap.manage")}</button></div></td>
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
SnapshotsPage.ownHeader = true;
