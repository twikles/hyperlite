import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { fetchTasks, fetchTaskDetail } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useT, useLangStore } from "../i18n";
import { usePolling } from "../lib/polling";
import { taskLabel, TASK_LABEL_KEYS } from "../lib/enums";
import { normalizeDetail } from "../lib/errors";
import StatusIndicator from "../components/StatusIndicator";
import { ErrorState } from "../components/States";
import { PageHeader, Empty } from "../components/ui";
import { Download, ListChecks, Search } from "lucide-react";

const SINCE = { all: null, "1h": 3600, "24h": 86400, "7d": 604800 };
const STUCK_S = 900; // a task "running" for more than 15 minutes is flagged (no cleanup after a crash)

function duration(start, end, now) {
  if (!start) return "—";
  const s = Math.max(0, Math.round(((end ? new Date(end).getTime() : now) - new Date(start).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function csv(rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return ["id,type,target,node,user,status,started,ended,error", ...rows.map((r) => [r.id, r.type, r.cible, r.node, r.username, r.statut, r.debut_le || r.cree_le, r.fin_le, r.erreur].map(esc).join(","))].join("\n");
}

// Activity: every persisted task with the filters the API already supports (status, type, target,
// user, period), live refresh, error detail and a CSV export.
// On a node page (`selection.type === "node"`) the same view is scoped to that node.
export default function ActivityPage({ selection }) {
  const nodeId = selection?.type === "node" ? selection.id : undefined;
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const navigateTo = useInfraStore((s) => s.navigateTo);
  const vms = useInfraStore((s) => s.vms);
  const nodes = useInfraStore((s) => s.nodes);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const EMPTY_F = { statut: "", type: "", cible: "", username: "", node: "", since: "24h" };
  const [f, setF] = useState(EMPTY_F);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState({});

  const load = useCallback(async () => {
    try {
      const depuis = SINCE[f.since] ? new Date(Date.now() - SINCE[f.since] * 1000).toISOString() : undefined;
      const r = await fetchTasks({ node: nodeId ?? (f.node || undefined), statut: f.statut, type: f.type, cible: f.cible, username: f.username, depuis, limit: 200, tri: "cree_le", ordre: "desc" });
      setRows(Array.isArray(r) ? r : []); setNow(Date.now()); setError(null);
    } catch (e) { setError(normalizeDetail(e.message)); }
  }, [f, nodeId]);
  usePolling(load, 8000);
  useEffect(() => { load(); }, [load]);

  const users = useMemo(() => [...new Set((rows || []).map((r) => r.username).filter(Boolean))], [rows]);
  const upd = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const fmt = (iso) => (iso ? new Intl.DateTimeFormat(lang, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso)) : "—");
  const toggle = async (r) => {
    setOpen(open === r.id ? null : r.id);
    if (!detail[r.id]) {
      let d;
      try { d = await fetchTaskDetail(r.id); } catch { d = { error: true }; }
      setDetail((x) => ({ ...x, [r.id]: d }));
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([csv(rows || [])], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = "hyperlite-tasks.csv"; a.click(); URL.revokeObjectURL(url);
  };

  const dirty = JSON.stringify(f) !== JSON.stringify(EMPTY_F);
  const nodeName = (id) => nodes.find((n) => n.id === id || n.nom === id)?.nom || id;
  const table = error ? <ErrorState message={error} onRetry={load} />
    : rows == null ? <p className="nx-muted" style={{ padding: "var(--space-4)" }}>{t("loading")}</p>
    : rows.length === 0 ? <Empty icon={ListChecks} title={t("act.none")} text={dirty ? t("act.noneFiltered") : t("act.noneHelp")} /> : (
      <div className="nx-tablewrap">
        <table className="nx-table">
          <thead><tr><th scope="col">{t("task.status")}</th><th scope="col">{t("act.started")}</th><th scope="col">{t("act.task")}</th><th scope="col">{t("act.object")}</th><th scope="col">{t("task.user")}</th><th scope="col" className="nx-num">{t("act.duration")}</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const stuck = r.statut === "en_cours" && (now - new Date(r.debut_le || r.cree_le).getTime()) / 1000 > STUCK_S;
              const isVm = vms.some((v) => v.nom === r.cible);
              return (
                <Fragment key={r.id}>
                  <tr className="nx-rowlink" onClick={() => toggle(r)}>
                    <td><StatusIndicator kind="task" wire={r.statut} /></td>
                    <td className="nx-mono">{fmt(r.debut_le || r.cree_le)}</td>
                    <th scope="row" style={{ fontWeight: 400 }}><button type="button" className="nx-lnk" style={{ fontWeight: 400 }} aria-expanded={open === r.id} onClick={(e) => { e.stopPropagation(); toggle(r); }}>{taskLabel(r.type)}</button>{stuck && <span className="nx-tone-warning" title={t("act.stuckHelp")}> ▲ {t("act.stuck")}</span>}</th>
                    <td>{isVm ? <button type="button" className="nx-lnk nx-mono" onClick={(e) => { e.stopPropagation(); navigateTo("vm", r.cible, "summary"); }}>{r.cible}</button> : <span className="nx-mono">{r.cible || "—"}</span>}</td>
                    <td>{r.username || "—"}</td>
                    <td className="nx-num nx-mono">{duration(r.debut_le, r.fin_le, now)}</td>
                  </tr>
                  {open === r.id && (
                    <tr><td colSpan={6} className="nx-detailcell">
                      <p className="nx-muted" style={{ margin: "0 0 4px" }}>{t("ns.node")} : <span className="nx-mono">{r.node ? nodeName(r.node) : "—"}</span></p>
                      {r.erreur ? <p className="nx-mono" style={{ margin: 0, overflowWrap: "anywhere" }}><StatusIndicator override={{ key: "state.failed", shape: "diamond", tone: "danger" }} compact /> {r.erreur}</p> : <p className="nx-muted" style={{ margin: 0 }}>{t("act.noError")}</p>}
                      {(detail[r.id]?.logs || []).slice(0, 8).map((l, i) => <p key={i} className="nx-mono nx-muted" style={{ margin: "2px 0 0" }}>{l.timestamp} · {l.action} · {l.result}{l.error_message ? ` · ${l.error_message}` : ""}</p>)}
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );

  return (
    <>
      {!nodeId && <PageHeader title={t("tab.activity")} count={rows ? rows.length : null} fresh freshAt={now} />}
      <div className="nx-bar" role="group" aria-label={t("act.filters")}>
        <label className="nx-search2"><Search size={15} aria-hidden="true" /><input type="search" aria-label={t("act.target")} value={f.cible} onChange={upd("cible")} placeholder={t("act.searchPh")} /></label>
        <select className="nx-sel" aria-label={t("task.status")} value={f.statut} onChange={upd("statut")}><option value="">{t("act.allStatus")}</option><option value="en_cours">{t("state.inprogress")}</option><option value="termine">{t("state.done")}</option><option value="echec">{t("state.failed")}</option></select>
        <select className="nx-sel" aria-label={t("act.type")} value={f.type} onChange={upd("type")}><option value="">{t("act.allTypes")}</option>{Object.keys(TASK_LABEL_KEYS).map((k) => <option key={k} value={k}>{taskLabel(k)}</option>)}</select>
        {!nodeId && nodes.length > 1 && <select className="nx-sel" aria-label={t("ns.node")} value={f.node} onChange={upd("node")}><option value="">{t("act.allNodes")}</option>{nodes.map((n) => <option key={n.id} value={n.id === "local" ? n.nom : n.id}>{n.nom}</option>)}</select>}
        <select className="nx-sel" aria-label={t("task.user")} value={f.username} onChange={upd("username")}><option value="">{t("act.allUsers")}</option>{users.map((u) => <option key={u} value={u}>{u}</option>)}</select>
        <select className="nx-sel" aria-label={t("act.period")} value={f.since} onChange={upd("since")}>{Object.keys(SINCE).map((k) => <option key={k} value={k}>{t(`act.since.${k}`)}</option>)}</select>
        {dirty && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => setF(EMPTY_F)}>{t("act.clear")}</button>}
        <span className="nx-sp" />
        <button type="button" className="nx-btn" disabled={!rows?.length} onClick={download}><Download size={15} aria-hidden="true" />{t("act.export")}</button>
      </div>
      <div className="nx-card2 nx-card2--flush">{table}</div>
    </>
  );
}
ActivityPage.ownHeader = true;
