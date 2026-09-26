import { useEffect, useState } from "react";
import { createContainer, searchDockerHub } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { confirmAction } from "../../store/useConfirmStore";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useT } from "../i18n";
import { errorMessage } from "../lib/errors";
import { GALLERY, NAME_RE } from "../lib/containerImages";

const initial = (networks) => ({ name: "", vcpu: 1, memory_mb: 512, username: "", password: "", network: networks[0]?.nom || "default", image: "" });
const int = (v, min, max) => v !== "" && Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;

// One screen on purpose: a container has far fewer choices than a VM (no ISO, no OS to pick). Same payload as
// the historical dialog. Errors are shown next to their field on submit, a refusal keeps every typed value,
// one submit only, and closing with typed values asks first.
export default function CreateContainerWizard({ open, onClose, triggerRef }) {
  const t = useT();
  const networks = useInfraStore((s) => s.networks);
  const containersTaken = useInfraStore((s) => s.vms); // VM names share the libvirt namespace
  const addTask = useInfraStore((s) => s.addTask);
  const completeTask = useInfraStore((s) => s.completeTask);
  const pushToast = useInfraStore((s) => s.pushToast);
  const [form, setForm] = useState(() => initial(networks));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);

  useEffect(() => { setForm((f) => (networks.some((n) => n.nom === f.network) ? f : { ...f, network: networks[0]?.nom || f.network })); }, [networks]);
  useEffect(() => {
    if (!query.trim()) return undefined;
    const id = setTimeout(() => { searchDockerHub(query).then((r) => setResults(Array.isArray(r) ? r : [])).catch(() => setResults([])); }, 400);
    return () => clearTimeout(id);
  }, [query]);

  const patch = (f) => setForm((x) => ({ ...x, ...f }));
  const pick = (image) => { patch({ image }); setQuery(""); setResults([]); };
  const taken = containersTaken.some((v) => v.nom === form.name);
  const errors = {
    name: !NAME_RE.test(form.name) ? "wz.e.name" : taken ? "wz.e.taken" : "",
    vcpu: int(form.vcpu, 1, 16) ? "" : "cw.e.vcpu",
    memory_mb: int(form.memory_mb, 128, 1048576) ? "" : "cw.e.memory",
    username: /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(form.username) ? "" : "wz.e.user",
    password: form.password.length >= 4 ? "" : "wz.e.password",
    network: networks.length === 0 || networks.some((n) => n.nom === form.network) ? "" : "wz.e.network",
  };
  const bad = Object.values(errors).some(Boolean);
  const dirty = Boolean(form.name || form.username || form.password || form.image);
  const fe = (k) => attempted && errors[k] && <span className="nx-hint nx-hint--error" id={`cw-${k}`}>{t(errors[k])}</span>;
  const inv = (k) => ({ "aria-invalid": attempted && errors[k] ? true : undefined, "aria-describedby": attempted && errors[k] ? `cw-${k}` : undefined });

  const reset = () => { setForm(initial(networks)); setAttempted(false); setError(null); setQuery(""); setResults([]); };
  async function requestClose() {
    if (busy) return;
    if (dirty && !(await confirmAction({ title: t("wz.discardTitle"), message: t("wz.discardMsg"), confirmLabel: t("wz.discard") }))) return;
    onClose(); reset();
  }
  async function create(e) {
    e.preventDefault();
    if (busy) return;
    if (bad) { setAttempted(true); return; }
    setBusy(true); setError(null);
    const taskId = addTask({ type: "create_container", cible: form.name });
    try {
      await createContainer({ ...form, vcpu: Number(form.vcpu), memory_mb: Number(form.memory_mb) });
      completeTask(taskId, "termine");
      pushToast({ kind: "success", title: t("ct.created"), message: `${form.name}: ${t("ct.building")}` });
      window.dispatchEvent(new Event("nx:containers-changed"));
      onClose(); reset();
    } catch (er) { completeTask(taskId, "echec", errorMessage(er)); setError(errorMessage(er)); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) requestClose(); }}>
      <DialogContent className="nx-wizard nx-wizard2 nx-wizard2--sm w-full max-w-3xl sm:max-w-3xl p-0 gap-0 overflow-hidden" onCloseAutoFocus={(e) => { if (triggerRef?.current) { e.preventDefault(); triggerRef.current.focus(); } }}>
        <DialogHeader className="nx-wiz-head">
          <DialogTitle>{t("cw.title")}</DialogTitle>
          <DialogDescription className="nx-muted">{t("cw.desc")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={create} noValidate>
          <div className="nx-wiz-body nx-form">
            <label>{t("ct.name")}<input className="nx-input" aria-label="Name" autoFocus value={form.name} onChange={(e) => patch({ name: e.target.value })} {...inv("name")} />{fe("name")}</label>
            <fieldset className="nx-fieldset">
              <legend>{t("ct.image")}</legend>
              <div className="nx-tiles">
                {GALLERY.map(([key, label, desc]) => <button type="button" key={label} className="nx-tile" aria-pressed={form.image === key} onClick={() => pick(key)}><b>{label}</b><small>{t(desc)}</small></button>)}
              </div>
              <label>{t("ct.otherImage")}<input className="nx-input" aria-label="Docker Hub image" value={query} placeholder="traefik, ghcr.io/foo/bar:tag" onChange={(e) => { setQuery(e.target.value); patch({ image: e.target.value }); }} /></label>
              {results.length > 0 && (
                <ul className="nx-list nx-list--vols" aria-label={t("ct.results")}>
                  {results.map((r) => <li key={r.nom}><button type="button" className="nx-link" onClick={() => pick(`${r.nom}:latest`)}>{r.nom}</button><span className="nx-muted">{r.officielle ? `${t("ct.official")} · ` : ""}{r.description}</span><span className="nx-mono nx-muted">★ {r.etoiles}</span></li>)}
                </ul>
              )}
              {form.image && !GALLERY.some((g) => g[0] === form.image) && <span className="nx-hint">{t("ct.selected")} <span className="nx-mono">{form.image}</span></span>}
              <span className="nx-hint">{t("cw.imageHelp")}</span>
            </fieldset>
            <div className="nx-formgrid nx-fg">
              <label>vCPU<input className="nx-input" aria-label="vCPU" type="number" min={1} max={16} value={form.vcpu} onChange={(e) => patch({ vcpu: e.target.value })} {...inv("vcpu")} />{fe("vcpu")}</label>
              <label>{t("ct.ram")}<input className="nx-input" aria-label="RAM (MB)" type="number" min={128} step={128} value={form.memory_mb} onChange={(e) => patch({ memory_mb: e.target.value })} {...inv("memory_mb")} />{fe("memory_mb")}</label>
              <label>{t("ct.network")}<select className="nx-input" aria-label="Network" value={form.network} onChange={(e) => patch({ network: e.target.value })}>{networks.length === 0 && <option value="default">default</option>}{networks.map((n) => <option key={n.nom} value={n.nom}>{n.nom}</option>)}</select>{fe("network")}</label>
            </div>
            <div className="nx-formgrid nx-fg">
              <label>{t("ct.user")}<input className="nx-input" aria-label="User" autoComplete="off" value={form.username} onChange={(e) => patch({ username: e.target.value })} {...inv("username")} />{fe("username")}</label>
              <label>{t("ct.password")}<input className="nx-input" aria-label="Password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => patch({ password: e.target.value })} {...inv("password")} />{fe("password")}</label>
            </div>
            <div className="nx-bn" data-tone="info" role="note"><span className="nx-bn-t">{t("cw.firstBuild")}</span></div>
          </div>
          {error && <div role="alert" className="nx-error nx-wiz-error"><strong>{t("cw.failed")}</strong> <span className="nx-mono" style={{ overflowWrap: "anywhere" }}>{error}</span></div>}
          <DialogFooter className="nx-wiz-foot">
            <span className="nx-sp" />
            <button type="button" className="nx-btn nx-btn--ghost" onClick={requestClose}>{t("action.cancel")}</button>
            <button type="submit" className="nx-btn nx-btn--primary" disabled={busy}>{busy ? t("stor.creating") : t("cw.create")}</button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
