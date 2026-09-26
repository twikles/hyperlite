import { useEffect, useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { fetchNodeCapabilitiesById, fetchHostProfile, setHostProfile, setHostAllocation } from "../../api/client";
import { compareNodes, NA } from "../../lib/capabilitiesView";
import { useT } from "../i18n";
import { capabilities } from "../lib/capabilities";
import { errorMessage } from "../lib/errors";
import { PageHeader, Card, Empty, Field } from "../components/ui";
import { capRow } from "../lib/capsI18n";

// Deployment profile and VM allocation policy (GET/PUT /host/profile, /host/allocation): the labels come from
// the API in English, so known ids are translated here and unknown ones fall back to the API text.
function AllocationCard() {
  const t = useT();
  const admin = capabilities(useAuthStore((s) => s.role)).admin;
  const pushToast = useInfraStore((s) => s.pushToast);
  const [data, setData] = useState(null);
  const [profile, setProfile] = useState("auto");
  const [policy, setPolicy] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetchHostProfile().then((d) => { setData(d); setProfile(d.choix in d.profils ? d.choix : "auto"); setPolicy(d.allocation.actif); }).catch(() => setData(false)); }, []);
  if (data === false) return null;
  if (!data) return <Card title={t("cp.alloc")}><p className="nx-muted" style={{ margin: 0 }}>{t("loading")}</p></Card>;
  const tr = (prefix, id, field, fallback) => { const k = `${prefix}.${id}.${field}`; const v = t(k); return v === k ? fallback : v; };
  const alloc = data.allocation;
  const pForced = data.source === "configuration";
  const aForced = alloc.source === "configuration";
  const initialProfile = data.choix in data.profils ? data.choix : "auto";
  const dirty = profile !== initialProfile || policy !== alloc.actif;
  const settings = data.reglages;

  async function save() {
    setBusy(true);
    try {
      let d = data;
      if (profile !== initialProfile) d = await setHostProfile(profile);
      if (policy !== alloc.actif) d = await setHostAllocation(policy);
      setData(d); setProfile(d.choix in d.profils ? d.choix : "auto"); setPolicy(d.allocation.actif);
      pushToast({ kind: "success", title: t("cp.saved") });
    } catch (e) { pushToast({ kind: "error", title: t("cp.saveFailed"), message: errorMessage(e) }); }
    finally { setBusy(false); }
  }

  return (
    <Card title={t("cp.alloc")}>
      <div className="nx-fg nx-fg--1">
        <Field label={t("cp.profile")} hint={t("cp.profileHint", { ram: Math.round(settings.memory_host_share * 100), disk: Math.round(settings.disk_free_share * 100), s: settings.metrics_interval_s })}>
          {(p) => (
            <select {...p} className="nx-inp" aria-label={t("a11y.deployment_profile")} value={profile} disabled={!admin || busy || pForced} onChange={(e) => setProfile(e.target.value)}>
              <option value="auto">{t("cp.auto", { name: tr("prof", data.recommande, "label", data.profils[data.recommande].libelle) })}</option>
              {Object.entries(data.profils).map(([k, v]) => <option key={k} value={k}>{tr("prof", k, "label", v.libelle)}</option>)}
            </select>
          )}
        </Field>
        <p className="nx-muted" style={{ margin: 0, fontSize: "var(--fs-125)" }}>{tr("prof", data.actif, "desc", settings.description)}</p>
        {pForced && <p className="nx-tone-warning" style={{ margin: 0 }}>{t("cp.profileForced")}</p>}
        <Field label={t("cp.policy")}>
          {(p) => (
            <select {...p} className="nx-inp" aria-label={t("a11y.resource_allocation_policy")} value={policy} disabled={!admin || busy || aForced} onChange={(e) => setPolicy(e.target.value)}>
              {Object.entries(alloc.politiques).map(([k, v]) => <option key={k} value={k}>{tr("alloc", k, "label", v.libelle)}</option>)}
            </select>
          )}
        </Field>
        <p className="nx-muted" style={{ margin: 0, fontSize: "var(--fs-125)" }}>{tr("alloc", policy, "desc", alloc.politiques[policy]?.description)}</p>
        {aForced && <p className="nx-tone-warning" style={{ margin: 0 }}>{t("cp.policyForced")}</p>}
      </div>
      <div className="nx-fa">
        <span className="nx-fa-l">{t("cp.defaults", { vcpu: data.vm_defaults_effectifs.vcpu, mem: data.vm_defaults_effectifs.memory_mb, disk: data.vm_defaults_effectifs.disk_gb })}</span>
        {admin && <button type="button" className="nx-btn" disabled={!dirty || busy} onClick={save}>{t("sso.save")}</button>}
      </div>
    </Card>
  );
}

const yes = (v) => v === true || ["oui", "yes", "present", "available", "importable"].includes(String(v).toLowerCase());
const no = (v) => v === false || ["non", "no", "absent", "unavailable"].includes(String(v).toLowerCase());

// Node comparison: what differs between machines, a prerequisite to a migration or to adding a node.
// Informational rows (RAM, CPU model…) always differ and are reported separately from blocking ones.
export default function CompatibilityPage() {
  const t = useT();
  const nodes = useInfraStore((s) => s.nodes);
  const [profiles, setProfiles] = useState({});
  const [errors, setErrors] = useState({});
  const [onlyDiff, setOnlyDiff] = useState(true);

  // Keyed on ids: the store replaces the array on every refresh and that must not reset the table.
  const nodeKey = nodes.map((n) => n.id).join("|");
  useEffect(() => {
    setProfiles({}); setErrors({});
    nodeKey.split("|").filter(Boolean).forEach((id) => {
      fetchNodeCapabilitiesById(id).then((p) => setProfiles((prev) => ({ ...prev, [id]: p }))).catch((e) => setErrors((prev) => ({ ...prev, [id]: errorMessage(e) })));
    });
  }, [nodeKey]);

  const loaded = useMemo(() => nodes.filter((n) => profiles[n.id]), [nodes, profiles]);
  const rows = useMemo(() => compareNodes(Object.fromEntries(loaded.map((n) => [n.id, profiles[n.id]]))).map((r) => ({ ...capRow(t, { ...r, value: null }), values: r.values })), [loaded, profiles, t]);
  const shown = onlyDiff && loaded.length > 1 ? rows.filter((r) => r.differe) : rows;
  const blocking = rows.filter((r) => r.differe && !r.informatif);
  const nameOf = (id) => nodes.find((n) => n.id === id)?.nom || id;
  const cell = (v) => (v === NA ? <span className="nx-muted">{t("ns.notReported")}</span>
    : yes(v) ? <span className="nx-st nx-tone-success"><Check size={14} aria-hidden="true" />{t("cp.yes")}</span>
    : no(v) ? <span className="nx-st" data-tone="offline"><X size={14} aria-hidden="true" />{t("cp.no")}</span>
    : <span className="nx-mono">{String(v)}</span>);

  return (
    <>
      <PageHeader title={t("tab.compat")} desc={t("cp.desc")} />
      <div className="nx-cols2">
        <Card title={t("cp.title")} flush note={loaded.length > 1 ? t("cp.diffNote") : null}
          actions={loaded.length > 1 && <label className="nx-check"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> {t("cp.onlyDiff")}</label>}>
          {Object.entries(errors).map(([id, msg]) => <p key={id} className="nx-error-inline" role="alert" style={{ margin: "0 var(--space-4) var(--space-2)" }}>{t("cp.nodeError", { node: nameOf(id) })} <span className="nx-mono">{msg}</span></p>)}
          {loaded.length > 1 && (
            <div className="nx-bn" data-tone={blocking.length ? "warning" : "success"} role="status" style={{ margin: "0 var(--space-4) var(--space-3)" }}>
              <span className="nx-bn-t">{blocking.length ? t("cp.blocking", { n: blocking.length, list: blocking.map((r) => r.label).join(", ") }) : t("cp.same")}</span>
            </div>
          )}
          {loaded.length === 1 && <p className="nx-muted" style={{ margin: "0 var(--space-4) var(--space-3)" }}>{t("cp.oneNode")}</p>}
          {loaded.length === 0 && Object.keys(errors).length === 0 ? <p className="nx-muted" role="status" style={{ padding: "0 var(--space-4) var(--space-4)" }}>{t("cp.detecting")}</p> : shown.length === 0 ? (
            <Empty title={t("cp.noDiff")} />
          ) : (
            <div className="nx-tablewrap" role="region" aria-label={t("cp.title")} tabIndex={0}>
              <table className="nx-table">
                <thead><tr><th scope="col">{t("cp.capability")}</th>{loaded.map((n) => <th scope="col" key={n.id}>{n.nom}</th>)}</tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.key} className={r.differe && !r.informatif ? "is-diff" : ""}>
                      <th scope="row" style={{ fontWeight: 500 }}>{r.section} : {r.label}{r.differe && (r.informatif ? ` (${t("cp.info")})` : ` — ${t("cp.differs")}`)}</th>
                      {loaded.map((n) => <td key={n.id}>{cell(r.values[n.id])}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <AllocationCard />
      </div>
    </>
  );
}
CompatibilityPage.ownHeader = true;
