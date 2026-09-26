import { useEffect, useRef } from "react";

// One-shot navigation intents: a control somewhere asks a page to open one of its own forms once it is shown
// (Create ▸ Storage pool opens the pool form of the Storage page, VM ▸ Actions ▸ Create a snapshot opens the
// snapshot dialog...). The page consumes the intent on mount, so a later visit does not reopen the form.
const pending = new Map();

export function requestIntent(kind, payload = true) {
  pending.set(kind, payload);
  window.dispatchEvent(new CustomEvent("nx:intent", { detail: kind }));
}

export function consumeIntent(kind) {
  if (!pending.has(kind)) return null;
  const v = pending.get(kind);
  pending.delete(kind);
  return v;
}

// Calls `handler(payload)` when an intent of `kind` is pending on mount, or arrives while the page is shown.
// `ready` lets a page wait for its data before opening the form.
export function useIntent(kind, handler, ready = true) {
  const ref = useRef(handler);
  useEffect(() => { ref.current = handler; });
  useEffect(() => {
    if (!ready) return undefined;
    const run = () => { const v = consumeIntent(kind); if (v != null) ref.current(v); };
    run();
    const on = (e) => { if (e.detail === kind) run(); };
    window.addEventListener("nx:intent", on);
    return () => window.removeEventListener("nx:intent", on);
  }, [kind, ready]);
}
