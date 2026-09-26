import { Fragment, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Layers, Plus, Trash2 } from "lucide-react";
import { createStoragePool, deleteStoragePool, fetchVolumes } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { confirmAction } from "../../store/useConfirmStore";
import { useT, useLangStore } from "../i18n";
import { capabilities } from "../lib/capabilities";
import { formatSizeGb } from "../lib/format";
import { errorMessage } from "../lib/errors";
import { useIntent } from "../lib/intents";
import StatusIndicator from "../components/StatusIndicator";
import { PageHeader, Meter, Chip, SideDrawer, Field, Empty } from "../components/ui";

const EMPTY = { name: "", type: "dir", node: "local", path: "", nfs_host: "", nfs_export_path: "", size_gb: "20" };

function CreatePoolDrawer({ open, onClose }) {
  const t = useT();
  const { nodes, refreshAll, pushToast } = useInfraStore(useShallow((s) => ({ nodes: s.nodes, refreshAll: s.refreshAll, pushToast: s.pushToast })));
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const TYPES = [["dir", t("stor.type.dir")], ["netfs", t("stor.type.netfs")], ["zfs", "ZFS"]];
  const valid = form.name && (form.type !== "netfs" || (form.nfs_host && form.nfs_export_path)) && (form.type !== "zfs" || Number(form.size_gb) >= 1);

  async function create() {
    setBusy(true);
    try {
      const payload = form.type === "dir" ? { name: form.name, type: "dir", path: form.path || null }
        : form.type === "netfs" ? { name: form.name, type: "netfs", nfs_host: form.nfs_host, nfs_export_path: form.nfs_export_path }
        : { name: form.name, type: "zfs", size_gb: Number(form.size_gb) };
      // "local" is the frontend sentinel of the local host: the backend only accepts registered remote nodes.
      await createStoragePool(payload, form.node === "local" ? undefined : form.node);
      pushToast({ kind: "success", title: t("stor.created"), message: form.name });
      setForm(EMPTY); onClose(); refreshAll();
    } catch (err) { pushToast({ kind: "error", title: t("stor.createFailed"), message: errorMessage(err) }); }
    finally { setBusy(false); }
  }
  return (
    <SideDrawer open={open} title={t("stor.createPool")} onClose={onClose} busy={busy} footer={<>
      <button type="button" className="nx-btn nx-btn--ghost" onClick={onClose} disabled={busy}>{t("action.cancel")}</button>
      <button type="button" className="nx-btn nx-btn--primary" disabled={busy || !valid} onClick={create}>{busy ? t("stor.creating") : t("stor.createPool")}</button>
    </>}>
      <Field label={t("stor.poolName")}>{(p) => <input {...p} className="nx-inp" aria-label={t("a11y.pool_name")} value={form.name} onChange={set("name")} placeholder="nfs-shared" />}</Field>
      <Field label={t("ns.node")}>{(p) => <select {...p} className="nx-inp" aria-label={t("a11y.node")} value={form.node} onChange={set("node")}>{nodes.map((n) => <option key={n.id} value={n.id}>{n.nom}</option>)}</select>}</Field>
      <div className="nx-f">
        <span className="nx-f-label" id="pool-type">{t("stor.poolType")}</span>
        <div className="nx-seg2" role="group" aria-labelledby="pool-type">
          {TYPES.map(([v, label]) => <button key={v} type="button" aria-pressed={form.type === v} onClick={() => setForm((f) => ({ ...f, type: v }))}>{label}</button>)}
        </div>
      </div>
      {form.type === "dir" && <Field label={t("stor.path")} hint={t("stor.pathHelp")}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.local_path_optional")} value={form.path} onChange={set("path")} placeholder="/var/lib/libvirt/hyperlite-pools/…" />}</Field>}
      {form.type === "netfs" && <>
        <Field label={t("stor.nfsHost")}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.nfs_server_host")} value={form.nfs_host} onChange={set("nfs_host")} placeholder="192.168.1.10" />}</Field>
        <Field label={t("stor.nfsPath")}>{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.exported_path")} value={form.nfs_export_path} onChange={set("nfs_export_path")} placeholder="/srv/share" />}</Field>
      </>}
      {form.type === "zfs" && <Field label={t("stor.zfsSize")} hint={t("stor.zfsHelp")} unit="Go">{(p) => <input {...p} className="nx-inp nx-mono" aria-label={t("a11y.size_gb_loopback_file")} type="number" min="1" max="4096" value={form.size_gb} onChange={set("size_gb")} />}</Field>}
    </SideDrawer>
  );
}

// Storage: the pools only (the ISO images live in the Library). Same safeguards as the historical screen:
// the default pool is never removable; removing a directory/NFS pool only removes its definition.
export default function StoragePage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const { pools, nodes, refreshAll, pushToast } = useInfraStore(useShallow((s) => ({ pools: s.storagePools, nodes: s.nodes, refreshAll: s.refreshAll, pushToast: s.pushToast })));
  const caps = capabilities(useAuthStore((s) => s.role));
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [volumes, setVolumes] = useState({});
  useIntent("pool", () => caps.admin && setCreating(true));

  async function toggleVolumes(p) {
    const key = `${p.node}:${p.nom}`;
    setOpen(open === key ? null : key);
    if (open !== key && p.node === "local" && !volumes[key]) {
      try { const v = await fetchVolumes(p.nom); setVolumes((x) => ({ ...x, [key]: Array.isArray(v) ? v : [] })); }
      catch { setVolumes((x) => ({ ...x, [key]: [] })); }
    }
  }
  async function removePool(p) {
    if (p.nom === "default") return;
    const fsBacked = p.type === "dir" || p.type === "netfs";
    const ok = await confirmAction({ title: t("stor.confirmTitle", { name: p.nom }), message: fsBacked ? t("stor.confirmFs", { name: p.nom }) : t("stor.confirmEmpty", { name: p.nom }), confirmLabel: t("action.confirm"), danger: true });
    if (!ok) return;
    try { await deleteStoragePool(p.nom, p.node === "local" ? undefined : p.node, fsBacked); pushToast({ kind: "success", title: t("stor.removed"), message: p.nom }); refreshAll(); }
    catch (err) { pushToast({ kind: "error", title: t("stor.deleteFailed"), message: errorMessage(err) }); }
  }

  return (
    <>
      <PageHeader title={t("tab.storage")} count={pools.length} desc={t("stor.desc")}
        actions={caps.admin && <button type="button" className="nx-btn nx-btn--primary" onClick={() => setCreating(true)}><Plus size={15} aria-hidden="true" />{t("stor.createPool")}</button>} />
      <div className="nx-card2 nx-card2--flush">
        {pools.length === 0 ? <Empty icon={Layers} title={t("ov.noPools")} text={t("stor.noneHelp")} /> : (
          <div className="nx-tablewrap">
            <table className="nx-table">
              <thead><tr><th scope="col">{t("ns.col.state")}</th><th scope="col">{t("stor.pool")}</th><th scope="col">{t("ns.node")}</th><th scope="col">{t("stor.type")}</th><th scope="col">{t("stor.usage")}</th><th scope="col" className="nx-num">{t("stor.capacity")}</th><th scope="col" className="nx-num">{t("stor.free")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
              <tbody>
                {pools.map((p) => {
                  const key = `${p.node}:${p.nom}`;
                  const r = p.capacite_go ? ((p.capacite_go - (p.disponible_go ?? p.capacite_go)) / p.capacite_go) * 100 : null;
                  const vols = volumes[key];
                  return (
                    <Fragment key={key}>
                      <tr>
                        <td><StatusIndicator kind="pool" wire={p.etat} /></td>
                        <th scope="row" className="nx-nm">{p.nom}{p.chemin && <small className="nx-mono">{p.chemin}</small>}</th>
                        <td className="nx-mono">{nodes.find((n) => n.id === p.node)?.nom || p.node}</td>
                        <td><Chip title={p.type === "zfs" ? t("stor.zfsLocal") : undefined}>{p.type === "netfs" ? "NFS" : p.type === "zfs" ? "ZFS" : p.type}</Chip></td>
                        <td><Meter value={r} label={`${p.nom} ${t("stor.usage")}`} /></td>
                        <td className="nx-num nx-mono">{formatSizeGb(p.capacite_go, lang) ?? "—"}</td>
                        <td className="nx-num nx-mono">{formatSizeGb(p.disponible_go, lang) ?? "—"}</td>
                        <td><div className="nx-ra">
                          <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" aria-expanded={open === key} aria-label={t("stor.volumesOf", { name: p.nom })} onClick={() => toggleVolumes(p)}>{t("stor.volumes")}</button>
                          {caps.admin && p.nom !== "default" && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" aria-label={t("a11y.delete_pool_x", { v: p.nom })} title={t("menu.delete").replace("…", "")} onClick={() => removePool(p)}><Trash2 size={15} aria-hidden="true" /></button>}
                        </div></td>
                      </tr>
                      {open === key && (
                        <tr><td colSpan={8} className="nx-detailcell">
                          {p.node !== "local" ? <span className="nx-muted">{t("stor.volLocalOnly")}</span> : vols == null ? <span className="nx-muted">{t("loading")}</span> : vols.length === 0 ? <span className="nx-muted">{t("stor.noVolumes")}</span> : (
                            <ul className="nx-list nx-list--vols">{vols.map((v) => <li key={v.nom}><span className="nx-mono">{v.nom}</span><span className="nx-mono nx-muted">{formatSizeGb(v.capacite_go, lang)}</span><span className="nx-muted">{v.utilise ? t("stor.inUse") : t("stor.free")}</span></li>)}</ul>
                          )}
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <CreatePoolDrawer open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
StoragePage.ownHeader = true;
