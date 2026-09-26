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
import ProgressBar from "../../components/ProgressBar";
import StatusIndicator from "../components/StatusIndicator";
import { EmptyState, ErrorState } from "../components/States";

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

  return (
    <div className="nx-ns">
      <section className="nx-card" aria-labelledby="vs-title">
        <div className="nx-cardhead">
          <h2 id="vs-title">{t("tab.snapshots")} <span className="nx-count">{snaps ? list.length : "…"}</span></h2>
          {caps.admin && <button id="vs-create" type="button" className="nx-btn nx-btn--primary" disabled={busy} onClick={create}>{t("vs.create")}</button>}
        </div>
        {list.length >= 3 && <p className="nx-notice nx-notice--warning" role="status">{t(zfs ? "vs.manyZfs" : "vs.manyQcow", { n: list.length })}</p>}
        {job && (
          <div className="nx-notice" role="status" aria-live="polite">
            <div className="nx-cardhead"><strong>{job.label}</strong><span className="nx-muted nx-mono">{elapsed(job.startedAt)}</span></div>
            <ProgressBar indeterminate statut="en_cours" />
            <span className="nx-hint">{zfs ? t("vs.zfsNote") : t("vs.qcowNote")}</span>
          </div>
        )}
        {snaps == null ? <p className="nx-muted" role="status">{t("loading")}</p> : list.length === 0 ? <EmptyState title={t("vs.none")} help={caps.admin ? t("vs.noneHelp") : undefined} /> : (
          <div className="nx-tablewrap">
            <table className="nx-table">
              <thead><tr><th scope="col">{t("ct.name")}</th><th scope="col">{t("vs.kind")}</th><th scope="col">{t("vm.created")}</th><th scope="col">{t("vm.description")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.nom}>
                    <th scope="row" className="nx-mono" style={{ paddingLeft: `calc(var(--space-3) + ${depthOf(s) * 1.25}rem)` }}>{s.nom} {s.actuel && <span className="nx-tag">{t("vs.current")}</span>}</th>
                    <td>{kind(s)}</td>
                    <td className="nx-mono">{formatDateTime(s.date_creation, lang) || "—"}</td>
                    <td>{s.description || <span className="nx-muted">—</span>}</td>
                    <td className="nx-num nx-rowactions">
                      {caps.admin && <button type="button" className="nx-btn" disabled={busy} aria-label={`Restore snapshot ${s.nom}`} onClick={() => restore(s)}>{t("vs.restore")}</button>}
                      {caps.admin && <button type="button" className="nx-btn nx-btn--danger" disabled={busy} aria-label={`Delete snapshot ${s.nom}`} onClick={() => remove(s)}>{t("menu.delete").replace("…", "")}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
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
    e.preventDefault();
    if (problems.heure || problems.retention) return;
    setBusy(true);
    try { const s = await setBackupSchedule(vm.nom, { ...form, retention_count: ret }); setSchedule(s); pushToast({ kind: "success", title: t("vb.scheduleSaved"), message: `${t(`vb.f.${form.frequence}`)} · ${form.heure} UTC` }); }
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
    <div className="nx-ns">
      <section className="nx-card" aria-labelledby="vb-sched">
        <div className="nx-cardhead">
          <h2 id="vb-sched">{t("vb.schedule")}</h2>
          {caps.admin && <button type="button" className="nx-btn nx-btn--primary" disabled={busy} onClick={now}>{t("vb.now")}</button>}
        </div>
        <form className="nx-form" onSubmit={save} noValidate>
          <div className="nx-formgrid">
            <label>{t("vb.frequency")}<select className="nx-input" aria-label="Backup frequency" disabled={!caps.admin} value={form.frequence} onChange={(e) => setForm({ ...form, frequence: e.target.value })}><option value="quotidien">{t("vb.f.quotidien")}</option><option value="hebdomadaire">{t("vb.f.hebdomadaire")}</option><option value="mensuel">{t("vb.f.mensuel")}</option></select></label>
            <label>{t("vb.time")}<input className="nx-input" aria-label="Backup time" type="time" disabled={!caps.admin} value={form.heure} onChange={(e) => setForm({ ...form, heure: e.target.value })} aria-invalid={problems.heure || undefined} /><span className="nx-hint">{t("vb.utc")}</span></label>
            <label>{t("vb.retention")}<input className="nx-input" aria-label="Retention (backups kept)" type="number" min={1} max={365} disabled={!caps.admin} value={form.retention_count} onChange={(e) => setForm({ ...form, retention_count: e.target.value })} aria-invalid={problems.retention || undefined} />{problems.retention && <span className="nx-hint nx-hint--error">{t("vb.retentionRule")}</span>}</label>
          </div>
          {schedule && <p className="nx-muted" style={{ margin: 0 }}>{t("vb.next")}: <span className="nx-mono">{schedule.prochaine_execution ? new Date(schedule.prochaine_execution).toLocaleString(lang) : "—"}</span>{schedule.derniere_execution && <> · {t("vb.last")}: <span className="nx-mono">{new Date(schedule.derniere_execution).toLocaleString(lang)}</span></>}</p>}
          {caps.admin && (
            <div className="nx-formactions">
              {schedule && <button type="button" className="nx-btn" disabled={busy} onClick={disable}>{t("nt.disable")}</button>}
              <button type="submit" className="nx-btn nx-btn--primary" disabled={busy || !dirty || problems.heure || problems.retention}>{t("sso.save")}</button>
            </div>
          )}
        </form>
      </section>

      <section className="nx-card" aria-labelledby="vb-list">
        <div className="nx-cardhead"><h2 id="vb-list">{t("tab.backup")} <span className="nx-count">{backups ? list.length : "…"}</span></h2></div>
        {caps.admin && !stopped && list.some((b) => b.statut === "termine") && <p className="nx-hint">{t("vb.stopToRestore")}</p>}
        {backups == null ? <p className="nx-muted" role="status">{t("loading")}</p> : list.length === 0 ? <EmptyState title={t("vb.none")} help={t("vb.noneHelp")} /> : (
          <div className="nx-tablewrap">
            <table className="nx-table">
              <thead><tr><th scope="col">{t("ns.col.state")}</th><th scope="col">{t("act.started")}</th><th scope="col">{t("vb.mode")}</th><th scope="col" className="nx-num">{t("ct.size")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.id}>
                    <td><StatusIndicator kind="task" wire={taskWire(b.statut)} /></td>
                    <td className="nx-mono">{new Date(b.cree_le).toLocaleString(lang)}{b.erreur && <div className="nx-hint nx-hint--error">{b.erreur}</div>}</td>
                    <td>{b.mode === "chaud" ? t("vb.hot") : t("vb.cold")}</td>
                    <td className="nx-num nx-mono">{size(b.taille_octets)}</td>
                    <td className="nx-num nx-rowactions">
                      {caps.admin && b.statut === "termine" && <button type="button" className="nx-btn" disabled={!stopped} title={!stopped ? t("vb.stopToRestore") : undefined} aria-label={`Restore backup #${b.id} in place`} onClick={() => restoreInPlace(b)}>{t("vb.inPlace")}</button>}
                      {caps.admin && b.statut === "termine" && <button type="button" className="nx-btn" aria-label={`Restore backup #${b.id} to a new VM`} onClick={() => restoreNew(b)}>{t("vb.newVm")}</button>}
                      {caps.admin && (b.statut === "termine" || b.statut === "echec") && <button type="button" className="nx-btn nx-btn--danger" aria-label={`Delete backup #${b.id}`} onClick={() => remove(b)}>{t("menu.delete").replace("…", "")}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
