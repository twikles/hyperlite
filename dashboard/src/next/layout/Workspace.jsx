import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { useT, useLangStore } from "../i18n";
import { EmptyState } from "../components/States";
import PermissionNotice from "../components/PermissionNotice";
import { DATACENTER_TABS, NODE_TABS, VM_TABS, locate } from "../legacy/tabs";
import { selectionToPath, withTab } from "../lib/urls";
import { capabilities } from "../lib/capabilities";
import { useFreshness } from "../lib/inventory";
import { formatUptimeLong, formatVersionInt } from "../lib/format";
import { Monitor, Server } from "lucide-react";
import { PageHeader, StatePill } from "../components/ui";
import { VmHeaderActions, NodeHeaderActions } from "../components/ObjectActions";



// Keeps the URL and the store selection in step, in both directions. Unlike the legacy hook it
// PUSHES history entries, so the browser Back button restores the previous selection and tab.
function useUrlSync() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const { selection, pendingTab, activeTab } = useInfraStore(useShallow((s) => ({ selection: s.selection, pendingTab: s.pendingTab, activeTab: s.activeTab })));
  const select = useInfraStore((s) => s.select);
  const setActiveTab = useInfraStore((s) => s.setActiveTab);
  const clearPendingTab = useInfraStore((s) => s.clearPendingTab);

  // URL -> store
  useEffect(() => {
    const m = pathname.match(/^\/(node|vm)\/([^/]+)/);
    const cur = useInfraStore.getState().selection;
    if (m) {
      const id = decodeURIComponent(m[2]);
      if (cur.type !== m[1] || cur.id !== id) select(m[1], id);
    } else if (pathname.startsWith("/datacenter") && cur.type !== "datacenter" && cur.type !== "storage" && cur.type !== "container") {
      select("datacenter", null);
    }
    const tab = new URLSearchParams(search).get("tab") || "summary";
    if (useInfraStore.getState().activeTab !== tab) setActiveTab(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, search]);

  // store -> URL (selection or requested tab changed from the tree, a legacy panel, the rail...)
  useEffect(() => {
    const sel = useInfraStore.getState().selection;
    const base = selectionToPath(sel);
    if (!base) return;
    const params = new URLSearchParams(search);
    const currentTab = params.get("tab") || "summary";
    const wantedTab = pendingTab || (base === pathname ? currentTab : "summary");
    const target = withTab(base, wantedTab);
    if (pendingTab) clearPendingTab();
    if (target !== `${pathname}${search}`) navigate(target);
    if (useInfraStore.getState().activeTab !== wantedTab) setActiveTab(wantedTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.type, selection.id, pendingTab]);
  return activeTab;
}

// Datacenter pages the backend reserves to administrators (their endpoints answer 403 to anyone else).
const ADMIN_ONLY = new Set(["permissions", "sso", "journal", "exports"]);

// Object header of a VM: state, OS, node, IP and uptime on one line, then the actions.
function VmHead({ vm, node, tab, setTab }) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const navigateTo = useInfraStore((s) => s.navigateTo);
  return (
    <div className="nx-oh">
      <span className="nx-otile" aria-hidden="true"><Monitor size={20} /></span>
      <div className="nx-oh-main">
        <h1>{vm.nom}</h1>
        <div className="nx-ometa">
          <StatePill kind="vm" wire={vm.etat} />
          {vm.os && <span>{vm.os}</span>}
          <span className="nx-sep" aria-hidden="true">·</span>
          <button type="button" className="nx-lnk" onClick={() => navigateTo("node", vm.node, "summary")}>{node?.nom || vm.node}</button>
          <span className="nx-sep" aria-hidden="true">·</span>
          <span className="nx-mono" title={vm.ip ? undefined : t("ns.ipHelp")}>{vm.ip || t("vm.ipNone")}</span>
          {vm.etat === "actif" && vm.uptime_s ? <><span className="nx-sep" aria-hidden="true">·</span><span>{t("vm.since", { d: formatUptimeLong(vm.uptime_s, lang) })}</span></> : null}
        </div>
      </div>
      <VmHeaderActions vm={vm} currentTab={tab} setTab={setTab} />
    </div>
  );
}

function NodeHead({ node, setTab }) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const offline = node.etat !== "online";
  const qemu = formatVersionInt(node.version_hyperviseur);
  const lv = formatVersionInt(node.version_libvirt);
  return (
    <div className="nx-oh">
      <span className="nx-otile" aria-hidden="true"><Server size={20} /></span>
      <div className="nx-oh-main">
        <h1 style={offline ? { fontStyle: "italic" } : undefined}>{node.nom}</h1>
        <div className="nx-ometa">
          <StatePill kind="node" wire={node.etat} />
          <span>{node.id === "local" ? t("node.roleLocal") : t("node.roleMember")}</span>
          {(qemu || lv) && <><span className="nx-sep" aria-hidden="true">·</span><span className="nx-mono">{[qemu && `QEMU ${qemu}`, lv && `libvirt ${lv}`].filter(Boolean).join(" · ")}</span></>}
          {node.uptime_s ? <><span className="nx-sep" aria-hidden="true">·</span><span>{t("node.upSince", { d: formatUptimeLong(node.uptime_s, lang) })}</span></> : null}
        </div>
      </div>
      <NodeHeaderActions node={node} setTab={setTab} />
    </div>
  );
}

export default function Workspace({ children }) {
  const t = useT();
  const activeTab = useUrlSync();
  const { selection, nodes, vms, loading } = useInfraStore(useShallow((s) => ({ selection: s.selection, nodes: s.nodes, vms: s.vms, loading: s.loading })));
  const navigateTo = useInfraStore((s) => s.navigateTo);
  const caps = capabilities(useAuthStore((s) => s.role));
  const failing = useFreshness((s) => s.failing);

  const resource = selection.type === "vm" ? vms.find((v) => v.nom === selection.id)
    : selection.type === "node" ? nodes.find((n) => n.id === selection.id) : null;
  const isDc = selection.type === "datacenter";
  const isObj = selection.type === "node" || selection.type === "vm";
  const { tabs: topTabs, top, page: tab } = locate(isObj ? selection.type : "datacenter", activeTab);
  const Registry = selection.type === "node" ? NODE_TABS : selection.type === "vm" ? VM_TABS : DATACENTER_TABS;
  const Active = Registry[tab];
  const missing = !loading && isObj && !resource;
  const vmNode = selection.type === "vm" && resource ? nodes.find((n) => n.id === resource.node) : null;
  const remote = (selection.type === "node" && resource?.distant) || vmNode?.distant;

  function setTab(id) { navigateTo(selection.type, selection.id, id); }
  const goTop = (tt) => setTab(tt.pages[0].page);
  function onTabKeyDown(e) {
    const i = topTabs.findIndex((x) => x.id === top.id);
    let n = null;
    if (e.key === "ArrowRight") n = topTabs[(i + 1) % topTabs.length];
    else if (e.key === "ArrowLeft") n = topTabs[(i - 1 + topTabs.length) % topTabs.length];
    else if (e.key === "Home") n = topTabs[0];
    else if (e.key === "End") n = topTabs[topTabs.length - 1];
    if (n) { e.preventDefault(); goTop(n); requestAnimationFrame(() => document.getElementById(`nx-top-${n.id}`)?.focus()); }
  }
  const useSubnav = isObj && top.pages.length > 1;
  const pageEl = Active ? <Active resource={resource} selection={selection} /> : null;

  return (
    <main className="nx-main" id="nx-main" tabIndex={-1}>
      {failing && <div className="nx-banner" role="status">▲ {t("inv.stale")}</div>}
      {remote && <div className="nx-banner nx-banner--info" role="status">{t("res.remoteBanner")}</div>}
      <div className="nx-content" data-legacy="true">
        {children}
        {isDc ? (
          <div className="nx-page" id="nx-panel">
            {ADMIN_ONLY.has(tab) && !caps.admin ? (<><PageHeader title={t(`tab.${tab}`)} /><PermissionNotice requires={t("top.role.admin")} /></>)
              : loading ? null
              : Active?.ownHeader ? pageEl
              : (<><PageHeader title={tab === "summary" ? t("nav.overview") : t(`tab.${tab}`)} />{pageEl}</>)}
          </div>
        ) : !isObj ? (
          <div className="nx-page"><div className="nx-legacy"><p>{t("res.storagePlaceholder")}</p></div></div>
        ) : missing ? (
          <div className="nx-page"><EmptyState title={t("res.notFound")} help={t("res.notFoundHelp")} action={<button type="button" className="nx-btn" onClick={() => navigateTo("datacenter", null, "summary")}>{t("crumb.datacenter")}</button>} /></div>
        ) : resource ? (
          <>
            {selection.type === "vm" ? <VmHead vm={resource} node={vmNode} tab={tab} setTab={setTab} /> : <NodeHead node={resource} setTab={setTab} />}
            <div className="nx-tabs" role="tablist" aria-label={resource.nom} onKeyDown={onTabKeyDown}>
              {topTabs.map((x) => (
                <button key={x.id} id={`nx-top-${x.id}`} type="button" role="tab" aria-selected={top.id === x.id} aria-controls="nx-panel" tabIndex={top.id === x.id ? 0 : -1} onClick={() => goTop(x)}>{t(x.label)}</button>
              ))}
            </div>
            <div className="nx-page" id="nx-panel" role="tabpanel" aria-labelledby={`nx-top-${top.id}`} tabIndex={0}>
              {loading ? null : useSubnav ? (
                <div className="nx-subnav2-layout">
                  <nav className="nx-subnav2" aria-label={t(top.label)}>
                    {top.pages.map((p) => <button key={p.page} type="button" aria-current={tab === p.page ? "page" : undefined} onClick={() => setTab(p.page)}>{t(p.label || `tab.${p.page}`)}</button>)}
                  </nav>
                  <div className="nx-stack">{pageEl}</div>
                </div>
              ) : pageEl}
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
