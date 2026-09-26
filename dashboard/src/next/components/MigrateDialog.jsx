import { useEffect, useRef, useState } from "react";
import { fetchMigrationCheck, migrateVM } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useT } from "../i18n";
import { errorMessage } from "../lib/errors";
import CompatChecks from "../../components/CompatChecks";

// Live migration of one VM: pick an online destination, read the compatibility diagnostic (the same
// read-only endpoint as the historical screen), then start it. Blockers stop the button unless the admin
// explicitly chooses to ignore them; the server checks again in any case.
export default function MigrateDialog({ vm, targets, onClose }) {
  const t = useT();
  const pushToast = useInfraStore((s) => s.pushToast);
  const refreshAll = useInfraStore((s) => s.refreshAll);
  const [target, setTarget] = useState(targets.length === 1 ? targets[0].id : "");
  const [check, setCheck] = useState(null);
  const [ignore, setIgnore] = useState(false);
  const [busy, setBusy] = useState(false);
  const first = useRef(null);
  const opener = useRef(typeof document !== "undefined" ? document.activeElement : null);

  useEffect(() => { first.current?.focus(); const el = opener.current; return () => el?.focus?.(); }, []);
  useEffect(() => {
    setIgnore(false);
    if (!target) { setCheck(null); return undefined; }
    let alive = true;
    setCheck({ loading: true });
    fetchMigrationCheck(vm.nom, target, vm.node)
      .then((report) => alive && setCheck({ report }))
      .catch((e) => alive && setCheck({ error: errorMessage(e) }));
    return () => { alive = false; };
  }, [target, vm.nom, vm.node]);

  const blocked = Boolean(check?.report?.resume?.bloquant) && !ignore;
  const name = targets.find((n) => n.id === target)?.nom || target;

  async function start() {
    setBusy(true);
    try {
      await migrateVM(vm.nom, target, vm.node, ignore);
      pushToast({ kind: "success", title: t("mig.started"), message: t("mig.startedMsg", { vm: vm.nom, node: name }) });
      onClose();
      refreshAll?.();
    } catch (e) {
      pushToast({ kind: "error", title: t("mig.failed"), message: errorMessage(e) });
      setBusy(false);
    }
  }

  return (
    <div className="nx-scrim" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="nx-dialog" role="dialog" aria-modal="true" aria-labelledby="mig-title" onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.stopPropagation(); onClose(); } }}>
        <h2 id="mig-title">{t("mig.title", { name: vm.nom })}</h2>
        <p className="nx-muted" style={{ margin: 0 }}>{t("mig.help")}</p>
        <label className="nx-dialog-field">{t("mig.target")}
          <select ref={first} className="nx-input" value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
            <option value="">{t("mig.choose")}</option>
            {targets.map((n) => <option key={n.id} value={n.id}>{n.nom}</option>)}
          </select>
        </label>
        {check?.loading && <p className="nx-muted" role="status" style={{ margin: 0 }}>{t("mig.checking")}</p>}
        {check?.error && <p className="nx-notice nx-notice--warning" role="status" style={{ margin: 0 }}>{t("mig.checkFailed", { error: check.error })}</p>}
        {check?.report && <CompatChecks report={check.report} labels={{ blocking: t("cc.blocking"), warning: t("cc.warning"), ok: t("cc.ok"), allOk: t("cc.allOk"), action: t("cc.action"), toggle: (show, n) => t(show ? "cc.hideOk" : "cc.showOk", { n }) }} />}
        {check?.report?.resume?.bloquant && (
          <label className="nx-check"><input type="checkbox" checked={ignore} onChange={(e) => setIgnore(e.target.checked)} disabled={busy} /> {t("mig.ignore")}</label>
        )}
        <div className="nx-dialog-actions">
          <button type="button" className="nx-btn" onClick={onClose} disabled={busy}>{t("action.cancel")}</button>
          <button type="button" className="nx-btn nx-btn--primary" disabled={!target || busy || check?.loading || blocked} onClick={start}>{busy ? t("mig.starting") : t("mig.go")}</button>
        </div>
      </div>
    </div>
  );
}
