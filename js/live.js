// Volet live / followers : position en direct, médias géolocalisés, encouragements.
// Lecture publique par « code » de course ; écriture position/média réservée à
// l'athlète connecté ; encouragements ouverts (follower avec simple pseudo).

import { SB_URL, SB_KEY, apiFetch, getSession } from './auth.js';

const BUCKET = 'runnav-media';

// ------------------------------------------------------------ CODE DE SUIVI (follower)
/** Résout un code de suivi → { name, track } (nom de l'épreuve + trace), ou null.
    Ne renvoie PAS la config éditable : un follower regarde, il n'importe rien. */
export async function resolveFollow(followCode) {
  const res = await apiFetch('/rest/v1/rpc/runnav_get_by_follow', {
    method: 'POST',
    body: JSON.stringify({ p_follow_code: String(followCode || '').trim().toUpperCase() }),
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return (Array.isArray(rows) ? rows[0] : rows) || null;
}
/** Fixe le code de suivi d'une épreuve (réservé au propriétaire via RLS). */
export async function setFollowCode(raceCode, followCode) {
  const res = await apiFetch(`/rest/v1/runnav_configs?code=eq.${encodeURIComponent(raceCode)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ follow_code: followCode }),
  });
  return res.ok;
}
/** Récupère le code de suivi existant d'une épreuve (propriétaire). */
export async function getFollowCode(raceCode) {
  const res = await apiFetch(`/rest/v1/runnav_configs?code=eq.${encodeURIComponent(raceCode)}&select=follow_code`, { method: 'GET' });
  if (!res.ok) return null;
  const rows = await res.json();
  return (rows[0] && rows[0].follow_code) || null;
}

// ------------------------------------------------------------ POSITION LIVE (athlète)
export async function broadcastPosition(code, pos) {
  const body = { code, ...pos, updated_at: new Date().toISOString() };
  const res = await apiFetch('/rest/v1/runnav_live?on_conflict=code', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  });
  return res.ok;
}

export async function setLiveActive(code, active) {
  const res = await apiFetch(`/rest/v1/runnav_live?code=eq.${encodeURIComponent(code)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ active, updated_at: new Date().toISOString() }),
  });
  return res.ok;
}

export async function fetchLive(code) {
  const res = await apiFetch(`/rest/v1/runnav_live?code=eq.${encodeURIComponent(code)}&select=*`, { method: 'GET' });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

// ------------------------------------------------------------ MÉDIAS
export function mediaUrl(path) {
  return `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

/** Envoie un fichier (photo/vidéo) dans le Storage puis crée la ligne géolocalisée. */
export async function uploadMedia(code, file, meta) {
  const s = getSession();
  if (!s || !s.access_token) throw new Error('Connecte-toi pour poster un média.');
  const isVideo = (file.type || '').startsWith('video');
  const ext = (file.name && file.name.includes('.') ? file.name.split('.').pop() : (isVideo ? 'mp4' : 'jpg')).toLowerCase();
  const path = `${code}/${Date.now()}.${ext}`;
  const up = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${s.access_token}`,
      'Content-Type': file.type || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: file,
  });
  if (!up.ok) throw new Error('Upload échoué (' + up.status + ')');
  const row = {
    code, kind: isVideo ? 'video' : 'photo', path,
    caption: (meta.caption || '').trim() || null,
    lat: meta.lat, lon: meta.lon, d: meta.d,
  };
  const res = await apiFetch('/rest/v1/runnav_media', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error('Enregistrement du média échoué');
  const rows = await res.json();
  return rows[0];
}

/** Supprime un média (ligne + fichier) — réservé au propriétaire (RLS). */
export async function deleteMedia(id, path) {
  const res = await apiFetch(`/rest/v1/runnav_media?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { Prefer: 'return=minimal' },
  });
  if (!res.ok) throw new Error('Suppression impossible (' + res.status + ')');
  if (path) {
    const s = getSession();
    if (s && s.access_token) {
      fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
        method: 'DELETE',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${s.access_token}` },
      }).catch(() => { /* fichier orphelin toléré */ });
    }
  }
  return true;
}

/** Liste les médias d'une course (les plus récents d'abord), ou seulement après `sinceIso`. */
export async function fetchMedia(code, sinceIso) {
  let path = `/rest/v1/runnav_media?code=eq.${encodeURIComponent(code)}&select=*&order=created_at.desc`;
  if (sinceIso) path += `&created_at=gt.${encodeURIComponent(sinceIso)}`;
  const res = await apiFetch(path, { method: 'GET' });
  if (!res.ok) return [];
  return await res.json();
}

// ------------------------------------------------------------ ENCOURAGEMENTS (likes / messages)
export async function postCheer(code, cheer) {
  const res = await apiFetch('/rest/v1/runnav_cheers', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ code, ...cheer }),
  });
  return res.ok;
}

export async function fetchCheers(code, sinceIso) {
  let path = `/rest/v1/runnav_cheers?code=eq.${encodeURIComponent(code)}&select=*&order=created_at.desc`;
  if (sinceIso) path += `&created_at=gt.${encodeURIComponent(sinceIso)}`;
  const res = await apiFetch(path, { method: 'GET' });
  if (!res.ok) return [];
  return await res.json();
}
