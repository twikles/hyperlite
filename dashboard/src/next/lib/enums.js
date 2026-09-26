import { translate, useLangStore } from "../i18n";
// Wire values (French, immutable contracts) -> presentation: shape + tone + i18n key.
// A state is always carried by shape + text + colour, never colour alone.
const VM_STATES = {
  actif: { key: "state.running", shape: "dot", tone: "success" },
  arrete: { key: "state.stopped", shape: "square", tone: "offline" },
  en_arret: { key: "state.shuttingdown", shape: "square", tone: "offline" },
  en_pause: { key: "state.paused", shape: "pause", tone: "info" },
  suspendu: { key: "state.suspended", shape: "half", tone: "info" },
  bloque: { key: "state.blocked", shape: "triangle", tone: "warning" },
  plante: { key: "state.crashed", shape: "diamond", tone: "danger" },
  inconnu: { key: "state.unknown", shape: "ring", tone: "unknown" },
};
const NODE_STATES = {
  online: { key: "state.online", shape: "dot", tone: "success" },
  erreur: { key: "state.offline", shape: "ring", tone: "offline" },
};
const POOL_STATES = {
  actif: { key: "state.active", shape: "dot", tone: "success" },
  degrade: { key: "state.degraded", shape: "triangle", tone: "warning" },
  inactif: { key: "state.inactive", shape: "square", tone: "offline" },
  inaccessible: { key: "state.unreachable", shape: "diamond", tone: "danger" },
  en_construction: { key: "state.building", shape: "ring", tone: "info" },
  inconnu: { key: "state.unknown", shape: "ring", tone: "unknown" },
};
const TASK_STATES = {
  en_cours: { key: "state.inprogress", shape: "spinner", tone: "info" },
  termine: { key: "state.done", shape: "check", tone: "success" },
  echec: { key: "state.failed", shape: "cross", tone: "danger" },
};
const TABLES = { vm: VM_STATES, container: VM_STATES, node: NODE_STATES, pool: POOL_STATES, storage: POOL_STATES, task: TASK_STATES };
const UNKNOWN = VM_STATES.inconnu;

export function stateInfo(kind, wire) {
  return (TABLES[kind] || VM_STATES)[wire] || UNKNOWN;
}

// Severity used to bubble the worst state of the children up to a parent row.
const SEVERITY = { danger: 4, warning: 3, info: 1, offline: 1, unknown: 1, success: 0, accent: 0 };
export function severity(info) { return SEVERITY[info.tone] ?? 0; }

export const TASK_LABEL_KEYS = {
  start_vm: "Start VM", stop_vm: "Stop VM", force_stop_vm: "Force stop VM", restart_vm: "Restart VM", delete_vm: "Delete VM",
  create_vm: "Create VM", auto_install: "Automatic installation", update_vm: "Update VM resources", create_snapshot: "Create snapshot",
  restore_snapshot: "Restore snapshot", delete_snapshot: "Delete snapshot", clone_vm: "Clone VM", migrate_vm: "Migrate VM",
  backup_vm: "Back up VM", restore_backup: "Restore backup", export_vm: "Export VM", run_job: "Run job", upload_iso: "Upload ISO",
  upload_vm_disk: "Upload disk", create_container: "Create container", clone_container: "Clone container",
  backup_container: "Back up container", hyperlite_update: "Hyperlite update", host_shell: "Host shell",
};
// Task labels follow the interface language (keys task.type.<type>); unknown types show their wire value.
export function taskLabel(type) {
  const lang = useLangStore.getState().lang;
  const key = `task.type.${type}`;
  const v = translate(lang, key);
  return v === key ? TASK_LABEL_KEYS[type] || type : v;
}
