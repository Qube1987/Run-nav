// Persistance des réglages : localStorage (immédiat, hors-ligne) + Supabase
// (sauvegarde cloud partagée par « code », survit au vidage de site / changement
// d'appareil). Base sandbox partagée → table préfixée `runnav_`.
// Si l'utilisateur est connecté (voir auth.js), ses épreuves sont rattachées à
// son compte (colonne user_id) et retrouvées automatiquement dans « Mes épreuves ».

import { apiFetch } from './auth.js';

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

/** Sauvegarde complète (config + trace GPX) — upsert par code.
    Si connecté, user_id est rempli automatiquement côté serveur (défaut auth.uid()). */
export async function cloudSaveFull(code, gpxKey, name, data, track, isoNow, groupId) {
  const body = { code, gpx_key: gpxKey, name: name || null, data, track, updated_at: isoNow };
  if (groupId) body.group_id = groupId;
  const res = await apiFetch(`/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('cloud save ' + res.status);
}

/** Mise à jour de la config seule (autosave) — la trace reste inchangée. */
export async function cloudSaveConfig(code, data, isoNow) {
  const path = `/rest/v1/${TABLE}?code=eq.${encodeURIComponent(code)}`;
  const res = await apiFetch(path, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ data, updated_at: isoNow }),
  });
  if (!res.ok) throw new Error('cloud patch ' + res.status);
}

/** Récupère une sauvegarde par code. Renvoie { data, name, gpx_key, track } ou null.
    Passe par une RPC security-definer : marche pour une épreuve à soi, une épreuve
    anonyme (partagée par code) ou celle d'un autre compte partagée par code. */
export async function cloudLoad(code) {
  const res = await apiFetch(`/rest/v1/rpc/runnav_get_by_code`, {
    method: 'POST',
    body: JSON.stringify({ p_code: String(code || '').trim().toUpperCase() }),
  });
  if (!res.ok) throw new Error('cloud load ' + res.status);
  const rows = await res.json();
  return (Array.isArray(rows) ? rows[0] : rows) || null;
}

/** Liste les épreuves du compte connecté (RLS filtre automatiquement sur user_id). */
export async function cloudListRaces() {
  const path = `/rest/v1/${TABLE}?select=code,name,gpx_key,updated_at&order=updated_at.desc`;
  const res = await apiFetch(path, { method: 'GET' });
  if (!res.ok) throw new Error('cloud list ' + res.status);
  return await res.json();
}

/** Supprime une épreuve du compte connecté (RLS empêche de toucher celles des autres). */
export async function cloudDeleteRace(code) {
  const path = `/rest/v1/${TABLE}?code=eq.${encodeURIComponent(code)}`;
  const res = await apiFetch(path, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!res.ok) throw new Error('cloud delete ' + res.status);
}

/** Code de partage court, non ambigu (sans O/0/I/1/L). */
export function makeCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
