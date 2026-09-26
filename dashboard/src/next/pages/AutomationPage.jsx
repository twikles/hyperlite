import { useCallback, useEffect, useState } from "react";
import { fetchJobs, fetchJob, createJob, deleteJob, runJob, fetchJobRuns, fetchJobRun } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { confirmAction } from "../../store/useConfirmStore";
import { useT, useLangStore } from "../i18n";
import { capabilities } from "../lib/capabilities";
import { errorMessage } from "../lib/errors";
import StatusIndicator from "../components/StatusIndicator";
import { ErrorState } from "../components/States";
import { PageHeader, Card, Empty, SideDrawer, Field, Chip } from "../components/ui";
import { Clock, Play, Plus, Trash2, Zap } from "lucide-react";

const newStep = () => ({ cible_type: "host", cible: "", commande: "", condition_type: "exit_code", condition_valeur: "0" });
const runWire = (s) => (s === "succes" ? "termine" : s === "echec" ? "echec" : "en_cours");
const targetLabel = (s, t) => (s.cible_type === "host" ? t("au.host") : s.cible_type === "vm" ? `VM ${s.cible}` : t("au.eachTarget"));

const jobName = (job, t) => { const k = `au.pre.${job.predefined_key}.name`; const v = job.predefined_key ? t(k) : k; return v === k ? job.name : v; };
const jobDesc = (job, t) => { const k = `au.pre.${job.predefined_key}.desc`; const v = job.predefined_key ? t(k) : k; return v === k ? job.description : v; };

// Automation: jobs are ordered shell steps on the host or on VMs. A real run always shows the exact
// commands first (a dry run only previews); run history refreshes by itself while a run is in progress.
export default function AutomationPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const caps = capabilities(useAuthStore((s) => s.role));
  const pushToast = useInfraStore((s) => s.pushToast);
  const [jobs, setJobs] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState({});   // job id -> {steps}
  const [runs, setRuns] = useState({});
  const [runOpen, setRunOpen] = useState(null);
  const [runDetail, setRunDetail] = useState(null);
  const [targets, setTargets] = useState({});
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", steps: [newStep()] });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try { const j = await fetchJobs(); setJobs(Array.isArray(j) ? j : []); setError(null); } catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const loadRuns = useCallback(async (id) => {
    try { const r = await fetchJobRuns(id); setRuns((p) => ({ ...p, [id]: Array.isArray(r) ? r : [] })); }
    catch (e) { pushToast({ kind: "error", title: t("au.historyError"), message: errorMessage(e) }); }
  }, [pushToast, t]);

  // while the expanded job has a run in progress, refresh its history every 3 s
  const running = open != null && (runs[open] || []).some((r) => r.statut !== "succes" && r.statut !== "echec");
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => loadRuns(open), 3000);
    return () => clearInterval(id);
  }, [running, open, loadRuns]);

  async function toggle(job) {
    if (open === job.id) { setOpen(null); return; }
    setOpen(job.id); setRunOpen(null);
    loadRuns(job.id);
    if (!detail[job.id]) fetchJob(job.id).then((d) => setDetail((p) => ({ ...p, [job.id]: d }))).catch(() => {});
  }
  async function showRun(id) {
    if (runOpen === id) { setRunOpen(null); return; }
    setRunOpen(id); setRunDetail(null);
    try { setRunDetail(await fetchJobRun(id)); } catch (e) { pushToast({ kind: "error", title: t("au.detailError"), message: errorMessage(e) }); }
  }

  async function run(job, dry) {
    const list = (targets[job.id] || "").split(",").map((x) => x.trim()).filter(Boolean);
    let steps = detail[job.id]?.steps;
    if (!steps) { try { steps = (await fetchJob(job.id)).steps; } catch { steps = null; } }
    const needsTargets = (steps || []).some((s) => s.cible_type === "chaque_cible");
    if (needsTargets && list.length === 0) { pushToast({ kind: "error", title: t("au.needTargets"), message: t("au.needTargetsHelp") }); return; }
    if (!dry) {
      const cmds = steps ? steps.map((s, i) => `${i + 1}. [${targetLabel(s, t)}] ${s.commande}`).join("  •  ") : t("au.stepsUnknown");
      if (!(await confirmAction({ title: t("au.runTitle", { name: job.name }), message: `${t("au.runMsg", { n: list.length })} ${cmds}`, confirmLabel: t("au.run"), danger: true }))) return;
    }
    try {
      await runJob(job.id, list, dry);
      pushToast({ kind: "success", title: dry ? t("au.dryStarted") : t("au.runStarted"), message: job.name });
      setOpen(job.id); loadRuns(job.id);
      setTimeout(() => loadRuns(job.id), 1200);
    } catch (e) { pushToast({ kind: "error", title: t("au.launchFailed"), message: errorMessage(e) }); }
  }

  const problems = (s) => ({
    commande: !s.commande.trim(),
    cible: s.cible_type === "vm" && !(s.cible || "").trim(),
    valeur: s.condition_type === "stdout_contains" ? !(s.condition_valeur || "").trim() : !/^-?\d+$/.test((s.condition_valeur ?? "").trim()),
  });
  const formOk = form.name.trim() && form.steps.length > 0 && form.steps.every((s) => !Object.values(problems(s)).some(Boolean));
  const upd = (i, patch) => setForm((f) => ({ ...f, steps: f.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));

  async function create(e) {
    e?.preventDefault();
    setTouched(true);
    if (!formOk) return;
    setBusy(true);
    try {
      await createJob({ ...form, name: form.name.trim(), steps: form.steps.map((s) => ({ ...s, cible: s.cible_type === "vm" ? s.cible.trim() : null })) });
      pushToast({ kind: "success", title: t("au.created"), message: form.name });
      setCreating(false); setTouched(false); setForm({ name: "", description: "", steps: [newStep()] }); await reload();
    } catch (er) { pushToast({ kind: "error", title: t("nt.createFailed"), message: errorMessage(er) }); }
    finally { setBusy(false); }
  }
  async function remove(job) {
    if (!(await confirmAction({ title: t("au.deleteTitle", { name: job.name }), message: t("au.deleteMsg"), confirmLabel: t("menu.delete").replace("…", ""), danger: true }))) return;
    try { await deleteJob(job.id); pushToast({ kind: "success", title: t("au.deleted"), message: job.name }); await reload(); }
    catch (e) { pushToast({ kind: "error", title: t("nt.deleteFailed"), message: errorMessage(e) }); }
  }

  const list = jobs || [];
  const bad = (cond) => touched && cond;
  const selected = list.find((j) => j.id === open) || null;
  const closeForm = () => { setCreating(false); setTouched(false); };

  return (
    <>
      <PageHeader title={t("tab.automation")} count={jobs ? list.length : null} desc={t("au.desc")}
        actions={caps.admin && <button type="button" className="nx-btn nx-btn--primary" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" />{t("au.create")}</button>} />
      {error && jobs == null ? <ErrorState message={error} onRetry={reload} /> : (
        <div className="nx-cols2">
          <Card title={t("au.available")}>
            {jobs == null ? <p className="nx-muted" role="status" style={{ margin: 0 }}>{t("loading")}</p> : list.length === 0 ? <Empty icon={Zap} title={t("au.none")} /> : (
              <div className="nx-stack">
                {list.map((job) => (
                  <div key={job.id} className={`nx-tile nx-tile--static${open === job.id ? " is-sel" : ""}`}>
                    <div className="nx-inline"><b>{jobName(job, t)}</b>{job.predefined_key && <Chip>{t("au.predefined")}</Chip>}<span className="nx-sp" />
                      <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" aria-pressed={open === job.id} aria-label={t("a11y.show_run_history_of_x", { v: job.name })} onClick={() => toggle(job)}><Clock size={14} aria-hidden="true" />{t("au.history")}</button>
                      {caps.admin && !job.predefined_key && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" aria-label={t("a11y.delete_job_x", { v: job.name })} title={t("menu.delete").replace("…", "")} onClick={() => remove(job)}><Trash2 size={15} aria-hidden="true" /></button>}
                    </div>
                    {jobDesc(job, t) && <small>{jobDesc(job, t)}</small>}
                    {caps.admin && (
                      <div className="nx-inline" style={{ marginTop: "var(--space-2)" }}>
                        <input className="nx-inp nx-mono" style={{ flex: 1, minWidth: "12rem" }} aria-label={t("a11y.targets_for_x_vms_separated_by_commas", { v: job.name })} placeholder={t("au.targets")} value={targets[job.id] || ""} onChange={(e) => setTargets((x) => ({ ...x, [job.id]: e.target.value }))} />
                        <button type="button" className="nx-btn nx-btn--sm" aria-label={t("a11y.dry_run_x", { v: job.name })} onClick={() => run(job, true)}>{t("au.dry")}</button>
                        <button type="button" className="nx-btn nx-btn--primary nx-btn--sm" aria-label={t("a11y.run_x", { v: job.name })} onClick={() => run(job, false)}><Play size={14} aria-hidden="true" />{t("au.run")}</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title={t("au.history")} note={selected ? jobName(selected, t) : null}>
            {!selected ? <Empty icon={Clock} title={t("au.pickJob")} text={t("au.pickJobHelp")} /> : (
              <div className="nx-stack">
                {detail[selected.id]?.steps?.length > 0 && (
                  <ol className="nx-steps" aria-label={t("au.steps")}>{detail[selected.id].steps.map((st) => <li key={st.id ?? st.ordre}><span className="nx-muted">[{targetLabel(st, t)}]</span> <code className="nx-mono">{st.commande}</code></li>)}</ol>
                )}
                {!runs[selected.id] ? <p className="nx-muted" role="status" style={{ margin: 0 }}>{t("loading")}</p> : runs[selected.id].length === 0 ? <Empty icon={Clock} title={t("au.noRuns")} text={t("au.noRunsHelp")} /> : (
                  <ul className="nx-list2">
                    {runs[selected.id].map((r) => (
                      <li key={r.id} style={{ flexWrap: "wrap" }}>
                        <StatusIndicator kind="task" wire={runWire(r.statut)} compact />
                        <div className="nx-list2-main">
                          <button type="button" className="nx-lnk" style={{ fontWeight: 500 }} aria-expanded={runOpen === r.id} onClick={() => showRun(r.id)}>{new Date(r.started_at).toLocaleString(lang)}</button>
                          <div className="nx-list2-sub">{r.dry_run ? t("au.dryRun") : t("au.real")}{r.resultat ? ` · ${r.resultat}` : ""}</div>
                        </div>
                        {runOpen === r.id && (
                          <div style={{ flexBasis: "100%" }}>
                            {!runDetail ? <span className="nx-muted">{t("loading")}</span> : runDetail.logs.length === 0 ? <span className="nx-muted">{t("au.noLogs")}</span> : (
                              <pre className="nx-logs" tabIndex={0} aria-label={t("au.logs")}>{runDetail.logs.map((l) => `${l.reussi ? "✓" : "✗"} [${l.cible}] ${l.commande} → exit=${l.exit_code}${l.stdout ? `\n${l.stdout.trim().slice(0, 2000)}` : ""}`).join("\n")}</pre>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>
        </div>
      )}

      <SideDrawer open={creating} title={t("au.create")} onClose={closeForm} busy={busy} footer={<>
        <button type="button" className="nx-btn" onClick={() => setForm((f) => ({ ...f, steps: [...f.steps, newStep()] }))}>{t("au.addStep")}</button>
        <span className="nx-sp" />
        <button type="button" className="nx-btn nx-btn--ghost" onClick={closeForm} disabled={busy}>{t("action.cancel")}</button>
        <button type="button" className="nx-btn nx-btn--primary" disabled={busy} onClick={create}>{busy ? t("stor.creating") : t("au.createBtn")}</button>
      </>}>
        <Field label={t("au.jobName")} error={bad(!form.name.trim()) ? t("nt.required") : null}>{(p) => <input {...p} className="nx-inp" aria-label={t("a11y.job_name")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label={t("au.description")}>{(p) => <input {...p} className="nx-inp" aria-label={t("a11y.description_optional")} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
        {form.steps.map((st, i) => {
          const pb = problems(st);
          return (
            <fieldset key={i} className="nx-fs nx-stepbox">
              <legend>{t("au.step", { n: i + 1 })}</legend>
              <div className="nx-fg">
                <Field label={t("au.target")}>{(p) => <select {...p} className="nx-inp" aria-label={t("a11y.step_target_type")} value={st.cible_type} onChange={(e) => upd(i, { cible_type: e.target.value })}><option value="host">{t("au.host")}</option><option value="vm">{t("au.aVm")}</option><option value="chaque_cible">{t("au.eachTarget")}</option></select>}</Field>
                {st.cible_type === "vm" && <Field label={t("au.vmName")} error={bad(pb.cible) ? t("nt.required") : null}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.vm_name")} value={st.cible || ""} onChange={(e) => upd(i, { cible: e.target.value })} />}</Field>}
                <Field label={t("au.condition")}>{(p) => <select {...p} className="nx-inp" aria-label={t("a11y.success_condition_type")} value={st.condition_type} onChange={(e) => upd(i, { condition_type: e.target.value, condition_valeur: e.target.value === "exit_code" ? "0" : "" })}><option value="exit_code">{t("au.exitCode")}</option><option value="stdout_contains">{t("au.contains")}</option></select>}</Field>
                <Field label={t("au.conditionValue")} error={bad(pb.valeur) ? t(st.condition_type === "exit_code" ? "au.badInt" : "nt.required") : null}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.success_condition_value")} value={st.condition_valeur || ""} onChange={(e) => upd(i, { condition_valeur: e.target.value })} />}</Field>
              </div>
              <Field label={t("au.command")} error={bad(pb.commande) ? t("nt.required") : null}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.shell_command")} value={st.commande} onChange={(e) => upd(i, { commande: e.target.value })} placeholder="systemctl status nginx" />}</Field>
              {form.steps.length > 1 && <div><button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" aria-label={t("a11y.remove_step_x", { v: i + 1 })} onClick={() => setForm((f) => ({ ...f, steps: f.steps.filter((_, k) => k !== i) }))}><Trash2 size={14} aria-hidden="true" />{t("sec.remove")}</button></div>}
            </fieldset>
          );
        })}
      </SideDrawer>
    </>
  );
}
AutomationPage.ownHeader = true;
