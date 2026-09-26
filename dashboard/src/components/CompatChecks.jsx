import { useState } from "react";

const STYLE = { blocking: "text-status-error", warning: "text-status-warning", ok: "text-status-running" };
// English defaults for the historical interface; the rebuilt one passes its translations through `labels`.
const LABELS = {
  blocking: "Blocking", warning: "Attention", ok: "OK", allOk: "All compatibility checks passed.", action: "Action",
  toggle: (show, n) => `${show ? "Hide" : "Show"} the ${n} passed check(s)`,
};

// List of compatibility checks (shape {statut, message, action?} from
// app/core/cluster_compat.py): unsatisfied items first, the OK ones collapsible so
// they do not drown out the essentials.
export default function CompatChecks({ report, labels }) {
  const L = { ...LABELS, ...labels };
  const [showOk, setShowOk] = useState(false);
  if (!report) return null;
  const bad = report.controles.filter((c) => c.statut !== "ok");
  const ok = report.controles.filter((c) => c.statut === "ok");
  const rows = showOk ? [...bad, ...ok] : bad;
  return (
    <div className="w-full space-y-1.5 text-sm">
      {bad.length === 0 && <div className="text-status-running">{L.allOk}</div>}
      {rows.map((c, i) => {
        const cls = STYLE[c.statut];
        const label = L[c.statut];
        return (
          <div key={`${c.id}-${i}`} className="flex items-start justify-between gap-4">
            <div>
              <div className="text-foreground">{c.message}</div>
              {c.action && <div className="text-xs text-foreground/80">{L.action}: {c.action}</div>}
            </div>
            <span className={`shrink-0 text-xs font-medium ${cls}`}>{label}</span>
          </div>
        );
      })}
      {ok.length > 0 && (
        <button type="button" className="text-xs text-foreground/80 underline transition-colors duration-150 hover:text-foreground" onClick={() => setShowOk((v) => !v)}>
          {L.toggle(showOk, ok.length)}
        </button>
      )}
    </div>
  );
}
