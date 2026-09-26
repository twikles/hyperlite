import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import AppShell from "./layout/AppShell";
const NextApp = lazy(() => import("./next/NextApp"));
const NextLogin = lazy(() => import("./next/NextLogin"));
import LoginScreen from "./auth/LoginScreen";
import ConsoleWindow from "./console/ConsoleWindow";
import HostShellWindow from "./console/HostShellWindow";
import ContainerTerminalWindow from "./console/ContainerTerminalWindow";
import { useAuthStore } from "./store/useAuthStore";

// /console/:name and /host-shell have their own authentication gate
// (ConsoleWindow / HostShellWindow): these pages open in a separate window (see
// VMConsoleTab / NodeShellTab), independently of the main dashboard lifecycle, so
// they stay outside the global gate below.
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/console/:name" element={<ConsoleWindow />} />
        <Route path="/host-shell" element={<HostShellWindow />} />
        <Route path="/container-terminal/:name" element={<ContainerTerminalWindow />} />
        <Route path="/*" element={<MainApp />} />
      </Routes>
    </BrowserRouter>
  );
}

function MainApp() {
  const status = useAuthStore((s) => s.status);
  const restoreSession = useAuthStore((s) => s.restoreSession);
  // Decided once per mount (reads and clears the ?ui= parameter).
  const [nextUi] = useState(readNextUi);

  useEffect(() => { restoreSession(); }, [restoreSession]);

  if (status === "checking") {
    return <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">Checking the session...</div>;
  }
  if (status === "anonymous") {
    return nextUi ? <Suspense fallback={null}><NextLogin /></Suspense> : <LoginScreen />;
  }

  if (nextUi) return <Suspense fallback={null}><NextApp /></Suspense>;

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/datacenter" replace />} />
      <Route path="/datacenter" element={<AppShell />} />
      <Route path="/node/:id" element={<AppShell />} />
      <Route path="/vm/:id" element={<AppShell />} />
      <Route path="*" element={<Navigate to="/datacenter" replace />} />
    </Routes>
  );
}

// The rebuilt interface is opt-in until the migration is complete: `?ui=next` switches to it and
// remembers the choice, `?ui=legacy` (or the "classic interface" menu entry) switches back.
function readNextUi() {
  const params = new URLSearchParams(window.location.search);
  const asked = params.get("ui");
  const nextDefault = import.meta.env.VITE_DEFAULT_UI === "next";
  if (asked === "next" || asked === "legacy") {
    // In a build whose default is the rebuilt interface, ?ui=legacy applies to this load only, so a
    // stored "legacy" choice can never trap the user in the old screens.
    if (!(nextDefault && asked === "legacy")) {
      try { localStorage.setItem("hyperlite-ui", asked); } catch { /* storage unavailable: applies to this load only */ }
    } else {
      try { localStorage.removeItem("hyperlite-ui"); } catch { /* storage unavailable */ }
    }
    params.delete("ui");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    return asked === "next";
  }
  if (nextDefault) return true;
  try { return localStorage.getItem("hyperlite-ui") === "next"; } catch { return false; }
}
