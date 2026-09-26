import { useEffect, useId, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Info, X } from "lucide-react";
import { useT, useLangStore } from "../i18n";
import { useFreshness } from "../lib/inventory";

// Shared building blocks of the redesigned screens: page header, KPI strip, meter, pill, sparkline, empty
// state, side drawer. Every colour comes from the tokens; status is always a shape plus a word.

export const toneOf = (pct) => (pct == null ? "info" : pct >= 90 ? "danger" : pct >= 80 ? "warning" : "info");

const nowMs = () => Date.now();

// "Up to date · 4 s ago" for pages that poll, instead of a Refresh button.
export function Freshness({ at }) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const { updatedAt, failing } = useFreshness(useShallow((s) => ({ updatedAt: s.updatedAt, failing: s.failing })));
  const [now, setNow] = useState(nowMs);
  useEffect(() => { const id = setInterval(() => setNow(nowMs()), 1000); return () => clearInterval(id); }, []);
  const stamp = at ?? updatedAt;
  if (!stamp) return null;
  const s = Math.max(0, Math.round((now - stamp) / 1000));
  const stale = at ? false : failing;
  const ago = s < 60 ? t("fresh.s", { n: s }) : t("fresh.min", { n: new Intl.NumberFormat(lang).format(Math.floor(s / 60)) });
  return (
    <span className={`nx-fresh-ind${stale ? " is-stale" : ""}`}>
      <span className="nx-dot" data-tone={stale ? "warning" : "success"} aria-hidden="true" />
      {stale ? t("fresh.stale", { ago }) : t("fresh.ok", { ago })}
    </span>
  );
}

// Page header: the h1 (with the object count beside it), a one-line description or an (i) help, and the
// page's actions (at most one primary). Card titles never repeat it.
export function PageHeader({ title, count, desc, help, actions, fresh = false, freshAt, level = 1 }) {
  const t = useT();
  const H = `h${level}`;
  return (
    <div className={`nx-ph${level > 1 ? " nx-ph--sub" : ""}`}>
      <div className="nx-ph-text">
        <div className="nx-ph-title">
          <H>{title}</H>
          {count != null && <span className="nx-cnt">{count}</span>}
          {help && <HelpTip text={help} label={t("help")} />}
        </div>
        {desc && <p className="nx-ph-desc">{desc}</p>}
      </div>
      {(actions || fresh) && <div className="nx-ph-acts">{fresh && <Freshness at={freshAt} />}{actions}</div>}
    </div>
  );
}

// (i) button whose explanation shows on hover and on focus (keyboard), and is read by screen readers.
export function HelpTip({ text, label }) {
  const id = useId();
  return (
    <span className="nx-help">
      <button type="button" className="nx-help-btn" aria-label={label} aria-describedby={id}><Info size={15} aria-hidden="true" /></button>
      <span role="tooltip" id={id} className="nx-help-tip">{text}</span>
    </span>
  );
}

export function Spark({ data, max = 100, tone, label }) {
  const pts = (data || []).filter((v) => v != null && !Number.isNaN(v));
  if (pts.length < 2) return null;
  const top = max === "auto" ? Math.max(1, ...pts) : max;
  const w = 200, h = 28;
  const line = pts.map((v, i) => `${i ? "L" : "M"}${((i * w) / (pts.length - 1)).toFixed(1)} ${(h - 2 - (Math.min(v, top) / top) * (h - 4)).toFixed(1)}`).join(" ");
  const tn = tone || (max === 100 ? toneOf(pts[pts.length - 1]) : "info");
  return (
    <svg className="nx-spark" data-tone={tn} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
      <path d={`${line} L${w} ${h} L0 ${h}Z`} className="nx-spark-fill" />
      <path d={line} className="nx-spark-line" />
    </svg>
  );
}

// KPI strip: one row of figures; a tile with `onClick` is a button that opens the matching page.
export function KpiStrip({ items, label }) {
  return (
    <div className="nx-strip" role="group" aria-label={label} style={{ "--n": items.length }}>
      {items.map((k) => {
        const Tag = k.onClick ? "button" : "div";
        return (
          <Tag key={k.id || k.label} type={k.onClick ? "button" : undefined} className="nx-kpi" onClick={k.onClick}>
            <span className="nx-kpi-l">{k.dot && <span className="nx-dot" data-tone={k.dot} aria-hidden="true" />}{k.label}</span>
            <span className="nx-kpi-v">{k.value ?? "—"}{k.unit && <small>{k.unit}</small>}</span>
            {k.sub && <span className={`nx-kpi-s${k.subTone ? ` nx-tone-${k.subTone}` : ""}`}>{k.sub}</span>}
            {k.spark && <Spark data={k.spark} max={k.sparkMax ?? 100} />}
          </Tag>
        );
      })}
    </div>
  );
}

// Percentage meter with its value; the colour follows the thresholds (80 % warning, 90 % danger).
export function Meter({ value, label, wide }) {
  if (value == null || Number.isNaN(value)) return <span className="nx-muted">—</span>;
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <span className="nx-meter">
      <span className={`nx-track${wide ? " nx-track--wide" : ""}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span data-tone={toneOf(pct)} style={{ width: `${pct}%` }} />
      </span>
      <span className="nx-mono nx-meter-v" data-tone={pct >= 80 ? toneOf(pct) : undefined}>{pct} %</span>
    </span>
  );
}

// State pill: a dot plus a word, on a tinted background.
export function Pill({ tone = "offline", children }) {
  return <span className="nx-pill" data-tone={tone}><span className="nx-dot" data-tone={tone} aria-hidden="true" />{children}</span>;
}

export function Chip({ tone, children, title }) {
  return <span className="nx-chip" data-tone={tone} title={title}>{children}</span>;
}

// Empty state: an icon tile, a title, one sentence saying how to get the first item, at most one default button.
export function Empty({ icon: IconC, title, text, action }) {
  return (
    <div className="nx-empty2" role="status">
      {IconC && <span className="nx-empty2-tile" aria-hidden="true"><IconC size={20} /></span>}
      <strong>{title}</strong>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

// Card: a titled section. Title only when the page holds several sections; `flush` for a table filling it.
export function Card({ title, id, note, actions, flush, children, className = "" }) {
  const autoId = useId();
  const hid = id || autoId;
  return (
    <section className={`nx-card2${flush ? " nx-card2--flush" : ""} ${className}`} aria-labelledby={title ? hid : undefined}>
      {title && (
        <div className="nx-card2-h">
          <h2 id={hid}>{title}</h2>
          {note != null && <span className="nx-card2-note">{note}</span>}
          {actions && <div className="nx-card2-acts">{actions}</div>}
        </div>
      )}
      <div className="nx-card2-b">{children}</div>
    </section>
  );
}

// Right-hand side drawer (440 px) for short forms. Escape and the scrim close it; focus moves in and back.
export function SideDrawer({ open, title, onClose, children, footer, busy = false }) {
  const t = useT();
  const ref = useRef(null);
  const opener = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    const el = ref.current;
    requestAnimationFrame(() => el?.querySelector("input, select, textarea, button:not(.nx-sdrawer-x)")?.focus());
    return () => { const o = opener.current; if (o && document.body.contains(o)) o.focus(); };
  }, [open]);
  if (!open) return null;
  const onKeyDown = (e) => {
    if (e.key === "Escape" && !busy) { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab") return;
    const f = [...ref.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [href], [tabindex="0"]')];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <>
      <div className="nx-scrim nx-scrim--drawer" onClick={() => !busy && onClose()} />
      <aside ref={ref} className="nx-sdrawer" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown}>
        <div className="nx-sdrawer-h"><h2>{title}</h2><button type="button" className="nx-btn nx-btn--ghost nx-btn--icon nx-sdrawer-x" aria-label={t("action.close")} onClick={onClose} disabled={busy}><X size={16} aria-hidden="true" /></button></div>
        <div className="nx-sdrawer-b">{children}</div>
        {footer && <div className="nx-sdrawer-f">{footer}</div>}
      </aside>
    </>
  );
}

// Labelled form field: label above, hint (or error) below, optional unit inside the input.
export function Field({ label, hint, error, unit, children, id }) {
  const autoId = useId();
  const fid = id || autoId;
  const child = typeof children === "function" ? children({ id: fid, "aria-invalid": error ? true : undefined, "aria-describedby": hint || error ? `${fid}-h` : undefined }) : children;
  return (
    <div className="nx-f">
      <label htmlFor={fid}>{label}</label>
      {unit ? <div className="nx-unit">{child}<span aria-hidden="true">{unit}</span></div> : child}
      {(error || hint) && <span id={`${fid}-h`} className={`nx-f-h${error ? " is-error" : ""}`}>{error || hint}</span>}
    </div>
  );
}
