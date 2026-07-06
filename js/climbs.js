// Détection des côtes (montées significatives) à partir de la trace.

/**
 * Détecte les côtes : segments de montée soutenue.
 * Algorithme :
 *  1. On segmente la trace en tronçons montants/descendants.
 *  2. On fusionne les petites descentes (< seuil) à l'intérieur d'une montée.
 *  3. On garde les côtes avec un dénivelé et une pente moyenne suffisants.
 *
 * Renvoie une liste de côtes :
 *  { startD, endD, startEle, topEle, gain, length, avgGrade, maxGrade, category }
 */
export function detectClimbs(points) {
  if (points.length < 3) return [];

  // Petites côtes fusionnées : on autorise de courtes portions plates/descendantes
  // (jusqu'à -10 m de dénivelé cumulé) sans casser une montée.
  const climbs = [];
  let i = 0;
  const n = points.length;

  while (i < n - 1) {
    // cherche le début d'une montée
    if (points[i + 1].ele <= points[i].ele) { i++; continue; }

    const startIdx = i;
    let topIdx = i;
    let j = i;
    let dipFromTop = 0; // combien on est redescendu depuis le dernier sommet local

    while (j < n - 1) {
      const dz = points[j + 1].ele - points[j].ele;
      if (dz >= 0) {
        if (points[j + 1].ele >= points[topIdx].ele) {
          topIdx = j + 1;
          dipFromTop = 0;
        }
      } else {
        dipFromTop += -dz;
        // tolère une redescente jusqu'à 12 m OU 25 % du gain déjà acquis
        const gainSoFar = points[topIdx].ele - points[startIdx].ele;
        const tolerance = Math.max(12, gainSoFar * 0.25);
        if (dipFromTop > tolerance) break;
      }
      j++;
    }

    const gain = points[topIdx].ele - points[startIdx].ele;
    const length = points[topIdx].d - points[startIdx].d;
    const avgGrade = length > 0 ? (gain / length) * 100 : 0;

    // filtre : vraie côte
    if (gain >= 20 && length >= 150 && avgGrade >= 2.5) {
      let maxGrade = 0;
      for (let k = startIdx; k <= topIdx; k++) maxGrade = Math.max(maxGrade, points[k].grade || 0);
      climbs.push({
        startD: points[startIdx].d,
        endD: points[topIdx].d,
        startEle: points[startIdx].ele,
        topEle: points[topIdx].ele,
        gain: Math.round(gain),
        length,
        avgGrade,
        maxGrade,
        category: categorize(gain, avgGrade),
      });
    }

    i = Math.max(topIdx, startIdx + 1);
  }

  return climbs;
}

/**
 * Catégorisation à la cycliste, basée sur un "score" = longueur(m) × pente(%) / 100.
 * Approximation des catégories de cols.
 */
function categorize(gain, avgGrade) {
  const score = gain * (avgGrade / 100) * 10; // pondère la difficulté
  if (avgGrade >= 3) {
    if (gain >= 1000) return 'HC';
    if (gain >= 600) return '1';
    if (gain >= 300) return '2';
    if (gain >= 150) return '3';
  }
  if (gain >= 80) return '4';
  return '';
}

/** Trouve la côte "en cours" ou la prochaine à partir d'une distance donnée. */
export function currentClimb(climbs, dist) {
  for (const c of climbs) {
    if (dist >= c.startD && dist <= c.endD) return { climb: c, state: 'in' };
  }
  // prochaine côte devant nous
  let next = null;
  for (const c of climbs) {
    if (c.startD > dist && (!next || c.startD < next.startD)) next = c;
  }
  return next ? { climb: next, state: 'next' } : null;
}
