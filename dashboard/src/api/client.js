// Single entry point for all the application's data. Everything comes from the
// real Hyperlite backend (the same paths as the real FastAPI routes, see
// vite.config.js for the dev proxy).

let taskIdCounter = 0;
export function makeTaskId() {
  taskIdCounter += 1;
  return `task-${Date.now()}-${taskIdCounter}`;
}

let token = null;
export function setAuthToken(t) {
  token = t;
}
export function getAuthToken() {
  return token;
}

// Called when the backend rejects the session token (expired, revoked): the auth
// store registers a handler that returns the user to the sign-in page.
let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

// FastAPI answers `detail` as a string, a list of strings or (validation, 422) a list of
// {loc, msg, type} objects; joining the latter used to print "[object Object]".
function formatDetail(d) {
  if (d == null) return "";
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map(formatDetail).filter(Boolean).join(" ; ");
  if (typeof d === "object") {
    if (d.msg) {
      const where = Array.isArray(d.loc) ? d.loc.filter((p) => p !== "body").join(".") : "";
      return where ? `${where}: ${d.msg}` : d.msg;
    }
    try { return JSON.stringify(d); } catch { return String(d); }
  }
  return String(d);
}

async function realFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, { ...opts, headers });
  } catch {
    throw new Error("Cannot reach the server. Check your network connection and try again.");
  }
  let data = null;
  let parsed = true;
  try { data = await res.json(); } catch { parsed = false; }
  if (res.status === 401 && token && !path.startsWith("/auth/login")) unauthorizedHandler?.();
  if (res.ok && !parsed && (res.headers.get("content-type") || "").includes("application/json")) {
    throw new Error("The server returned an unreadable response.");
  }
  if (!res.ok) {
    const msg = (data && data.detail) ? (formatDetail(data.detail) || "Unknown error") : "Unknown error";
    throw new Error(msg);
  }
  return data;
}

function jsonBody(payload) {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

export function mountVMDriversIso(name, iso) {
  return realFetch(`/vms/${encodeURIComponent(name)}/cdrom`, { method: "PUT", ...jsonBody({ iso, target_dev: "hdd" }) });
}

export function ejectVMDriversIso(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/cdrom?target_dev=hdd`, { method: "DELETE" });
}

// Per-VM resource limits derived from the real host (GET /host/limits), which
// replace the 1-2 vCPU / 256-2048 MB bounds that were hard-coded in the forms.
export async function fetchHostLimits() {
  return realFetch("/host/limits");
}

export async function fetchDashboardSummary() {
  return realFetch("/dashboard");
}

// Live figures of a node recorded by the backend metrics collector (null until it has been sampled once).
function liveFields(l) {
  return {
    cpu_coeurs: l?.cores ?? null,
    cpu_modele: l?.cpu_model ?? null,
    cpu_utilisation: l?.cpu_pct ?? null,
    memoire_totale_mo: l?.mem_total_mb ?? null,
    memoire_utilisee_mo: l?.mem_used_mb ?? null,
    noyau: l?.kernel ?? null,
    os: l?.os ?? null,
    version_hyperviseur: l?.version_hyperviseur ?? null,
    version_libvirt: l?.version_libvirt ?? null,
    mesure_le: l?.mesure_le ?? null,
  };
}

export async function fetchNodes() {
  const d = await fetchDashboardSummary();
  const localNode = {
    // "local" is an internal SENTINEL identifier for "the host running this Hyperlite
    // instance", never a real machine name. The real name (d.hyperviseur.nom) is
    // displayed everywhere; only this `id` is used for internal comparisons.
    id: "local",
    nom: d.hyperviseur.nom,
    etat: d.hyperviseur.connecte ? "online" : "erreur",
    ...liveFields(d.live),
    memoire_disponible_mo: d.memoire_disponible_mo,
    stockage_total_go: d.stockage.capacite_go,
    stockage_utilise_go: d.stockage.capacite_go != null && d.stockage.disponible_go != null
      ? Math.round((d.stockage.capacite_go - d.stockage.disponible_go) * 100) / 100 : null,
    uptime_s: d.live?.uptime_s ?? d.hyperviseur.uptime_s,
    ip: d.live?.address ?? null,
    version: `Hyperlite (${d.hyperviseur.type})`,
    vms_actives: d.vms.actives,
    vms_arretees: d.vms.arretees,
  };

  // Registered remote nodes. They used to be missing here: this function only ever
  // returned a single synthetic "local" node, so a remote node that was really
  // registered and working on the backend (GET /nodes) stayed invisible in the main
  // tree. It was a real bug reported when testing a real second physical node (only
  // the dedicated "Nodes" tab, which queries /nodes directly, showed it).
  let remoteNodes = [];
  try {
    const remotes = await fetchRemoteNodes();
    remoteNodes = await Promise.all(remotes.map(async (n) => {
      let s = null;
      try { s = await fetchRemoteNodeSummary(n.name); } catch { /* node unreachable for now: degrade instead of failing the whole dashboard */ }
      return {
        id: n.name,
        nom: n.name,
        etat: s ? (s.connecte ? "online" : "erreur") : (n.statut === "en_ligne" ? "online" : "erreur"),
        ...liveFields(n.live ?? s?.live),
        memoire_disponible_mo: null,
        stockage_total_go: s?.stockage_capacite_go ?? null,
        stockage_utilise_go: s && s.stockage_capacite_go != null && s.stockage_disponible_go != null
          ? Math.round((s.stockage_capacite_go - s.stockage_disponible_go) * 100) / 100 : null,
        uptime_s: (n.live ?? s?.live)?.uptime_s ?? null,
        ip: n.hostname,
        ssh_port: n.ssh_port,
        ssh_user: n.ssh_user,
        version: "Hyperlite (remote)",
        vms_actives: s?.vms_actives ?? 0,
        vms_arretees: s?.vms_arretees ?? 0,
        distant: true,
      };
    }));
  } catch { /* GET /nodes unavailable: stay on the local node alone, as before this fix */ }

  return [localNode, ...remoteNodes];
}

// GET /vms does not return every statistic displayed by this dashboard yet
// (detailed disk, tags...): they are completed with default values until a richer
// GET /vms exists.
function mapVm(v, nodeId) {
  return {
    nom: v.nom, node: nodeId, type: "vm", etat: v.etat,
    vcpu: v.vcpu, memoire_mo: v.memoire_mo, memoire_utilisee_mo: null,
    disque_go: null, disque_utilise_go: null,
    ip: v.ip, utilisateur_ssh: v.utilisateur_ssh, uuid: v.uuid,
    os: v.os, uptime_s: v.uptime_s,
    // This mapping whitelists the fields, so a field added on the backend
    // (stockage_zfs, see app/routers/vms.py::_domain_summary) is silently dropped
    // here unless it is listed: VMSnapshotsTab.jsx would always receive `undefined`.
    stockage_zfs: v.stockage_zfs,
  };
}

export async function fetchVMs() {
  const localVms = await realFetch("/vms");
  let result = localVms.map((v) => mapVm(v, "local"));

  // Registered remote nodes: they were never queried here before (node hard-coded
  // to "local" for everyone), so the VMs of a remote node never appeared in the main
  // tree despite a successful registration on the backend. GET /vms now accepts a
  // node= parameter (see app/routers/vms.py).
  try {
    const remotes = await fetchRemoteNodes();
    const remoteLists = await Promise.all(remotes.map(async (n) => {
      try {
        const vms = await realFetch(`/vms?node=${encodeURIComponent(n.name)}`);
        return vms.map((v) => mapVm(v, n.name));
      } catch { return []; /* node unreachable for now */ }
    }));
    result = result.concat(...remoteLists);
  } catch { /* GET /nodes unavailable: stay on the local node alone */ }

  return result;
}

function mapPool(p, nodeId) {
  // `type` used to be hard-coded to "dir" here. That was harmless as long as
  // GET /storage never returned a real `type` field (all existing pools really were
  // "dir"), but it would have silently masked the new real field once NFS pools
  // existed on the backend.
  return { nom: p.nom, node: nodeId, type: p.type, etat: p.etat, capacite_go: p.capacite_go, disponible_go: p.disponible_go, chemin: p.chemin ?? null };
}

export async function fetchStoragePools() {
  const localPools = await realFetch("/storage");
  let result = localPools.map((p) => mapPool(p, "local"));

  try {
    const remotes = await fetchRemoteNodes();
    const remoteLists = await Promise.all(remotes.map(async (n) => {
      try {
        const pools = await realFetch(`/storage?node=${encodeURIComponent(n.name)}`);
        return pools.map((p) => mapPool(p, n.name));
      } catch { return []; }
    }));
    result = result.concat(...remoteLists);
  } catch { /* GET /nodes unavailable */ }

  return result;
}

export async function fetchNetworks() {
  const nets = await realFetch("/networks");
  return nets.map((n) => ({ nom: n.nom, type: n.type, pont: n.pont, actif: n.actif, reseau: n.reseau, autostart: n.autostart, dhcp: n.dhcp, vms: n.vms }));
}
export async function fetchNetworkDetail(name) {
  return realFetch(`/networks/${encodeURIComponent(name)}`);
}
export async function createNetwork(payload) {
  return realFetch("/networks", { method: "POST", ...jsonBody(payload) });
}
export async function deleteNetwork(name) {
  return realFetch(`/networks/${encodeURIComponent(name)}?confirm=true`, { method: "DELETE" });
}

// ---- Network firewall (real: GET/PUT /networks/{name}/firewall), distinct from
// the per-VM firewall: it filters at the bridge level, not at the interface level ----
export async function fetchNetworkFirewall(name) {
  return realFetch(`/networks/${encodeURIComponent(name)}/firewall`);
}
export async function setNetworkFirewall(name, payload) {
  return realFetch(`/networks/${encodeURIComponent(name)}/firewall`, { method: "PUT", ...jsonBody(payload) });
}

// ---- Per-VM firewall (real: GET/PUT /vms/{name}/firewall, libvirt nwfilter) ----
export async function fetchVMFirewall(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/firewall`);
}
export async function setVMFirewall(name, payload) {
  return realFetch(`/vms/${encodeURIComponent(name)}/firewall`, { method: "PUT", ...jsonBody(payload) });
}

// ---- Native backups (real: GET/POST /vms/{name}/backups, DELETE /backups/{id},
// POST /backups/{id}/restore, GET/PUT/DELETE /vms/{name}/backup-schedule; see
// app/routers/backups.py) ----
export async function fetchAllBackups() {
  return realFetch("/backups");
}
export async function fetchVMBackups(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/backups`);
}
export async function createBackup(name, targetDir = null) {
  return realFetch(`/vms/${encodeURIComponent(name)}/backups`, { method: "POST", ...jsonBody({ target_dir: targetDir }) });
}
export async function deleteBackup(id) {
  return realFetch(`/backups/${id}?confirm=true`, { method: "DELETE" });
}
export async function restoreBackup(id, mode, newName = null) {
  return realFetch(`/backups/${id}/restore`, { method: "POST", ...jsonBody({ mode, new_name: newName }) });
}
export async function fetchBackupSchedule(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/backup-schedule`);
}
export async function setBackupSchedule(name, payload) {
  return realFetch(`/vms/${encodeURIComponent(name)}/backup-schedule`, { method: "PUT", ...jsonBody(payload) });
}
export async function deleteBackupSchedule(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/backup-schedule`, { method: "DELETE" });
}

export async function fetchIsoTemplates() {
  return realFetch("/isos");
}
export async function deleteIso(filename) {
  return realFetch(`/isos/${encodeURIComponent(filename)}?confirm=true`, { method: "DELETE" });
}

// ---- Importable disks (importing a VM from a disk file) ----
export async function fetchVmDisks() {
  return realFetch("/vm-disks");
}
export async function deleteVmDisk(filename) {
  return realFetch(`/vm-disks/${encodeURIComponent(filename)}`, { method: "DELETE" });
}

// ---- VM export ----
export async function fetchVmExports() {
  return realFetch("/vm-exports");
}
export async function exportVM(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/export`, { method: "POST" });
}
export async function deleteVmExport(filename) {
  return realFetch(`/vm-exports/${encodeURIComponent(filename)}`, { method: "DELETE" });
}
export async function downloadVmExport(filename) {
  const { ticket } = await realFetch(`/vm-exports/${encodeURIComponent(filename)}/download-ticket`, { method: "POST" });
  window.open(`/vm-exports/download?ticket=${encodeURIComponent(ticket)}`, "_blank");
}

// ---- Audit journal (real: the audit_log table, fed by every action) ----
export async function fetchAuditLog(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") params.set(k, v);
  });
  const qs = params.toString();
  return realFetch(`/audit${qs ? `?${qs}` : ""}`);
}
export async function fetchAuditActions() {
  return realFetch("/audit/actions");
}

// ---- Automation: the job engine (real: /jobs, see app/routers/jobs.py) ----
export async function fetchJobs() {
  return realFetch("/jobs");
}
export async function fetchJob(id) {
  return realFetch(`/jobs/${id}`);
}
export async function createJob(payload) {
  return realFetch("/jobs", { method: "POST", ...jsonBody(payload) });
}
export async function deleteJob(id) {
  return realFetch(`/jobs/${id}`, { method: "DELETE" });
}
export async function runJob(id, targets, dryRun) {
  return realFetch(`/jobs/${id}/run`, { method: "POST", ...jsonBody({ targets, dry_run: dryRun }) });
}
export async function fetchJobRuns(id) {
  return realFetch(`/jobs/${id}/runs`);
}
export async function fetchJobRun(runId) {
  return realFetch(`/jobs/runs/${runId}`);
}

// ---- Multi-node (real: /nodes, see app/routers/nodes.py) ----
export async function fetchRemoteNodes() {
  return realFetch("/nodes");
}
export async function fetchClusterPubkey() {
  return realFetch("/nodes/cluster-pubkey");
}
export async function addRemoteNode(payload) {
  return realFetch("/nodes", { method: "POST", ...jsonBody(payload) });
}
export async function fetchRemoteNodeSummary(name) {
  return realFetch(`/nodes/${encodeURIComponent(name)}/summary`);
}
export async function deleteRemoteNode(name) {
  return realFetch(`/nodes/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// ---- Persisted tasks (real: the tasks table, with creation/start/end
// timestamps; see app/core/tasks.py). Replaces the theoretical fetchTasks() that
// was closed over in NodeTasksTab.jsx with a real, filterable and sortable
// GET /tasks. ----
export async function fetchTasks(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") params.set(k, v);
  });
  const qs = params.toString();
  return realFetch(`/tasks${qs ? `?${qs}` : ""}`);
}
export async function fetchTaskDetail(id) {
  return realFetch(`/tasks/${encodeURIComponent(id)}`);
}

// ---- Hyperlite update from Git (real: GET/POST /update/*, see
// app/routers/update.py) ----
export async function fetchUpdateCheck() {
  return realFetch("/update/check");
}
export async function applyUpdate() {
  return realFetch("/update/apply", { method: "POST" });
}

// ---- Users (real) ----
export async function fetchUsers() {
  return realFetch("/auth/users");
}
export async function createUser(username, password, role) {
  return realFetch("/auth/users", { method: "POST", ...jsonBody({ username, password, role }) });
}
export async function updateUser(username, payload) {
  return realFetch(`/auth/users/${encodeURIComponent(username)}`, { method: "PATCH", ...jsonBody(payload) });
}
export async function deleteUser(username) {
  return realFetch(`/auth/users/${encodeURIComponent(username)}`, { method: "DELETE" });
}

// ---- VM actions (real endpoints) ----
// node: "local" or omitted = the local host (the historical behaviour,
// unchanged), otherwise the name of a registered remote node. The same
// convention as fetchVMs()/migrateVM().
export async function startVM(name, node = null) {
  const q = node && node !== "local" ? `?node=${encodeURIComponent(node)}` : "";
  return realFetch(`/vms/${encodeURIComponent(name)}/start${q}`, { method: "POST" });
}
export async function stopVM(name, force = false, node = null) {
  const params = new URLSearchParams({ force: String(force) });
  if (node && node !== "local") params.set("node", node);
  return realFetch(`/vms/${encodeURIComponent(name)}/stop?${params}`, { method: "POST" });
}
export async function restartVM(name, node = null) {
  const params = new URLSearchParams({ force: "true" });
  if (node && node !== "local") params.set("node", node);
  return realFetch(`/vms/${encodeURIComponent(name)}/restart?${params}`, { method: "POST" });
}
export async function deleteVM(name, node = null) {
  const params = new URLSearchParams({ confirm: "true" });
  if (node && node !== "local") params.set("node", node);
  return realFetch(`/vms/${encodeURIComponent(name)}?${params}`, { method: "DELETE" });
}
export async function cloneVM(name, newName) {
  return realFetch(`/vms/${encodeURIComponent(name)}/clone`, { method: "POST", ...jsonBody({ new_name: newName }) });
}
// Live migration: sourceNode "local" (or omitted) = the local host, the same
// convention as the rest (open_conn(node), fetchVMs...).
export async function migrateVM(name, targetNode, sourceNode, ignorerVerifications = false) {
  const qs = sourceNode && sourceNode !== "local" ? `?node=${encodeURIComponent(sourceNode)}` : "";
  return realFetch(`/vms/${encodeURIComponent(name)}/migrate${qs}`, { method: "POST", ...jsonBody({ target_node: targetNode, ignorer_verifications: ignorerVerifications }) });
}
// Cluster compatibility diagnostic
export async function fetchMigrationCheck(name, targetNode, sourceNode) {
  const params = new URLSearchParams({ target_node: targetNode });
  if (sourceNode && sourceNode !== "local") params.set("node", sourceNode);
  return realFetch(`/vms/${encodeURIComponent(name)}/migration-check?${params}`);
}
export async function fetchNodeCompatibility(nodeName) {
  return realFetch(`/nodes/${encodeURIComponent(nodeName)}/compatibility`);
}
// HA: see app/core/ha.py. There is no fencing, and recovery is always triggered by
// an admin, never automatic.
export async function fetchHaProtected() {
  return realFetch("/ha");
}
export async function enableHa(name, node) {
  return realFetch(`/ha/${encodeURIComponent(name)}/enable`, { method: "POST", ...jsonBody({ node: node && node !== "local" ? node : null }) });
}
export async function disableHa(name) {
  return realFetch(`/ha/${encodeURIComponent(name)}`, { method: "DELETE" });
}
export async function recoverHa(name, targetNode) {
  return realFetch(`/ha/${encodeURIComponent(name)}/recover`, { method: "POST", ...jsonBody({ target_node: targetNode }) });
}

// Automatic deletion of inactive VMs (opt-in per VM, see app/core/vm_cleanup.py).
// The counter only runs while the VM is stopped, and never if it is HA-protected.
export async function fetchVMAutoCleanup(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/auto-cleanup`);
}
export async function setVMAutoCleanup(name, inactiveDays) {
  return realFetch(`/vms/${encodeURIComponent(name)}/auto-cleanup`, { method: "PUT", ...jsonBody({ inactive_days: inactiveDays }) });
}
export async function disableVMAutoCleanup(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/auto-cleanup`, { method: "DELETE" });
}
// Outgoing notifications: see app/core/notifications.py.
export async function fetchNotifyEvents() {
  return realFetch("/notifications/events");
}
export async function fetchNotificationChannels() {
  return realFetch("/notifications/channels");
}
export async function createNotificationChannel(payload) {
  return realFetch("/notifications/channels", { method: "POST", ...jsonBody(payload) });
}
export async function setNotificationChannelEnabled(id, enabled) {
  return realFetch(`/notifications/channels/${id}`, { method: "PATCH", ...jsonBody({ enabled }) });
}
export async function deleteNotificationChannel(id) {
  return realFetch(`/notifications/channels/${id}`, { method: "DELETE" });
}
export async function testNotificationChannel(id) {
  return realFetch(`/notifications/channels/${id}/test`, { method: "POST" });
}

// OIDC SSO: see app/core/sso.py / app/routers/sso.py. fetchSsoStatus() is called
// WITHOUT a token (login screen, nobody is authenticated yet); realFetch only adds
// the Authorization header when a token is present, so it can be reused as is here.
export async function fetchSsoStatus() {
  return realFetch("/auth/sso/status");
}
export async function fetchSsoConfig() {
  return realFetch("/auth/sso/config");
}
export async function updateSsoConfig(payload) {
  return realFetch("/auth/sso/config", { method: "PUT", ...jsonBody(payload) });
}
export async function testSso(issuer) {
  return realFetch("/auth/sso/test", { method: "POST", ...jsonBody({ issuer }) });
}

export async function createVM(payload) {
  return realFetch("/vms", { method: "POST", ...jsonBody(payload) });
}
export async function updateVM(name, payload) {
  return realFetch(`/vms/${encodeURIComponent(name)}`, { method: "PATCH", ...jsonBody(payload) });
}
export async function fetchVM(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}`);
}

// ---- Resource limits/reservations (real: GET/PUT /vms/{name}/limits, cgroups
// through libvirt schedulerParametersFlags/memoryParameters) ----
export async function fetchVMLimits(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/limits`);
}
export async function setVMLimits(name, payload) {
  return realFetch(`/vms/${encodeURIComponent(name)}/limits`, { method: "PUT", ...jsonBody(payload) });
}
export async function fetchVMMetrics(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/metrics`);
}
export async function fetchVMMetricsHistory(name, range = "1h", node = null) {
  const params = new URLSearchParams({ range });
  if (node && node !== "local") params.set("node", node);
  return realFetch(`/vms/${encodeURIComponent(name)}/metrics/history?${params}`);
}
// History of a node: "local" = this host, otherwise a registered remote node.
export async function fetchNodeMetricsHistory(node, range = "1h") {
  return realFetch(`/nodes/${encodeURIComponent(node)}/metrics/history?range=${encodeURIComponent(range)}`);
}
export async function fetchStorageHistory(range = "24h", node = null) {
  const params = new URLSearchParams({ range });
  if (node) params.set("node", node);
  return realFetch(`/storage/history?${params}`);
}
export async function fetchNodeHardware(node) {
  return realFetch(`/nodes/${encodeURIComponent(node)}/hardware`);
}
export async function testNodeConnection(payload) {
  return realFetch("/nodes/test", { method: "POST", ...jsonBody(payload) });
}
export async function fetchBackupSchedules() {
  return realFetch("/backup-schedules");
}
export async function fetchAuditCount(filters = {}) {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  return realFetch(`/audit/count${qs ? `?${qs}` : ""}`);
}
export async function fetchHostMetricsHistory(range = "1h") {
  return realFetch(`/host/metrics/history?range=${encodeURIComponent(range)}`);
}
export async function fetchProvisioningStatus(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/provisioning`);
}
const nodeQs = (node) => (node && node !== "local" ? `?node=${encodeURIComponent(node)}` : "");
export async function fetchVMDisks(name, node = null) {
  return realFetch(`/vms/${encodeURIComponent(name)}/disks${nodeQs(node)}`);
}
export async function attachDisk(name, volumeName, targetDev, pool = "default") {
  return realFetch(`/vms/${encodeURIComponent(name)}/disks`, { method: "POST", ...jsonBody({ volume_name: volumeName, pool, target_dev: targetDev }) });
}
export async function detachDisk(name, targetDev) {
  return realFetch(`/vms/${encodeURIComponent(name)}/disks/${encodeURIComponent(targetDev)}`, { method: "DELETE" });
}
export async function fetchVMNetwork(name, node = null) {
  return realFetch(`/vms/${encodeURIComponent(name)}/network${nodeQs(node)}`);
}
export async function attachInterface(name, network, vlanTag = null) {
  return realFetch(`/vms/${encodeURIComponent(name)}/interfaces`, { method: "POST", ...jsonBody({ network, vlan_tag: vlanTag }) });
}
export async function detachInterface(name, mac) {
  return realFetch(`/vms/${encodeURIComponent(name)}/interfaces/${encodeURIComponent(mac)}`, { method: "DELETE" });
}
export async function createVolume(pool, name, sizeGb) {
  return realFetch(`/storage/${encodeURIComponent(pool)}/volumes`, { method: "POST", ...jsonBody({ name, size_gb: sizeGb }) });
}
export async function fetchVolumes(pool) {
  return realFetch(`/storage/${encodeURIComponent(pool)}/volumes`);
}
// Shared storage: node is optional, the same convention as the rest (fetchVMs,
// fetchStoragePools...): it creates/deletes a pool on a registered remote node
// instead of the local host.
export async function createStoragePool(payload, node) {
  const qs = node ? `?node=${encodeURIComponent(node)}` : "";
  return realFetch(`/storage${qs}`, { method: "POST", ...jsonBody(payload) });
}
export async function deleteStoragePool(poolName, node, detacher = false) {
  const params = new URLSearchParams({ confirm: "true" });
  if (detacher) params.set("detacher", "true");
  if (node) params.set("node", node);
  return realFetch(`/storage/${encodeURIComponent(poolName)}?${params.toString()}`, { method: "DELETE" });
}

// ---- VNC console / SSH terminal (real WebSocket relays) ----
export async function createConsoleTicket(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/console-ticket`, { method: "POST" });
}
export async function createTerminalTicket(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/terminal-ticket`, { method: "POST" });
}

// ---- Interactive shell on the physical host (admin only, see app/routers/host.py) ----
export async function createHostTerminalTicket() {
  return realFetch("/host/terminal-ticket", { method: "POST" });
}

// ---- Snapshots (real) ----
export async function fetchSnapshots(name) {
  return realFetch(`/vms/${encodeURIComponent(name)}/snapshots`);
}
export async function createSnapshot(name, snapshotName, description) {
  return realFetch(`/vms/${encodeURIComponent(name)}/snapshots`, { method: "POST", ...jsonBody({ name: snapshotName, description }) });
}
export async function restoreSnapshot(name, snapName) {
  return realFetch(`/vms/${encodeURIComponent(name)}/snapshots/${encodeURIComponent(snapName)}/restore?confirm=true`, { method: "POST" });
}
export async function deleteSnapshot(name, snapName) {
  return realFetch(`/vms/${encodeURIComponent(name)}/snapshots/${encodeURIComponent(snapName)}`, { method: "DELETE" });
}

// ---- Templates (real) ----
export async function fetchTemplates() {
  return realFetch("/templates");
}
export async function createTemplateFromVM(vmName, templateName) {
  return realFetch(`/templates/from-vm/${encodeURIComponent(vmName)}`, { method: "POST", ...jsonBody({ template_name: templateName || null }) });
}
export async function deployTemplate(templateName, newName, network) {
  return realFetch(`/templates/${encodeURIComponent(templateName)}/deploy`, { method: "POST", ...jsonBody({ new_name: newName, network: network || null }) });
}
export async function deleteTemplate(templateName) {
  return realFetch(`/templates/${encodeURIComponent(templateName)}?confirm=true`, { method: "DELETE" });
}

// ---- Granular permissions (real): groups, pools, ACL ----
export async function fetchGroups() {
  return realFetch("/groups");
}
export async function createGroup(name) {
  return realFetch("/groups", { method: "POST", ...jsonBody({ name }) });
}
export async function deleteGroup(groupId) {
  return realFetch(`/groups/${groupId}`, { method: "DELETE" });
}
export async function addGroupMember(groupId, username) {
  return realFetch(`/groups/${groupId}/members`, { method: "POST", ...jsonBody({ username }) });
}
export async function removeGroupMember(groupId, username) {
  return realFetch(`/groups/${groupId}/members/${encodeURIComponent(username)}`, { method: "DELETE" });
}

export async function fetchPools() {
  return realFetch("/pools");
}
export async function createPool(name, description = "") {
  return realFetch("/pools", { method: "POST", ...jsonBody({ name, description }) });
}
export async function deletePool(poolId) {
  return realFetch(`/pools/${poolId}`, { method: "DELETE" });
}
export async function addPoolMember(poolId, vmName) {
  return realFetch(`/pools/${poolId}/members`, { method: "POST", ...jsonBody({ vm_name: vmName }) });
}
export async function removePoolMember(poolId, vmName) {
  return realFetch(`/pools/${poolId}/members/${encodeURIComponent(vmName)}`, { method: "DELETE" });
}

export async function fetchAclRoles() {
  return realFetch("/acl/roles");
}
export async function fetchAcl() {
  return realFetch("/acl");
}
export async function createAcl(payload) {
  return realFetch("/acl", { method: "POST", ...jsonBody(payload) });
}
export async function deleteAcl(aclId) {
  return realFetch(`/acl/${aclId}`, { method: "DELETE" });
}

export async function fetchPrivileges() {
  return realFetch("/acl/privileges");
}
export async function fetchCustomRoles() {
  return realFetch("/acl/custom-roles");
}
export async function createCustomRole(name, privileges) {
  return realFetch("/acl/custom-roles", { method: "POST", ...jsonBody({ name, privileges }) });
}
export async function deleteCustomRole(roleId) {
  return realFetch(`/acl/custom-roles/${roleId}`, { method: "DELETE" });
}

// ---- LXC containers (real: GET/POST/DELETE /containers) ----
export async function fetchContainers() {
  return realFetch("/containers");
}
export async function fetchContainer(name) {
  return realFetch(`/containers/${encodeURIComponent(name)}`);
}
export async function searchDockerHub(query) {
  return realFetch(`/containers/docker-hub/search?q=${encodeURIComponent(query)}`);
}
export async function createContainer(payload) {
  return realFetch("/containers", { method: "POST", ...jsonBody(payload) });
}
export async function startContainer(name) {
  return realFetch(`/containers/${encodeURIComponent(name)}/start`, { method: "POST" });
}
export async function stopContainer(name, force = false) {
  return realFetch(`/containers/${encodeURIComponent(name)}/stop?force=${force}`, { method: "POST" });
}
export async function deleteContainer(name) {
  return realFetch(`/containers/${encodeURIComponent(name)}`, { method: "DELETE" });
}
export async function createContainerTerminalTicket(name) {
  return realFetch(`/containers/${encodeURIComponent(name)}/terminal-ticket`, { method: "POST" });
}

// Container clone and backup/restore (no instantaneous snapshot is possible, since
// libvirt's LXC driver does not support it; see app/core/container_builder.py).
export async function cloneContainer(name, newName) {
  return realFetch(`/containers/${encodeURIComponent(name)}/clone`, { method: "POST", ...jsonBody({ new_name: newName }) });
}
export async function fetchContainerBackups() {
  return realFetch("/containers/backups");
}
export async function createContainerBackup(name) {
  return realFetch(`/containers/${encodeURIComponent(name)}/backups`, { method: "POST" });
}
export async function deleteContainerBackup(id) {
  return realFetch(`/containers/backups/${id}?confirm=true`, { method: "DELETE" });
}
export async function restoreContainerBackup(id, newName = null) {
  return realFetch(`/containers/backups/${id}/restore`, { method: "POST", ...jsonBody({ new_name: newName }) });
}

// Two-factor authentication and API tokens, self-service: each user manages their
// own account (no need to be an admin).
export async function setup2FA() {
  return realFetch("/auth/2fa/setup", { method: "POST" });
}
export async function confirm2FA(code) {
  return realFetch("/auth/2fa/confirm", { method: "POST", ...jsonBody({ code }) });
}
export async function disable2FA(password) {
  return realFetch("/auth/2fa/disable", { method: "POST", ...jsonBody({ password }) });
}
export async function fetchApiTokens() {
  return realFetch("/auth/tokens");
}
export async function createApiToken(name) {
  return realFetch("/auth/tokens", { method: "POST", ...jsonBody({ name }) });
}
export async function deleteApiToken(id) {
  return realFetch(`/auth/tokens/${id}`, { method: "DELETE" });
}

// ---- Compatibility and capabilities ----
export async function fetchNodeCapabilitiesById(nodeId) {
  if (!nodeId || nodeId === "local") return realFetch("/host/capabilities");
  return realFetch(`/nodes/${encodeURIComponent(nodeId)}/capabilities`);
}
export async function fetchHostPreflight() {
  return realFetch("/host/preflight");
}
export async function fetchHostProfile() {
  return realFetch("/host/profile");
}
export async function setHostProfile(profil) {
  return realFetch("/host/profile", { method: "PUT", ...jsonBody({ profil }) });
}
export async function setHostAllocation(politique) {
  return realFetch("/host/allocation", { method: "PUT", ...jsonBody({ politique }) });
}
