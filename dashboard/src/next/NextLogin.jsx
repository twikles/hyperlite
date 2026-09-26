import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, ShieldCheck } from "lucide-react";
import "./next.css";
import "./refonte.css";
import { useAuthStore } from "../store/useAuthStore";
import { fetchSsoStatus } from "../api/client";
import EnclaveMark from "../components/EnclaveMark";
import { useT, useLangStore } from "./i18n";
import { useThemeStore } from "./tokens/theme";

// Sign-in screen of the rebuilt interface: a graphite brand pane and the form card. Same store actions as the
// historical screen (password, then the TOTP step when 2FA is on, SSO when the server enables it); "Stay signed
// in" asks the server for a longer session.
export default function NextLogin() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const initTheme = useThemeStore((s) => s.init);
  const login = useAuthStore((s) => s.login);
  const loginWith2FA = useAuthStore((s) => s.loginWith2FA);
  const storeError = useAuthStore((s) => s.error);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState(storeError || "");
  const [loading, setLoading] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [health, setHealth] = useState(null);
  const [preAuthToken, setPreAuthToken] = useState(null);
  const [code, setCode] = useState("");

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.ui = "next";
    root.lang = lang;
    const cleanup = initTheme();
    return () => cleanup?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    fetchSsoStatus().then((r) => setSsoEnabled(!!r.enabled)).catch(() => {});
    fetch("/health").then((r) => (r.ok ? r.json() : null)).then(setHealth).catch(() => {});
    const params = new URLSearchParams(window.location.search);
    const ssoError = params.get("sso_error");
    if (ssoError) { setError(ssoError); window.history.replaceState({}, "", window.location.pathname); }
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      const result = await login(username, password, remember);
      if (result.require2FA) setPreAuthToken(result.preAuthToken);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  async function onSubmit2FA(e) {
    e.preventDefault();
    setError(""); setLoading(true);
    try { await loginWith2FA(preAuthToken, code, username); } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  return (
    <div className="nx-login">
      <div className="nx-login-l">
        <EnclaveMark size={44} rails="var(--color-text-primary)" core="var(--color-accent)" />
        <b>{t("app.name")}</b>
        <p>{t("login.tagline")}</p>
        {health && <span className="nx-login-v">{[health.hyperlite_version, health.hostname].filter(Boolean).join(" · ")}</span>}
      </div>
      <div className="nx-login-r">
        {preAuthToken ? (
          <form className="nx-login-box" onSubmit={onSubmit2FA}>
            <h1><ShieldCheck size={20} aria-hidden="true" /> {t("login.twoStep")}</h1>
            <p className="nx-muted" style={{ margin: 0 }}>{t("login.twoStepHelp")}</p>
            <input className="nx-inp nx-mono nx-login-code" aria-label={t("login.code")} autoComplete="one-time-code" autoFocus inputMode="numeric" maxLength={6}
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            {error && <p role="alert" className="nx-f-h is-error" style={{ margin: 0 }}>{error}</p>}
            <button type="submit" className="nx-btn nx-btn--primary nx-login-btn" disabled={loading || code.length !== 6}>{loading ? t("login.verifying") : t("login.verify")}</button>
            <button type="button" className="nx-btn nx-btn--ghost nx-login-btn" onClick={() => { setPreAuthToken(null); setCode(""); setError(""); }}>{t("login.back")}</button>
          </form>
        ) : (
          <form className="nx-login-box" onSubmit={onSubmit}>
            <h1>{t("login.title")}</h1>
            <div className="nx-f">
              <label htmlFor="login-username">{t("login.username")}</label>
              <input id="login-username" className="nx-inp" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="nx-f">
              <label htmlFor="login-password">{t("login.password")}</label>
              <div className="nx-unit">
                <input id="login-password" className="nx-inp" autoComplete="current-password" type={reveal ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" className="nx-login-eye" aria-label={t(reveal ? "login.hide" : "login.show")} aria-pressed={reveal} onClick={() => setReveal((r) => !r)}>{reveal ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}</button>
              </div>
            </div>
            <label className="nx-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {t("login.remember")}</label>
            {error && <p role="alert" className="nx-f-h is-error" style={{ margin: 0 }}>{error}</p>}
            <button type="submit" className="nx-btn nx-btn--primary nx-login-btn" disabled={loading}>{loading ? t("login.signingIn") : t("login.signIn")}</button>
            {ssoEnabled && (
              <>
                <div className="nx-login-or"><span />{t("login.or")}<span /></div>
                <a className="nx-btn nx-login-btn" href="/auth/sso/login"><KeyRound size={15} aria-hidden="true" />{t("login.sso")}</a>
              </>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
