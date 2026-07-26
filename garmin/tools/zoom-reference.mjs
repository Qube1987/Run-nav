// Choix du palier de zoom de la zone A (§5.1), avec hystérésis.
export const PALIERS = [200, 400, 800, 1500, 3000];   // demi-fenêtre (m)
// Le lookahead suit la VITESSE : on montre ce qui arrive dans les ~4 prochaines
// minutes. Mesuré sur RT 2026, un lookahead figé dégénère — à 600 m le zoom
// reste bloqué à 92 % sur un seul palier, à 1 000 m sur 79 %. Indexé sur la
// vitesse, le même code sert l'ultra-trail (~1,5 m/s → ~360 m, paliers serrés)
// et le bikepacking (~8 m/s → ~1 900 m, paliers larges), comme demandé au §1.
export const HORIZON_SEC = 240;
export const LOOKAHEAD_MIN = 250;
export const LOOKAHEAD_MAX = 2500;
export function lookaheadFor(speed) {
  var la = speed * HORIZON_SEC;
  if (la < LOOKAHEAD_MIN) { la = LOOKAHEAD_MIN; }
  if (la > LOOKAHEAD_MAX) { la = LOOKAHEAD_MAX; }
  return la;
}
export const FILL = 0.80;        // on vise à remplir 80 % de la fenêtre
export const DWELL = 5;          // ticks de confirmation avant de changer de palier

/** Étalement géométrique de la trace sur les LOOKAHEAD prochains mètres. */
export function spreadAhead(xs, ys, cum, idx, s, n, lookahead) {
  const px = interpX(xs, cum, idx, s), py = interpY(ys, cum, idx, s);
  let max = 0;
  for (let k = idx; k < n - 1 && cum[k] - s < lookahead; k++) {
    const dx = xs[k] - px, dy = ys[k] - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > max) max = d;
  }
  return max;
}
function interpX(xs, cum, k, s){ const sp=cum[k+1]-cum[k]; const t=sp>0?(s-cum[k])/sp:0; return xs[k]+t*(xs[k+1]-xs[k]); }
function interpY(ys, cum, k, s){ const sp=cum[k+1]-cum[k]; const t=sp>0?(s-cum[k])/sp:0; return ys[k]+t*(ys[k+1]-ys[k]); }

export class ZoomPicker {
  constructor(){ this.level = 2; this.want = 2; this.dwell = 0; this.changes = 0; }
  /** @param hysteresis false → comportement naïf, pour comparaison */
  update(spread, hysteresis = true) {
    let want = PALIERS.length - 1;
    for (let i = 0; i < PALIERS.length; i++) {
      if (spread <= PALIERS[i] * FILL) { want = i; break; }
    }
    if (!hysteresis) {
      if (want !== this.level) this.changes++;
      this.level = want;
      return this.level;
    }
    // hystérésis : le nouveau palier doit se confirmer DWELL ticks de suite.
    // Sans cela, un spread oscillant autour d'un seuil fait pomper le zoom à
    // chaque seconde — illisible en course.
    if (want === this.level) { this.dwell = 0; this.want = want; return this.level; }
    if (want !== this.want) { this.want = want; this.dwell = 1; return this.level; }
    this.dwell++;
    if (this.dwell >= DWELL) { this.level = want; this.dwell = 0; this.changes++; }
    return this.level;
  }
}
