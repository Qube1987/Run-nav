// Calcul des temps de passage / estimation d'arrivée.
//
// Le modèle tient compte du dénivelé : la vitesse « à plat » est ajustée
// selon la pente locale (on ralentit en montée, on accélère un peu en descente),
// puis calibrée pour que la moyenne réelle corresponde à la vitesse de référence.

/**
 * Facteur de vitesse relatif selon la pente (%).
 * 1 = vitesse de référence à plat. En montée on ralentit fortement,
 * en descente on gagne un peu (plafonné).
 */
function speedFactor(grade) {
  if (grade >= 0) {
    // ~ -8 %/point de pente positif, plancher à 0.25
    return Math.max(0.25, 1 - grade * 0.085);
  }
  // descente : léger gain, plafonné à +25 %
  return Math.min(1.25, 1 + -grade * 0.02);
}

/**
 * Construit un "coût temps" cumulé le long de la trace pour une vitesse de
 * référence donnée (m/s à plat). Renvoie un tableau cumulTime[] (s) aligné sur points.
 * Le résultat est recalibré pour que le temps total corresponde à la distance
 * totale divisée par une vitesse moyenne « terrain » cohérente.
 */
export function buildTimeModel(points, refSpeedFlat) {
  const n = points.length;
  const cum = new Array(n);
  cum[0] = 0;
  for (let i = 1; i < n; i++) {
    const dd = points[i].d - points[i - 1].d;
    const g = points[i].grade || 0;
    // v reste strictement positif (speedFactor >= 0.25). L'epsilon évite juste une
    // division par zéro si refSpeedFlat est nul, sans casser la linéarité du modèle
    // (indispensable pour que la calibration des temps de passage soit exacte).
    const v = Math.max(1e-3, refSpeedFlat * speedFactor(g));
    cum[i] = cum[i - 1] + dd / v;
  }
  return cum;
}

/**
 * Détermine la vitesse de référence à plat telle que le temps total modélisé
 * corresponde exactement à `targetTotalSec`.
 */
export function calibrateForTotalTime(points, targetTotalSec) {
  // le modèle est linéaire en 1/refSpeed → une seule passe suffit
  const unit = buildTimeModel(points, 1); // temps avec refSpeed = 1 m/s
  const totalUnit = unit[unit.length - 1];
  return totalUnit / targetTotalSec; // = refSpeedFlat
}

/**
 * Vitesse de référence à plat pour atteindre une vitesse moyenne globale donnée
 * (km/h) sur l'ensemble du parcours.
 */
export function calibrateForAvgSpeed(points, avgKmh) {
  const totalDist = points[points.length - 1].d;
  const targetSec = totalDist / (avgKmh / 3.6);
  return calibrateForTotalTime(points, targetSec);
}

/**
 * Vitesse de référence à plat telle que le temps modélisé pour atteindre la
 * distance `dist` vaille `targetSec`. Sert à éditer un temps de passage cible
 * sur un point précis : tout le reste du parcours se recalibre en conséquence.
 */
export function calibrateForTimeAtDistance(points, dist, targetSec) {
  const unit = buildTimeModel(points, 1);
  const unitAt = timeAtDistance(points, unit, dist);
  if (targetSec <= 0) return null;
  return unitAt / targetSec;
}

/** Vitesse moyenne globale (km/h) correspondant à une vitesse de référence à plat. */
export function avgSpeedFor(points, refSpeedFlat) {
  const total = points[points.length - 1].d;
  const unit = buildTimeModel(points, 1);
  const totalSec = unit[unit.length - 1] / refSpeedFlat;
  return (total / totalSec) * 3.6;
}

/** Temps cumulé (s) interpolé à une distance donnée. */
export function timeAtDistance(points, cum, dist) {
  if (dist <= 0) return 0;
  const last = points.length - 1;
  if (dist >= points[last].d) return cum[last];
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].d < dist) lo = mid; else hi = mid;
  }
  const span = points[hi].d - points[lo].d || 1;
  const t = (dist - points[lo].d) / span;
  return cum[lo] + t * (cum[hi] - cum[lo]);
}

/** Formate une durée en s → "h:mm" ou "m:ss". */
export function fmtDuration(sec) {
  if (!isFinite(sec) || sec < 0) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Formate une heure d'horloge à partir d'un timestamp (ms). */
export function fmtClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
