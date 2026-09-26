import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Keyboard, Maximize, Plug, TriangleAlert, Unplug } from "lucide-react";
import { createConsoleTicket, createTerminalTicket } from "../../api/client";
import { ensureXtermLoaded, wsUrl } from "../../utils/loadXterm";
import { useAuthStore } from "../../store/useAuthStore";
import { useT } from "../i18n";
import { capabilities } from "../lib/capabilities";
import { errorMessage } from "../lib/errors";
import { Empty } from "../components/ui";

// Console embedded in the VM page: the graphical console (VNC through noVNC, opened automatically for a running
// VM) or the SSH terminal (xterm, administrators only, like the backend), with the same ticket + WebSocket relay
// as the separate window, which stays one click away.
export default function VmConsole({ resource: vm }) {
  const t = useT();
  const caps = capabilities(useAuthStore((s) => s.role));
  const [mode, setMode] = useState("vnc");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const screen = useRef(null);
  const frame = useRef(null);
  const rfb = useRef(null);
  const term = useRef(null);
  const ws = useRef(null);
  const onResize = useRef(null);
  const name = vm?.nom;
  const running = vm?.etat === "actif";
  const terminal = mode === "terminal";

  const cleanup = useCallback(() => {
    try { rfb.current?.disconnect(); } catch { /* already closed */ }
    try { ws.current?.close(); } catch { /* already closed */ }
    try { term.current?.dispose(); } catch { /* already disposed */ }
    if (onResize.current) window.removeEventListener("resize", onResize.current);
    rfb.current = null; ws.current = null; term.current = null; onResize.current = null;
    if (screen.current) screen.current.innerHTML = "";
    setStatus("idle");
  }, []);

  const connectVnc = useCallback(async () => {
    setStatus("connecting"); setError(null);
    try {
      const ticket = await createConsoleTicket(name);
      const url = wsUrl(`/vms/${encodeURIComponent(name)}/console?ticket=${encodeURIComponent(ticket.ticket)}`);
      // noVNC lives in public/novnc, outside the bundle: loaded as is at runtime.
      const mod = await import(/* @vite-ignore */ new URL("/novnc/core/rfb.js", window.location.origin).href);
      screen.current.innerHTML = "";
      const r = new mod.default(screen.current, url);
      r.scaleViewport = true;
      rfb.current = r;
      r.addEventListener("connect", () => { setStatus("connected"); r.scaleViewport = true; });
      r.addEventListener("disconnect", () => setStatus("idle"));
      r.addEventListener("credentialsrequired", () => { setError(t("vc.credentials")); setStatus("error"); });
    } catch (e) { setError(errorMessage(e)); setStatus("error"); }
  }, [name, t]);

  async function connectTerminal() {
    setStatus("connecting"); setError(null);
    try {
      await ensureXtermLoaded();
      const ticket = await createTerminalTicket(name);
      screen.current.innerHTML = "";
      // xterm is a UMD global; its theme is the graphite of the navigation column.
      // eslint-disable-next-line no-undef
      const tm = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "IBM Plex Mono, ui-monospace, monospace", theme: { background: "#141215", foreground: "#F1ECEE", cursor: "#CE9DB2" } });
      // eslint-disable-next-line no-undef
      const fit = new FitAddon.FitAddon();
      tm.loadAddon(fit); tm.open(screen.current); fit.fit(); term.current = tm;
      const sock = new WebSocket(wsUrl(`/vms/${encodeURIComponent(name)}/terminal?ticket=${encodeURIComponent(ticket.ticket)}`));
      ws.current = sock;
      sock.onopen = () => { setStatus("connected"); fit.fit(); sock.send("\x00" + JSON.stringify({ cols: tm.cols, rows: tm.rows })); };
      sock.onmessage = (ev) => tm.write(ev.data);
      sock.onclose = () => { tm.write("\r\n\x1b[33m[connection closed]\x1b[0m\r\n"); setStatus("idle"); };
      sock.onerror = () => setError(t("vc.termError"));
      tm.onData((d) => { if (sock.readyState === WebSocket.OPEN) sock.send(d); });
      tm.onResize(({ cols, rows }) => { if (sock.readyState === WebSocket.OPEN) sock.send("\x00" + JSON.stringify({ cols, rows })); });
      onResize.current = () => fit.fit();
      window.addEventListener("resize", onResize.current);
    } catch (e) { setError(errorMessage(e)); setStatus("error"); }
  }

  useEffect(() => cleanup, [cleanup, name, mode]);
  // The graphical console opens by itself for a running VM, as in the separate window.
  useEffect(() => { if (running && mode === "vnc") connectVnc(); }, [running, mode, name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!vm) return null;
  const openWindow = () => window.open(`/console/${encodeURIComponent(vm.nom)}?mode=${mode}`, `hyperlite-console-${vm.nom}-${mode}`, "width=1100,height=750,noopener");
  const connected = status === "connected";
  const switchMode = (m) => { if (m !== mode) { cleanup(); setMode(m); } };

  return (
    <>
      {terminal && caps.admin && <div className="nx-bn" data-tone="warning" role="note"><TriangleAlert size={16} aria-hidden="true" /><span className="nx-bn-t">{t("vc.sshWarn")}</span></div>}
      <div>
        <div className="nx-termbar">
          <div className="nx-seg2" role="group" aria-label={t("vc.mode")}>
            <button type="button" aria-pressed={!terminal} onClick={() => switchMode("vnc")}>{t("vc.vnc")}</button>
            <button type="button" aria-pressed={terminal} onClick={() => switchMode("terminal")}>{t("vc.ssh")}</button>
          </div>
          <span className="nx-st" data-tone={connected ? undefined : "offline"} style={{ fontSize: "var(--fs-125)" }}><span className="nx-dot" data-tone={connected ? "success" : "offline"} aria-hidden="true" />{t(connected ? "nn.connected" : status === "connecting" ? "nn.connecting" : "nn.notConnected")}</span>
          <span className="nx-sp" />
          {!(terminal && !caps.admin) && (connected
            ? <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={cleanup}><Unplug size={14} aria-hidden="true" />{t("nn.disconnect")}</button>
            : <button type="button" className="nx-btn nx-btn--sm" disabled={!running || status === "connecting"} onClick={() => (terminal ? connectTerminal() : connectVnc())}><Plug size={14} aria-hidden="true" />{t("vc.connect")}</button>)}
          {!terminal && <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" disabled={!connected} onClick={() => rfb.current?.sendCtrlAltDel()}><Keyboard size={14} aria-hidden="true" />Ctrl+Alt+Suppr</button>}
          <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" disabled={!connected} onClick={() => frame.current?.requestFullscreen?.()}><Maximize size={14} aria-hidden="true" />{t("vc.fullscreen")}</button>
          <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" disabled={!running || (terminal && !caps.admin)} onClick={openWindow}><ExternalLink size={14} aria-hidden="true" />{t("nn.openWindow")}</button>
        </div>
        {terminal && !caps.admin ? (
          <div className="nx-card2" style={{ borderRadius: "0 0 10px 10px" }}><Empty title={t("vc.adminOnlyTitle")} text={t("vc.adminOnlyHelp")} /></div>
        ) : (
          <div className="nx-termwrap nx-screen" ref={frame}>
            <div className="nx-term nx-term--screen" ref={screen} role="region" aria-label={terminal ? t("vc.ssh") : t("vc.vnc")} />
            {!connected && status !== "connecting" && <p className="nx-term-hint">{running ? t(terminal ? "vc.sshHelp" : "vc.vncHelp") : t("vc.mustRun")}</p>}
          </div>
        )}
        {error && <p className="nx-f-h is-error" role="alert">{error}</p>}
      </div>
    </>
  );
}
