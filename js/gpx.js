// Parsing GPX + préparation de la trace (distances, lissage, D+/D-).

import { haversine } from './geo.js';

/**
 * Parse un texte GPX et renvoie la liste brute des points {lat, lon, ele, time}.
 * Gère <trkpt> (traces) et, en repli, <rtept> (routes).
 */
export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Fichier GPX illisible (XML invalide).');
  }

  let nodes = Array.from(doc.getElementsByTagName('trkpt'));
  if (nodes.length === 0) nodes = Array.from(doc.getElementsByTagName('rtept'));
  if (nodes.length < 2) {
    throw new Error('Aucune trace exploitable dans ce GPX.');
  }

  const points = [];
  for (const n of nodes) {
    const lat = parseFloat(n.getAttribute('lat'));
    const lon = parseFloat(n.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const eleEl = n.getElementsByTagName('ele')[0];
    const timeEl = n.getElementsByTagName('time')[0];
    points.push({
      lat,
      lon,
      ele: eleEl ? parseFloat(eleEl.textContent) : null,
      time: timeEl ? Date.parse(timeEl.textContent) : null,
    });
  }

  const nameEl = doc.getElementsByTagName('name')[0];
  const name = nameEl ? nameEl.textContent.trim() : '';

  return { points, name };
}

/**
 * Construit la trace exploitable :
 *  - distance cumulée `d` (m)
 *  - altitude lissée `ele`
 *  - pente `grade` (%) lissée
 * Retourne aussi les métriques globales (distance, D+, D-, min/max ele).
 */
export function buildTrack(rawPoints) {
  // 1) nettoie les points aberrants (sauts > 500 m entre deux points)
  const pts = [];
  for (const p of rawPoints) {
    if (pts.length === 0) { pts.push({ ...p }); continue; }
    const jump = haversine(pts[pts.length - 1], p);
    if (jump > 500) continue; // ignore les glitches GPS
    pts.push({ ...p });
  }
  if (pts.length < 2) throw new Error('Trace trop courte après nettoyage.');

  // 2) distance cumulée
  pts[0].d = 0;
  for (let i = 1; i < pts.length; i++) {
    pts[i].d = pts[i - 1].d + haversine(pts[i - 1], pts[i]);
  }
  const total = pts[pts.length - 1].d;

  // 3) altitude : interpole les trous puis lisse
  fillMissingEle(pts);
  const raw = pts.map((p) => p.ele);
  const smooth = smoothByDistance(pts, raw, 40); // fenêtre ~40 m
  pts.forEach((p, i) => { p.ele = smooth[i]; });

  // 4) pente lissée sur ~60 m de part et d'autre
  computeGrades(pts, 60);

  // 5) métriques D+/D-
  let gain = 0, loss = 0, minE = Infinity, maxE = -Infinity;
  for (let i = 1; i < pts.length; i++) {
    const dz = pts[i].ele - pts[i - 1].ele;
    if (dz > 0) gain += dz; else loss -= dz;
  }
  for (const p of pts) { minE = Math.min(minE, p.ele); maxE = Math.max(maxE, p.ele); }

  return {
    name: '',
    points: pts,
    total,
    gain: Math.round(gain),
    loss: Math.round(loss),
    minEle: minE,
    maxEle: maxE,
  };
}

function fillMissingEle(pts) {
  // remplace les null par interpolation linéaire (ou 0 si tout est vide)
  const known = pts.map((p, i) => (p.ele != null && isFinite(p.ele) ? i : -1)).filter((i) => i >= 0);
  if (known.length === 0) { pts.forEach((p) => (p.ele = 0)); return; }
  // extrémités
  for (let i = 0; i < known[0]; i++) pts[i].ele = pts[known[0]].ele;
  for (let i = known[known.length - 1] + 1; i < pts.length; i++) pts[i].ele = pts[known[known.length - 1]].ele;
  // trous internes
  for (let k = 0; k < known.length - 1; k++) {
    const a = known[k], b = known[k + 1];
    if (b - a <= 1) continue;
    for (let i = a + 1; i < b; i++) {
      const t = (i - a) / (b - a);
      pts[i].ele = pts[a].ele + t * (pts[b].ele - pts[a].ele);
    }
  }
}

/** Moyenne glissante pondérée par une fenêtre spatiale (mètres). */
function smoothByDistance(pts, values, windowM) {
  const out = new Array(pts.length);
  let lo = 0, hi = 0;
  for (let i = 0; i < pts.length; i++) {
    while (lo < i && pts[i].d - pts[lo].d > windowM) lo++;
    while (hi < pts.length - 1 && pts[hi + 1].d - pts[i].d <= windowM) hi++;
    let sum = 0, n = 0;
    for (let j = lo; j <= hi; j++) { sum += values[j]; n++; }
    out[i] = n ? sum / n : values[i];
  }
  return out;
}

/** Calcule la pente (%) sur un rayon donné (mètres) autour de chaque point. */
function computeGrades(pts, radiusM) {
  for (let i = 0; i < pts.length; i++) {
    let a = i, b = i;
    while (a > 0 && pts[i].d - pts[a].d < radiusM) a--;
    while (b < pts.length - 1 && pts[b].d - pts[i].d < radiusM) b++;
    const run = pts[b].d - pts[a].d;
    const rise = pts[b].ele - pts[a].ele;
    pts[i].grade = run > 3 ? (rise / run) * 100 : 0;
  }
}
