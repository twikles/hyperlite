import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { useT, useLangStore, LANGS } from "../i18n";
import { useThemeStore } from "../tokens/theme";
import { capabilities } from "../lib/capabilities";
import { useFreshness } from "../lib/inventory";
import Menu, { MenuItem } from "../components/Menu";
import UpdateModal from "../../components/UpdateModal";
import AccountSecurityModal from "../../components/AccountSecurityModal";
import EnclaveMark from "../../components/EnclaveMark";
import { Archive, Bell, Box, Camera, Database, Disc3, Ellipsis, Heart, House, KeyRound, List, Monitor, Network, ScrollText, Server, Share, SquareCheck, Users, Zap } from "lucide-react";

const ICONS = {
  overview: House, nodes: Server, vms: Monitor, containers: Box, storage: Database, network: Network,
  ha: Heart, compat: SquareCheck, backups: Archive, snapshots: Camera, exports: Share, library: Disc3,
  tasks: List, audit: ScrollText, automation: Zap, users: Users, sso: KeyRound, notifications: Bell,
};

function NavItem({ icon, label, count, tone, active, onClick }) {
  const I = ICONS[icon];
  return (
    <button type="button" className={`nx-nav-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick} title={label}>
      {I && <I size={17} aria-hidden="true" />}
      <span className="nx-nav-label">{label}</span>
      {count != null && <span className={`nx-nav-count${tone ? ` nx-nav-count--${tone}` : ""}`}>{count}</span>}
    </button>
  );
}

// A titled group of entries: every entry is a real page, grouped by what an engineer is doing.
function NavGroup({ label, children }) {
  return (
    <div className="nx-nav-group" role="group" aria-label={label || undefined}>
      {label && <div className="nx-nav-group-label" aria-hidden="true">{label}</div>}
      {children}
    </div>
  );
}

const WIDTH_KEY = "hyperlite-next-sidebar-width";
const MIN_W = 240, MAX_W = 480;
const clampW = (w) => Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
const applyWidth = (px) => document.querySelector(".nx-root")?.style.setProperty("--sidebar-width", `${px}px`);

// Drag (or arrow keys) to widen the sidebar; the width is remembered. Long VM names stay readable.
function Resizer({ label }) {
  const [w, setW] = useState(() => { try { const n = Number(localStorage.getItem(WIDTH_KEY)); return n > 0 ? clampW(n) : null; } catch { return null; } });
  const ref = useRef(null);
  useEffect(() => { if (w) applyWidth(w); }, [w]);
  const commit = (n) => { const v = clampW(n); setW(v); try { localStorage.setItem(WIDTH_KEY, String(v)); } catch { /* preference only */ } };
  const current = () => w ?? ref.current?.parentElement?.getBoundingClientRect().width ?? 264;
  function onPointerDown(e) {
    e.preventDefault();
    const startX = e.clientX, startW = current();
    const move = (ev) => { const v = clampW(startW + ev.clientX - startX); applyWidth(v); setW(v); };
    const up = (ev) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); commit(startW + ev.clientX - startX); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }
  function onKeyDown(e) {
    if (e.key === "ArrowLeft") { e.preventDefault(); commit(current() - 16); }
    else if (e.key === "ArrowRight") { e.preventDefault(); commit(current() + 16); }
    else if (e.key === "Home") { e.preventDefault(); commit(MIN_W); }
    else if (e.key === "End") { e.preventDefault(); commit(MAX_W); }
    else if (e.key === "Enter" || e.key === "0") { e.preventDefault(); setW(null); try { localStorage.removeItem(WIDTH_KEY); } catch { /* preference only */ } document.querySelector(".nx-root")?.style.removeProperty("--sidebar-width"); }
  }
  return <div ref={ref} className="nx-resizer" role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0} aria-valuemin={MIN_W} aria-valuemax={MAX_W} aria-valuenow={Math.round(w ?? 264)} onPointerDown={onPointerDown} onKeyDown={onKeyDown} />;
}

export default function Sidebar({ collapsed }) {
  const t = useT();
  const { selection, nodes, vms } = useInfraStore(useShallow((s) => ({ selection: s.selection, nodes: s.nodes, vms: s.vms })));
  const navigateTo = useInfraStore((s) => s.navigateTo);
  const { containers } = useFreshness(useShallow((s) => ({ containers: s.containers })));
  const role = useAuthStore((s) => s.role);
  const username = useAuthStore((s) => s.username);
  const logout = useAuthStore((s) => s.logout);
  const caps = capabilities(role);
  const lang = useLangStore((s) => s.lang);
  const setLang = useLangStore((s) => s.setLang);
  const { mode, setMode } = useThemeStore(useShallow((s) => ({ mode: s.mode, setMode: s.setMode })));
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const userBtn = useRef(null);
  const tab = useInfraStore((s) => s.activeTab);
  const onDatacenterTab = (id) => selection.type === "datacenter" && tab === id;
  // On narrow screens the sidebar is a drawer: close it once a page is chosen.
  const goto = (dcTab) => { navigateTo("datacenter", null, dcTab); window.dispatchEvent(new Event("nx:navigated")); };
  const activeNode = selection.type === "node" ? nodes.find((n) => n.id === selection.id) : null;

  const nodesOnline = nodes.filter((n) => n.etat === "online").length;
  const problems = vms.filter((v) => ["plante", "bloque", "inconnu"].includes(v.etat)).length;
  const host = activeNode || nodes.find((n) => n.id === "local") || nodes[0];

  return (
    <nav className={`nx-sidebar${collapsed ? " collapsed" : ""}`} aria-label={t("nav.main")}>
      {!collapsed && <Resizer label={t("nav.resize")} />}
      <div className="nx-sidebar-brand">
        <span className="nx-brand-mark"><EnclaveMark size={24} rails="var(--color-text-primary)" core="var(--color-accent)" /></span>
        <span className="nx-brand-text"><strong>{t("app.name")}</strong><small>{t("app.tagline")}</small></span>
      </div>

      {!collapsed && (
        <button type="button" className="nx-cluster" aria-label={`${host?.nom || t("res.datacenter")} — ${t("cluster.hint")}`} title={t("cluster.hint")} onClick={() => window.dispatchEvent(new Event("nx:palette"))}>
          <span className={`nx-cluster-dot${nodesOnline === nodes.length && nodes.length > 0 ? "" : " is-warn"}`} aria-hidden="true" />
          <span className="nx-cluster-name">{host?.nom || t("res.datacenter")}</span>
          <span className="nx-cluster-count">{t("nav.nodesCount", { n: nodes.length })}</span>
        </button>
      )}

      <div className="nx-nav-scroll">
        <NavGroup>
          <NavItem icon="overview" label={t("nav.overview")} active={onDatacenterTab("summary")} onClick={() => goto("summary")} />
        </NavGroup>
        <NavGroup label={t("nav.group.infrastructure")}>
          <NavItem icon="nodes" label={t("nav.nodes")} count={nodes.length} active={onDatacenterTab("nodes") || selection.type === "node"} onClick={() => goto("nodes")} />
          <NavItem icon="vms" label={t("nav.vms")} count={vms.length} tone={problems ? "warning" : undefined} active={selection.type === "vm" || onDatacenterTab("vms")} onClick={() => goto("vms")} />
          <NavItem icon="containers" label={t("nav.containers")} count={containers?.length ?? 0} active={onDatacenterTab("containers")} onClick={() => goto("containers")} />
          <NavItem icon="storage" label={t("nav.storage")} active={onDatacenterTab("storage")} onClick={() => goto("storage")} />
          <NavItem icon="network" label={t("nav.network")} active={onDatacenterTab("reseau")} onClick={() => goto("reseau")} />
        </NavGroup>
        <NavGroup label={t("nav.group.cluster")}>
          <NavItem icon="ha" label={t("nav.ha")} active={onDatacenterTab("ha")} onClick={() => goto("ha")} />
          <NavItem icon="compat" label={t("nav.compat")} active={onDatacenterTab("compat")} onClick={() => goto("compat")} />
        </NavGroup>
        <NavGroup label={t("nav.group.protection")}>
          <NavItem icon="backups" label={t("nav.backups")} active={onDatacenterTab("backups")} onClick={() => goto("backups")} />
          <NavItem icon="snapshots" label={t("nav.snapshots")} active={onDatacenterTab("snapshots")} onClick={() => goto("snapshots")} />
          <NavItem icon="exports" label={t("nav.exports")} active={onDatacenterTab("exports")} onClick={() => goto("exports")} />
        </NavGroup>
        <NavGroup label={t("nav.group.library")}>
          <NavItem icon="library" label={t("nav.library")} active={onDatacenterTab("library") || onDatacenterTab("templates")} onClick={() => goto("library")} />
        </NavGroup>
        <NavGroup label={t("nav.group.operations")}>
          <NavItem icon="tasks" label={t("nav.tasks")} active={onDatacenterTab("activity")} onClick={() => goto("activity")} />
          <NavItem icon="audit" label={t("nav.auditLog")} active={onDatacenterTab("journal")} onClick={() => goto("journal")} />
          <NavItem icon="automation" label={t("nav.automation")} active={onDatacenterTab("automation")} onClick={() => goto("automation")} />
        </NavGroup>
        {caps.admin && (
          <NavGroup label={t("nav.group.administration")}>
            <NavItem icon="users" label={t("nav.usersRoles")} active={onDatacenterTab("permissions")} onClick={() => goto("permissions")} />
            <NavItem icon="sso" label={t("nav.sso")} active={onDatacenterTab("sso")} onClick={() => goto("sso")} />
            <NavItem icon="notifications" label={t("nav.notifications")} active={onDatacenterTab("notifications")} onClick={() => goto("notifications")} />
          </NavGroup>
        )}
      </div>

      <div className="nx-relative">
        <button ref={userBtn} type="button" className="nx-sidebar-user" aria-label={`${t("top.user")} — ${username}`} aria-haspopup="menu" aria-expanded={userMenuOpen} onClick={() => setUserMenuOpen((o) => !o)}>
          <span className="nx-avatar">{(username || "?").slice(0, 2).toUpperCase()}</span>
          <span className="nx-user-info">
            <strong>{username}</strong>
            <small>{caps.admin ? t("top.role.admin") : t("top.role.observer")}</small>
          </span>
          <Ellipsis size={16} className="nx-user-more" aria-hidden="true" />
        </button>
        <Menu open={userMenuOpen} onClose={() => setUserMenuOpen(false)} label={username} returnFocusRef={userBtn} style={{ bottom: "calc(100% + 4px)", left: "var(--space-3)", right: "var(--space-3)" }}>
          <div className="nx-menu-label">{t("top.language")}</div>
          {LANGS.map((l) => <MenuItem key={l.id} onSelect={() => setLang(l.id)}>{l.label}{lang === l.id ? " ✓" : ""}</MenuItem>)}
          <hr />
          <div className="nx-menu-label">{t("top.theme")}</div>
          {["dark", "light", "system"].map((m) => <MenuItem key={m} onSelect={() => setMode(m)}>{t(`top.theme.${m}`)}{mode === m ? " ✓" : ""}</MenuItem>)}
          <hr />
          {caps.admin && <MenuItem onSelect={() => { setUserMenuOpen(false); setUpdateOpen(true); }}>{t("top.updates")}</MenuItem>}
          <MenuItem onSelect={() => { setUserMenuOpen(false); setSecurityOpen(true); }}>{t("top.security")}</MenuItem>
          {import.meta.env.VITE_DEFAULT_UI !== "next" && <MenuItem onSelect={() => { localStorage.setItem("hyperlite-ui", "legacy"); window.location.reload(); }}>{t("top.legacy")}</MenuItem>}
          <hr />
          <MenuItem danger onSelect={logout}>{t("top.signout")}</MenuItem>
        </Menu>
      </div>

      <UpdateModal open={updateOpen} onClose={() => setUpdateOpen(false)} triggerRef={userBtn} />
      <AccountSecurityModal open={securityOpen} onClose={() => setSecurityOpen(false)} triggerRef={userBtn} />
    </nav>
  );
}
