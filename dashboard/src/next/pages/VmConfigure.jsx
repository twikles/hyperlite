import { useCallback, useEffect, useState } from "react";
import { Info, Plus, Trash2, Zap } from "lucide-react";
import {
  fetchVMDisks, attachDisk, detachDisk, createVolume, fetchVolumes, fetchVMNetwork, attachInterface, detachInterface, fetchNetworks,
  fetchVMFirewall, setVMFirewall, fetchVMLimits, setVMLimits, fetchIsoTemplates, mountVMDriversIso, ejectVMDriversIso,
} from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { confirmAction } from "../../store/useConfirmStore";
import { useHostLimits } from "../../hooks/useHostLimits";
import { useT, useLangStore } from "../i18n";
import { capabilities } from "../lib/capabilities";
import { errorMessage } from "../lib/errors";
import { formatSizeGb } from "../lib/format";
import { ErrorState } from "../components/States";
import { Card, Chip, Field, SideDrawer } from "../components/ui";
import FirewallCard from "../components/FirewallCard";

// First free SCSI letter (sda…sdz); null when none is left.
function nextScsiDev(disks) {
  const used = new Set(disks.filter((d) => /^sd[a-z]$/.test(d.cible)).map((d) => d.cible));
  for (const l of "abcdefghijklmnopqrstuvwxyz") if (!used.has(`sd${l}`)) return `sd${l}`;
  return null;
}
const freshName = (vm) => `${vm}-disk-${Date.now().toString().slice(-5)}`;
const VOL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const intIn = (v, min, max) => v !== "" && Number.isInteger(Number(v)) && Number(v) >= min && (max == null || Number(v) <= max);
const OS_SUGGESTIONS = ["Debian 12", "Ubuntu 24.04", "Rocky Linux 9", "Windows Server 2025", "Windows 11", "Alpine Linux"];

// Processor, memory and declared OS, editable in place. vCPU and memory need the VM stopped (the backend refuses
// otherwise); the OS label is only a description and can change at any time.
function ComputeCard({ vm, admin }) {
  const t = useT();
  const limits = useHostLimits();
  const updateVMResources = useInfraStore((s) => s.updateVMResources);
  const refreshAll = useInfraStore((s) => s.refreshAll);
  const pushToast = useInfraStore((s) => s.pushToast);
  const [vcpu, setVcpu] = useState(String(vm.vcpu ?? 1));
  const [mem, setMem] = useState(String(vm.memoire_mo ?? 512));
  const [os, setOs] = useState(vm.os || "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setVcpu(String(vm.vcpu ?? 1)); setMem(String(vm.memoire_mo ?? 512)); setOs(vm.os || ""); }, [vm.nom, vm.vcpu, vm.memoire_mo, vm.os]);
  const running = vm.etat === "actif";
  const vMin = limits?.vcpu.min ?? 1, vMax = limits?.vcpu.max, mMin = limits?.memoire_mo.min ?? 256, mMax = limits?.memoire_mo.max;
  const vBad = !intIn(vcpu, vMin, vMax), mBad = !intIn(mem, mMin, mMax);
  const resDirty = Number(vcpu) !== vm.vcpu || Number(mem) !== vm.memoire_mo;
  const osDirty = os.trim() !== (vm.os || "") && os.trim() !== "";
  const blocked = (resDirty && (running || vBad || mBad)) || (!resDirty && !osDirty);

  async function save() {
    if (blocked) return;
    setBusy(true);
    try {
      const payload = { ...(resDirty ? { vcpu: Number(vcpu), memory_mb: Number(mem) } : {}), ...(osDirty ? { os_label: os.trim() } : {}) };
      await updateVMResources(vm.nom, payload);
      pushToast({ kind: "success", title: t("vh.saved"), message: vm.nom });
      refreshAll?.();
    } catch { /* the store already shows the error */ } finally { setBusy(false); }
  }
  return (
    <Card title={t("vh.compute")}>
      {running && <p className="nx-f-h" style={{ margin: "0 0 var(--space-3)" }}>{t("vo.stopFirst")}</p>}
      <div className="nx-fg nx-fg--3">
        <Field label="vCPU" unit="vCPU" error={vBad ? t("vo.range", { min: vMin, max: vMax ?? "…" }) : null} hint={t("vo.range", { min: vMin, max: vMax ?? "…" })}>
          {(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.vcpu_count")} type="number" min={vMin} max={vMax} disabled={!admin || running} value={vcpu} onChange={(e) => setVcpu(e.target.value)} />}
        </Field>
        <Field label={t("ct.memory")} unit={lang() === "fr" ? "Mo" : "MB"} error={mBad ? t("vo.range", { min: mMin, max: mMax ?? "…" }) : null} hint={t("vo.range", { min: mMin, max: mMax ?? "…" })}>
          {(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.memory_in_mb")} type="number" min={mMin} max={mMax} step={128} disabled={!admin || running} value={mem} onChange={(e) => setMem(e.target.value)} />}
        </Field>
        <Field label={t("vh.osLabel")} hint={t("vh.osHint")}>
          {(p) => <><input {...p} className="nx-inp" aria-label={t("a11y.guest_os")} list="vh-os-list" disabled={!admin} value={os} maxLength={64} onChange={(e) => setOs(e.target.value)} /><datalist id="vh-os-list">{OS_SUGGESTIONS.map((o) => <option key={o} value={o} />)}</datalist></>}
        </Field>
      </div>
      {admin && (
        <div className="nx-fa">
          <span className="nx-fa-l"><Info size={14} aria-hidden="true" />{t("vh.nextBoot")}</span>
          <button type="button" className="nx-btn" disabled={busy || blocked} onClick={save}>{t("sso.save")}</button>
        </div>
      )}
    </Card>
  );
}
const lang = () => useLangStore.getState().lang;

function AddDiskDrawer({ open, onClose, vmName, disks, onDone }) {
  const t = useT();
  const pushToast = useInfraStore((s) => s.pushToast);
  const storagePools = useInfraStore((s) => s.storagePools);
  const limits = useHostLimits();
  const pools = storagePools.filter((p) => p.node === "local" && p.type !== "zfs" && p.etat === "actif");
  const [pool, setPool] = useState("default");
  const [volumes, setVolumes] = useState([]);
  const [source, setSource] = useState("__new__");
  const [name, setName] = useState(() => freshName(vmName));
  const [size, setSize] = useState("20");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(freshName(vmName)); fetchVolumes(pool).then((v) => setVolumes((Array.isArray(v) ? v : []).filter((x) => !x.utilise))).catch(() => setVolumes([])); } }, [open, pool, vmName]);
  const nextDev = nextScsiDev(disks || []);
  const maxGb = limits?.disque_go?.max;
  const sizeBad = source === "__new__" && (!Number.isInteger(Number(size)) || Number(size) < 1 || (maxGb && Number(size) > maxGb));
  const nameBad = source === "__new__" && !VOL_RE.test(name.trim());

  async function attach() {
    if (!nextDev || sizeBad || nameBad) return;
    setBusy(true);
    let created = null;
    try {
      let vol = source;
      if (source === "__new__") { const c = await createVolume(pool, name.trim(), Number(size)); vol = c.nom; created = c.nom; }
      await attachDisk(vmName, vol, nextDev, pool);
      pushToast({ kind: "success", title: t("vh.attached"), message: `${vol} → ${nextDev}` });
      onDone(); onClose();
    } catch (er) {
      // The volume may exist without being attached: it is now listed as a free volume so the attach can be retried.
      pushToast({ kind: "error", title: t("vh.attachFailed"), message: created ? `${errorMessage(er)} — ${t("vh.orphan", { name: created })}` : errorMessage(er) });
      if (created) { setSource(created); onDone(); }
    } finally { setBusy(false); }
  }
  const pick = pools.find((p) => p.nom === pool);
  return (
    <SideDrawer open={open} title={t("vh.addDisk")} onClose={onClose} busy={busy} footer={<>
      <span className="nx-f-h" style={{ marginRight: "auto" }}>{nextDev ? t("vh.willBe", { dev: nextDev }) : t("vh.noLetter")}</span>
      <button type="button" className="nx-btn nx-btn--ghost" onClick={onClose} disabled={busy}>{t("action.cancel")}</button>
      <button type="button" className="nx-btn nx-btn--primary" aria-label={t("a11y.attach")} disabled={busy || !nextDev || sizeBad || nameBad} onClick={attach}>{t("vh.attachBtn")}</button>
    </>}>
      <Field label={t("vh.pool")}>{(p) => <select {...p} className="nx-inp" aria-label={t("a11y.pool")} value={pool} onChange={(e) => { setPool(e.target.value); setSource("__new__"); }}>{(pools.length ? pools : [{ nom: "default" }]).map((x) => <option key={x.nom} value={x.nom}>{x.nom}{x.disponible_go != null ? ` · ${formatSizeGb(x.disponible_go, lang())} ${t("stor.free").toLowerCase()}` : ""}</option>)}</select>}</Field>
      <Field label={t("vh.disk")}>{(p) => <select {...p} className="nx-inp" aria-label={t("a11y.disk_to_attach")} value={source} onChange={(e) => setSource(e.target.value)}><option value="__new__">{t("vh.newDisk")}</option>{volumes.map((v) => <option key={v.nom} value={v.nom}>{v.nom} ({v.capacite_go} GB)</option>)}</select>}</Field>
      {source === "__new__" && <>
        <Field label={t("vh.volName")} error={nameBad ? t("vh.volRule") : null}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.volume_name")} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={t("vh.size")} unit={lang() === "fr" ? "Go" : "GB"} error={sizeBad ? t("vh.sizeRule", { max: maxGb ?? "…" }) : null} hint={pick?.disponible_go != null ? t("vh.poolFree", { n: formatSizeGb(pick.disponible_go, lang()) }) : null}>
          {(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.new_disk_size_in_gb")} type="number" min={1} max={maxGb} value={size} onChange={(e) => setSize(e.target.value)} />}
        </Field>
      </>}
    </SideDrawer>
  );
}

function DriversCard({ vmName, onChanged }) {
  const t = useT();
  const pushToast = useInfraStore((s) => s.pushToast);
  const [isos, setIsos] = useState([]);
  const [iso, setIso] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetchIsoTemplates().then((r) => setIsos(Array.isArray(r) ? r : [])).catch(() => setIsos([])); }, []);
  async function change(eject) {
    setBusy(true);
    try {
      if (eject) await ejectVMDriversIso(vmName); else await mountVMDriversIso(vmName, iso);
      pushToast({ kind: "success", title: t(eject ? "vh.drvEjected" : "vh.drvMounted") });
      await onChanged();
    } catch (e) { pushToast({ kind: "error", title: t("vh.drvFailed"), message: errorMessage(e) }); }
    finally { setBusy(false); }
  }
  return (
    <Card title={t("vh.drivers")}>
      <div className="nx-inline">
        <select className="nx-inp" style={{ flex: 1, minWidth: "12rem" }} aria-label={t("vh.drvIso")} value={iso} onChange={(e) => setIso(e.target.value)}>
          <option value="">{t("vh.drvChoose")}</option>
          {isos.map((i) => <option key={i.nom} value={i.nom}>{i.nom}</option>)}
        </select>
        <button type="button" className="nx-btn" disabled={busy || !iso} onClick={() => change(false)}>{t("vh.drvInsert")}</button>
        <button type="button" className="nx-btn nx-btn--ghost" disabled={busy} onClick={() => change(true)}>{t("vh.drvEject")}</button>
      </div>
      <p className="nx-f-h" style={{ margin: "var(--space-2) 0 0" }}>{t("vh.drvHelp")}</p>
    </Card>
  );
}

// Hardware: the editable processor and memory, the disks (table, add from a drawer), the Windows drivers drive.
export function VmHardwarePage({ resource: vm }) {
  const t = useT();
  const admin = capabilities(useAuthStore((s) => s.role)).admin;
  const pushToast = useInfraStore((s) => s.pushToast);
  const [disks, setDisks] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = vm?.nom;
  const node = vm?.node;
  const reload = useCallback(async () => {
    try { const d = await fetchVMDisks(name, node); setDisks(Array.isArray(d) ? d : []); setError(null); }
    catch (e) { setError(errorMessage(e)); }
  }, [name, node]);
  useEffect(() => { if (name) reload(); }, [name, reload]);
  if (!vm) return null;

  async function detach(d) {
    if (!(await confirmAction({ title: t("vh.detachTitle", { dev: d.cible }), message: t("vh.detachMsg"), confirmLabel: t("vh.detach"), danger: true }))) return;
    setBusy(true);
    try { await detachDisk(vm.nom, d.cible); pushToast({ kind: "success", title: t("vh.detached"), message: d.cible }); await reload(); }
    catch (e) { pushToast({ kind: "error", title: t("vh.detachFailed"), message: errorMessage(e) }); } finally { setBusy(false); }
  }
  const size = (d) => (d.taille_go ? formatSizeGb(d.taille_go, lang()) : "—");
  return (
    <>
      <ComputeCard vm={vm} admin={admin} />
      <Card title={t("vh.disks")} note={disks ? disks.length : null} flush actions={admin && <button type="button" className="nx-btn nx-btn--sm" onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" />{t("vh.addDisk")}</button>}>
        {error && disks == null ? <ErrorState message={error} onRetry={reload} /> : disks == null ? <p className="nx-muted" role="status" style={{ padding: "0 var(--space-4) var(--space-4)", margin: 0 }}>{t("loading")}</p> : disks.length === 0 ? <p className="nx-muted" style={{ padding: "0 var(--space-4) var(--space-4)", margin: 0 }}>{t("vh.noDisks")}</p> : (
          <div className="nx-tablewrap">
            <table className="nx-table">
              <thead><tr><th scope="col">{t("vh.device")}</th><th scope="col">Bus</th><th scope="col">{t("vh.source")}</th><th scope="col" className="nx-num">{t("lib.size")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
              <tbody>
                {disks.map((d) => (
                  <tr key={d.cible}>
                    <th scope="row" className="nx-mono" style={{ fontWeight: 500 }}>{d.cible}</th>
                    <td><Chip>{[d.bus ? d.bus.toUpperCase() : null, d.type === "cdrom" ? "CD" : null].filter(Boolean).join(" · ") || "—"}</Chip></td>
                    <td className="nx-mono nx-wrapcell">{d.source || <span className="nx-muted">{t("vh.emptyDrive")}</span>}{d.pool && <span className="nx-muted"> ({d.pool})</span>}</td>
                    <td className="nx-num nx-mono">{size(d)}</td>
                    <td><div className="nx-ra">{admin && d.type !== "cdrom" && d.cible !== "vda" && d.cible !== "sda" && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" disabled={busy} aria-label={t("a11y.detach_disk_x", { v: d.cible })} onClick={() => detach(d)}>{t("vh.detach")}</button>}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {admin && <DriversCard vmName={vm.nom} onChanged={reload} />}
      <AddDiskDrawer open={adding} onClose={() => setAdding(false)} vmName={vm.nom} disks={disks} onDone={reload} />
    </>
  );
}

function AddInterfaceDrawer({ open, onClose, vmName, onDone }) {
  const t = useT();
  const pushToast = useInfraStore((s) => s.pushToast);
  const [networks, setNetworks] = useState([]);
  const [net, setNet] = useState("");
  const [vlan, setVlan] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) fetchNetworks().then((n) => { const l = Array.isArray(n) ? n : []; setNetworks(l); setNet((p) => p || l[0]?.nom || ""); }).catch(() => setNetworks([])); }, [open]);
  const vlanBad = vlan !== "" && (!Number.isInteger(Number(vlan)) || Number(vlan) < 1 || Number(vlan) > 4094);
  async function add() {
    if (!net || vlanBad) return;
    setBusy(true);
    try { await attachInterface(vmName, net, vlan ? Number(vlan) : null); pushToast({ kind: "success", title: t("vh.ifAdded"), message: net }); setVlan(""); onDone(); onClose(); }
    catch (er) { pushToast({ kind: "error", title: t("sec.addFailed"), message: errorMessage(er) }); } finally { setBusy(false); }
  }
  return (
    <SideDrawer open={open} title={t("vh.addIf")} onClose={onClose} busy={busy} footer={<>
      <button type="button" className="nx-btn nx-btn--ghost" onClick={onClose} disabled={busy}>{t("action.cancel")}</button>
      <button type="button" className="nx-btn nx-btn--primary" aria-label={t("a11y.add_an_interface")} disabled={busy || !net || vlanBad} onClick={add}>{t("vh.addIfBtn")}</button>
    </>}>
      <Field label={t("vh.network")}>{(p) => <select {...p} className="nx-inp" aria-label={t("a11y.network_to_attach")} value={net} onChange={(e) => setNet(e.target.value)}>{networks.map((n) => <option key={n.nom} value={n.nom}>{n.nom} ({t(`net.mode.${n.type}`)})</option>)}</select>}</Field>
      <Field label="VLAN" error={vlanBad ? t("vh.vlanRule") : null} hint={t("vh.vlanHint")}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.vlan_optional")} type="number" min={1} max={4094} value={vlan} placeholder={t("vh.optional")} onChange={(e) => setVlan(e.target.value)} />}</Field>
    </SideDrawer>
  );
}

// Network: interfaces (network, model, MAC, VLAN, firewall) and the VM firewall rules.
export function VmNetworkPage({ resource: vm }) {
  const t = useT();
  const admin = capabilities(useAuthStore((s) => s.role)).admin;
  const pushToast = useInfraStore((s) => s.pushToast);
  const [info, setInfo] = useState(null);
  const [nets, setNets] = useState([]);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = vm?.nom;
  const node = vm?.node;
  const reload = useCallback(async () => {
    try { const [i, n] = await Promise.all([fetchVMNetwork(name, node), fetchNetworks().catch(() => [])]); setInfo(i); setNets(Array.isArray(n) ? n : []); setError(null); }
    catch (e) { setError(errorMessage(e)); }
  }, [name, node]);
  useEffect(() => { if (name) reload(); }, [name, reload]);
  const fetchFw = useCallback(() => fetchVMFirewall(name), [name]);
  const saveFw = useCallback((c) => setVMFirewall(name, c), [name]);
  if (!vm) return null;
  const ifaces = info?.interfaces || [];
  const netOf = (n) => nets.find((x) => x.nom === n);

  async function detach(i) {
    if (!(await confirmAction({ title: t("vh.ifDetachTitle", { mac: i.mac }), message: t("vh.ifDetachMsg"), confirmLabel: t("sec.remove"), danger: true }))) return;
    setBusy(true);
    try { await detachInterface(vm.nom, i.mac); pushToast({ kind: "success", title: t("vh.ifDetached"), message: i.mac }); await reload(); }
    catch (e) { pushToast({ kind: "error", title: t("vh.detachFailed"), message: errorMessage(e) }); } finally { setBusy(false); }
  }
  return (
    <>
      <Card title={t("vh.interfaces")} note={info ? ifaces.length : null} flush actions={admin && <button type="button" className="nx-btn nx-btn--sm" onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" />{t("vh.addIf")}</button>}>
        {error && !info ? <ErrorState message={error} onRetry={reload} /> : !info ? <p className="nx-muted" role="status" style={{ padding: "0 var(--space-4) var(--space-4)", margin: 0 }}>{t("loading")}</p> : (
          <div className="nx-tablewrap">
            <table className="nx-table">
              <thead><tr><th scope="col">{t("vh.network")}</th><th scope="col">{t("vh.model")}</th><th scope="col">MAC</th><th scope="col">VLAN</th><th scope="col">{t("vh.firewallCol")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
              <tbody>
                {ifaces.map((i) => {
                  const n = netOf(i.reseau);
                  return (
                    <tr key={i.mac}>
                      <th scope="row" className="nx-nm">{i.reseau || <span className="nx-muted">{i.type_source || t("ns.notReported")}</span>}{n && <small>{[t(`net.mode.${n.type}`), n.reseau?.adresse].filter(Boolean).join(" · ")}</small>}</th>
                      <td>{i.modele ? <Chip>{i.modele}</Chip> : <span className="nx-muted">—</span>}</td>
                      <td className="nx-mono">{i.mac}</td>
                      <td className="nx-mono">{i.vlan ?? <span className="nx-muted">—</span>}</td>
                      <td>{i.pare_feu ? <span className="nx-st nx-tone-success"><span className="nx-dot" data-tone="success" aria-hidden="true" />{t("state.active")}</span> : <span className="nx-muted">{t("vh.noFirewall")}</span>}</td>
                      <td><div className="nx-ra">{admin && ifaces.length > 1 && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" disabled={busy} aria-label={t("a11y.remove_interface_x", { v: i.mac })} title={t("sec.remove")} onClick={() => detach(i)}><Trash2 size={15} aria-hidden="true" /></button>}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <FirewallCard title={t("vh.firewall")} fetchConfig={fetchFw} saveConfig={saveFw} isAdmin={admin} />
      <AddInterfaceDrawer open={adding} onClose={() => setAdding(false)} vmName={vm.nom} onDone={reload} />
    </>
  );
}

// ---- Options and limits: cgroup limits applied live -------------------------------------------------------
export function VmOptionsPage({ resource: vm }) {
  const t = useT();
  const admin = capabilities(useAuthStore((s) => s.role)).admin;
  const pushToast = useInfraStore((s) => s.pushToast);
  const [limits, setLimits] = useState(null);
  const [error, setError] = useState(null);
  const [shares, setShares] = useState("1024");
  const [cpu, setCpu] = useState("");
  const [ram, setRam] = useState("");
  const [busy, setBusy] = useState(false);
  const name = vm?.nom;
  const load = useCallback(async () => {
    try { const l = await fetchVMLimits(name); setLimits(l); setShares(String(l.cpu_shares)); setCpu(l.cpu_limit_pct ?? ""); setRam(l.mem_hard_limit_mb ?? ""); setError(null); }
    catch (e) { setError(errorMessage(e)); }
  }, [name]);
  useEffect(() => { if (name) load(); }, [name, load]);
  if (!vm) return null;
  if (error && !limits) return <ErrorState message={error} onRetry={load} />;
  if (!limits) return <p className="nx-muted" role="status">{t("loading")}</p>;
  const bad = { shares: !intIn(shares, 2, 262144), cpu: cpu !== "" && !intIn(cpu, 1, 100), ram: ram !== "" && !intIn(ram, 64) };
  const dirty = Number(shares) !== limits.cpu_shares || (cpu === "" ? null : Number(cpu)) !== (limits.cpu_limit_pct ?? null) || (ram === "" ? null : Number(ram)) !== (limits.mem_hard_limit_mb ?? null);
  async function save() {
    if (bad.shares || bad.cpu || bad.ram) return;
    setBusy(true);
    try {
      const u = await setVMLimits(vm.nom, { cpu_shares: Number(shares), cpu_limit_pct: cpu === "" ? null : Number(cpu), mem_hard_limit_mb: ram === "" ? null : Number(ram) });
      setLimits(u); pushToast({ kind: "success", title: t("vo.applied"), message: vm.nom });
    } catch (er) { pushToast({ kind: "error", title: t("vo.applyFailed"), message: errorMessage(er) }); } finally { setBusy(false); }
  }
  return (
    <Card title={t("vo.limits")}>
      <p className="nx-muted" style={{ margin: "0 0 var(--space-4)", fontSize: "var(--fs-13)" }}>{t("vo.limitsHelp")}</p>
      <div className="nx-fg nx-fg--3">
        <Field label={t("vo.shares")} unit={t("vo.parts")} error={bad.shares ? t("vo.sharesRule") : null} hint={t("vo.sharesHelp")}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.cpu_shares")} type="number" min={2} max={262144} disabled={!admin} value={shares} onChange={(e) => setShares(e.target.value)} />}</Field>
        <Field label={t("vo.cpuCap")} unit="% / vCPU" error={bad.cpu ? t("vo.cpuCapRule") : null} hint={t("vo.cpuCapHelp")}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.max_cpu_limit_percent_per_vcpu")} type="number" min={1} max={100} placeholder={t("vo.unlimited")} disabled={!admin} value={cpu} onChange={(e) => setCpu(e.target.value)} />}</Field>
        <Field label={t("vo.ramCap")} unit={lang() === "fr" ? "Mo" : "MB"} error={bad.ram ? t("vo.ramCapRule") : null} hint={t("vo.ramCapHelp")}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.ram_limit_in_mb")} type="number" min={64} placeholder={t("vo.unlimited")} disabled={!admin} value={ram} onChange={(e) => setRam(e.target.value)} />}</Field>
      </div>
      {admin && <div className="nx-fa"><button type="button" className="nx-btn" aria-label={t("a11y.apply_live")} disabled={!dirty || busy || bad.shares || bad.cpu || bad.ram} onClick={save}><Zap size={14} aria-hidden="true" />{t("vo.applyLive")}</button></div>}
    </Card>
  );
}
