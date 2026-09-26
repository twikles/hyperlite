import { useCallback, useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import "./next.css";
import "./refonte.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import ConfirmHost from "../components/ConfirmHost";
import { useT, useLangStore } from "./i18n";
import { useThemeStore } from "./tokens/theme";
import { useInfraStore } from "../store/useInfraStore";
import { usePolling } from "./lib/polling";
import { refreshInventory, refreshExtras } from "./lib/inventory";
import TopBar from "./layout/TopBar";
import Workspace from "./layout/Workspace";
import Dock from "./layout/Dock";
import Palette from "./layout/Palette";
import Sidebar from "./layout/Sidebar";

const SIDEBAR_KEY = "hyperlite-next-sidebar";
function readSidebarCollapsed() { try { return localStorage.getItem(SIDEBAR_KEY) === "1"; } catch { return false; } }

const REFRESH_MS = 6000;
const EXTRAS_MS = 15000;

// Root of the rebuilt interface. Same auth, stores, API client and routes as the legacy UI (this
// component is rendered by App.jsx once the session is authenticated).
export default function NextApp() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const initTheme = useThemeStore((s) => s.init);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [wizards, setWizards] = useState({});

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.ui = "next";
    root.lang = lang;
    const cleanup = initTheme();
    return () => {
      cleanup?.();
      delete root.dataset.ui; delete root.dataset.theme;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  // The task dock starts collapsed (calm by default); it shows a running-task count and can be opened at any time.
  useEffect(() => { useInfraStore.setState({ taskLogCollapsed: true }); }, []);

  useEffect(() => { refreshInventory({ initial: true }).catch(() => {}); refreshExtras(); }, []);
  usePolling(useCallback(() => refreshInventory(), []), REFRESH_MS);
  usePolling(useCallback(() => refreshExtras(), []), EXTRAS_MS);

  const toggleSidebar = useCallback(() => {
    if (window.innerWidth < 1024) { setSidebarOpen((o) => !o); return; }
    setSidebarCollapsed((c) => { const next = !c; try { localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0"); } catch { /* preference only */ } return next; });
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      const typing = tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen(true); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); toggleSidebar(); return; }
      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setPaletteOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  useEffect(() => {
    const on = () => setPaletteOpen(true);
    window.addEventListener("nx:palette", on);
    return () => window.removeEventListener("nx:palette", on);
  }, []);

  useEffect(() => {
    const on = (e) => setWizards({ [e.detail]: true });
    window.addEventListener("nx:wizard", on);
    return () => window.removeEventListener("nx:wizard", on);
  }, []);

  useEffect(() => {
    const close = () => { if (window.innerWidth < 1024) setSidebarOpen(false); };
    window.addEventListener("nx:navigated", close);
    return () => window.removeEventListener("nx:navigated", close);
  }, []);

  // Escape closes the narrow-screen drawer.
  useEffect(() => {
    if (!sidebarOpen) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setSidebarOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  const sidebarState = sidebarOpen ? "open" : sidebarCollapsed ? "collapsed" : undefined;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="nx-root" data-sidebar={sidebarState}>
        <a className="nx-skip" href="#nx-main" onClick={(e) => { e.preventDefault(); document.getElementById("nx-main")?.focus(); }}>{t("skip")}</a>
        <Sidebar collapsed={sidebarCollapsed} />
        {sidebarOpen && <div className="nx-scrim" style={{ zIndex: 39 }} onClick={() => setSidebarOpen(false)} />}
        <TopBar onOpenPalette={() => setPaletteOpen(true)} onToggleSidebar={toggleSidebar} wizards={wizards} setWizards={setWizards} />
        <Routes>
          <Route path="/" element={<Navigate to="/datacenter" replace />} />
          <Route path="/datacenter" element={<Workspace />} />
          <Route path="/node/:id" element={<Workspace />} />
          <Route path="/vm/:id" element={<Workspace />} />
          <Route path="*" element={<Navigate to="/datacenter" replace />} />
        </Routes>
        <Dock />
        <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} setWizards={setWizards} />
      </div>
      <Toaster position="bottom-right" />
      <ConfirmHost />
    </TooltipProvider>
  );
}
