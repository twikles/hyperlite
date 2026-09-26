import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot, fetchTaskDetail,
  fetchVMBackups, createBackup, deleteBackup, restoreBackup, fetchBackupSchedule, setBackupSchedule, deleteBackupSchedule,
} from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { confirmAction } from "../../store/useConfirmStore";
import { promptText } from "../../store/usePromptStore";
import { useT, useLangStore } from "../i18n";
import { capabilities } from "../lib/capabilities";
import { useIntent } from "../lib/intents";
import { errorMessage } from "../lib/errors";
import { formatSizeMb, formatDateTime } from "../lib/format";
import StatusIndicator from "../components/StatusIndicator";
import { ErrorState } from "../components/States";
import { PageHeader, Card, Empty, Field } from "../components/ui";
import { Archive, Camera, LoaderCircle, Trash2, TriangleAlert } from "lucide-react";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}$/;
const SNAP_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const taskWire = (s) => (s === "termine" ? "termine" : s === "echec" ? "echec" : "en_cours");

const nowMs = () => Date.now();
const elapsed = (from) => { const s = Math.max(0, Math.round((nowMs() - from) / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };

// ---- Snapshots -------------------------------------------------------------------------------------------

// create / restore answer 202 + a task id: the page follows the real task (bounded at 5 minutes, stopped when
// the page is left) instead of inventing a percentage libvirt does not expose.
export function VmSnapshotsPage({ resource: vm }) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const caps = capabilities(useAuthStore((s) => s.role));
  const pushToast = useInfraStore((s) => s.pushToast);
  const [snaps, setSnaps] = useState(null);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  const [, tick] = useState(0);
  const alive = useRef(true);
  const vmName = vm?.nom;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!job) return undefined; const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, [job]);

  const reload = useCallback(async () => {
    try { const r = await fetchSnapshots(vmName); setSnaps(Array.isArray(r) ? r : []); setError(null); } catch (e) { setError(errorMessage(e)); }
  }, [vmName]);
  useEffect(() => { if (vmName) reload(); }, [vmName, reload]);
  // VM ▸ Actions ▸ Create a snapshot opens this tab and starts the creation dialog once the list is loaded.
  useIntent("snapshot", (name) => { if (name === vmName) document.getElementById("vs-create")?.click(); }, snaps != null);

  const waitTask = useCallback(async (id) => {
    for (let i = 0; i < 300; i++) {
      if (!alive.current) return { statut: "abandonne" };
      const task = await fetchTaskDetail(id);
      if (task.statut !== "en_cours") return task;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { statut: "echec", erreur: t("vs.stillRunning") };
  }, [t]);

  if (!vm) return null;
  if (error && snaps == null) return <ErrorState message={error} onRetry={reload} />;
  const zfs = Boolean(vm.stockage_zfs);
  const busy = job != null;
  const list = snaps || [];

  async function run(label, start, okTitle, failTitle) {
    setJob({ label, startedAt: nowMs() });
    try {
      const { task_id } = await start();
      const done = await waitTask(task_id);
      if (done.statut === "termine") pushToast({ kind: "success", title: okTitle });
      else if (done.statut !== "abandonne") pushToast({ kind: "error", title: failTitle, message: done.erreur || t("err.unknown") });
      if (alive.current) await reload();
    } catch (e) { pushToast({ kind: "error", title: failTitle, message: errorMessage(e) }); }
    finally { if (alive.current) setJob(null); }
  }

  async function create() {
    const auto = `snap-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    const name = await promptText({ title: t("vs.createTitle"), label: t("vs.name"), defaultValue: auto, confirmLabel: t("vs.create"), validate: (v) => (!SNAP_RE.test(v) ? t("vs.nameRule") : list.some((s) => s.nom === v) ? t("vs.nameTaken") : "") });
    if (!name) return;
    run(t("vs.creating", { name }), () => createSnapshot(vm.nom, name.trim(), "Created from the dashboard"), t("vs.created"), t("vs.createFailed"));
  }
  async function restore(s) {
    const running = vm.etat === "actif";
    if (!(await confirmAction({ title: t("vs.restoreTitle", { name: s.nom }), message: t("vs.restoreMsg") + (running && s.etat_vm === "stopped" ? ` ${t("vs.restoreRunning")}` : ""), confirmLabel: t("vs.restore"), danger: true }))) return;
    run(t("vs.restoring", { name: s.nom }), () => restoreSnapshot(vm.nom, s.nom), t("vs.restored"), t("vs.restoreFailed"));
  }
  async function remove(s) {
    if (!(await confirmAction({ title: t("vs.deleteTitle", { name: s.nom }), message: t("vs.deleteMsg"), confirmLabel: t("menu.delete").replace("…", ""), danger: true }))) return;
    try { await deleteSnapshot(vm.nom, s.nom); pushToast({ kind: "success", title: t("vs.deleted"), message: s.nom }); await reload(); }
    catch (e) { pushToast({ kind: "error", title: t("vs.deleteFailed"), message: errorMessage(e) }); }
  }

  const depthOf = (s, seen = new Set()) => { if (!s.parent || seen.has(s.nom)) return 0; seen.add(s.nom); const p = list.find((x) => x.nom === s.parent); return p ? 1 + depthOf(p, seen) : 0; };
  const kind = (s) => (s.etat_vm === "disque_seul" ? t("vs.zfsDisk") : s.etat_vm === "running" ? t("vs.withMemory") : s.etat_vm ? t("vs.diskOnly") : "—");

  const sorted = [...list].sort((x, y) => Number(y.date_creation || 0) - Number(x.date_creation || 0));
  return (
    <>
      <PageHeader level={2} title={t("tab.snapshots")} count={snaps ? list.length : null} desc={t("vs.desc")}
        actions={caps.admin && <button id="vs-create" type="button" className="nx-btn nx-btn--primary" disabled={busy} onClick={create}><Camera size={15} aria-hidden="true" />{t("vs.create")}</button>} />
      {list.length >= 3 && <div className="nx-bn" data-tone="warning" role="status"><TriangleAlert size={16} aria-hidden="true" /><span className="nx-bn-t">{t(zfs ? "vs.manyZfs" : "vs.manyQcow", { n: list.length })}</span></div>}
      {job && (
        <div className="nx-bn" data-tone="info" role="status" aria-live="polite">
          <LoaderCircle size={16} className="nx-spin" aria-hidden="true" />
          <span className="nx-bn-t"><b>{job.label}</b> <span className="nx-mono nx-muted">{elapsed(job.startedAt)}</span><br /><span className="nx-muted">{zfs ? t("vs.zfsNote") : t("vs.qcowNote")}</span></span>
        </div>
      )}
      <div className="nx-card2">
        <div className="nx-card2-b">
          {snaps == null ? <p className="nx-muted" role="status" style={{ margin: 0 }}>{t("loading")}</p> : (
            <ol className="nx-tl" aria-label={t("vs.timeline")}>
              <li className="nx-tl-it is-now"><b>{t("vs.now")}</b><div className="nx-tl-m">{t("vs.nowSub")}</div></li>
              {sorted.map((s) => (
                <li key={s.nom} className="nx-tl-it" style={{ marginLeft: `${depthOf(s) * 1.25}rem` }}>
                  <div className="nx-inline" style={{ alignItems: "flex-start" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b className="nx-mono">{s.nom}</b> {s.actuel && <span className="nx-chip" data-tone="accent">{t("vs.current")}</span>}
                      <div className="nx-tl-m">{[formatDateTime(s.date_creation, lang), kind(s), s.parent ? t("vs.after", { name: s.parent }) : null].filter(Boolean).join(" · ")}</div>
                      {s.description && <div className="nx-muted" style={{ fontSize: "var(--fs-13)" }}>{s.description}</div>}
                    </div>
                    {caps.admin && <div className="nx-ra">
                      <button type="button" className="nx-btn nx-btn--sm" disabled={busy} aria-label={`Restore snapshot ${s.nom}`} onClick={() => restore(s)}>{t("vs.restore")}</button>
                      <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" disabled={busy} aria-label={`Delete snapshot ${s.nom}`} title={t("menu.delete").replace("…", "")} onClick={() => remove(s)}><Trash2 size={15} aria-hidden="true" /></button>
                    </div>}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {snaps && list.length === 0 && <Empty icon={Camera} title={t("vs.none")} text={caps.admin ? t("vs.noneHelp") : null} />}
        </div>
      </div>
    </>
  );
}

// ---- Backups ---------------------------------------------------------------------------------------------
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export function VmBackupPage({ resource: vm }) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const caps = capabilities(useAuthStore((s) => s.role));
  const pushToast = useInfraStore((s) => s.pushToast);
  const vms = useInfraStore((s) => s.vms);
  const [backups, setBackups] = useState(null);
  const [error, setError] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [form, setForm] = useState({ frequence: "quotidien", heure: "02:00", retention_count: 7 });
  const [busy, setBusy] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const vmName = vm?.nom;

  const reload = useCallback(async () => {
    if (!vmName) return;
    try { const b = await fetchVMBackups(vmName); setBackups(Array.isArray(b) ? b : []); setError(null); } catch (e) { setError(errorMessage(e)); }
    fetchBackupSchedule(vmName).then((s) => { setSchedule(s || null); if (s) setForm({ frequence: s.frequence, heure: s.heure, retention_count: s.retention_count }); }).catch(() => {});
  }, [vmName]);
  useEffect(() => { reload(); }, [reload]);
  const running = Boolean(backups?.some((b) => b.statut !== "termine" && b.statut !== "echec"));
  useEffect(() => { if (!running) return undefined; const id = setInterval(reload, 4000); return () => clearInterval(id); }, [running, reload]);

  if (!vm) return null;
  if (error && backups == null) return <ErrorState message={error} onRetry={reload} />;
  const list = backups || [];
  const stopped = vm.etat !== "actif";
  const ret = Number(form.retention_count);
  const problems = { heure: !TIME_RE.test(form.heure || ""), retention: !Number.isInteger(ret) || ret < 1 || ret > 365 };
  const dirty = !schedule || schedule.frequence !== form.frequence || schedule.heure !== form.heure || schedule.retention_count !== ret;
  const fail = (title) => (e) => pushToast({ kind: "error", title, message: errorMessage(e) });

  async function now() {
    setBusy(true);
    try { await createBackup(vm.nom); pushToast({ kind: "success", title: t("vb.started"), message: vm.nom }); setTimeout(reload, 1500); } catch (e) { fail(t("vb.startFailed"))(e); } finally { setBusy(false); }
  }
  async function save(e) {
    e?.preventDefault();
    if (problems.heure || problems.retention) return;
    setBusy(true);
    try { const s = await setBackupSchedule(vm.nom, { ...form, retention_count: ret }); setSchedule(s); setEnabling(false); pushToast({ kind: "success", title: t("vb.scheduleSaved"), message: `${t(`vb.f.${form.frequence}`)} · ${form.heure} UTC` }); }
    catch (er) { fail(t("vb.scheduleFailed"))(er); } finally { setBusy(false); }
  }
  async function disable() {
    if (!(await confirmAction({ title: t("vb.disableTitle"), message: t("vb.disableMsg", { name: vm.nom }), confirmLabel: t("nt.disable"), danger: true }))) return;
    setBusy(true);
    try { await deleteBackupSchedule(vm.nom); setSchedule(null); pushToast({ kind: "success", title: t("vb.scheduleOff"), message: vm.nom }); } catch (er) { fail(t("vb.scheduleFailed"))(er); } finally { setBusy(false); }
  }
  async function remove(b) {
    if (!(await confirmAction({ title: t("vb.deleteTitle", { id: b.id }), message: t("vb.deleteMsg"), confirmLabel: t("menu.delete").replace("…", ""), danger: true }))) return;
    try { await deleteBackup(b.id); pushToast({ kind: "success", title: t("vb.deleted"), message: `#${b.id}` }); await reload(); } catch (er) { fail(t("vb.deleteFailed"))(er); }
  }
  async function restoreInPlace(b) {
    if (!stopped) return;
    if (!(await confirmAction({ title: t("vb.overwriteTitle", { name: vm.nom }), message: t("vb.overwriteMsg"), confirmLabel: t("vs.restore"), danger: true }))) return;
    try { await restoreBackup(b.id, "overwrite"); pushToast({ kind: "success", title: t("vb.restoreStarted") }); await reload(); } catch (er) { fail(t("vb.restoreFailed"))(er); }
  }
  async function restoreNew(b) {
    const taken = new Set(vms.map((v) => v.nom));
    const name = await promptText({ title: t("vb.newTitle", { id: b.id }), label: t("tp.newName"), defaultValue: `${vm.nom}-restored`, confirmLabel: t("vs.restore"), validate: (v) => (!NAME_RE.test(v) ? t("ct.nameRule") : taken.has(v) ? t("tp.nameTaken") : "") });
    if (!name) return;
    try { await restoreBackup(b.id, "new", name.trim()); pushToast({ kind: "success", title: t("vb.restoreStarted"), message: name.trim() }); } catch (er) { fail(t("vb.restoreFailed"))(er); }
  }
  const size = (bytes) => (bytes ? formatSizeMb(bytes / 1048576, lang) : "—");

  return (
    <>
      <PageHeader level={2} title={t("tab.backups")} count={backups ? list.length : null} desc={t("vb.desc")}
        actions={caps.admin && <button type="button" className="nx-btn nx-btn--primary" disabled={busy} onClick={now}><Archive size={15} aria-hidden="true" />{t("vb.now")}</button>} />
      <div className="nx-cols2">
        <Card title={t("vb.history")} flush={list.length > 0}>
          {caps.admin && !stopped && list.some((b) => b.statut === "termine") && <p className="nx-f-h" style={{ margin: "0 var(--space-4) var(--space-3)" }}>{t("vb.stopToRestore")}</p>}
          {backups == null ? <p className="nx-muted" role="status" style={{ margin: 0 }}>{t("loading")}</p> : list.length === 0 ? <Empty icon={Archive} title={t("vb.none")} text={t("vb.noneHelp")} /> : (
            <div className="nx-tablewrap">
              <table className="nx-table">
                <thead><tr><th scope="col">{t("ns.col.state")}</th><th scope="col">{t("vm.created")}</th><th scope="col">{t("vb.mode")}</th><th scope="col" className="nx-num">{t("ct.size")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
                <tbody>
                  {list.map((b) => (
                    <tr key={b.id}>
                      <td><StatusIndicator kind="task" wire={taskWire(b.statut)} /></td>
                      <td className="nx-mono">{formatDateTime(b.cree_le, lang)}{b.erreur && <div className="nx-f-h is-error nx-wrapcell">{b.erreur}</div>}</td>
                      <td>{b.mode === "chaud" ? t("vb.hot") : t("vb.cold")}</td>
                      <td className="nx-num nx-mono">{size(b.taille_octets)}</td>
                      <td><div className="nx-ra">
                        {caps.admin && b.statut === "termine" && <button type="button" className="nx-btn nx-btn--sm" aria-disabled={!stopped || undefined} title={!stopped ? t("vb.stopToRestore") : undefined} aria-label={`Restore backup #${b.id} in place`} onClick={() => restoreInPlace(b)}>{t("vb.inPlace")}</button>}
                        {caps.admin && b.statut === "termine" && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" aria-label={`Restore backup #${b.id} to a new VM`} onClick={() => restoreNew(b)}>{t("vb.newVm")}</button>}
                        {caps.admin && (b.statut === "termine" || b.statut === "echec") && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" aria-label={`Delete backup #${b.id}`} title={t("menu.delete").replace("…", "")} onClick={() => remove(b)}><Trash2 size={15} aria-hidden="true" /></button>}
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title={t("vb.planning")}>
          <div className="nx-inline" style={{ marginBottom: "var(--space-4)" }}>
            <button type="button" className="nx-sw" role="switch" aria-checked={Boolean(schedule) || enabling} aria-label={t("vb.scheduleSwitch")} disabled={!caps.admin || busy} onClick={() => (schedule ? disable() : setEnabling((v) => !v))} />
            <span>{schedule ? t("vb.enabled") : enabling ? t("vb.toEnable") : t("vb.disabled")}</span>
          </div>
          <div className="nx-fg nx-fg--1">
            <Field label={t("vb.frequency")}>{(p) => <select {...p} className="nx-inp" aria-label="Backup frequency" disabled={!caps.admin} value={form.frequence} onChange={(e) => setForm({ ...form, frequence: e.target.value })}><option value="quotidien">{t("vb.f.quotidien")}</option><option value="hebdomadaire">{t("vb.f.hebdomadaire")}</option><option value="mensuel">{t("vb.f.mensuel")}</option></select>}</Field>
            <Field label={t("vb.time")} hint={t("vb.utc")} error={problems.heure ? t("vb.timeRule") : null}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label="Backup time" type="time" disabled={!caps.admin} value={form.heure} onChange={(e) => setForm({ ...form, heure: e.target.value })} />}</Field>
            <Field label={t("vb.retention")} unit={t("vb.copies")} error={problems.retention ? t("vb.retentionRule") : null}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label="Retention (backups kept)" type="number" min={1} max={365} disabled={!caps.admin} value={form.retention_count} onChange={(e) => setForm({ ...form, retention_count: e.target.value })} />}</Field>
          </div>
          {caps.admin && (
            <div className="nx-fa">
              <span className="nx-fa-l">{schedule?.prochaine_execution ? `${t("vb.next")} : ${formatDateTime(schedule.prochaine_execution, lang)}` : ""}{schedule?.derniere_execution ? ` · ${t("vb.last")} ${formatDateTime(schedule.derniere_execution, lang)}` : ""}</span>
              <button type="button" className="nx-btn" disabled={busy || (!dirty && Boolean(schedule)) || problems.heure || problems.retention} onClick={save}>{t("sso.save")}</button>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
