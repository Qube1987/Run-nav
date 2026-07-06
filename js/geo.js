// Utilitaires géographiques : distances, projection sur la trace.

const R = 6371000; // rayon terrestre en mètres
const toRad = (d) => (d * Math.PI) / 180;

/** Distance haversine (m) entre deux points {lat, lon}. */
export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Projette un point GPS sur la polyligne de la trace.
 * Renvoie l'index de segment, la distance cumulée le long de la trace (m),
 * et l'écart perpendiculaire à la trace (m).
 *
 * On travaille dans un plan local équirectangulaire centré sur le point,
 * suffisant pour des écarts de quelques km.
 */
export function projectOnTrack(pt, points, hint = 0) {
  const lat0 = toRad(pt.lat);
  const cosLat = Math.cos(lat0);
  const mx = (p) => toRad(p.lon) * cosLat * R;
  const my = (p) => toRad(p.lat) * R;

  const px = mx(pt);
  const py = my(pt);

  let best = { dist: Infinity, along: 0, index: 0, t: 0 };

  // Fenêtre de recherche autour de l'index précédent pour la performance,
  // avec repli sur la trace entière si on est loin.
  const searchAll = hint <= 0;
  const lo = searchAll ? 0 : Math.max(0, hint - 60);
  const hi = searchAll ? points.length - 1 : Math.min(points.length - 1, hint + 200);

  const scan = (start, end) => {
    for (let i = start; i < end; i++) {
      const a = points[i];
      const b = points[i + 1];
      const ax = mx(a), ay = my(a);
      const bx = mx(b), by = my(b);
      const dx = bx - ax, dy = by - ay;
      const segLen2 = dx * dx + dy * dy;
      let t = segLen2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / segLen2 : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy;
      const d = Math.hypot(px - cx, py - cy);
      if (d < best.dist) {
        best = {
          dist: d,
          index: i,
          t,
          along: a.d + t * (b.d - a.d),
        };
      }
    }
  };

  scan(lo, hi);
  // Si l'écart est énorme, la fenêtre était peut-être mauvaise → re-scan complet.
  if (!searchAll && best.dist > 300) scan(0, points.length - 1);

  return best;
}

/** Interpole un point (lat/lon/ele) à une distance cumulée donnée. */
export function pointAtDistance(points, dist) {
  if (dist <= 0) return { ...points[0] };
  const last = points[points.length - 1];
  if (dist >= last.d) return { ...last };

  // recherche dichotomique
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].d < dist) lo = mid;
    else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const span = b.d - a.d || 1;
  const t = (dist - a.d) / span;
  return {
    lat: a.lat + t * (b.lat - a.lat),
    lon: a.lon + t * (b.lon - a.lon),
    ele: a.ele + t * (b.ele - a.ele),
    d: dist,
  };
}
