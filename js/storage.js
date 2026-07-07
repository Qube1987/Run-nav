// Persistance des réglages : localStorage (immédiat, hors-ligne) + Supabase
// (sauvegarde cloud partagée par « code », survit au vidage de site / changement
// d'appareil). Base sandbox partagée → table préfixée `runnav_`.

const SB_URL = 'https://sjuxeqmqfdonzvmtwiby.supabase.co';
const SB_KEY = 'sb_publishable_e6TkpLNF0wDJMUrMC7w1fQ_dIqtP2Ce';
const TABLE = 'runnav_configs';
const LS = (k) => `runnav:${k}`;

/** Empreinte stable d'un parcours (indépendante des menus temps réel). */
export function hashTrack(track) {
  const p = track.points;
  const a = p[0], b = p[p.length - 1];
  const s = `${p.length}|${Math.round(track.total)}|${a.lat.toFixed(4)},${a.lon.toFixed(4)}|${b.lat.toFixed(4)},${b.lon.toFixed(4)}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 'g' + (h >>> 0).toString(36);
}

export function localSave(key, config) {
  try { localStorage.setItem(LS(key), JSON.stringify(config)); } catch (_) { /* quota / privé */ }
}
export function localLoad(key) {
  try { const v = localStorage.getItem(LS(key)); return v ? JSON.parse(v) : null; }
  catch (_) { return null; }
}
export function localGet(k) { try { return localStorage.getItem(LS(k)); } catch (_) { return null; } }
export function localSet(k, v) { try { localStorage.setItem(LS(k), v); } catch (_) { /* ignore */ } }

function headers() {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
}

/** Sauvegarde complète (config + trace GPX) — upsert par code. */
export async function cloudSaveFull(code, gpxKey, name, data, track, isoNow) {
  const body = { code, gpx_key: gpxKey, name: name || null, data, track, updated_at: isoNow };
  const res = await fetch(`${SB_URL}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('cloud save ' + res.status);
}

/** Mise à jour de la config seule (autosave) — la trace reste inchangée. */
export async function cloudSaveConfig(code, data, isoNow) {
  const url = `${SB_URL}/rest/v1/${TABLE}?code=eq.${encodeURIComponent(code)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({ data, updated_at: isoNow }),
  });
  if (!res.ok) throw new Error('cloud patch ' + res.status);
}

/** Récupère une sauvegarde par code. Renvoie { data, name, gpx_key, track } ou null. */
export async function cloudLoad(code) {
  const url = `${SB_URL}/rest/v1/${TABLE}?code=eq.${encodeURIComponent(code)}&select=data,name,gpx_key,track`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error('cloud load ' + res.status);
  const rows = await res.json();
  return rows[0] || null;
}

/** Code de partage court, non ambigu (sans O/0/I/1/L). */
export function makeCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
