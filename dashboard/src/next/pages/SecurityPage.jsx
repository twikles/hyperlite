import { useCallback, useEffect, useState } from "react";
import {
  fetchUsers, createUser, updateUser, deleteUser,
  fetchGroups, createGroup, deleteGroup, addGroupMember, removeGroupMember,
  fetchPools, createPool, deletePool, addPoolMember, removePoolMember,
  fetchAclRoles, fetchAcl, createAcl, deleteAcl,
  fetchPrivileges, fetchCustomRoles, createCustomRole, deleteCustomRole, fetchContainers,
} from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { useAuthStore } from "../../store/useAuthStore";
import { confirmAction } from "../../store/useConfirmStore";
import { useT, useLangStore } from "../i18n";
import { errorMessage } from "../lib/errors";
import { ErrorState } from "../components/States";
import { PageHeader, SideDrawer, Field, Chip, Empty } from "../components/ui";
import { useIntent } from "../lib/intents";
import { Layers, Plus, Trash2, Users as UsersIcon, X } from "lucide-react";

// Global roles stay `admin` / `observateur` (wire values); ACLs, groups, pools and custom roles only ADD
// scoped rights on top of them (app/core/permissions.py). Same endpoints and payloads as the historical tab.
const MIN_PASSWORD = 4;

const TABS = ["users", "groups", "roles", "pools", "acl"];

export default function SecurityPage() {
  const t = useT();
  const pushToast = useInfraStore((s) => s.pushToast);
  const vms = useInfraStore((s) => s.vms);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("users");
  const [drawer, setDrawer] = useState(null);

  const reload = useCallback(async () => {
    try {
      const [users, groups, pools, roles, privileges, customRoles, acl, containers] = await Promise.all([
        fetchUsers(), fetchGroups(), fetchPools(), fetchAclRoles(), fetchPrivileges(), fetchCustomRoles(), fetchAcl(), fetchContainers().catch(() => []),
      ]);
      setData({ users, groups, pools, roles, privileges, customRoles, acl, containers });
      setError(null);
    } catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useIntent("user", () => { setTab("users"); setDrawer("users"); });

  // Runs a mutation, then reloads; failures are shown with the backend's message.
  const run = useCallback(async (fn, { ok, fail }) => {
    try { await fn(); if (ok) pushToast({ kind: "success", title: ok.title, message: ok.message }); await reload(); return true; }
    catch (e) { pushToast({ kind: "error", title: fail, message: errorMessage(e) }); return false; }
  }, [pushToast, reload]);

  const counts = data ? { users: data.users.length, groups: data.groups.length, roles: 2 + Object.keys(data.roles).length + data.customRoles.length, pools: data.pools.length, acl: data.acl.length } : {};
  const primary = { users: "sec.createUser", groups: "sec.createGroup", roles: "sec.createRoleBtn", pools: "sec.createPool", acl: "sec.assignRole" }[tab];
  const onTabKey = (e) => {
    const i = TABS.indexOf(tab); let n = null;
    if (e.key === "ArrowRight") n = TABS[(i + 1) % TABS.length]; else if (e.key === "ArrowLeft") n = TABS[(i - 1 + TABS.length) % TABS.length];
    if (n) { e.preventDefault(); setTab(n); requestAnimationFrame(() => document.getElementById(`sec-tab-${n}`)?.focus()); }
  };

  let body = null;
  if (error && !data) body = <ErrorState message={error} onRetry={reload} />;
  else if (!data) body = <p className="nx-muted" role="status">{t("loading")}</p>;
  else {
    const allRoles = { ...data.roles, ...Object.fromEntries(data.customRoles.map((r) => [r.key, r])) };
    const ctx = { t, run, data, vms, allRoles, drawer, closeDrawer: () => setDrawer(null) };
    body = tab === "users" ? <UsersTab {...ctx} /> : tab === "groups" ? <GroupsTab {...ctx} /> : tab === "roles" ? <RolesTab {...ctx} /> : tab === "pools" ? <PoolsTab {...ctx} /> : <AclTab {...ctx} />;
  }

  return (
    <>
      <PageHeader title={t("tab.permissions")} actions={data && <button type="button" className="nx-btn nx-btn--primary" onClick={() => setDrawer(tab)}><Plus size={15} aria-hidden="true" />{t(primary)}</button>} />
      <div className="nx-tabs nx-tabs--page" role="tablist" aria-label={t("tab.permissions")} onKeyDown={onTabKey}>
        {TABS.map((id) => (
          <button key={id} id={`sec-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls="sec-panel" tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>
            {t(`sec.tab.${id}`)}{counts[id] != null && <span className="nx-n">{counts[id]}</span>}
          </button>
        ))}
      </div>
      <div id="sec-panel" role="tabpanel" aria-labelledby={`sec-tab-${tab}`} className="nx-stack">{body}</div>
    </>
  );
}
SecurityPage.ownHeader = true;

const del = (t) => t("menu.delete").replace("…", "");
function IconBtn({ label, onClick, disabled, title }) {
  return <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" aria-label={label} title={title || label} disabled={disabled} onClick={onClick}><Trash2 size={15} aria-hidden="true" /></button>;
}

function UsersTab({ t, run, data, drawer, closeDrawer }) {
  const me = useAuthStore((s) => s.username);
  const lang = useLangStore((s) => s.lang);
  const EMPTY = { username: "", password: "", role: "observateur" };
  const [f, setF] = useState(EMPTY);
  const valid = f.username.trim() && f.password.length >= MIN_PASSWORD;
  async function create() {
    if (await run(() => createUser(f.username.trim(), f.password, f.role), { ok: { title: t("sec.userCreated"), message: f.username.trim() }, fail: t("sec.createFailed") })) { setF(EMPTY); closeDrawer(); }
  }
  async function remove(u) {
    if (!(await confirmAction({ title: t("sec.userDeleteTitle", { name: u.username }), message: t("sec.userDeleteMsg"), confirmLabel: del(t), danger: true }))) return;
    run(() => deleteUser(u.username), { ok: { title: t("sec.userDeleted"), message: u.username }, fail: t("sec.deleteFailed") });
  }
  async function changeRole(u, role) {
    if (role === "admin" && !(await confirmAction({ title: t("sec.promoteTitle", { name: u.username }), message: t("sec.promoteMsg"), confirmLabel: t("sec.promote"), danger: true }))) return;
    run(() => updateUser(u.username, { role }), { fail: t("sec.updateFailed") });
  }
  const when = (iso) => (iso ? new Intl.DateTimeFormat(lang, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : null);
  return (
    <>
      <div className="nx-card2 nx-card2--flush">
        <div className="nx-tablewrap">
          <table className="nx-table">
            <thead><tr><th scope="col">{t("sec.user")}</th><th scope="col">{t("sec.globalRole")}</th><th scope="col">{t("sec.auth")}</th><th scope="col">2FA</th><th scope="col">{t("sec.lastLogin")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
            <tbody>
              {data.users.map((u) => {
                const self = u.username === me;
                return (
                  <tr key={u.username}>
                    <th scope="row"><span className="nx-userrow"><span className="nx-avatar nx-avatar--sm" aria-hidden="true">{u.username.slice(0, 2).toUpperCase()}</span>{u.username}{self && <span className="nx-muted" style={{ fontWeight: 400 }}> ({t("sec.you")})</span>}</span></th>
                    <td><select className="nx-sel" aria-label={t("a11y.role_of_x", { v: u.username })} value={u.role} disabled={self} title={self ? t("sec.selfRole") : undefined} onChange={(e) => changeRole(u, e.target.value)}><option value="observateur">{t("sec.observer")}</option><option value="admin">{t("sec.admin")}</option></select></td>
                    <td><Chip>{u.auth_source === "sso" ? "SSO" : t("sec.local")}</Chip></td>
                    <td>{u.totp_enabled ? <span className="nx-tone-success">{t("sec.on2fa")}</span> : <span className="nx-muted">{t("sec.off2fa")}</span>}</td>
                    <td className="nx-mono nx-muted">{when(u.last_login_at) || t("sec.never")}</td>
                    <td><div className="nx-ra"><IconBtn label={self ? t("sec.selfDelete") : `Delete user ${u.username}`} title={self ? t("sec.selfDelete") : del(t)} disabled={self} onClick={() => remove(u)} /></div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <SideDrawer open={drawer === "users"} title={t("sec.createUser")} onClose={closeDrawer} footer={<>
        <button type="button" className="nx-btn nx-btn--ghost" onClick={closeDrawer}>{t("action.cancel")}</button>
        <button type="button" className="nx-btn nx-btn--primary" disabled={!valid} onClick={create}>{t("sec.createUserBtn")}</button>
      </>}>
        <Field label={t("sec.username")}>{(p) => <input {...p} className="nx-inp" aria-label={t("a11y.username")} value={f.username} autoComplete="off" placeholder="jdupont" onChange={(e) => setF({ ...f, username: e.target.value })} />}</Field>
        <Field label={t("ct.password")} hint={t("sec.passwordHelp", { n: MIN_PASSWORD })}>{(p) => <input {...p} className="nx-inp" aria-label={t("a11y.password")} type="password" value={f.password} autoComplete="new-password" onChange={(e) => setF({ ...f, password: e.target.value })} />}</Field>
        <Field label={t("sec.globalRole")}>{(p) => <select {...p} className="nx-inp" aria-label={t("a11y.role_of_the_new_user")} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="observateur">{t("sec.observer")}</option><option value="admin">{t("sec.admin")}</option></select>}</Field>
      </SideDrawer>
    </>
  );
}

function Chips({ t, list, onRemove, label, none }) {
  return (
    <ul className="nx-tags" aria-label={label}>
      {list.length === 0 && <li className="nx-muted">{none}</li>}
      {list.map((m) => <li key={m} className="nx-tag"><span className="nx-mono">{m}</span><button type="button" aria-label={`${t("sec.remove")} ${m}`} onClick={() => onRemove(m)}><X size={12} aria-hidden="true" /></button></li>)}
    </ul>
  );
}

function NameDrawer({ t, open, title, label, placeholder, confirm, onClose, onCreate }) {
  const [name, setName] = useState("");
  return (
    <SideDrawer open={open} title={title} onClose={onClose} footer={<>
      <button type="button" className="nx-btn nx-btn--ghost" onClick={onClose}>{t("action.cancel")}</button>
      <button type="button" className="nx-btn nx-btn--primary" disabled={!name.trim()} onClick={async () => { if (await onCreate(name.trim())) { setName(""); onClose(); } }}>{confirm}</button>
    </>}>
      <Field label={label}>{(p) => <input {...p} className="nx-inp" aria-label={label} placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
    </SideDrawer>
  );
}

function GroupsTab({ t, run, data, drawer, closeDrawer }) {
  const [member, setMember] = useState({});
  const removeGroup = async (g) => { if (await confirmAction({ title: t("sec.groupDeleteTitle", { name: g.name }), message: t("sec.groupDeleteMsg"), confirmLabel: del(t), danger: true })) run(() => deleteGroup(g.id), { ok: { title: t("sec.groupDeleted"), message: g.name }, fail: t("sec.deleteFailed") }); };
  const removeMember = async (g, m) => { if (await confirmAction({ title: t("sec.memberRemoveTitle", { name: m }), message: t("sec.memberRemoveMsg"), confirmLabel: t("sec.remove") })) run(() => removeGroupMember(g.id, m), { fail: t("sec.removeFailed") }); };
  const addMember = async (g) => { const u = (member[g.id] || "").trim(); if (u && (await run(() => addGroupMember(g.id, u), { fail: t("sec.addFailed") }))) setMember((s) => ({ ...s, [g.id]: "" })); };
  return (
    <>
      {data.groups.length === 0 ? <div className="nx-card2"><Empty icon={UsersIcon} title={t("sec.noGroups")} text={t("sec.groupsHelp")} /></div> : (
        <div className="nx-cols2 nx-cols2--even">
          {data.groups.map((g) => (
            <section key={g.id} className="nx-card2" aria-label={g.name}>
              <div className="nx-card2-h"><h2>{g.name}</h2><div className="nx-card2-acts"><IconBtn label={`Delete group ${g.name}`} title={del(t)} onClick={() => removeGroup(g)} /></div></div>
              <div className="nx-card2-b nx-stack">
                <Chips t={t} list={g.membres} label={`${t("sec.members")} ${g.name}`} none={t("sec.noMembers")} onRemove={(m) => removeMember(g, m)} />
                <div className="nx-inline">
                  <select className="nx-sel" aria-label={`${t("sec.addMember")} ${g.name}`} value={member[g.id] || ""} onChange={(e) => setMember((s) => ({ ...s, [g.id]: e.target.value }))}>
                    <option value="">{t("sec.chooseUser")}</option>
                    {data.users.filter((u) => !g.membres.includes(u.username)).map((u) => <option key={u.username} value={u.username}>{u.username}</option>)}
                  </select>
                  <button type="button" className="nx-btn nx-btn--sm" disabled={!member[g.id]} onClick={() => addMember(g)}>{t("sec.add")}</button>
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
      <NameDrawer t={t} open={drawer === "groups"} title={t("sec.createGroup")} label={t("sec.groupName")} placeholder="ops" confirm={t("sec.createGroupBtn")} onClose={closeDrawer}
        onCreate={(name) => run(() => createGroup(name), { ok: { title: t("sec.groupCreated"), message: name }, fail: t("sec.createFailed") })} />
    </>
  );
}

function PoolsTab({ t, run, data, vms, drawer, closeDrawer }) {
  const [pick, setPick] = useState({});
  const removePool = async (p) => { if (await confirmAction({ title: t("sec.poolDeleteTitle", { name: p.name }), message: t("sec.poolDeleteMsg"), confirmLabel: del(t), danger: true })) run(() => deletePool(p.id), { ok: { title: t("sec.poolDeleted"), message: p.name }, fail: t("sec.deleteFailed") }); };
  const removeVm = async (p, v) => { if (await confirmAction({ title: t("sec.vmRemoveTitle", { name: v }), message: t("sec.vmRemoveMsg"), confirmLabel: t("sec.remove") })) run(() => removePoolMember(p.id, v), { fail: t("sec.removeFailed") }); };
  return (
    <>
      {data.pools.length === 0 ? <div className="nx-card2"><Empty icon={Layers} title={t("sec.noPools")} text={t("sec.poolsHelp")} /></div> : (
        <div className="nx-cols2 nx-cols2--even">
          {data.pools.map((p) => {
            const available = vms.filter((v) => !p.vms.includes(v.nom));
            return (
              <section key={p.id} className="nx-card2" aria-label={p.name}>
                <div className="nx-card2-h"><h2>{p.name}</h2><div className="nx-card2-acts"><IconBtn label={`Delete pool ${p.name}`} title={del(t)} onClick={() => removePool(p)} /></div></div>
                <div className="nx-card2-b nx-stack">
                  <Chips t={t} list={p.vms} label={`VM ${p.name}`} none={t("sec.noVms")} onRemove={(v) => removeVm(p, v)} />
                  {available.length > 0 && (
                    <div className="nx-inline">
                      <select className="nx-sel" aria-label={`${t("sec.addVm")} ${p.name}`} value={pick[p.id] || ""} onChange={(e) => setPick((s) => ({ ...s, [p.id]: e.target.value }))}>
                        <option value="">{t("sec.chooseVm")}</option>
                        {available.map((v) => <option key={v.nom} value={v.nom}>{v.nom}</option>)}
                      </select>
                      <button type="button" className="nx-btn nx-btn--sm" disabled={!pick[p.id]} onClick={() => run(() => addPoolMember(p.id, pick[p.id]), { fail: t("sec.addFailed") })}>{t("sec.add")}</button>
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <NameDrawer t={t} open={drawer === "pools"} title={t("sec.createPool")} label={t("sec.poolName")} placeholder="projet-a" confirm={t("sec.createPoolBtn")} onClose={closeDrawer}
        onCreate={(name) => run(() => createPool(name), { ok: { title: t("sec.poolCreated"), message: name }, fail: t("sec.createFailed") })} />
    </>
  );
}

function RolesTab({ t, run, data, drawer, closeDrawer }) {
  const [name, setName] = useState("");
  const [sel, setSel] = useState({});
  const chosen = Object.keys(sel).filter((k) => sel[k]);
  const countBy = (key) => data.acl.filter((a) => a.role === key).length;
  async function create() {
    if (await run(() => createCustomRole(name.trim(), chosen), { ok: { title: t("sec.roleCreated"), message: name.trim() }, fail: t("sec.createFailed") })) { setName(""); setSel({}); closeDrawer(); }
  }
  async function remove(r) {
    if (await confirmAction({ title: t("sec.roleDeleteTitle", { name: r.label }), message: t("sec.roleDeleteMsg"), confirmLabel: del(t), danger: true })) run(() => deleteCustomRole(r.id), { ok: { title: t("sec.roleDeleted"), message: r.label }, fail: t("sec.deleteFailed") });
  }
  const users = (role) => data.users.filter((u) => u.role === role).length;
  return (
    <>
      <div className="nx-card2 nx-card2--flush">
        <div className="nx-tablewrap">
          <table className="nx-table">
            <thead><tr><th scope="col">{t("sec.role")}</th><th scope="col">{t("sec.roleType")}</th><th scope="col">{t("sec.can")}</th><th scope="col" className="nx-num">{t("sec.usedBy")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
            <tbody>
              <tr><th scope="row">{t("sec.admin")}</th><td><Chip tone="accent">{t("sec.global")}</Chip></td><td className="nx-wrapcell nx-muted">{t("sec.role.admin")}</td><td className="nx-num nx-mono">{users("admin")}</td><td /></tr>
              <tr><th scope="row">{t("sec.observer")}</th><td><Chip tone="accent">{t("sec.global")}</Chip></td><td className="nx-wrapcell nx-muted">{t("sec.role.observer")}</td><td className="nx-num nx-mono">{users("observateur")}</td><td /></tr>
              {Object.entries(data.roles).map(([k, r]) => <tr key={k}><th scope="row">{r.label}</th><td><Chip>{t("sec.scoped")}</Chip></td><td className="nx-wrapcell nx-muted">{r.description}</td><td className="nx-num nx-mono">{countBy(k)}</td><td /></tr>)}
              {data.customRoles.map((r) => (
                <tr key={r.key}><th scope="row">{r.label}</th><td><Chip tone="info">{t("sec.custom")}</Chip></td><td className="nx-wrapcell nx-muted">{[...r.privileges].map((p) => data.privileges[p] || p).join(", ")}</td><td className="nx-num nx-mono">{countBy(r.key)}</td>
                  <td><div className="nx-ra"><IconBtn label={`Delete role ${r.label}`} title={del(t)} onClick={() => remove(r)} /></div></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <SideDrawer open={drawer === "roles"} title={t("sec.createRoleBtn")} onClose={closeDrawer} footer={<>
        <button type="button" className="nx-btn nx-btn--ghost" onClick={closeDrawer}>{t("action.cancel")}</button>
        <button type="button" className="nx-btn nx-btn--primary" disabled={!name.trim() || chosen.length === 0} onClick={create}>{t("sec.createRole", { n: chosen.length })}</button>
      </>}>
        <p className="nx-muted" style={{ margin: 0 }}>{t("sec.customRolesHelp")}</p>
        <Field label={t("sec.roleName")}>{(p) => <input {...p} className="nx-inp" aria-label={t("a11y.role_name")} placeholder="backups-only" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <fieldset className="nx-fs">
          <legend>{t("sec.privileges")}</legend>
          <div className="nx-checks">{Object.entries(data.privileges).map(([k, label]) => <label key={k} className="nx-check"><input type="checkbox" checked={!!sel[k]} onChange={() => setSel((s) => ({ ...s, [k]: !s[k] }))} /> {label}</label>)}</div>
        </fieldset>
      </SideDrawer>
    </>
  );
}

function AclTab({ t, run, data, vms, allRoles, drawer, closeDrawer }) {
  const [f, setF] = useState({ subjectType: "user", subjectId: "", role: Object.keys(allRoles)[0] || "", resourceType: "vm", resourceId: "" });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value, ...(k === "subjectType" ? { subjectId: "" } : {}), ...(k === "resourceType" ? { resourceId: "" } : {}) }));
  const role = allRoles[f.role] ? f.role : Object.keys(allRoles)[0];
  const resources = f.resourceType === "vm" ? vms.map((v) => [v.nom, v.nom]) : f.resourceType === "pool" ? data.pools.map((p) => [String(p.id), p.name]) : data.containers.map((c) => [c.nom, c.nom]);
  async function create() {
    if (await run(() => createAcl({ subject_type: f.subjectType, subject_id: f.subjectId, role, resource_type: f.resourceType, resource_id: f.resourceId }), { ok: { title: t("sec.assigned") }, fail: t("sec.assignFailed") })) { setF((x) => ({ ...x, subjectId: "", resourceId: "" })); closeDrawer(); }
  }
  async function remove(a) {
    if (await confirmAction({ title: t("sec.aclDeleteTitle"), message: t("sec.aclDeleteMsg"), confirmLabel: t("sec.remove"), danger: true })) run(() => deleteAcl(a.id), { fail: t("sec.removeFailed") });
  }
  const resLabel = (a) => (a.resource_type === "pool" ? `${t("sec.pool")} ${a.resource_label}` : a.resource_type === "container" ? `${t("sec.container")} ${a.resource_label}` : a.resource_label);
  return (
    <>
      <div className="nx-card2 nx-card2--flush">
        {data.acl.length === 0 ? <Empty icon={UsersIcon} title={t("sec.noAcl")} text={t("sec.aclHelp")} /> : (
          <div className="nx-tablewrap">
            <table className="nx-table">
              <thead><tr><th scope="col">{t("sec.subject")}</th><th scope="col">{t("sec.role")}</th><th scope="col">{t("sec.scope")}</th><th scope="col"><span className="nx-sr">{t("actions")}</span></th></tr></thead>
              <tbody>
                {data.acl.map((a) => (
                  <tr key={a.id}>
                    <th scope="row">{a.subject_type === "group" ? `${t("sec.group")} ${a.subject_label}` : a.subject_label}</th>
                    <td><Chip tone="accent">{allRoles[a.role]?.label || a.role}</Chip></td>
                    <td className="nx-mono">{resLabel(a)}</td>
                    <td><div className="nx-ra"><IconBtn label={`Remove assignment ${a.id}`} title={t("sec.remove")} onClick={() => remove(a)} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <SideDrawer open={drawer === "acl"} title={t("sec.assignRole")} onClose={closeDrawer} footer={<>
        <button type="button" className="nx-btn nx-btn--ghost" onClick={closeDrawer}>{t("action.cancel")}</button>
        <button type="button" className="nx-btn nx-btn--primary" disabled={!f.subjectId || !f.resourceId} onClick={create}>{t("sec.assign")}</button>
      </>}>
        <div className="nx-fg">
          <Field label={t("sec.who")}>{(p) => <select {...p} className="nx-inp" aria-label={t("a11y.who")} value={f.subjectType} onChange={set("subjectType")}><option value="user">{t("sec.user")}</option><option value="group">{t("sec.group")}</option></select>}</Field>
          <Field label={t("sec.subject")}>{(p) => <select {...p} className="nx-inp" aria-label={t("a11y.subject")} value={f.subjectId} onChange={set("subjectId")}><option value="">{t("sec.choose")}</option>{f.subjectType === "user" ? data.users.map((u) => <option key={u.username} value={u.username}>{u.username}</option>) : data.groups.map((g) => <option key={g.id} value={String(g.id)}>{g.name}</option>)}</select>}</Field>
        </div>
        <Field label={t("sec.role")} hint={allRoles[role]?.description}>{(p) => <select {...p} className="nx-inp" aria-label={t("a11y.role")} value={role} onChange={set("role")}>{Object.entries(allRoles).map(([k, r]) => <option key={k} value={k}>{r.label}</option>)}</select>}</Field>
        <div className="nx-fg">
          <Field label={t("sec.on")}>{(p) => <select {...p} className="nx-inp" aria-label={t("a11y.on")} value={f.resourceType} onChange={set("resourceType")}><option value="vm">{t("sec.aVm")}</option><option value="pool">{t("sec.aPool")}</option><option value="container">{t("sec.aContainer")}</option></select>}</Field>
          <Field label={t("sec.resource")}>{(p) => <select {...p} className="nx-inp" aria-label={t("a11y.resource")} value={f.resourceId} onChange={set("resourceId")}><option value="">{t("sec.choose")}</option>{resources.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}</Field>
        </div>
      </SideDrawer>
    </>
  );
}
