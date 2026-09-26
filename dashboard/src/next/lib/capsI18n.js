import { NA } from "../../lib/capabilitiesView";

// The capability profile rows and features are built by a module shared with the historical interface, in English.
// Known sections, labels and values are translated here; anything unknown keeps its original text.
const tr = (t, key, fallback) => { const v = t(key); return v === key ? fallback : v; };

export function capRow(t, r) {
  return {
    ...r,
    section: tr(t, `caps.s.${r.section}`, r.section),
    label: tr(t, `caps.k.${r.key}`, r.label),
    value: r.value === NA ? NA : typeof r.value === "string" ? tr(t, `caps.v.${r.value}`, r.value) : r.value,
  };
}

export function featureRow(t, f) {
  return { ...f, label: tr(t, `feat.${f.id}`, f.label), detail: f.detail ? tr(t, `feat.d.${f.detail}`, f.detail) : f.detail };
}
