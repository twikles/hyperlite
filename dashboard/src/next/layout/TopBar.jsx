import { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Activity, Box, ChevronDown, ChevronRight, Database, Monitor, Network, PanelLeft, Plus, Search, Users } from "lucide-react";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { useT } from "../i18n";
import { capabilities } from "../lib/capabilities";
import { deriveAlerts } from "../lib/alerts";
import { requestIntent } from "../lib/intents";
import Menu, { MenuItem } from "../components/Menu";
import CreateVmWizard from "../wizard/CreateVmWizard";
import CreateContainerWizard from "../wizard/CreateContainerWizard";
import { locate } from "../legacy/tabs";

// Top bar: clickable breadcrumb, global search (opens the palette), one Activity button whose badge counts
// alerts (or running tasks), and the Create menu as a default button: list pages carry their own primary.
export default function TopBar({ onOpenPalette, onToggleSidebar, wizards, setWizards }) {
  const t = useT();
  const { tasks, nodes, vms, storagePools, selection, activeTab, navigateTo } = useInfraStore(useShallow((s) => ({
    tasks: s.tasks, nodes: s.nodes, vms: s.vms, storagePools: s.storagePools, selection: s.selection, activeTab: s.activeTab, navigateTo: s.navigateTo,
  })));
  const caps = capabilities(useAuthStore((s) => s.role));
  const [createOpen, setCreateOpen] = useState(false);
  const createBtn = useRef(null);

  const running = tasks.filter((x) => x.statut === "en_cours").length;
  const alerts = deriveAlerts({ nodes, vms, storagePools, tasks }).length;
  const badge = alerts || running;
  const page = locate("datacenter", activeTab || "summary").page;
  const node = selection.type === "node" ? nodes.find((n) => n.id === selection.id) : null;

  const crumbs = [];
  if (selection.type === "node") crumbs.push([t("nav.nodes"), () => navigateTo("datacenter", null, "nodes")], [node?.nom || selection.id]);
  else if (selection.type === "vm") crumbs.push([t("nav.vms"), () => navigateTo("datacenter", null, "vms")], [selection.id]);
  else if (page !== "summary") crumbs.push([t(`tab.${page}`)]);

  const openActivity = () => {
    window.dispatchEvent(new CustomEvent("nx:dock", { detail: alerts ? "alerts" : running ? "tasks" : "alerts" }));
  };
  const create = (kind) => {
    setCreateOpen(false);
    if (kind === "vm" || kind === "container") { setWizards({ [kind]: true }); return; }
    requestIntent(kind);
    navigateTo("datacenter", null, kind === "pool" ? "storage" : kind === "network" ? "reseau" : "permissions");
  };

  return (
    <header className="nx-top">
      <button type="button" className="nx-btn nx-btn--icon nx-btn--ghost" aria-label={t("nav.toggleSidebar")} onClick={onToggleSidebar}>
        <PanelLeft size={16} aria-hidden="true" />
      </button>
      <nav className="nx-crumbs" aria-label={t("crumb.label")}>
        {crumbs.length === 0 ? <span className="nx-crumb-current" aria-current="page">{t("crumb.datacenter")}</span>
          : <button type="button" onClick={() => navigateTo("datacenter", null, "summary")}>{t("crumb.datacenter")}</button>}
        {crumbs.map(([label, go], i) => (
          <span key={i} className="nx-crumb-seg">
            <ChevronRight size={12} aria-hidden="true" />
            {go ? <button type="button" onClick={go}>{label}</button> : <span className="nx-crumb-current" aria-current="page">{label}</span>}
          </span>
        ))}
      </nav>
      <button type="button" className="nx-find" onClick={onOpenPalette} aria-label={t("find.open")}>
        <Search size={15} aria-hidden="true" />
        <span className="nx-find-label">{t("find.placeholder")}</span>
        <span className="nx-kbd" aria-hidden="true">Ctrl K</span>
      </button>
      <button type="button" className="nx-btn nx-btn--ghost nx-btn--icon nx-activity-btn" title={t("top.activity")}
        aria-label={t("top.activityLabel", { alerts, running })} onClick={openActivity}>
        <Activity size={17} aria-hidden="true" />
        {badge > 0 && <span className={`nx-badge-count${alerts ? " is-warn" : ""}`} aria-hidden="true">{badge}</span>}
      </button>
      {caps.create && (
        <span className="nx-relative">
          <button ref={createBtn} type="button" className="nx-btn" aria-haspopup="menu" aria-expanded={createOpen} onClick={() => setCreateOpen((o) => !o)}>
            <Plus size={15} aria-hidden="true" /><span className="nx-hide-narrow">{t("action.create")}</span><ChevronDown size={14} aria-hidden="true" />
          </button>
          <Menu open={createOpen} onClose={() => setCreateOpen(false)} label={t("action.create")} returnFocusRef={createBtn} style={{ top: "calc(100% + 4px)", right: 0 }}>
            <MenuItem onSelect={() => create("vm")}><Monitor size={16} aria-hidden="true" />{t("action.createVm")}</MenuItem>
            <MenuItem onSelect={() => create("container")}><Box size={16} aria-hidden="true" />{t("action.createContainer")}</MenuItem>
            <hr />
            <MenuItem onSelect={() => create("pool")}><Database size={16} aria-hidden="true" />{t("action.createPool")}</MenuItem>
            <MenuItem onSelect={() => create("network")}><Network size={16} aria-hidden="true" />{t("action.createNetwork")}</MenuItem>
            <MenuItem onSelect={() => create("user")}><Users size={16} aria-hidden="true" />{t("action.createUser")}</MenuItem>
          </Menu>
        </span>
      )}

      <CreateVmWizard open={!!wizards.vm} onClose={() => setWizards({})} triggerRef={createBtn} />
      <CreateContainerWizard open={!!wizards.container} onClose={() => setWizards({})} triggerRef={createBtn} />
    </header>
  );
}
