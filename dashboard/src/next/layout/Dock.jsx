import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, X } from "lucide-react";
import { fetchAuditLog } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { useT, useLangStore } from "../i18n";
import StatusIndicator from "../components/StatusIndicator";
import { taskLabel } from "../lib/enums";
import { formatDuration, relativeTime } from "../lib/format";
import { deriveAlerts } from "../lib/alerts";
import { capabilities } from "../lib/capabilities";

const ALERT_STATE = { "node-offline": "state.offline", "vm-crashed": "state.crashed", "vm-blocked": "state.blocked", "pool-state": "state.degraded", "pool-full": "state.degraded", "pool-high": "state.degraded", "task-failed": "state.failed" };
const nowMs = () => Date.now();

// Activity panel, opened from the single Activity button of the top bar: open alerts (each with a "View"
// button), the operations running now and the latest audit entries, with links to the full Tasks and
// Audit log pages. Closed by default so pages keep their whole width.
export default function Dock() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const { tasks, collapsed, toggle, nodes, vms, storagePools, navigateTo } = useInfraStore(useShallow((s) => ({
    tasks: s.tasks, collapsed: s.taskLogCollapsed, toggle: s.toggleTaskLog, nodes: s.nodes, vms: s.vms, storagePools: s.storagePools, navigateTo: s.navigateTo,
  })));
  const admin = capabilities(useAuthStore((s) => s.role)).admin;
  const [tab, setTab] = useState("alerts");
  const [openId, setOpenId] = useState(null);
  const [journal, setJournal] = useState(null);
  const open = !collapsed;

  useEffect(() => {
    const on = (e) => { if (e.detail) setTab(e.detail === "logs" ? "journal" : e.detail); if (useInfraStore.getState().taskLogCollapsed) useInfraStore.getState().toggleTaskLog(); };
    window.addEventListener("nx:dock", on);
    return () => window.removeEventListener("nx:dock", on);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") useInfraStore.getState().toggleTaskLog(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => {
    if (!open || tab !== "journal" || !admin) return;
    fetchAuditLog({ limit: 15 }).then((r) => setJournal(Array.isArray(r) ? r : [])).catch(() => setJournal([]));
  }, [open, tab, admin]);

  const running = tasks.filter((x) => x.statut === "en_cours");
  const alerts = deriveAlerts({ nodes, vms, storagePools, tasks });
  const tabs = [["alerts", t("dock.alerts"), alerts.length || null, "warn"], ["tasks", t("dock.running.tab"), running.length || null], ["journal", t("dock.journal"), null]];
  const go = (dcTab) => { navigateTo("datacenter", null, dcTab); toggle(); };

  return (
    <aside className="nx-drawer" data-open={open} aria-label={t("dock.title")} inert={!open}>
      <header className="nx-drawer-head">
        <h2>{t("dock.title")}</h2>
        <button type="button" className="nx-btn nx-btn--ghost nx-btn--icon" style={{ marginLeft: "auto" }} aria-label={t("dock.close")} onClick={toggle}><X size={16} aria-hidden="true" /></button>
      </header>
      <div className="nx-drawer-tabs" role="tablist" aria-label={t("dock.title")}>
        {tabs.map(([id, label, n, tone]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}{n ? <span className={`nx-badge-count${tone ? " is-warn" : ""}`} style={{ marginLeft: 6 }}>{n}</span> : null}
          </button>
        ))}
      </div>
      <div className="nx-drawer-body" role="tabpanel" aria-label={tabs.find((x) => x[0] === tab)[1]} tabIndex={0}>
        {tab === "alerts" && (alerts.length === 0 ? <div className="nx-drawer-empty" role="status"><StatusIndicator override={{ key: "health.ok", shape: "dot", tone: "success" }} /><span className="nx-muted">{t("dock.alertsNone")}</span></div> : alerts.map((a) => (
          <div key={a.id} className="nx-trow">
            <div className="nx-trow-main" style={{ cursor: "default" }}>
              <StatusIndicator override={{ key: ALERT_STATE[a.kind] || "state.unknown", shape: a.level === "danger" ? "diamond" : a.level === "warning" ? "triangle" : "ring", tone: a.level }} compact />
              <span className="nx-trow-text"><span className="nx-mono">{a.text}</span><span className="nx-muted">{t(`alert.kind.${a.kind}`)}{a.detail ? ` · ${a.detail}` : ""}</span></span>
              {a.target && <button type="button" className="nx-btn nx-btn--sm" onClick={() => { navigateTo(a.target.type, a.target.id, a.target.tab); toggle(); }}>{t("dock.view")}</button>}
            </div>
          </div>
        )))}
        {tab === "tasks" && (running.length === 0 ? (
          <div className="nx-drawer-empty"><strong>{t("dock.noneRunning")}</strong><span className="nx-muted">{t("dock.emptyHelp")}</span></div>
        ) : running.map((x) => (
          <div key={x.id} className="nx-trow">
            <button type="button" className="nx-trow-main" aria-expanded={openId === x.id} onClick={() => setOpenId(openId === x.id ? null : x.id)}>
              <StatusIndicator kind="task" wire={x.statut} compact />
              <span className="nx-trow-text"><span>{taskLabel(x.type)}</span><span className="nx-mono nx-muted">{x.cible}</span></span>
              <span className="nx-mono nx-muted">{formatDuration(x.debut, x.fin)}</span>
            </button>
            <span className="nx-progress" role="progressbar" aria-valuenow={x.progres || 0} aria-valuemin={0} aria-valuemax={100} aria-label={taskLabel(x.type)}><span style={{ width: `${x.progres || 0}%` }} /></span>
            {openId === x.id && <div className="nx-muted nx-trow-detail">{t("task.node")}: {x.node} · {t("task.user")}: {x.utilisateur}</div>}
          </div>
        )))}
        {tab === "journal" && (!admin ? <div className="nx-drawer-empty"><span className="nx-muted">{t("dock.logsHint")}</span></div>
          : journal == null ? <p className="nx-muted" style={{ padding: "var(--space-4)" }}>{t("loading")}</p>
          : journal.length === 0 ? <div className="nx-drawer-empty"><span className="nx-muted">{t("dock.journalNone")}</span></div>
          : journal.map((e) => (
            <div key={e.id} className="nx-trow">
              <div className="nx-trow-main" style={{ cursor: "default" }}>
                <StatusIndicator kind="task" wire={e.result === "succes" ? "termine" : "echec"} compact />
                <span className="nx-trow-text"><span className="nx-mono">{e.action}</span><span className="nx-muted">{e.username}{e.resource ? ` · ${e.resource}` : ""}</span></span>
                <span className="nx-mono nx-muted">{relativeTime(Date.parse(e.timestamp), lang, nowMs())}</span>
              </div>
            </div>
          )))}
      </div>
      <footer className="nx-drawer-foot">
        <button type="button" className="nx-btn nx-btn--ghost" onClick={() => go("activity")}>{t("dock.allTasks")}<ChevronRight size={14} aria-hidden="true" /></button>
        {admin && <button type="button" className="nx-btn nx-btn--ghost" onClick={() => go("journal")}>{t("nav.auditLog")}<ChevronRight size={14} aria-hidden="true" /></button>}
      </footer>
    </aside>
  );
}
