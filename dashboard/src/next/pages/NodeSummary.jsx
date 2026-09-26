import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight } from "lucide-react";
import { fetchTasks } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useT, useLangStore } from "../i18n";
import { usePolling } from "../lib/polling";
import { deriveAlerts } from "../lib/alerts";
import { taskLabel } from "../lib/enums";
import { formatSizeMb, formatSizeGb, formatUptimeLong, formatVersionInt, clockTime, formatDateTime } from "../lib/format";
import StatusIndicator from "../components/StatusIndicator";
import { KpiStrip, Card } from "../components/ui";
import { useHostHistory } from "./VmPerformance";

const asList = (v) => (Array.isArray(v) ? v : []);
const pct = (used, total) => (used != null && total ? (used / total) * 100 : null);
const fmt1 = (v, lang) => new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(v);

// Node summary: the KPI strip (with the last hour as sparklines), the VMs of this node in a compact table, its
// configuration and alert state, and the recent activity of the node. Full charts are in Performance only.
export default function NodeSummary({ resource: node }) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const { vms, storagePools, navigateTo } = useInfraStore(useShallow((s) => ({ vms: s.vms, storagePools: s.storagePools, navigateTo: s.navigateTo })));
  const hist = useHostHistory(node, "1h");
  const [recent, setRecent] = useState(null);
  const nodeId = node?.id;
  const taskNode = nodeId;
  const loadRecent = () => fetchTasks({ node: taskNode, limit: 6, tri: "cree_le", ordre: "desc" }).then((r) => setRecent(asList(r))).catch(() => setRecent([]));
  useEffect(() => { loadRecent(); }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps
  usePolling(loadRecent, 10000);

  const nodeVms = useMemo(() => vms.filter((v) => v.node === nodeId), [vms, nodeId]);
  if (!node) return null;
  const rows = (hist.rows || []).slice(-60);
  const pools = storagePools.filter((p) => p.node === nodeId);
  const running = nodeVms.filter((v) => v.etat === "actif").length;
  const alerts = deriveAlerts({ nodes: [node], vms: nodeVms, storagePools: pools, tasks: [] });
  const memP = pct(node.memoire_utilisee_mo, node.memoire_totale_mo);
  const stoP = pct(node.stockage_utilise_go, node.stockage_total_go);
  const qemu = formatVersionInt(node.version_hyperviseur);
  const lv = formatVersionInt(node.version_libvirt);
  const na = <span className="nx-muted">{t("ns.notReported")}</span>;
  const today = new Date().toDateString();

  return (
    <>
      <KpiStrip label={t("ns.resources")} items={[
        { id: "cpu", label: t("ns.cpu"), value: node.cpu_utilisation != null ? fmt1(node.cpu_utilisation, lang) : "—", unit: node.cpu_utilisation != null ? "%" : null, sub: [node.cpu_coeurs && t("nd.cores", { n: node.cpu_coeurs }), node.cpu_modele].filter(Boolean).join(" · ") || t("ns.collecting"), spark: rows.map((r) => r.cpu_pct), onClick: () => navigateTo("node", nodeId, "perf") },
        { id: "mem", label: t("ns.memory"), value: node.memoire_utilisee_mo != null ? formatSizeMb(node.memoire_utilisee_mo, lang) : "—", unit: node.memoire_totale_mo ? `/ ${formatSizeMb(node.memoire_totale_mo, lang)}` : null, sub: memP != null ? t("ns.usedPct", { p: Math.round(memP) }) : t("ns.collecting"), spark: rows.map((r) => pct(r.mem_used_mb, r.mem_total_mb)), onClick: () => navigateTo("node", nodeId, "perf") },
        { id: "sto", label: t("ns.storage"), value: node.stockage_utilise_go != null ? formatSizeGb(node.stockage_utilise_go, lang) : "—", unit: node.stockage_total_go ? `/ ${formatSizeGb(node.stockage_total_go, lang)}` : null, sub: stoP != null ? t("ns.poolPct", { pool: pools[0]?.nom || "default", p: Math.round(stoP) }) : "", onClick: () => navigateTo("node", nodeId, "disk") },
        { id: "vms", label: t("nav.vms"), value: running, unit: t("ov.ofRunning", { n: nodeVms.length }), sub: t("ov.stoppedN", { n: nodeVms.length - running }), onClick: () => navigateTo("datacenter", null, "vms") },
      ]} />

      <div className="nx-cols2">
        <Card title={t("ns.vmsOnNode")} flush actions={<button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => navigateTo("datacenter", null, "vms")}>{t("ns.allVms")}<ChevronRight size={14} aria-hidden="true" /></button>}>
          {nodeVms.length === 0 ? <p className="nx-muted" role="status" style={{ margin: 0, padding: "0 var(--space-4) var(--space-4)" }}>{t("ns.noVms")}</p> : (
            <div className="nx-tablewrap">
              <table className="nx-table">
                <thead><tr><th scope="col">{t("ns.col.state")}</th><th scope="col">{t("ns.col.name")}</th><th scope="col" className="nx-num">{t("ns.vcpuRam")}</th><th scope="col">{t("vmlist.ip")}</th><th scope="col">{t("ns.col.uptime")}</th></tr></thead>
                <tbody>
                  {nodeVms.map((v) => (
                    <tr key={v.nom}>
                      <td><StatusIndicator kind="vm" wire={v.etat} /></td>
                      <th scope="row" className="nx-nm"><button type="button" className="nx-lnk" onClick={() => navigateTo("vm", v.nom, "summary")}>{v.nom}</button>{v.os && <small>{v.os}</small>}</th>
                      <td className="nx-num nx-mono">{v.vcpu} · {formatSizeMb(v.memoire_mo, lang)}</td>
                      <td className="nx-mono">{v.ip || <span className="nx-muted">—</span>}</td>
                      <td className="nx-mono nx-muted">{v.etat === "actif" ? formatUptimeLong(v.uptime_s, lang) || "—" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title={t("vm.config")}>
          <dl className="nx-dl2">
            <dt>{t("ns.address")}</dt><dd className="nx-mono">{node.ip || (node.id === "local" ? na : na)}</dd>
            <dt>{t("ns.hypervisor")}</dt><dd className="nx-mono">{qemu || lv ? [qemu && `QEMU ${qemu}`, lv && `libvirt ${lv}`].filter(Boolean).join(" · ") : na}</dd>
            <dt>{t("ns.cpuModel")}</dt><dd>{node.cpu_modele || na}{node.cpu_coeurs ? <span className="nx-muted"> · {t("nd.cores", { n: node.cpu_coeurs })}</span> : null}</dd>
            <dt>{t("nn.kernel")}</dt><dd className="nx-mono">{node.noyau || na}</dd>
            <dt>{t("nn.os")}</dt><dd>{node.os || na}</dd>
            <dt>{t("dock.alerts")}</dt><dd>{alerts.length === 0 ? <span className="nx-st nx-tone-success"><span className="nx-dot" data-tone="success" aria-hidden="true" />{t("ns.noAlert")}</span>
              : <button type="button" className="nx-lnk nx-tone-warning" onClick={() => window.dispatchEvent(new CustomEvent("nx:dock", { detail: "alerts" }))}>{t("ns.alertsN", { n: alerts.length })}</button>}</dd>
          </dl>
        </Card>
      </div>

      <Card title={t("ns.activity")} actions={<button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => navigateTo("node", nodeId, "tasks")}>{t("ns.nodeTasks")}<ChevronRight size={14} aria-hidden="true" /></button>}>
        {recent == null ? <p className="nx-muted" style={{ margin: 0 }}>{t("loading")}</p> : recent.length === 0 ? <p className="nx-muted" role="status" style={{ margin: 0 }}>{t("dock.none")}</p> : (
          <ul className="nx-list2">
            {recent.map((r) => {
              const at = r.debut_le || r.cree_le;
              return (
                <li key={r.id}><StatusIndicator kind="task" wire={r.statut} compact />
                  <div className="nx-list2-main">{taskLabel(r.type)}{r.cible ? <> · <b>{r.cible}</b></> : null}<div className="nx-list2-sub">{r.username || t("ov.system")}</div></div>
                  <span className="nx-list2-t">{new Date(at).toDateString() === today ? clockTime(at, lang) : formatDateTime(at, lang)}</span></li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
