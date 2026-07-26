// Implémentation de référence du modèle de vitesse ascensionnelle (VAM).
// Transliterée ensuite en Monkey C (source/PaceModel.mc).
//
// Sert à estimer le temps restant jusqu'au sommet de la côte en cours (§5.2).
// Pas de modèle de fatigue ici : c'est le rôle de run-nav en amont (§11).

export const WINDOW_SEC = 20 * 60;   // moyenne glissante sur 20 min (§5.2)
export const VAM_MIN = 200;          // m/h — bornes de sécurité
export const VAM_MAX = 900;
export const CLIMB_GRADE = 3.0;      // % — au-dessous, on ne mesure pas de VAM
export const MOVING_SPEED = 0.3;     // m/s — au-dessous, on considère à l'arrêt
export const SLOTS = 64;             // taille du tampon circulaire (borné : pas d'alloc)

export class PaceModel {
  constructor(initialVAM = 450) {
    this.initial = initialVAM;
    this.tBuf = new Float64Array(SLOTS);
    this.gBuf = new Float64Array(SLOTS);
    this.head = 0; this.count = 0;
    this.cumGain = 0; this.lastEle = null;
    this.vam = initialVAM;
  }

  /**
   * @param {number} tSec  temps d'activité (s). Sur la montre : Activity.Info.timerTime,
   *                       qui NE COURT PAS quand l'activité est en pause — les arrêts
   *                       longs (ravito, sieste) sont donc neutralisés gratuitement.
   * @param {number} ele   altitude courante (m)
   * @param {number} grade pente instantanée (%)
   * @param {number} speed vitesse instantanée (m/s)
   */
  update(tSec, ele, grade, speed) {
    if (this.lastEle != null) {
      const dz = ele - this.lastEle;
      if (dz > 0) this.cumGain += dz;
    }
    this.lastEle = ele;

    // On n'échantillonne QUE en montée effective. Sinon un long faux plat ou un
    // arrêt timer-tournant (debout au ravito) noierait la moyenne et ferait
    // plonger la VAM au plancher, rendant l'ETA absurdement pessimiste.
    const climbing = (grade >= CLIMB_GRADE) && (speed >= MOVING_SPEED);
    if (climbing) this._push(tSec, this.cumGain);

    this._recompute();
    return this.vam;
  }

  _push(t, g) {
    this.tBuf[this.head] = t; this.gBuf[this.head] = g;
    this.head = (this.head + 1) % SLOTS;
    if (this.count < SLOTS) this.count++;
  }

  _recompute() {
    if (this.count < 2) { this.vam = this.initial; return; }
    const newest = (this.head - 1 + SLOTS) % SLOTS;
    const tNew = this.tBuf[newest], gNew = this.gBuf[newest];
    // plus ancien échantillon encore dans la fenêtre
    let oldest = newest, found = false;
    for (let k = 1; k < this.count; k++) {
      const i = (newest - k + SLOTS) % SLOTS;
      if (tNew - this.tBuf[i] > WINDOW_SEC) break;
      oldest = i; found = true;
    }
    if (!found) { this.vam = this.initial; return; }
    const dt = tNew - this.tBuf[oldest];
    const dg = gNew - this.gBuf[oldest];
    if (dt < 60) { return; }                 // trop peu de recul : on garde la valeur courante
    let v = (dg / dt) * 3600;
    if (v < VAM_MIN) v = VAM_MIN;
    if (v > VAM_MAX) v = VAM_MAX;
    this.vam = v;
  }

  /** Secondes estimées pour avaler `gainRemaining` mètres de D+. */
  etaSeconds(gainRemaining) {
    if (gainRemaining <= 0) return 0;
    return (gainRemaining / this.vam) * 3600;
  }
}
