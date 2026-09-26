import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Archive, Camera, ChevronDown, Copy, CopyPlus, Eraser, Heart, LayoutTemplate, Link, MoveHorizontal, Play, Plus, Power, RefreshCw,
  RotateCw, Share, Square, SquareTerminal, Trash2,
} from "lucide-react";
import {
  cloneVM, createTemplateFromVM, createBackup, exportVM, fetchHaProtected, enableHa, disableHa,
  fetchVMAutoCleanup, setVMAutoCleanup, disableVMAutoCleanup,
} from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { confirmAction } from "../../store/useConfirmStore";
import { promptText } from "../../store/usePromptStore";
import { useT } from "../i18n";
import { capabilities, vmActionState } from "../lib/capabilities";
import { useVmActions } from "../lib/vmActions";
import { errorMessage } from "../lib/errors";
import { requestIntent } from "../lib/intents";
import Menu, { MenuItem } from "./Menu";
import MigrateDialog from "./MigrateDialog";
import { SideDrawer, Field } from "./ui";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}$/;

function MenuGroup({ label }) { return <div className="nx-menu-group" role="presentation">{label}</div>; }

// Automatic clean-up of a stopped VM after N days: same endpoints and rules as the historical screen.
function CleanupDrawer({ vm, state, onClose, onSaved }) {
  const t = useT();
  const pushToast = useInfraStore((s) => s.pushToast);
  const [days, setDays] = useState(String(state?.active ? state.inactive_days : 7));
  const [busy, setBusy] = useState(false);
  const n = Number(days);
  const bad = !Number.isInteger(n) || n < 1 || n > 365;
  async function save() {
    setBusy(true);
    try { await setVMAutoCleanup(vm.nom, n); pushToast({ kind: "success", title: t("vc.enabled"), message: t("vc.enabledMsg", { name: vm.nom, n }) }); onSaved({ active: true, inactive_days: n }); onClose(); }
    catch (e) { pushToast({ kind: "error", title: t("vc.failed"), message: errorMessage(e) }); } finally { setBusy(false); }
  }
  async function off() {
    setBusy(true);
    try { await disableVMAutoCleanup(vm.nom); pushToast({ kind: "success", title: t("vc.disabled"), message: vm.nom }); onSaved({ active: false }); onClose(); }
    catch (e) { pushToast({ kind: "error", title: t("vc.failed"), message: errorMessage(e) }); } finally { setBusy(false); }
  }
  return (
    <SideDrawer open title={t("vc.title", { name: vm.nom })} onClose={onClose} busy={busy} footer={<>
      {state?.active && <button type="button" className="nx-btn nx-btn--danger" disabled={busy} onClick={off}>{t("vc.disable")}</button>}
      <span className="nx-sp" />
      <button type="button" className="nx-btn nx-btn--ghost" disabled={busy} onClick={onClose}>{t("action.cancel")}</button>
      <button type="button" className="nx-btn nx-btn--primary" disabled={busy || bad} onClick={save}>{state?.active ? t("vc.update") : t("vc.enable")}</button>
    </>}>
      <p className="nx-muted" style={{ margin: 0 }}>{t("vc.help")}</p>
      <Field label={t("vc.days")} unit={t("vc.daysUnit")} error={bad ? t("vc.daysRule") : null}>
        {(p) => <input {...p} className="nx-inp nx-mono" type="number" min={1} max={365} aria-label={t("a11y.inactivity_threshold_in_days")} value={days} onChange={(e) => setDays(e.target.value)} />}
      </Field>
      <p className="nx-f-h" style={{ margin: 0 }}>{t("vc.note")}</p>
    </SideDrawer>
  );
}

// VM header: the contextual primary (Console when running, Start when stopped), Stop, and ONE grouped Actions
// menu holding every other operation (power, protection, lifecycle, links, delete). Unavailable entries stay
// listed and say why.
export function VmHeaderActions({ vm, currentTab, setTab }) {
  const t = useT();
  const caps = capabilities(useAuthStore((s) => s.role));
  const { nodes, pushToast, refreshAll, navigateTo } = useInfraStore(useShallow((s) => ({ nodes: s.nodes, pushToast: s.pushToast, refreshAll: s.refreshAll, navigateTo: s.navigateTo })));
  const vmActions = useVmActions();
  const [open, setOpen] = useState(false);
  const [migrate, setMigrate] = useState(false);
  const [cleanup, setCleanup] = useState(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [ha, setHa] = useState(null);
  const btn = useRef(null);
  const running = vm.etat === "actif";
  const act = (a) => vmActionState(a, vm, caps);
  const admin = (state = { enabled: true }) => (caps.admin ? state : { enabled: false, reason: "menu.reason.admin" });
  const stopped = running ? { enabled: false, reason: "menu.reason.mustStop" } : { enabled: true };
  const targets = nodes.filter((n) => n.id !== vm.node && n.etat === "online");
  const mig = !caps.admin ? { enabled: false, reason: "menu.reason.admin" } : !running ? { enabled: false, reason: "menu.reason.notRunning" } : targets.length === 0 ? { enabled: false, reason: "mig.noTarget" } : { enabled: true };

  useEffect(() => {
    if (!open || !caps.admin) return;
    fetchHaProtected().then((r) => setHa((Array.isArray(r) ? r : []).some((x) => x.vm_name === vm.nom))).catch(() => setHa(null));
    fetchVMAutoCleanup(vm.nom).then(setCleanup).catch(() => setCleanup(null));
  }, [open, caps.admin, vm.nom]);

  const close = () => setOpen(false);
  const fail = (title, e) => pushToast({ kind: "error", title, message: errorMessage(e) });

  async function clone() {
    const name = await promptText({ title: t("vx.cloneTitle", { name: vm.nom }), message: t("vx.cloneMsg"), label: t("vx.cloneName"), defaultValue: `${vm.nom}-clone`, confirmLabel: t("vx.clone"), validate: (v) => (NAME_RE.test(v) ? "" : t("vx.nameRule")) });
    if (!name) return;
    try { await cloneVM(vm.nom, name.trim()); pushToast({ kind: "success", title: t("vx.cloned"), message: `${vm.nom} → ${name.trim()}` }); refreshAll?.(); }
    catch (e) { fail(t("vx.cloneFailed"), e); }
  }
  async function toTemplate() {
    const name = await promptText({ title: t("vx.tplTitle", { name: vm.nom }), message: t("vx.tplMsg"), label: t("vx.tplName"), defaultValue: vm.nom, confirmLabel: t("vx.tpl"), validate: (v) => (NAME_RE.test(v) ? "" : t("vx.nameRule")) });
    if (!name) return;
    try { await createTemplateFromVM(vm.nom, name.trim()); pushToast({ kind: "success", title: t("vx.tplDone"), message: name.trim() }); refreshAll?.(); navigateTo("datacenter", null, "templates"); }
    catch (e) { fail(t("vx.tplFailed"), e); }
  }
  async function backupNow() {
    try { await createBackup(vm.nom); pushToast({ kind: "success", title: t("vb.started"), message: vm.nom }); setTab("backup"); }
    catch (e) { fail(t("vb.startFailed"), e); }
  }
  async function doExport() {
    try { await exportVM(vm.nom); pushToast({ kind: "success", title: t("vx.exportStarted"), message: t("vx.exportMsg", { name: vm.nom }) }); }
    catch (e) { fail(t("vx.exportFailed"), e); }
  }
  async function toggleHa() {
    const on = !!ha;
    if (!(await confirmAction({ title: t(on ? "vx.haOffTitle" : "vx.haOnTitle", { name: vm.nom }), message: t(on ? "vx.haOffMsg" : "vx.haOnMsg"), confirmLabel: t(on ? "vx.haOff" : "vx.haOn"), danger: on }))) return;
    try {
      if (on) await disableHa(vm.nom); else await enableHa(vm.nom, vm.node);
      setHa(!on);
      pushToast({ kind: "success", title: t(on ? "vx.haOffDone" : "vx.haOnDone"), message: vm.nom });
    } catch (e) { fail(t("vx.haFailed"), e); }
  }
  async function remove() {
    if (!(await confirmAction({ title: t("vx.deleteTitle", { name: vm.nom }), message: t("vx.deleteMsg"), confirmLabel: t("vx.delete"), danger: true }))) return;
    try { await useInfraStore.getState().runVMAction(vm.nom, "delete"); navigateTo("datacenter", null, "vms"); }
    catch { /* the store already shows the error */ }
  }
  function snapshot() {
    requestIntent("snapshot", vm.nom);
    if (currentTab !== "snapshots") setTab("snapshots");
  }

  const item = (key, Icon, label, state, run, extra = {}) => (
    <MenuItem key={key} danger={extra.danger} disabled={!state.enabled} reason={state.reason ? t(state.reason) : undefined} onSelect={() => { close(); run(); }}>
      <Icon size={16} aria-hidden="true" />{label}{!state.enabled && state.reason ? <span className="nx-menu-k" aria-hidden="true">{t(state.reason)}</span> : extra.k ? <span className="nx-menu-k">{extra.k}</span> : null}
    </MenuItem>
  );

  const c = act("console"); const st = act("start"); const sp = act("stop");
  return (
    <div className="nx-oh-acts">
      {running
        ? <HeadBtn primary state={c} icon={SquareTerminal} label={t("actions.primary.console")} onClick={() => vmActions.openConsole(vm)} />
        : <HeadBtn primary state={st} icon={Play} label={t("menu.start")} onClick={() => vmActions.run(vm, "start")} />}
      {(running || sp.enabled) && <HeadBtn state={sp} icon={Square} label={t("menu.stop")} onClick={() => vmActions.run(vm, "stop")} />}
      <span className="nx-relative">
        <button ref={btn} type="button" className="nx-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{t("actions")}<ChevronDown size={14} aria-hidden="true" /></button>
        <Menu open={open} onClose={close} label={t("actions")} returnFocusRef={btn} style={{ top: "calc(100% + 4px)", right: 0 }}>
          <MenuGroup label={t("vx.g.power")} />
          {item("restart", RotateCw, t("menu.restart"), act("restart"), () => vmActions.run(vm, "restart"))}
          {item("force-stop", Power, t("menu.forceStop"), act("force-stop"), () => vmActions.run(vm, "force-stop"), { danger: true })}
          <hr />
          <MenuGroup label={t("vx.g.protection")} />
          {item("snapshot", Camera, t("vx.snapshot"), admin(), snapshot)}
          {item("backup", Archive, t("vb.now"), admin(), backupNow)}
          {item("ha", Heart, ha ? t("vx.haProtected") : t("vx.haMenu"), admin(), toggleHa)}
          <hr />
          <MenuGroup label={t("vx.g.lifecycle")} />
          {item("clone", CopyPlus, t("vx.cloneMenu"), admin(stopped), clone)}
          {item("migrate", MoveHorizontal, t("head.migrate"), mig, () => setMigrate(true))}
          {item("template", LayoutTemplate, t("vx.tplMenu"), admin(stopped), toTemplate)}
          {item("export", Share, t("vx.exportMenu"), admin(), doExport)}
          {item("cleanup", Eraser, cleanup?.active ? t("vx.cleanupOn", { n: cleanup.inactive_days }) : t("vx.cleanupMenu"), admin(), () => setCleanupOpen(true))}
          <hr />
          {item("link", Link, t("menu.copyLink"), { enabled: true }, () => navigator.clipboard?.writeText(window.location.href))}
          {vm.ip && item("ip", Copy, t("menu.copyIp"), { enabled: true }, () => navigator.clipboard?.writeText(vm.ip))}
          <hr />
          {item("delete", Trash2, t("vx.deleteMenu"), admin(stopped), remove, { danger: true })}
        </Menu>
      </span>
      {migrate && <MigrateDialog vm={vm} targets={targets} onClose={() => setMigrate(false)} />}
      {cleanupOpen && <CleanupDrawer vm={vm} state={cleanup} onClose={() => setCleanupOpen(false)} onSaved={setCleanup} />}
    </div>
  );
}

// Node header: one Actions menu (no other button, the Shell is a tab).
export function NodeHeaderActions({ node, setTab }) {
  const t = useT();
  const caps = capabilities(useAuthStore((s) => s.role));
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const local = node.id === "local";
  const close = () => setOpen(false);
  const create = !caps.create ? { enabled: false, reason: "menu.reason.admin" } : !local ? { enabled: false, reason: "node.createLocalOnly" } : { enabled: true };
  const shell = !caps.hostShell ? { enabled: false, reason: "menu.reason.admin" } : !local ? { enabled: false, reason: "node.shellLocalOnly" } : { enabled: true };
  const item = (key, Icon, label, state, run) => (
    <MenuItem key={key} disabled={!state.enabled} reason={state.reason ? t(state.reason) : undefined} onSelect={() => { close(); run(); }}>
      <Icon size={16} aria-hidden="true" />{label}{!state.enabled && state.reason ? <span className="nx-menu-k" aria-hidden="true">{t(state.reason)}</span> : null}
    </MenuItem>
  );
  return (
    <div className="nx-oh-acts">
      <span className="nx-relative">
        <button ref={btn} type="button" className="nx-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{t("actions")}<ChevronDown size={14} aria-hidden="true" /></button>
        <Menu open={open} onClose={close} label={t("actions")} returnFocusRef={btn} style={{ top: "calc(100% + 4px)", right: 0 }}>
          {item("vm", Plus, t("node.createVm"), create, () => window.dispatchEvent(new CustomEvent("nx:wizard", { detail: "vm" })))}
          {item("shell", SquareTerminal, t("node.openShell"), shell, () => setTab("shell"))}
          <hr />
          {item("link", Link, t("menu.copyLink"), { enabled: true }, () => navigator.clipboard?.writeText(window.location.href))}
          {item("caps", RefreshCw, t("node.refreshCaps"), { enabled: true }, () => window.dispatchEvent(new CustomEvent("nx:node-refresh", { detail: node.id })))}
        </Menu>
      </span>
    </div>
  );
}

function HeadBtn({ state, label, onClick, primary, icon: Icon }) {
  const t = useT();
  return (
    <button type="button" className={`nx-btn${primary ? " nx-btn--primary" : ""}`} aria-disabled={!state.enabled || undefined} title={!state.enabled && state.reason ? t(state.reason) : undefined} onClick={() => state.enabled && onClick()}>
      {Icon && <Icon size={15} aria-hidden="true" />}{label}{!state.enabled && state.reason && <span className="nx-sr"> — {t(state.reason)}</span>}
    </button>
  );
}
