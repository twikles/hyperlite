import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleCheck, ExternalLink, Network, Plug, RefreshCw, TriangleAlert, Unplug } from "lucide-react";
import { fetchNodeCapabilitiesById, fetchHostPreflight, fetchNodeCompatibility, fetchNodeHardware, createHostTerminalTicket } from "../../api/client";
import { flattenCapabilities, deriveFeatures, NA } from "../../lib/capabilitiesView";
import { ensureXtermLoaded, wsUrl } from "../../utils/loadXterm";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { useT, useLangStore } from "../i18n";
import { capabilities } from "../lib/capabilities";
import { errorMessage } from "../lib/errors";
import { formatSizeGb, formatSizeMb, formatVersionInt } from "../lib/format";
import { capRow, featureRow } from "../lib/capsI18n";
import StatusIndicator from "../components/StatusIndicator";
import { EmptyState, ErrorState } from "../components/States";
import PermissionNotice from "../components/PermissionNotice";
import { Card, Chip, Empty } from "../components/ui";

const isLocal = (node) => node?.id === "local";

// Host data (kernel, metrics, networks) only exists for the machine running this Hyperlite. For a remote node
// the API does not provide it: say so instead of showing the local host's values under another name.
function RemoteNotice({ node }) {
  const t = useT();
  return <EmptyState title={t("nn.remoteTitle", { name: node.nom })} help={t("nn.remoteHelp")} />;
}

// Hardware inventory of a node (interfaces, disks, CPU topology), read on demand; "Refresh capabilities" in
// the node's Actions menu reloads it.
function useHardware(node) {
  const id = node?.id;
  const [hw, setHw] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    if (!id) return;
    setError(null);
    fetchNodeHardware(id).then(setHw).catch((e) => setError(errorMessage(e)));
  }, [id]);
  useEffect(() => { setHw(null); load(); }, [load]);
  useEffect(() => {
    const on = (e) => { if (e.detail === id) load(); };
    window.addEventListener("nx:node-refresh", on);
    return () => window.removeEventListener("nx:node-refresh", on);
  }, [id, load]);
  return { hw, error, load };
}

export function NodeSystemPage({ resource: node }) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const local = isLocal(node);
  const { hw, error, load } = useHardware(node);
  const [caps, setCaps] = useState(null);
  const [health, setHealth] = useState(null);
  const nodeId = node?.id;
  useEffect(() => { if (nodeId) fetchNodeCapabilitiesById(nodeId).then(setCaps).catch(() => setCaps(null)); }, [nodeId]);
  useEffect(() => { if (local) fetch("/health").then((r) => (r.ok ? r.json() : null)).then(setHealth).catch(() => setHealth(null)); }, [local]);
  if (!node) return null;
  const cpu = hw?.cpu || {};
  const na = <span className="nx-muted">{t("ns.notReported")}</span>;
  const qemu = formatVersionInt(node.version_hyperviseur);
  const lv = formatVersionInt(node.version_libvirt);
  const flags = [cpu.virtualisation, caps?.cpu?.virtualisation_materielle ? "KVM" : null, caps?.virtualisation?.conteneurs_lxc_disponibles ? "LXC" : null].filter(Boolean);
  return (
    <>
      {error && !hw && <ErrorState message={error} onRetry={load} />}
      <div className="nx-cols2 nx-cols2--even">
        <Card title={t("nn.hardware")}>
          <dl className="nx-dl2">
            <dt>{t("ns.cpuModel")}</dt><dd>{cpu.modele || node.cpu_modele || na}</dd>
            <dt>{t("nn.topology")}</dt><dd className="nx-mono">{cpu.sockets ? t("nn.topologyVal", { s: cpu.sockets, c: cpu.coeurs_par_socket ?? "?", th: cpu.threads ?? node.cpu_coeurs ?? "?" }) : node.cpu_coeurs ? t("nd.cores", { n: node.cpu_coeurs }) : na}</dd>
            <dt>{t("ns.memory")}</dt><dd className="nx-mono">{node.memoire_totale_mo ? formatSizeMb(node.memoire_totale_mo, lang) : na}</dd>
            <dt>{t("nn.virt")}</dt><dd>{flags.length ? <span className="nx-chips">{flags.map((f) => <Chip key={f} tone="info">{f}</Chip>)}</span> : na}</dd>
            <dt>{t("nn.arch")}</dt><dd className="nx-mono">{caps?.cpu?.architecture || na}</dd>
          </dl>
        </Card>
        <Card title={t("nn.software")}>
          <dl className="nx-dl2">
            <dt>{t("nn.os")}</dt><dd>{node.os || na}</dd>
            <dt>{t("nn.kernel")}</dt><dd className="nx-mono">{node.noyau || health?.kernel || na}</dd>
            <dt>QEMU</dt><dd className="nx-mono">{qemu || na}</dd>
            <dt>libvirt</dt><dd className="nx-mono">{lv || na}</dd>
            <dt>{t("nn.hostname")}</dt><dd className="nx-mono">{local ? health?.hostname || node.nom : node.nom}</dd>
            {local && <><dt>Hyperlite</dt><dd className="nx-mono">{health?.hyperlite_version || na}</dd></>}
            {local && health && <><dt>Python / FastAPI</dt><dd className="nx-mono">{health.python_version} / {health.fastapi_version}</dd></>}
          </dl>
        </Card>
      </div>
    </>
  );
}

export function NodeNetworkPage({ resource: node }) {
  const t = useT();
  const { hw, error, load } = useHardware(node);
  if (!node) return null;
  if (error && !hw) return <ErrorState message={error} onRetry={load} />;
  const list = hw?.interfaces || [];
  return (
    <div className="nx-card2 nx-card2--flush">
      {!hw ? <p className="nx-muted" role="status" style={{ padding: "var(--space-4)", margin: 0 }}>{t("loading")}</p> : list.length === 0 ? <Empty icon={Network} title={t("nn.noIfaces")} /> : (
        <div className="nx-tablewrap">
          <table className="nx-table">
            <thead><tr><th scope="col">{t("nn.link")}</th><th scope="col">{t("nn.iface")}</th><th scope="col">{t("stor.type")}</th><th scope="col">{t("nn.addresses")}</th><th scope="col">MAC</th><th scope="col">{t("nn.speed")}</th><th scope="col" className="nx-num">MTU</th></tr></thead>
            <tbody>
              {list.map((i) => {
                const up = i.etat === "up" || i.etat === "unknown";
                return (
                  <tr key={i.nom}>
                    <td><span className="nx-st" data-tone={up ? undefined : "offline"}><span className="nx-dot" data-tone={i.etat === "up" ? "success" : up ? "info" : "offline"} aria-hidden="true" />{t(i.etat === "up" ? "nn.up" : up ? "nn.unknown" : "nn.down")}</span></td>
                    <th scope="row" className="nx-mono" style={{ fontWeight: 500 }}>{i.nom}</th>
                    <td><Chip>{t(`nn.type.${i.type}`)}</Chip></td>
                    <td className="nx-mono nx-wrapcell">{i.adresses.length ? i.adresses.join(", ") : <span className="nx-muted">—</span>}</td>
                    <td className="nx-mono nx-muted">{i.mac || "—"}</td>
                    <td className="nx-mono">{i.debit_mbps ? (i.debit_mbps >= 1000 ? `${i.debit_mbps / 1000} Gb/s` : `${i.debit_mbps} Mb/s`) : "—"}</td>
                    <td className="nx-num nx-mono">{i.mtu ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function NodeDiskPage({ resource: node }) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const storagePools = useInfraStore((s) => s.storagePools);
  const { hw, error, load } = useHardware(node);
  if (!node) return null;
  const pools = storagePools.filter((p) => p.node === node.id);
  const disks = hw?.disques || [];
  const usedBy = (d) => {
    const names = pools.filter((p) => p.chemin && d.points_montage.some((m) => m === "/" || p.chemin.startsWith(m))).map((p) => p.nom);
    return [...d.points_montage.slice(0, 3), ...names].join(", ") || "—";
  };
  return (
    <>
      <Card title={t("ov.pools")}>
        {pools.length === 0 ? <p className="nx-muted" style={{ margin: 0 }}>{t("nn.noPools")}</p> : pools.map((p) => {
          const r = p.capacite_go ? ((p.capacite_go - (p.disponible_go ?? p.capacite_go)) / p.capacite_go) * 100 : null;
          return (
            <div key={p.nom} className="nx-cap nx-cap--3">
              <div className="nx-cap-nm"><b>{p.nom}</b><small>{[p.type === "netfs" ? "NFS" : p.type, p.chemin, formatSizeGb(p.capacite_go, lang)].filter(Boolean).join(" · ")}</small></div>
              <span className="nx-track nx-track--wide" role="meter" aria-label={`${p.nom} ${t("stor.usage")}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r == null ? undefined : Math.round(r)}><span data-tone={r >= 90 ? "danger" : r >= 80 ? "warning" : "info"} style={{ width: `${Math.round(r || 0)}%` }} /></span>
              <span className="nx-cap-pct">{r == null ? "—" : `${Math.round(r)} %`}</span>
            </div>
          );
        })}
      </Card>
      <Card title={t("nn.disks")} flush>
        {error && !hw ? <ErrorState message={error} onRetry={load} /> : !hw ? <p className="nx-muted" role="status" style={{ padding: "0 var(--space-4) var(--space-4)", margin: 0 }}>{t("loading")}</p> : disks.length === 0 ? <p className="nx-muted" style={{ padding: "0 var(--space-4) var(--space-4)", margin: 0 }}>{t("nn.noDisks")}</p> : (
          <div className="nx-tablewrap">
            <table className="nx-table">
              <thead><tr><th scope="col">{t("nn.device")}</th><th scope="col">{t("nn.model")}</th><th scope="col">{t("stor.type")}</th><th scope="col" className="nx-num">{t("lib.size")}</th><th scope="col">SMART</th><th scope="col">{t("nn.usedBy")}</th></tr></thead>
              <tbody>
                {disks.map((d) => (
                  <tr key={d.nom}>
                    <th scope="row" className="nx-mono" style={{ fontWeight: 500 }}>{d.nom}</th>
                    <td>{d.modele || <span className="nx-muted">—</span>}</td>
                    <td><Chip>{d.type}</Chip></td>
                    <td className="nx-num nx-mono">{d.taille_go != null ? formatSizeGb(d.taille_go, lang) : "—"}</td>
                    <td>{d.sante === "ok" ? <span className="nx-st nx-tone-success"><span className="nx-dot" data-tone="success" aria-hidden="true" />{t("nn.healthy")}</span> : d.sante === "echec" ? <span className="nx-st" data-tone="danger"><span className="nx-dot" data-tone="danger" aria-hidden="true" />{t("nn.failing")}</span> : <span className="nx-muted" title={t("nn.smartNa")}>—</span>}</td>
                    <td className="nx-mono nx-wrapcell">{usedBy(d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// Embedded host shell: the same ticket + WebSocket + xterm relay as the separate window, which stays available.
export function NodeShellPage({ resource: node }) {
  const t = useT();
  const caps = capabilities(useAuthStore((s) => s.role));
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [started, setStarted] = useState(false);
  const screen = useRef(null);
  const term = useRef(null);
  const ws = useRef(null);
  const onResize = useRef(null);

  const cleanup = useCallback(() => {
    try { ws.current?.close(); } catch { /* already closed */ }
    try { term.current?.dispose(); } catch { /* already disposed */ }
    if (onResize.current) window.removeEventListener("resize", onResize.current);
    ws.current = null; term.current = null; onResize.current = null;
    if (screen.current) screen.current.innerHTML = "";
    setStatus("idle");
  }, []);
  useEffect(() => cleanup, [cleanup]);

  async function connect() {
    setStatus("connecting"); setError(null);
    try {
      await ensureXtermLoaded();
      const ticket = await createHostTerminalTicket();
      setStarted(true);
      screen.current.innerHTML = "";
      // xterm is loaded as a UMD global; its theme is the graphite of the navigation column.
      // eslint-disable-next-line no-undef
      const tm = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "IBM Plex Mono, ui-monospace, monospace", theme: { background: "#141215", foreground: "#F1ECEE", cursor: "#CE9DB2" } });
      // eslint-disable-next-line no-undef
      const fit = new FitAddon.FitAddon();
      tm.loadAddon(fit); tm.open(screen.current); fit.fit(); term.current = tm;
      const sock = new WebSocket(wsUrl(`/host/terminal?ticket=${encodeURIComponent(ticket.ticket)}`));
      ws.current = sock;
      sock.onopen = () => { setStatus("connected"); fit.fit(); sock.send("\x00" + JSON.stringify({ cols: tm.cols, rows: tm.rows })); };
      sock.onmessage = (ev) => tm.write(ev.data);
      sock.onclose = () => { tm.write("\r\n\x1b[33m[session ended]\x1b[0m\r\n"); setStatus("idle"); };
      sock.onerror = () => setError(t("nn.shellError"));
      tm.onData((d) => { if (sock.readyState === WebSocket.OPEN) sock.send(d); });
      tm.onResize(({ cols, rows }) => { if (sock.readyState === WebSocket.OPEN) sock.send("\x00" + JSON.stringify({ cols, rows })); });
      onResize.current = () => fit.fit();
      window.addEventListener("resize", onResize.current);
    } catch (e) { setError(errorMessage(e)); setStatus("error"); }
  }

  if (!node) return null;
  if (!caps.admin) return <PermissionNotice requires="admin" />;
  if (!isLocal(node)) return <RemoteNotice node={node} />;
  const connected = status === "connected";
  return (
    <>
      <div className="nx-bn" data-tone="warning" role="note"><TriangleAlert size={16} aria-hidden="true" /><span className="nx-bn-t"><b>{t("nn.shellWarn")}</b> {t("nn.shellHelp", { name: node.nom })}</span></div>
      <div>
        <div className="nx-termbar">
          <span className="nx-st" data-tone={connected ? undefined : "offline"}><span className="nx-dot" data-tone={connected ? "success" : "offline"} aria-hidden="true" />{t(connected ? "nn.connected" : status === "connecting" ? "nn.connecting" : "nn.notConnected")}</span>
          <span className="nx-mono nx-muted" style={{ fontSize: "var(--fs-12)" }}>root@{node.nom}</span>
          <span className="nx-sp" />
          {connected
            ? <button type="button" className="nx-btn nx-btn--sm" onClick={cleanup}><Unplug size={14} aria-hidden="true" />{t("nn.disconnect")}</button>
            : <button type="button" className="nx-btn nx-btn--primary nx-btn--sm" disabled={status === "connecting"} onClick={connect}><Plug size={14} aria-hidden="true" />{t("nn.connect")}</button>}
          <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" disabled={!connected} onClick={() => term.current?.clear()}>{t("nn.clear")}</button>
          <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => window.open("/host-shell", "hyperlite-host-shell", "width=1100,height=750,noopener")}><ExternalLink size={14} aria-hidden="true" />{t("nn.openWindow")}</button>
        </div>
        <div className="nx-termwrap">
          <div className="nx-term" ref={screen} aria-label={t("nn.shell")} role="region" />
          {!started && <p className="nx-term-hint">{t("nn.shellIdle")}</p>}
        </div>
        {error && <p className="nx-f-h is-error" role="alert">{error}</p>}
      </div>
    </>
  );
}

const FEATURE = {
  actif: { key: "state.active", shape: "dot", tone: "success" },
  limite: { key: "state.limited", shape: "triangle", tone: "warning" },
  inconnu: { key: "state.unknown", shape: "ring", tone: "unknown" },
};
const CHECK = {
  ok: { key: "cp.ok", shape: "check", tone: "success" },
  warning: { key: "cp.warning", shape: "triangle", tone: "warning" },
  disabled: { key: "cp.disabled", shape: "pause", tone: "warning" },
  blocking: { key: "cp.blocking1", shape: "diamond", tone: "danger" },
};

function Checks({ list, t }) {
  // warnings and blockers first, then what passed
  const order = { blocking: 0, disabled: 1, warning: 2, ok: 3 };
  const rows = [...list].sort((a, b) => (order[a.statut] ?? 2) - (order[b.statut] ?? 2));
  return (
    <ul className="nx-list2">
      {rows.map((c, i) => (
        <li key={`${c.id}-${i}`}>
          <StatusIndicator override={CHECK[c.statut] || CHECK.warning} compact />
          <div className="nx-list2-main"><b>{c.message}</b>{(c.fonctionnalite || c.action) && <div className="nx-list2-sub">{c.fonctionnalite && `${t("cp.impact")}: ${c.fonctionnalite}`}{c.fonctionnalite && c.action ? " · " : ""}{c.action && `${t("cp.action")}: ${c.action}`}</div>}</div>
        </li>
      ))}
    </ul>
  );
}

// What this node can really do (detected, never assumed): a summary of the preflight (local host) or of the
// compatibility with the local host (remote node), the checks with warnings first, and the feature chips.
export function NodeCompatPage({ resource: node }) {
  const t = useT();
  const nodeId = node?.id;
  const local = nodeId === "local";
  const [caps, setCaps] = useState(null);
  const [preflight, setPreflight] = useState(null);
  const [pair, setPair] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!nodeId) return;
    setLoading(true); setError(null);
    try {
      const jobs = [fetchNodeCapabilitiesById(nodeId).then(setCaps)];
      if (local) { setPair(null); jobs.push(fetchHostPreflight().then(setPreflight).catch(() => setPreflight(null))); }
      else { setPreflight(null); jobs.push(fetchNodeCompatibility(nodeId).then(setPair).catch(() => setPair(null))); }
      await Promise.all(jobs);
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, [nodeId, local]);
  useEffect(() => { setCaps(null); load(); }, [load]);

  if (!node) return null;
  if (error && !caps) return <ErrorState message={error} onRetry={load} />;
  const rows = flattenCapabilities(caps).map((r) => capRow(t, r));
  const sections = [...new Set(rows.map((r) => r.section))];
  const features = deriveFeatures(caps).map((f) => featureRow(t, f));
  const checks = (preflight || pair)?.controles || [];
  const bad = checks.filter((c) => c.statut !== "ok");
  const blocking = checks.filter((c) => c.statut === "blocking").length;

  return (
    <>
      {!caps && <p className="nx-muted" role="status" style={{ margin: 0 }}>{t("cp.detecting")}</p>}
      {(preflight || pair) && (
        <div className="nx-bn" data-tone={blocking ? "danger" : bad.length ? "warning" : "success"} role="status">
          {blocking || bad.length ? <TriangleAlert size={16} aria-hidden="true" /> : <CircleCheck size={16} aria-hidden="true" />}
          <span className="nx-bn-t"><b>{t(blocking ? "nc.sumBlocking" : "nc.sumOk")}</b> : {t("nc.sumCounts", { n: checks.length, w: bad.length })}</span>
          <button type="button" className="nx-btn nx-btn--sm" disabled={loading} onClick={load}><RefreshCw size={14} aria-hidden="true" />{loading ? t("loading") : t("nc.rerun")}</button>
        </div>
      )}
      <div className="nx-cols2 nx-cols2--even">
        {(preflight || pair) && <Card title={pair ? t("nc.pair") : t("nc.preflight")} note={preflight ? t("nc.preflightCount", preflight.resume.compte) : null}><Checks list={checks} t={t} /></Card>}
        {features.length > 0 && (
          <Card title={t("nc.features")}>
            <div className="nx-chips">
              {features.map((f) => <Chip key={f.id} tone={f.etat === "actif" ? "info" : f.etat === "limite" ? "warning" : undefined} title={f.detail || undefined}>{f.etat === "actif" ? <Check size={13} aria-hidden="true" /> : null}{f.label}{f.etat !== "actif" && <span className="nx-sr"> — {t(FEATURE[f.etat]?.key || "state.unknown")}</span>}</Chip>)}
            </div>
            {features.filter((f) => f.detail).map((f) => <p key={f.id} className="nx-f-h" style={{ margin: "var(--space-2) 0 0" }}>{f.label} : {f.detail}</p>)}
          </Card>
        )}
      </div>
      <details className="nx-card2 nx-details">
        <summary>{t("nc.allCaps")}</summary>
        <div className="nx-card2-b nx-stack">
          {sections.map((sct) => (
            <div key={sct}>
              <h3 className="nx-subhead">{sct}</h3>
              <dl className="nx-dl2">
                {rows.filter((r) => r.section === sct).map((r) => <div key={r.key} style={{ display: "contents" }}><dt>{r.label}</dt><dd className={`nx-mono ${r.value === NA ? "nx-muted" : ""}`}>{r.value === NA ? t("ns.notReported") : String(r.value)}</dd></div>)}
              </dl>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}
