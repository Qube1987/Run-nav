// Implémentation de référence du Locator (transliterée ensuite en Monkey C).
// Projette une position GPS sur la polyline du pack et renvoie l'abscisse VRAIE
// via l'échelle `dd`. Recherche LOCALE uniquement (fenêtre autour du dernier index).
export const WINDOW = 40;          // segments explorés de part et d'autre
export const MAX_SPEED = 200;      // m/s — au-delà : saut GPS rejeté
export const FREE_BAND = 30;       // m — tout déplacement plausible en 1 tick, non pénalisé
export const PLAUSIBLE_SPEED = 25; // m/s — borne haute (descente à vélo), élargit la bande si dt > 1 s
export const CONTINUITY_K = 3;     // m d'écart d'abscisse « coûtant » 1 m d'écart latéral
export const CONTINUITY_CAP = 50;  // m — plafond du biais : au-delà, l'évidence spatiale l'emporte
export const MAX_REJECTS = 5;      // rejets consécutifs avant ré-acquisition forcée
export const MIN_MOVE = 8;         // m — déplacement minimal pour que le cap soit fiable
export const DIR_W = 40;           // poids du désaccord de cap (m équivalents)

export class Locator {
  constructor(pack) {
    // décodage polyline + échelle de distances vraies
    const n = pack.t.length / 2 + 1;
    this.n = n;
    this.xs = new Float64Array(n); this.ys = new Float64Array(n);
    this.cum = new Float64Array(n);
    const R = 6371000, rad = Math.PI / 180;
    const lat0 = (pack.o[0] / 1e5) * rad, cosLat = Math.cos(lat0);
    let la = pack.o[0], lo = pack.o[1];
    this.xs[0] = (lo / 1e5) * rad * cosLat * R; this.ys[0] = (la / 1e5) * rad * R;
    this.cum[0] = 0;
    for (let k = 0; k < pack.dd.length; k++) {
      la += pack.t[2 * k]; lo += pack.t[2 * k + 1];
      this.xs[k + 1] = (lo / 1e5) * rad * cosLat * R;
      this.ys[k + 1] = (la / 1e5) * rad * R;
      this.cum[k + 1] = this.cum[k] + pack.dd[k];   // distance VRAIE
    }
    this.total = this.cum[n - 1];
    this.lat0 = lat0; this.cosLat = cosLat; this.R = R; this.rad = rad;
    this.reset();
  }
  reset() { this.idx = 0; this.s = 0; this.off = 0; this.started = false; this.stale = false; this.lastT = null; this.rejects = 0; this.lastPx = null; this.lastPy = null; }

  _xy(lat, lon) {
    return [lon * this.rad * this.cosLat * this.R, lat * this.rad * this.R];
  }

  /** @returns {{s:number, off:number, idx:number, rejected:boolean}} */
  update(lat, lon, tSec) {
    const [px, py] = this._xy(lat, lon);
    // fenêtre locale : préserve la continuité (aller-retour, boucles, croisements)
    let lo = this.idx - WINDOW, hi = this.idx + WINDOW;
    if (!this.started) { lo = 0; hi = this.n - 1; }      // 1re acquisition : balayage complet
    if (lo < 0) lo = 0;
    if (hi > this.n - 2) hi = this.n - 2;

    // Biais de CONTINUITÉ. Sur un lacet, les deux brins peuvent passer à ~25 m
    // l'un de l'autre : le seul critère « point le plus proche » accroche alors
    // le mauvais brin (mesuré : jusqu'à 283 m d'erreur sur RT 2026, km 72,06).
    // On pénalise donc les sauts d'abscisse invraisemblables, avec une bande
    // FRANCHE couvrant tout déplacement physiquement possible depuis le dernier
    // point : la marche normale n'est jamais pénalisée.
    // Sens de déplacement : sur un aller-retour empruntant LE MÊME sentier, les
    // deux brins se superposent (écart perpendiculaire mesuré : 0,4 m) — aucune
    // information spatiale ne peut trancher. Seul le cap le peut : les deux brins
    // sont à 180° l'un de l'autre. On pénalise les segments pris à contresens.
    let mvx = 0, mvy = 0, haveDir = false;
    if (this.lastPx != null) {
      const ddx = px - this.lastPx, ddy = py - this.lastPy;
      const m = Math.sqrt(ddx * ddx + ddy * ddy);
      if (m > MIN_MOVE) { mvx = ddx / m; mvy = ddy / m; haveDir = true; }
    }
    const dt = (this.lastT != null && tSec > this.lastT) ? (tSec - this.lastT) : 1;
    const free = Math.max(FREE_BAND, PLAUSIBLE_SPEED * dt);

    let bestCost = Infinity, bestD = Infinity, bestK = this.idx, bestT = 0;
    for (let k = lo; k <= hi; k++) {
      const ax = this.xs[k], ay = this.ys[k];
      const dx = this.xs[k + 1] - ax, dy = this.ys[k + 1] - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const cx = ax + t * dx, cy = ay + t * dy;
      const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      let cost = d2;
      if (this.started) {
        const sk = this.cum[k] + t * (this.cum[k + 1] - this.cum[k]);
        let excess = Math.abs(sk - this.s) - free;
        if (excess > 0) {
          // PLAFONNÉ : sans cela, une accroche erronée devient collante et le
          // biais empêche toute correction (mesuré : 1 098 m d'erreur tenue sur
          // 13 points, à 172 m de la position réelle). La continuité vaut au
          // plus CONTINUITY_CAP mètres d'écart latéral : elle départage des
          // candidats comparables, jamais un candidat manifestement meilleur.
          let pen = excess / CONTINUITY_K;
          if (pen > CONTINUITY_CAP) { pen = CONTINUITY_CAP; }
          cost += pen * pen;
        }
      }
      if (haveDir && len2 > 0) {
        const sl = Math.sqrt(len2);
        const dot = (dx * mvx + dy * mvy) / sl;       // -1 = à contresens
        cost += DIR_W * DIR_W * (1 - dot) / 2;
      }
      if (cost < bestCost) { bestCost = cost; bestD = d2; bestK = k; bestT = t; }
    }
    const s = this.cum[bestK] + bestT * (this.cum[bestK + 1] - this.cum[bestK]);

    // garde-fou anti-saut : une progression physiquement impossible est rejetée
    if (this.started && this.lastT != null && tSec > this.lastT) {
      const dt = tSec - this.lastT;
      if (Math.abs(s - this.s) / dt > MAX_SPEED && this.rejects < MAX_REJECTS) {
        // glitch isolé : on ignore. Mais si ça persiste, c'est que la position
        // a réellement changé (redémarrage, transport) → on se ré-accroche.
        this.rejects++;
        this.stale = true;
        return { s: this.s, off: this.off, idx: this.idx, rejected: true };
      }
      this.rejects = 0;
    }
    this.idx = bestK; this.s = s; this.off = Math.sqrt(bestD);
    this.started = true; this.stale = false; this.lastT = tSec;
    this.lastPx = px; this.lastPy = py;
    return { s, off: this.off, idx: bestK, rejected: false };
  }

  /** Perte GPS : on avance à l'estime avec la distance de l'activité. */
  coast(deltaMeters) {
    this.stale = true;
    this.s = Math.min(this.total, this.s + Math.max(0, deltaMeters));
    while (this.idx < this.n - 2 && this.cum[this.idx + 1] < this.s) this.idx++;
    return this.s;
  }
  remaining() { return Math.max(0, this.total - this.s); }
}
