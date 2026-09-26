import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVMMetricsHistory, fetchNodeMetricsHistory } from "../../api/client";
import { useT, useLangStore } from "../i18n";
import { usePolling } from "../lib/polling";
import { formatRate, formatSizeMb } from "../lib/format";
import LineChart from "../components/LineChart";

const asList = (v) => (Array.isArray(v) ? v : []);
export const RANGES = ["1h", "24h", "7j", "30j"];

// Persisted history, collected every tick for every node (local host and remote nodes) and each of their VMs.
// A range with no hourly roll-up yet falls back to the raw last hour, and says so, instead of an empty chart.
function useMetricsHistory(key, fetcher, local, range) {
  const [state, setState] = useState({ rows: null, shown: range, failed: false });
  const seq = useRef(0);
  const fetchRef = useRef(fetcher);
  useEffect(() => { fetchRef.current = fetcher; }, [fetcher]);
  const load = useCallback(async () => {
    if (!key || !local) return;
    const id = ++seq.current;
    try {
      let rows = asList(await fetchRef.current(range)); let shown = range;
      if (rows.length < 2 && range !== "1h") { rows = asList(await fetchRef.current("1h")); shown = "1h"; }
      if (id === seq.current) setState({ rows, shown, failed: false });
    } catch {
      if (id === seq.current) setState((s) => ({ ...s, rows: s.rows || [], failed: true }));
    }
  }, [key, local, range]);
  useEffect(() => { setState({ rows: null, shown: range, failed: false }); load(); }, [load, range]);
  usePolling(load, 30000, { enabled: !!key && local });
  return { ...state, local };
}
export function useVmHistory(vm, range) {
  const name = vm?.nom;
  const node = vm?.node;
  const fetcher = useCallback((r) => fetchVMMetricsHistory(name, r, node), [name, node]);
  return useMetricsHistory(name && `${node}:${name}`, fetcher, true, range);
}
export function useHostHistory(node, range) {
  const id = node?.id;
  const fetcher = useCallback((r) => fetchNodeMetricsHistory(id, r), [id]);
  return useMetricsHistory(id, fetcher, true, range);
}

const pts = (rows, pick) => rows.map((r) => ({ t: new Date(r.ts).getTime(), v: pick(r) })).filter((p) => p.v != null && !Number.isNaN(p.v) && !Number.isNaN(p.t));
const stats = (points) => {
  if (!points.length) return null;
  const v = points.map((p) => p.v);
  return { min: Math.min(...v), avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v), last: v[v.length - 1] };
};

// The four charts of a VM (CPU, memory, disk and network throughput), shared by the summary and the performance tab.
export function vmChartModel(rows, t, lang) {
  const pct = (v) => `${new Intl.NumberFormat(lang, { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v)} %`;
  const rate = (v, compact) => formatRate(v, lang, compact);
  const lastMem = [...rows].reverse().find((r) => r.mem_total_mb);
  return [
    { id: "cpu", title: t("ns.cpu"), format: pct, max: 100,
      series: [{ key: "cpu", label: t("ns.cpu"), tone: "info", points: pts(rows, (r) => r.cpu_pct) }] },
    { id: "mem", title: t("ns.memory"), format: pct, max: 100,
      note: lastMem ? `${formatSizeMb(lastMem.mem_used_mb, lang)} / ${formatSizeMb(lastMem.mem_total_mb, lang)}` : null,
      series: [{ key: "mem", label: t("ns.memory"), tone: "info2", points: pts(rows, (r) => (r.mem_total_mb ? (r.mem_used_mb / r.mem_total_mb) * 100 : null)) }] },
    { id: "disk", title: t("vm.disk"), format: rate, max: "auto", base: 1024,
      series: [
        { key: "read", label: t("vp.read"), tone: "info", points: pts(rows, (r) => r.disk_read_bps) },
        { key: "write", label: t("vp.write"), tone: "accent", points: pts(rows, (r) => r.disk_write_bps) },
      ] },
    { id: "net", title: t("ns.network"), format: rate, max: "auto", base: 1024,
      series: [
        { key: "rx", label: t("vp.rx"), tone: "info", points: pts(rows, (r) => r.net_rx_bps) },
        { key: "tx", label: t("vp.tx"), tone: "accent", points: pts(rows, (r) => r.net_tx_bps) },
      ] },
  ];
}

export function timeFormatter(shown, lang) {
  return (tk) => new Date(tk).toLocaleString(lang, shown === "7j" || shown === "30j" ? { day: "2-digit", month: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
}

// Why there is no chart: remote node (no collection there), request failure, not running with no history, or first samples pending.
export function emptyReason(running, hist, t, remoteKey = "vm.remoteNoMetrics") {
  if (!hist.local) return t(remoteKey);
  if (hist.failed && !(hist.rows || []).length) return t("vp.failed");
  if (hist.rows == null) return t("loading");
  if (hist.rows.length < 2) return running ? t("ns.collecting") : t("vp.noHistory");
  return null;
}

// Chart grid shared by the VM and node pages; `charts` picks among cpu / mem / disk / net.
export function ChartGrid({ hist, running, charts, remoteKey, height = 150, headingLevel = 3 }) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const H = `h${headingLevel}`;
  const reason = emptyReason(running, hist, t, remoteKey);
  const model = vmChartModel(hist.rows || [], t, lang).filter((c) => !charts || charts.includes(c.id));
  const timeFmt = timeFormatter(hist.shown, lang);
  return (
    <div className="nx-vm-charts">
      {model.map((c) => {
        const last = c.series.map((s) => stats(s.points)?.last).filter((v) => v != null);
        const now = last.length ? (c.series.length > 1 ? c.series.map((s, i) => `${s.label} ${c.format(last[i] ?? 0)}`).join(" · ") : c.format(last[0])) : null;
        return (
          <section key={c.id} className="nx-vm-chart" aria-labelledby={`vmc-${c.id}`}>
            <div className="nx-vm-chart-head"><H id={`vmc-${c.id}`}>{c.title}</H>{!reason && <span className="nx-mono nx-muted">{c.note || now}</span>}</div>
            {reason ? <p className="nx-muted nx-vm-chart-empty" role="status">{reason}</p>
              : <LineChart series={c.series} label={`${c.title} (${hist.shown})`} formatTime={timeFmt} height={height} max={c.max} format={c.format} base={c.base} />}
          </section>
        );
      })}
    </div>
  );
}

export function VmChartGrid({ vm, hist, height }) {
  return <ChartGrid hist={hist} running={vm.etat === "actif"} height={height} />;
}

// Performance tab: the charts, larger, with the range picker and min / average / max over the period.
export default function VmPerformancePage({ resource: vm }) {
  const [range, setRange] = useState("1h");
  const hist = useVmHistory(vm, range);
  if (!vm) return null;
  return <PerformanceView hist={hist} range={range} setRange={setRange} running={vm.etat === "actif"} />;
}
export function NodePerformancePage({ resource: node }) {
  const [range, setRange] = useState("1h");
  const hist = useHostHistory(node, range);
  if (!node) return null;
  return <PerformanceView hist={hist} range={range} setRange={setRange} running={node.etat === "online"} charts={NODE_CHARTS} />;
}
export const NODE_CHARTS = null; // the host probe reports CPU, memory, disk and network like a VM

export function PerformanceView({ hist, range, setRange, running, charts, remoteKey, title }) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const reason = emptyReason(running, hist, t, remoteKey);
  const model = vmChartModel(hist.rows || [], t, lang).filter((c) => !charts || charts.includes(c.id));
  return (
    <div className="nx-ns">
      <section className="nx-card" aria-labelledby="vp-title">
        <div className="nx-cardhead">
          <h2 id="vp-title">{title || t("tab.perf")}</h2>
          {hist.shown !== range && hist.rows && <span className="nx-muted nx-cardhead-note" role="status">{t("vp.fallback", { range })}</span>}
          <div className="nx-seg" role="group" aria-label={t("ov.range")}>
            {RANGES.map((r) => <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>)}
          </div>
        </div>
        <ChartGrid hist={hist} running={running} charts={charts} remoteKey={remoteKey} height={200} />
      </section>
      {!reason && (
        <section className="nx-card" aria-labelledby="vp-stats">
          <h2 id="vp-stats">{t("vp.stats", { range: hist.shown })}</h2>
          <div className="nx-tablewrap">
            <table className="nx-table">
              <thead><tr><th scope="col">{t("vp.metric")}</th><th scope="col" className="nx-num">{t("vp.min")}</th><th scope="col" className="nx-num">{t("vp.avg")}</th><th scope="col" className="nx-num">{t("vp.max")}</th><th scope="col" className="nx-num">{t("vp.last")}</th></tr></thead>
              <tbody>
                {model.flatMap((c) => c.series.map((s) => {
                  const st = stats(s.points);
                  const label = c.series.length > 1 ? `${c.title} · ${s.label}` : c.title;
                  return (
                    <tr key={`${c.id}-${s.key}`}>
                      <th scope="row">{label}</th>
                      {st ? ["min", "avg", "max", "last"].map((k) => <td key={k} className="nx-num nx-mono">{c.format(st[k])}</td>) : <td colSpan={4} className="nx-muted">—</td>}
                    </tr>
                  );
                }))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
