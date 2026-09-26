import { create } from "zustand";
import { setAuthToken, setUnauthorizedHandler } from "../api/client";

const KEY_TOKEN = "hyperlite_token";
const KEY_USERNAME = "hyperlite_username";
const KEY_ROLE = "hyperlite_role";

function clearStoredSession() {
  localStorage.removeItem(KEY_TOKEN);
  localStorage.removeItem(KEY_USERNAME);
  localStorage.removeItem(KEY_ROLE);
}

// Shared between login() and loginWith2FA(): a module-level function rather than a
// store method, because a zustand store is often destructured
// (`const { login } = useAuthStore()`), so a `this.xxx()` inside an action would
// lose its binding.
function applySession(set, token, username, role, totpEnabled) {
  localStorage.setItem(KEY_TOKEN, token);
  localStorage.setItem(KEY_USERNAME, username);
  localStorage.setItem(KEY_ROLE, role);
  setAuthToken(token);
  set({ token, username, role, totpEnabled, status: "authenticated", error: null });
}

export const useAuthStore = create((set, get) => ({
  token: null,
  username: null,
  role: null,
  totpEnabled: false,
  status: "checking", // "checking" | "authenticated" | "anonymous"
  error: null,

  async restoreSession() {
    // SSO: /auth/sso/callback redirects the browser to "/?sso_token=..." after a
    // successful sign-in. It is a normal Hyperlite session token (same format as a
    // classic login), not a special mechanism. It takes priority over localStorage (a
    // return from SSO must always replace a stale local session), and the URL is
    // cleaned immediately (history.replaceState) so a session token never lingers in
    // the browser history/access logs.
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get("sso_token");
    if (ssoToken) {
      window.history.replaceState({}, "", window.location.pathname);
      setAuthToken(ssoToken);
      try {
        const res = await fetch("/auth/me", { headers: { Authorization: `Bearer ${ssoToken}` } });
        if (!res.ok) throw new Error("invalid SSO token");
        const me = await res.json();
        applySession(set, ssoToken, me.username, me.role, !!me.totp_enabled);
        return;
      } catch {
        setAuthToken(null);
        set({ status: "anonymous", error: "SSO sign-in failed" });
        return;
      }
    }

    const token = localStorage.getItem(KEY_TOKEN);
    if (!token) {
      set({ status: "anonymous" });
      return;
    }
    setAuthToken(token);
    try {
      const res = await fetch("/auth/me", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("session expired");
      const me = await res.json();
      set({ token, username: me.username, role: me.role, totpEnabled: !!me.totp_enabled, status: "authenticated" });
    } catch {
      clearStoredSession();
      setAuthToken(null);
      set({ status: "anonymous" });
    }
  },

  // Called by AccountSecurityModal after enabling/disabling 2FA, so the rest of the
  // UI (status badge) sees the up-to-date state without having to sign in again.
  async refreshMe() {
    if (!get().token) return;
    const res = await fetch("/auth/me", { headers: { Authorization: `Bearer ${get().token}` } });
    if (!res.ok) return;
    const me = await res.json();
    set({ totpEnabled: !!me.totp_enabled });
  },

  // remember: "Stay signed in" asks the server for a longer session (see app/core/security.py).
  async login(username, password, remember = false) {
    set({ error: null });
    const body = new URLSearchParams({ username, password });
    if (remember) body.set("remember", "true");
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const msg = (data && data.detail) || "Invalid credentials";
      set({ error: msg });
      throw new Error(msg);
    }
    // 2FA: the password is correct but a TOTP code is still required. No session is
    // opened right away, the intermediate token is returned to the caller
    // (LoginScreen), which shows the code entry step and then calls loginWith2FA.
    if (data.require_2fa) {
      return { require2FA: true, preAuthToken: data.pre_auth_token };
    }
    applySession(set, data.access_token, username, data.role, false);
    return { require2FA: false };
  },

  async loginWith2FA(preAuthToken, code, username) {
    set({ error: null });
    const res = await fetch("/auth/login/2fa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pre_auth_token: preAuthToken, code }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const msg = (data && data.detail) || "Invalid code";
      set({ error: msg });
      throw new Error(msg);
    }
    applySession(set, data.access_token, username, data.role, true);
  },

  logout() {
    clearStoredSession();
    setAuthToken(null);
    set({ token: null, username: null, role: null, totpEnabled: false, status: "anonymous" });
  },
}));

export function selectIsAdmin(state) {
  return state.role === "admin";
}

setUnauthorizedHandler(() => {
  if (useAuthStore.getState().status !== "authenticated") return;
  clearStoredSession();
  setAuthToken(null);
  useAuthStore.setState({ token: null, username: null, role: null, status: "anonymous", error: "Your session has expired. Please sign in again." });
});
