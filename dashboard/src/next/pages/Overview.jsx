import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, Info, TriangleAlert } from "lucide-react";
import { fetchNodeMetricsHistory, fetchStorageHistory, fetchTasks, fetchBackupSchedules } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useT, useLangStore } from "../i18n";
import { usePolling } from "../lib/polling";
import { useFreshness } from "../lib/inventory";
import { deriveAlerts } from "../lib/alerts";
import { taskLabel } from "../lib/enums";
import { formatSizeGb, formatUptimeLong, clockTime, formatDateTime } from "../lib/format";
import StatusIndicator from "../components/StatusIndicator";
import { PageHeader, KpiStrip, Meter, Card, Spark } from "../components/ui";
import { PerformanceView, useHostHistory } from "./VmPerformance";

const asList = (v) => (Array.isArray(v) ? v : []);
const PB = new Set(["plante", "bloque", "inconnu"]);
const pct = (used, total) => (used != null && total ? (used / total) * 100 : null);
const fmtPct = (v, lang) => new Intl.NumberFormat(lang, { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v);

// Datacenter home: what needs attention first (banner, watch list), the headline figures, the nodes with their
// load, the pools and the latest activity. The full charts live only in the Performance tab.
function Summary({ setView }) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const { nodes, vms, storagePools, tasks, navigateTo } = useInfraStore(useShallow((s) => ({ nodes: s.nodes, vms: s.vms, storagePools: s.storagePools, tasks: s.tasks, navigateTo: s.navigateTo })));
  const containers = useFreshness((s) => s.containers);
  const [cpuHist, setCpuHist] = useState([]);
  const [poolHist, setPoolHist] = useState({});
  const [recent, setRecent] = useState(null);
  const [scheduled, setScheduled] = useState(null);

  const load = async () => {
    fetchNodeMetricsHistory("local", "1h").then((r) => setCpuHist(asList(r).map((x) => x.cpu_pct))).catch(() => {});
    fetchStorageHistory("24h").then((r) => setPoolHist(Object.fromEntries(asList(r).map((p) => [`${p.node}:${p.pool}`, p.points.map((x) => pct(x.allocation_b, x.capacity_b))])))).catch(() => {});
    fetchTasks({ limit: 6, tri: "cree_le", ordre: "desc" }).then((r) => setRecent(asList(r))).catch(() => setRecent([]));
    fetchBackupSchedules().then((r) => setScheduled(new Set(asList(r).map((x) => x.vm_name)))).catch(() => setScheduled(null));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  usePolling(load, 30000);

  const alerts = useMemo(() => deriveAlerts({ nodes, vms, storagePools, tasks }), [nodes, vms, storagePools, tasks]);
  const online = nodes.filter((n) => n.etat === "online").length;
  const running = vms.filter((v) => v.etat === "actif").length;
  const problems = vms.filter((v) => PB.has(v.etat));
  const stopped = vms.filter((v) => v.etat === "arrete").length;
  const ctRunning = containers.filter((c) => c.etat === "actif").length;
  // Cluster CPU: the load of each sampled node weighted by its cores.
  const sampled = nodes.filter((n) => n.cpu_utilisation != null && n.cpu_coeurs);
  const cores = nodes.reduce((a, n) => a + (n.cpu_coeurs || 0), 0);
  const clusterCpu = sampled.length ? sampled.reduce((a, n) => a + n.cpu_utilisation * n.cpu_coeurs, 0) / sampled.reduce((a, n) => a + n.cpu_coeurs, 0) : null;
  const totalGb = nodes.reduce((a, n) => a + (n.stockage_total_go || 0), 0);
  const usedGb = nodes.reduce((a, n) => a + (n.stockage_utilise_go || 0), 0);
  const unscheduled = scheduled ? vms.filter((v) => !scheduled.has(v.nom)).length : 0;

  // Watch list: open alerts, nodes short on memory, then VMs without a backup schedule.
  const watch = [
    ...alerts.map((a) => ({ id: a.id, tone: a.level, text: a.text, sub: t(`alert.kind.${a.kind}`), go: a.target && (() => navigateTo(a.target.type, a.target.id, a.target.tab)) })),
    ...nodes.filter((n) => pct(n.memoire_utilisee_mo, n.memoire_totale_mo) >= 80).map((n) => ({ id: `mem-${n.id}`, tone: "warning", text: t("ov.memHigh", { node: n.nom, p: Math.round(pct(n.memoire_utilisee_mo, n.memoire_totale_mo)) }), go: () => navigateTo("node", n.id, "perf") })),
    ...(unscheduled > 0 ? [{ id: "backups", tone: "info", text: t("ov.noSchedule", { n: unscheduled }), action: t("ov.plan"), go: () => navigateTo("datacenter", null, "backups") }] : []),
  ];

  return (
    <>
      {problems.length > 0 && (
        <div className="nx-bn" data-tone="warning" role="status"><TriangleAlert size={16} aria-hidden="true" />
          <span className="nx-bn-t"><b>{t("ov.attention", { n: problems.length })}</b> : {problems.slice(0, 3).map((v) => v.nom).join(", ")}</span>
          <button type="button" className="nx-btn nx-btn--sm" onClick={() => navigateTo("vm", problems[0].nom, "summary")}>{t("dock.view")}</button></div>
      )}
      <KpiStrip label={t("ov.inventory")} items={[
        { id: "nodes", label: t("nav.nodes"), dot: online === nodes.length && nodes.length ? "success" : "warning", value: online, unit: `/ ${nodes.length}`, sub: online === nodes.length ? t("ov.nodesOnlineAll") : t("ov.nodesOnline"), onClick: () => navigateTo("datacenter", null, "nodes") },
        { id: "vms", label: t("nav.vms"), value: running, unit: t("ov.ofRunning", { n: vms.length }), sub: [problems.length && t("ov.toCheck", { n: problems.length }), stopped && t("ov.stoppedN", { n: stopped })].filter(Boolean).join(" · ") || t("ov.allRunning"), subTone: problems.length ? "warning" : undefined, onClick: () => navigateTo("datacenter", null, "vms") },
        { id: "ct", label: t("nav.containers"), value: containers.length, unit: containers.length ? t("ov.ofRunningSm", { n: ctRunning }) : null, sub: containers.length ? t("ov.containersStopped", { n: containers.length - ctRunning }) : t("ov.noContainer"), onClick: () => navigateTo("datacenter", null, "containers") },
        { id: "cpu", label: t("ov.cpuCluster"), value: clusterCpu != null ? fmtPct(clusterCpu, lang) : "—", unit: clusterCpu != null ? "%" : null, sub: cores ? t("nd.cores", { n: cores }) : t("ns.collecting"), spark: cpuHist.slice(-60), onClick: () => setView("perf") },
        { id: "sto", label: t("nav.storage"), value: totalGb ? formatSizeGb(usedGb, lang) : "—", unit: totalGb ? `/ ${formatSizeGb(totalGb, lang)}` : null, sub: totalGb ? t("ov.usedPct", { p: Math.round((usedGb / totalGb) * 100) }) : t("ov.poolsSub"), onClick: () => navigateTo("datacenter", null, "storage") },
      ]} />

      <div className="nx-cols2">
        <Card title={t("nav.nodes")} flush>
          <div className="nx-tablewrap">
            <table className="nx-table">
              <thead><tr><th scope="col">{t("ns.col.state")}</th><th scope="col">{t("nd.node")}</th><th scope="col">{t("ns.cpu")}</th><th scope="col">{t("ns.memory")}</th><th scope="col">{t("ns.storage")}</th><th scope="col" className="nx-num">VM</th><th scope="col">{t("ns.col.uptime")}</th></tr></thead>
              <tbody>
                {nodes.map((n) => {
                  const nv = vms.filter((v) => v.node === n.id);
                  return (
                    <tr key={n.id}>
                      <td><StatusIndicator kind="node" wire={n.etat} /></td>
                      <th scope="row" className="nx-nm"><button type="button" className="nx-lnk" onClick={() => navigateTo("node", n.id, "summary")}>{n.nom}</button><small>{n.id === "local" ? t("node.roleLocal") : t("node.roleMember")}</small></th>
                      <td><Meter value={n.cpu_utilisation} label={`${n.nom} ${t("ns.cpu")}`} /></td>
                      <td><Meter value={pct(n.memoire_utilisee_mo, n.memoire_totale_mo)} label={`${n.nom} ${t("ns.memory")}`} /></td>
                      <td><Meter value={pct(n.stockage_utilise_go, n.stockage_total_go)} label={`${n.nom} ${t("ns.storage")}`} /></td>
                      <td className="nx-num nx-mono">{nv.filter((v) => v.etat === "actif").length} / {nv.length}</td>
                      <td className="nx-mono nx-muted">{formatUptimeLong(n.uptime_s, lang) || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title={t("ov.watch")}>
          {watch.length === 0 ? <p role="status" className="nx-inline" style={{ margin: 0 }}><StatusIndicator override={{ key: "health.ok", shape: "dot", tone: "success" }} /> <span className="nx-muted">{t("ns.noIncident")}</span></p> : (
            <ul className="nx-list2">
              {watch.slice(0, 8).map((w) => (
                <li key={w.id}>
                  {w.tone === "info" ? <Info size={16} aria-hidden="true" /> : <TriangleAlert size={16} className={`nx-tone-${w.tone === "danger" ? "danger" : "warning"}`} aria-hidden="true" />}
                  <div className="nx-list2-main">{w.text}{w.sub && <div className="nx-list2-sub">{w.sub}</div>}</div>
                  {w.go && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={w.go}>{w.action || t("dock.view")}</button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="nx-cols2">
        <Card title={t("ov.pools")} actions={<button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => navigateTo("datacenter", null, "storage")}>{t("ov.seeAll")}<ChevronRight size={14} aria-hidden="true" /></button>}>
          {storagePools.length === 0 ? <p className="nx-muted" role="status" style={{ margin: 0 }}>{t("ov.noPools")}</p> : storagePools.map((p) => {
            const r = p.capacite_go ? ((p.capacite_go - (p.disponible_go ?? p.capacite_go)) / p.capacite_go) * 100 : null;
            return (
              <div key={`${p.node}:${p.nom}`} className="nx-cap">
                <div className="nx-cap-nm"><b>{p.nom}</b><small>{[nodes.find((n) => n.id === p.node)?.nom || p.node, p.type, formatSizeGb(p.capacite_go, lang)].filter(Boolean).join(" · ")}</small></div>
                <span className="nx-track nx-track--wide" role="meter" aria-label={`${p.nom} ${t("stor.usage")}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r == null ? undefined : Math.round(r)}><span data-tone={r >= 90 ? "danger" : r >= 80 ? "warning" : "info"} style={{ width: `${Math.round(r || 0)}%` }} /></span>
                <span className="nx-cap-pct">{r == null ? "—" : `${Math.round(r)} %`}</span>
                <Spark data={poolHist[`${p.node}:${p.nom}`]} />
              </div>
            );
          })}
        </Card>
        <Card title={t("ns.activity")} actions={<button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => navigateTo("datacenter", null, "activity")}>{t("ov.seeAll")}<ChevronRight size={14} aria-hidden="true" /></button>}>
          <ActivityList items={recent} max={4} />
        </Card>
      </div>
    </>
  );
}

function ActivityList({ items, max }) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  if (items == null) return <p className="nx-muted" style={{ margin: 0 }}>{t("loading")}</p>;
  if (items.length === 0) return <p className="nx-muted" role="status" style={{ margin: 0 }}>{t("dock.none")}</p>;
  const today = new Date().toDateString();
  return (
    <ul className="nx-list2">
      {items.slice(0, max).map((r) => {
        const at = r.debut_le || r.cree_le;
        return (
          <li key={r.id}>
            <StatusIndicator kind="task" wire={r.statut} compact />
            <div className="nx-list2-main">{taskLabel(r.type)}{r.cible ? <> · <b>{r.cible}</b></> : null}<div className="nx-list2-sub">{r.username || t("ov.system")}</div></div>
            <span className="nx-list2-t">{new Date(at).toDateString() === today ? clockTime(at, lang) : formatDateTime(at, lang)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Perf() {
  const t = useT();
  const nodes = useInfraStore((s) => s.nodes);
  const [nodeId, setNodeId] = useState("local");
  const [range, setRange] = useState("1h");
  const node = nodes.find((n) => n.id === nodeId) || nodes[0];
  const hist = useHostHistory(node, range);
  if (!node) return null;
  return (
    <>
      {nodes.length > 1 && (
        <div className="nx-bar">
          <label className="nx-bar-lbl">{t("ns.node")}<select className="nx-sel" value={node.id} onChange={(e) => setNodeId(e.target.value)}>{nodes.map((n) => <option key={n.id} value={n.id}>{n.nom}</option>)}</select></label>
        </div>
      )}
      <PerformanceView hist={hist} range={range} setRange={setRange} running={node.etat === "online"} title={t("ov.hostPerf", { name: node.nom })} />
    </>
  );
}

function Events() {
  const t = useT();
  const navigateTo = useInfraStore((s) => s.navigateTo);
  const [items, setItems] = useState(null);
  const load = () => fetchTasks({ limit: 50, tri: "cree_le", ordre: "desc" }).then((r) => setItems(asList(r))).catch(() => setItems([]));
  useEffect(() => { load(); }, []);
  usePolling(load, 10000);
  return (
    <Card title={t("ns.activity")} actions={<button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => navigateTo("datacenter", null, "activity")}>{t("dock.allTasks")}<ChevronRight size={14} aria-hidden="true" /></button>}>
      <ActivityList items={items} max={50} />
    </Card>
  );
}

export default function Overview() {
  const t = useT();
  const { nodes, vms } = useInfraStore(useShallow((s) => ({ nodes: s.nodes, vms: s.vms })));
  const [view, setView] = useState("summary");
  const VIEWS = ["summary", "perf", "events"];
  return (
    <>
      <PageHeader title={t("nav.overview")} desc={t("ov.desc", { nodes: nodes.length, vms: vms.length })} fresh />
      <div className="nx-tabs nx-tabs--page" role="tablist" aria-label={t("ov.views")}>
        {VIEWS.map((v) => <button key={v} id={`ov-tab-${v}`} type="button" role="tab" aria-selected={view === v} aria-controls="ov-panel" onClick={() => setView(v)}>{t(`ov.view.${v}`)}</button>)}
      </div>
      <div id="ov-panel" role="tabpanel" aria-labelledby={`ov-tab-${view}`} className="nx-stack">
        {view === "summary" ? <Summary setView={setView} /> : view === "perf" ? <Perf /> : <Events />}
      </div>
    </>
  );
}
Overview.ownHeader = true;
