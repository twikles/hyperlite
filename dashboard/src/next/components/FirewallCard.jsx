import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useInfraStore } from "../../store/useInfraStore";
import { useT } from "../i18n";
import { errorMessage } from "../lib/errors";
import { Card } from "./ui";

const PROTOCOLS = ["tcp", "udp", "icmp", "all"];

// Firewall rules of a VM (nwfilter) or of a network (bridge iptables): the same rule shape on the backend, only
// fetchConfig / saveConfig differ. Rules are edited locally and applied together.
export default function FirewallCard({ title, fetchConfig, saveConfig, isAdmin }) {
  const t = useT();
  const pushToast = useInfraStore((s) => s.pushToast);
  const [config, setConfig] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    fetchConfig().then((c) => { setConfig(c); setSaved(JSON.stringify(c)); }).catch((e) => pushToast({ kind: "error", title: t("fw.error"), message: errorMessage(e) }));
  }, [fetchConfig, pushToast, t]);
  useEffect(() => { reload(); }, [reload]);

  if (!config) return <Card title={title}><p className="nx-muted" style={{ margin: 0 }}>{t("loading")}</p></Card>;
  const dirty = JSON.stringify(config) !== saved;
  const update = (i, patch) => setConfig((c) => ({ ...c, rules: c.rules.map((r, k) => (k === i ? { ...r, ...patch } : r)) }));
  async function apply() {
    setBusy(true);
    try { await saveConfig(config); pushToast({ kind: "success", title: t("fw.applied"), message: title }); reload(); }
    catch (e) { pushToast({ kind: "error", title: t("fw.failed"), message: errorMessage(e) }); }
    finally { setBusy(false); }
  }
  return (
    <Card title={title} flush actions={<>
      <span className="nx-muted" style={{ fontSize: "var(--fs-12)" }}>{t("fw.default")}</span>
      <select className="nx-sel" aria-label="Default firewall policy" disabled={!isAdmin} value={config.default_policy} onChange={(e) => setConfig((c) => ({ ...c, default_policy: e.target.value }))}>
        <option value="accept">{t("fw.allow")}</option><option value="drop">{t("fw.block")}</option>
      </select>
    </>}>
      {config.rules.length === 0 ? <p className="nx-muted" style={{ margin: 0, padding: "0 var(--space-4) var(--space-4)" }}>{t("fw.none")}</p> : (
        <div className="nx-tablewrap">
          <table className="nx-table">
            <thead><tr><th scope="col">{t("fw.direction")}</th><th scope="col">{t("fw.protocol")}</th><th scope="col">{t("fw.port")}</th><th scope="col">{t("fw.action")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
            <tbody>
              {config.rules.map((r, i) => (
                <tr key={i}>
                  <td><select className="nx-sel" aria-label="Rule direction" disabled={!isAdmin} value={r.direction} onChange={(e) => update(i, { direction: e.target.value })}><option value="in">{t("fw.in")}</option><option value="out">{t("fw.out")}</option><option value="inout">{t("fw.both")}</option></select></td>
                  <td><select className="nx-sel nx-mono" aria-label="Rule protocol" disabled={!isAdmin} value={r.protocol} onChange={(e) => update(i, { protocol: e.target.value })}>{PROTOCOLS.map((p) => <option key={p} value={p}>{p === "all" ? t("fw.all") : p.toUpperCase()}</option>)}</select></td>
                  <td>{r.protocol === "tcp" || r.protocol === "udp" ? <input className="nx-inp nx-mono" style={{ width: "6.6667rem", height: "2.1333rem" }} aria-label="port" type="number" min={1} max={65535} placeholder={t("fw.anyPort")} disabled={!isAdmin} value={r.port ?? ""} onChange={(e) => update(i, { port: e.target.value ? Number(e.target.value) : null })} /> : <span className="nx-muted">—</span>}</td>
                  <td><select className="nx-sel" aria-label="Rule action" disabled={!isAdmin} value={r.action} onChange={(e) => update(i, { action: e.target.value })}><option value="accept">{t("fw.allow")}</option><option value="drop">{t("fw.block")}</option></select></td>
                  <td><div className="nx-ra">{isAdmin && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" aria-label={`Remove rule ${i + 1}`} title={t("sec.remove")} onClick={() => setConfig((c) => ({ ...c, rules: c.rules.filter((_, k) => k !== i) }))}><Trash2 size={15} aria-hidden="true" /></button>}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {isAdmin && (
        <div className="nx-card2-foot">
          <button type="button" className="nx-btn nx-btn--sm" aria-label="Add a rule" onClick={() => setConfig((c) => ({ ...c, rules: [...c.rules, { action: "accept", direction: "in", protocol: "tcp", port: null }] }))}><Plus size={14} aria-hidden="true" />{t("fw.add")}</button>
          <span className="nx-sp" />
          {dirty && <span className="nx-muted" style={{ fontSize: "var(--fs-12)" }} role="status">{t("sso.unsaved")}</span>}
          <button type="button" className="nx-btn nx-btn--sm" aria-label="Apply" disabled={busy || !dirty} onClick={apply}>{t("fw.apply")}</button>
        </div>
      )}
    </Card>
  );
}
