import { useEffect, useMemo, useState } from "react";
import { fetchSsoConfig, updateSsoConfig, testSso } from "../../api/client";
import { useInfraStore } from "../../store/useInfraStore";
import { confirmAction } from "../../store/useConfirmStore";
import { useT } from "../i18n";
import { errorMessage } from "../lib/errors";
import { ErrorState } from "../components/States";
import { PageHeader, Card, Field } from "../components/ui";
import { Copy } from "lucide-react";

const EMPTY = { enabled: false, issuer: "", client_id: "", client_secret: "", redirect_uri: "", scope: "openid profile email groups", group_claim: "groups", admin_groups: "" };
const FIELDS = ["enabled", "issuer", "client_id", "redirect_uri", "scope", "group_claim", "admin_groups"];

const isUrl = (v, https = false) => { try { const u = new URL(v); return https ? u.protocol === "https:" : /^https?:$/.test(u.protocol); } catch { return false; } };

// OIDC single sign-on (server-wide setting). Local password sign-in always stays available as a fallback.
// The backend accepts any content, so the page prevents enabling an incomplete or malformed configuration
// (which would break the SSO button on the login screen) and shows unsaved changes.
export default function SsoPage() {
  const t = useT();
  const pushToast = useInfraStore((s) => s.pushToast);
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [secretSet, setSecretSet] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState(null);

  const load = () => fetchSsoConfig().then((c) => {
    const f = { ...EMPTY, ...c, enabled: !!c.enabled, client_secret: "" }; // the API stores 0/1
    setSaved(f); setForm(f); setSecretSet(!!c.client_secret_set); setError(null);
  }).catch((e) => setError(errorMessage(e)));
  useEffect(() => { load(); }, []);

  const dirty = useMemo(() => !!saved && (FIELDS.some((k) => form[k] !== saved[k]) || form.client_secret !== ""), [form, saved]);
  const problems = useMemo(() => {
    const p = {};
    if (form.issuer && !isUrl(form.issuer)) p.issuer = "sso.badUrl";
    else if (form.issuer && !isUrl(form.issuer, true)) p.issuer = "sso.httpsAdvice";
    if (form.redirect_uri && !isUrl(form.redirect_uri)) p.redirect_uri = "sso.badUrl";
    if (form.enabled) {
      if (!form.issuer) p.issuer = "sso.required";
      if (!form.client_id) p.client_id = "sso.required";
      if (!form.redirect_uri) p.redirect_uri = "sso.required";
      if (!secretSet && !form.client_secret) p.client_secret = "sso.required";
    }
    return p;
  }, [form, secretSet]);
  // an https advice is a warning, everything else blocks saving
  const blocking = Object.entries(problems).filter(([, v]) => v !== "sso.httpsAdvice");
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function runTest() {
    setTest({ running: true });
    try { setTest(await testSso(form.issuer)); } catch (err) { setTest({ ok: false, detail: errorMessage(err) }); }
  }

  async function save(e) {
    e?.preventDefault();
    if (blocking.length) return;
    if (form.enabled && !saved.enabled && !form.admin_groups.trim()
      && !(await confirmAction({ title: t("sso.noAdminTitle"), message: t("sso.noAdminMsg"), confirmLabel: t("sso.enable") }))) return;
    setSaving(true);
    try {
      await updateSsoConfig({ ...form, client_secret: form.client_secret || null });
      pushToast({ kind: "success", title: t("sso.saved") });
      await load();
    } catch (err) { pushToast({ kind: "error", title: t("sso.saveFailed"), message: errorMessage(err) }); }
    finally { setSaving(false); }
  }

  const header = <PageHeader title={t("tab.sso")} desc={t("sso.desc")} />;
  if (error && !saved) return <>{header}<ErrorState message={error} onRetry={load} /></>;
  if (!saved) return <>{header}<p className="nx-muted" role="status">{t("loading")}</p></>;

  const field = (k, label, props = {}) => (
    <Field label={label} error={problems[k] && problems[k] !== "sso.httpsAdvice" ? t(problems[k]) : null} hint={problems[k] === "sso.httpsAdvice" ? t(problems[k]) : props.help}>
      {(p) => <input {...p} className={`nx-inp${props.mono === false ? "" : " nx-mono"}`} aria-label={props.aria} value={form[k]} onChange={set(k)} autoComplete="off" {...props.input} />}
    </Field>
  );
  const callback = form.redirect_uri || `${window.location.origin}/auth/sso/callback`;

  return (
    <>
      {header}
      <div style={{ maxWidth: "50.6667rem" }}>
        <Card title={t("sso.provider")}>
          <form onSubmit={save} noValidate>
            <div className="nx-inline" style={{ marginBottom: "var(--space-4)" }}>
              <button type="button" className="nx-sw" role="switch" aria-checked={form.enabled} aria-label={t("sso.enabled")} onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))} />
              <span>{form.enabled ? t("sso.enabled") : t("sso.disabled")}</span>
              <span className="nx-sp" />
              <button type="button" className="nx-btn nx-btn--sm" disabled={!form.issuer || (!!problems.issuer && problems.issuer !== "sso.httpsAdvice") || test?.running} onClick={runTest}>{test?.running ? t("sso.testing") : t("sso.test")}</button>
            </div>
            {test && !test.running && (
              <div className="nx-bn" data-tone={test.ok ? "success" : "danger"} role="status" style={{ marginBottom: "var(--space-4)" }}>
                <span className="nx-bn-t">{test.ok ? t("sso.testOk", { issuer: test.issuer }) : t("sso.testKo", { error: test.detail })}</span>
              </div>
            )}
            <fieldset className="nx-fs">
              <legend>{t("sso.providerLegend")}</legend>
              <div className="nx-fg">
                {field("issuer", t("sso.issuer"), { aria: "Issuer (OIDC discovery URL)", input: { placeholder: "https://idp.example.com/realms/it", inputMode: "url" }, help: t("sso.issuerHelp") })}
                {field("client_id", "Client ID", { aria: "Client ID" })}
                <Field label={<>{t("sso.secret")} {secretSet && <span className="nx-muted">({t("sso.secretSet")})</span>}</>} error={problems.client_secret ? t(problems.client_secret) : null}>
                  {(p) => <input {...p} className="nx-inp" aria-label={t("a11y.client_secret")} type="password" autoComplete="new-password" value={form.client_secret} onChange={set("client_secret")} placeholder={secretSet ? t("sso.secretKeep") : ""} />}
                </Field>
                {field("scope", t("sso.scope"), { aria: "Scopes", help: t("sso.scopeHelp") })}
              </div>
            </fieldset>
            <fieldset className="nx-fs">
              <legend>{t("sso.mapping")}</legend>
              <div className="nx-fg">
                {field("group_claim", t("sso.groupClaim"), { aria: "Groups claim" })}
                {field("admin_groups", t("sso.adminGroups"), { aria: "IdP groups → admin role", input: { placeholder: "hyperlite-admins, infra-team" }, help: t("sso.adminGroupsHelp") })}
              </div>
            </fieldset>
            {field("redirect_uri", t("sso.redirect"), { aria: "Redirect URL (redirect_uri)", input: { placeholder: callback, inputMode: "url" }, help: t("sso.redirectHelp") })}
            <div className="nx-inline" style={{ marginTop: "var(--space-2)" }}>
              <span className="nx-muted nx-mono" style={{ fontSize: "var(--fs-12)" }}>{callback}</span>
              <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--icon" aria-label={t("sso.copyUrl")} title={t("sso.copyUrl")} onClick={() => navigator.clipboard?.writeText(callback)}><Copy size={14} aria-hidden="true" /></button>
            </div>
            <div className="nx-fa">
              <span className="nx-fa-l" role="status">{dirty ? t("sso.unsaved") : t("sso.noChange")}</span>
              <button type="button" className="nx-btn nx-btn--ghost" disabled={!dirty || saving} onClick={() => setForm(saved)}>{t("sso.discard")}</button>
              <button type="submit" className="nx-btn nx-btn--primary" disabled={saving || !dirty || blocking.length > 0}>{saving ? t("sso.saving") : t("sso.save")}</button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
SsoPage.ownHeader = true;
