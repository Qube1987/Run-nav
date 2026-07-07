// Authentification (Supabase Auth) : compte identifiant + mot de passe.
// L'identifiant est mappé sur <slug>@runnav.app (pas besoin de vraie adresse).
// Les comptes de l'app sont auto-confirmés côté serveur (fonction runnav_confirm).

export const SB_URL = 'https://sjuxeqmqfdonzvmtwiby.supabase.co';
export const SB_KEY = 'sb_publishable_e6TkpLNF0wDJMUrMC7w1fQ_dIqtP2Ce';

const SESSION_KEY = 'runnav:session';

function slugEmail(username) {
  const slug = String(username).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'user'}@runnav.app`;
}

function saveSession(tok, username) {
  const s = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
    username,
  };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (_) { /* ignore */ }
  return s;
}

export function getSession() {
  try { const v = localStorage.getItem(SESSION_KEY); return v ? JSON.parse(v) : null; }
  catch (_) { return null; }
}
export function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (_) { /* ignore */ } }
export function isLoggedIn() { return !!getSession(); }
export function currentUser() { const s = getSession(); return s ? s.username : null; }

async function jsonOrEmpty(res) { try { return await res.json(); } catch (_) { return {}; } }

export async function signup(username, password) {
  const email = slugEmail(username);
  const res = await fetch(`${SB_URL}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const e = await jsonOrEmpty(res);
    throw new Error(e.msg || e.error_description || e.error || 'Inscription impossible.');
  }
  // auto-confirmation (scoped @runnav.app côté serveur)
  await fetch(`${SB_URL}/rest/v1/rpc/runnav_confirm`, {
    method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_email: email }),
  }).catch(() => { /* pas bloquant */ });
  return login(username, password);
}

export async function login(username, password) {
  const email = slugEmail(username);
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const d = await jsonOrEmpty(res);
  if (!res.ok || !d.access_token) {
    throw new Error(d.error_description || d.msg || 'Identifiant ou mot de passe incorrect.');
  }
  return saveSession(d, username);
}

export function logout() { clearSession(); }

async function refreshSession() {
  const s = getSession();
  if (!s || !s.refresh_token) return null;
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  });
  const d = await jsonOrEmpty(res);
  if (!res.ok || !d.access_token) { clearSession(); return null; }
  return saveSession(d, s.username);
}

/** fetch vers Supabase avec la clé anon + le jeton du compte si connecté ; rafraîchit sur 401. */
export async function apiFetch(path, options = {}, retry = true) {
  const s = getSession();
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (s && s.access_token) headers.Authorization = `Bearer ${s.access_token}`;
  const res = await fetch(`${SB_URL}${path}`, { ...options, headers });
  if (res.status === 401 && retry && s && s.refresh_token) {
    const ns = await refreshSession();
    if (ns) return apiFetch(path, options, false);
  }
  return res;
}
