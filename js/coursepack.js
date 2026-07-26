// Exporteur « course pack » pour le data field Garmin (runnav-df).
//
// Produit un JSON compact (entiers uniquement) embarquant la trace, le profil,
// les côtes et les points d'intérêt, destiné à être compilé dans le data field
// ou servi par le backend. Voir docs/coursepack.md pour le format et les
// décisions d'architecture (espace d'abscisses, budgets de points).
//
// Module PUR : aucune dépendance au DOM, pour être testable hors navigateur.

import { haversine } from './geo.js';

export const PACK_VERSION = 1;

// Budgets par défaut (cf. cahier des charges §4.1). La tolérance est un point de
// départ : elle est relâchée automatiquement si le budget de points est dépassé.
export const DEFAULTS = {
  trackTol: 10,        // m — tolérance Douglas-Peucker sur la polyline
  trackMaxPoints: 2500,
  profileTol: 5,       // m — tolérance verticale sur le profil
  profileMaxPoints: 500,
};

// Seuil d'alerte sur la taille du pack.
// Budget mémoire d'un data field sur fenix847mm : 131 072 octets (128 Ko),
// relevé dans compiler.json du SDK. On ne peut pas s'en approcher : au
// chargement, le dictionnaire JSON DÉCODÉ coexiste avec les tableaux typés, et
// sa représentation en mémoire vaut plusieurs fois le texte source. On garde
// donc une marge large — à resserrer ou relâcher une fois le pic réel mesuré au
// profiler du simulateur (§9 : rester sous 70 % du budget).
export const SIZE_WARN_BYTES = 32 * 1024;

// ---------------------------------------------------------------- Douglas-Peucker
/**
 * Douglas-Peucker générique, pile explicite (pas de récursion : les traces
 * d'ultra font des dizaines de milliers de points).
 * @param {number} count nombre de points
 * @param {number} tol tolérance
 * @param {(i:number,a:number,b:number)=>number} perpDist écart du point i au segment [a,b]
 * @returns {number[]} indices conservés, triés
 */
function douglasPeucker(count, tol, perpDist) {
  if (count <= 2) { const all = []; for (let i = 0; i < count; i++) all.push(i); return all; }
  const keep = new Uint8Array(count);
  keep[0] = 1; keep[count - 1] = 1;
  const stack = [[0, count - 1]];
  while (stack.length) {
    const seg = stack.pop();
    const a = seg[0], b = seg[1];
    if (b - a < 2) continue;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(i, a, b);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > a && idx < b) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < count; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Simplifie en respectant un plafond de points : on part de la tolérance
 * cible, et on la relâche (doublement puis dichotomie) seulement si le budget
 * est dépassé. Une trace courte garde donc une tolérance fine et un pack léger.
 */
function simplifyToBudget(count, perpDist, tol0, maxPoints) {
  let idx = douglasPeucker(count, tol0, perpDist);
  if (idx.length <= maxPoints) return { idx, tol: tol0 };
  let lo = tol0, hi = tol0;
  for (let k = 0; k < 24 && douglasPeucker(count, hi, perpDist).length > maxPoints; k++) hi *= 2;
  for (let k = 0; k < 24 && hi - lo > 0.05; k++) {
    const mid = (lo + hi) / 2;
    if (douglasPeucker(count, mid, perpDist).length > maxPoints) lo = mid; else hi = mid;
  }
  idx = douglasPeucker(count, hi, perpDist);
  return { idx, tol: hi };
}

/** Écart d'un point à un segment, en coordonnées planes. */
function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ---------------------------------------------------------------- construction du pack
/**
 * Construit le course pack.
 * @param {object} o
 * @param {string} o.name nom de l'épreuve
 * @param {object} o.track sortie de buildTrack() : { points:[{lat,lon,ele,d}], total, gain }
 * @param {Array}  [o.climbs] sortie de detectClimbs()
 * @param {Array}  [o.waypoints] repères run-nav ({ d, label, icons, cutoff })
 * @param {number} [o.startMs] heure de départ (ms epoch), pour convertir les barrières
 * @param {object} [o.options] surcharges de DEFAULTS
 * @returns {{pack:object, report:object}}
 */
export function buildCoursePack({ name, track, climbs, waypoints, startMs, options }) {
  const opt = { ...DEFAULTS, ...(options || {}) };
  const pts = track.points;
  const n = pts.length;
  if (n < 2) throw new Error('Trace trop courte pour un course pack.');

  // --- projection plane locale (équirectangulaire) pour mesurer en mètres ---
  const R = 6371000, rad = Math.PI / 180;
  const lat0 = pts[0].lat * rad;
  const cosLat = Math.cos(lat0);
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = pts[i].lon * rad * cosLat * R;
    ys[i] = pts[i].lat * rad * R;
  }

  // --- 1) polyline simplifiée ---
  const geoDist = (i, a, b) => pointSegDist(xs[i], ys[i], xs[a], ys[a], xs[b], ys[b]);
  const simp = simplifyToBudget(n, geoDist, opt.trackTol, opt.trackMaxPoints);
  const idx = simp.idx;

  // --- 2) échelle de distances VRAIES le long de la polyline ---
  // Douglas-Peucker préserve la FORME mais raccourcit systématiquement la
  // LONGUEUR (il coupe les lacets) : sur un trail technique, ~3 % à 10 m de
  // tolérance. Impossible de descendre sous 0,5 % en resserrant la tolérance
  // sans exploser le budget de points (cf. docs/coursepack.md).
  //
  // On sépare donc les deux rôles de la polyline :
  //   - DESSIN  : les sommets simplifiés suffisent (erreur de forme ~10 m) ;
  //   - MESURE  : on joint à chaque sommet la distance RÉELLE parcourue sur la
  //               trace d'origine (`dd`, deltas en m).
  // La montre projette sa position sur le segment k à la fraction t, puis lit
  // l'abscisse = cum[k] + t·(cum[k+1] − cum[k]) : c'est la vraie distance, et
  // « restant = d − s » reste juste jusqu'à l'arrivée. Tout le pack (côtes,
  // profil, POI) vit donc dans l'abscisse d'origine, sans remappage.
  const dd = [];
  let prevCum = Math.round(pts[idx[0]].d);
  for (let k = 1; k < idx.length; k++) {
    const cum = Math.round(pts[idx[k]].d);   // deltas depuis la valeur quantifiée
    dd.push(cum - prevCum);
    prevCum = cum;
  }
  const trueTotal = pts[idx[idx.length - 1]].d;

  // longueur des cordes : sert uniquement à mesurer l'écart de FORME (info)
  let chordLen = 0;
  for (let k = 1; k < idx.length; k++) chordLen += haversine(pts[idx[k - 1]], pts[idx[k]]);

  // --- 3) polyline delta-encodée (1e-5 deg) ---
  // Les deltas sont calculés depuis la valeur DÉJÀ quantifiée : pas de dérive.
  const q = (v) => Math.round(v * 1e5);
  const o = [q(pts[idx[0]].lat), q(pts[idx[0]].lon)];
  const t = [];
  let pLat = o[0], pLon = o[1];
  for (let k = 1; k < idx.length; k++) {
    const la = q(pts[idx[k]].lat), lo2 = q(pts[idx[k]].lon);
    t.push(la - pLat, lo2 - pLon);
    pLat = la; pLon = lo2;
  }

  // --- 4) profil simplifié (écart VERTICAL, cf. docs) ---
  const pd = new Float64Array(n), pe = new Float64Array(n);
  for (let i = 0; i < n; i++) { pd[i] = pts[i].d; pe[i] = pts[i].ele; }
  const vertDist = (i, a, b) => {
    const span = pd[b] - pd[a];
    const tt = span > 0 ? (pd[i] - pd[a]) / span : 0;
    return Math.abs(pe[i] - (pe[a] + tt * (pe[b] - pe[a])));
  };
  const prof = simplifyToBudget(n, vertDist, opt.profileTol, opt.profileMaxPoints);
  const p = prof.idx.map((i) => [Math.round(pts[i].d), Math.round(pts[i].ele)]);

  // --- 5) côtes ---
  const c = (climbs || []).map((cl) => {
    const row = {
      s: Math.round(cl.startD),
      e: Math.round(cl.endD),
      g: Math.round(cl.gain),
      pc: Math.round((cl.avgGrade || 0) * 10),   // ‰
      n: (cl.name || '').trim(),
    };
    if (!row.n) delete row.n;                     // nom absent → la montre affiche l'index
    return row;
  });

  // --- 6) points d'intérêt ---
  // Les sommets auto sont déjà décrits par `c` : on ne garde que les repères
  // porteurs d'info (nommés à la main, avec pictogramme ou barrière horaire).
  const i2 = [];
  for (const w of (waypoints || [])) {
    if (w.d == null) continue;
    const icons = Array.isArray(w.icons) ? w.icons : (w.icon ? [w.icon] : []);
    const meaningful = !w.auto || !!w.cutoff || icons.length > 0;
    if (!meaningful || w.summit) continue;
    const row = { d: Math.round(w.d), k: poiKind(icons, w) };
    const nm = (w.label || '').trim();
    if (nm) row.n = nm;
    const cutMin = cutoffMinutes(w.cutoff, startMs);
    if (cutMin != null) row.cut = cutMin;
    i2.push(row);
  }
  i2.sort((a, b) => a.d - b.d);

  const pack = {
    v: PACK_VERSION,
    n: (name || track.name || 'Course').trim(),
    d: Math.round(trueTotal),
    a: Math.round(track.gain || 0),
    o, t, dd, p, c, i: i2,
  };

  // --- 7) contrôle de cohérence ---
  // Critère jalon 2 : la distance que la MONTRE reconstruira (échelle `dd`)
  // vs la distance d'origine. L'écart de forme des cordes est reporté à part :
  // il n'affecte que le dessin, plus la mesure.
  const json = JSON.stringify(pack);
  const bytes = byteLength(json);
  let packDistance = 0;
  for (const step of dd) packDistance += step;
  const drift = track.total > 0 ? Math.abs(track.total - packDistance) / track.total : 0;
  const chordDrift = track.total > 0 ? Math.abs(track.total - chordLen) / track.total : 0;
  const report = {
    bytes,
    sizeWarn: bytes > SIZE_WARN_BYTES,
    trackPoints: idx.length,
    trackTol: +simp.tol.toFixed(2),
    profilePoints: p.length,
    profileTol: +prof.tol.toFixed(2),
    climbs: c.length,
    pois: i2.length,
    originalDistance: Math.round(track.total),
    packDistance,
    driftPct: +(drift * 100).toFixed(3),
    driftOk: drift < 0.005,                       // < 0,5 % (critère jalon 2)
    chordDriftPct: +(chordDrift * 100).toFixed(3), // écart de forme (dessin only)
    budgetOk: idx.length <= opt.trackMaxPoints && p.length <= opt.profileMaxPoints,
  };
  return { pack, report };
}

function poiKind(icons, w) {
  const s = icons.join('');
  if (/[🥤💧🚰🍌🍽🥪🧃]/u.test(s)) return 'ravito';
  if (w.cutoff) return 'barriere';
  if (/[🏁]/u.test(s)) return 'arrivee';
  if (/[🏥⛑️]/u.test(s)) return 'secours';
  if (/[🛏️😴⛺]/u.test(s)) return 'base';
  return 'poi';
}

/** Barrière horaire → minutes depuis le départ (null si non calculable). */
function cutoffMinutes(cutoff, startMs) {
  if (!cutoff || startMs == null) return null;
  const ms = Date.parse(cutoff);
  if (!isFinite(ms)) return null;
  const min = Math.round((ms - startMs) / 60000);
  return min > 0 ? min : null;
}

/** Taille UTF-8 réelle (les noms peuvent contenir des accents / emoji). */
function byteLength(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
  return Buffer.byteLength(str, 'utf8');
}

/** Décode la polyline d'un pack → [{lat, lon}] (contrôle et tests). */
export function decodePolyline(pack) {
  const out = [{ lat: pack.o[0] / 1e5, lon: pack.o[1] / 1e5 }];
  let la = pack.o[0], lo = pack.o[1];
  for (let k = 0; k < pack.t.length; k += 2) {
    la += pack.t[k]; lo += pack.t[k + 1];
    out.push({ lat: la / 1e5, lon: lo / 1e5 });
  }
  return out;
}
