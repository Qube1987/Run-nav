// Modèle de vitesse ascensionnelle (VAM) → estimation du temps jusqu'au sommet.
//
// Transliteration de tools/pacemodel-reference.mjs, validé sur la plus grosse
// côte de RT 2026 (1 594 m D+ sur 10,5 km, 15,2 % de pente moyenne) :
//
//   grimpeur lent (380 m/h)              → VAM estimée 380, ETA à 0,1 %
//   grimpeur rapide (750 m/h)            → VAM estimée 745, ETA à 2,7 %
//   arrêt 15 min, timer en pause         → ETA à 0,6 %
//   arrêt 15 min DEBOUT, timer qui tourne → ETA à 0,6 %
//   VAM absurde (1 800 m/h)              → plafonnée à 900
//
// Pas de modèle de fatigue : c'est le rôle de run-nav en amont (§11).
//
// Compile avec le SDK 9.2.0 pour fenix847mm ; comportement à valider au simulateur.

using Toybox.Lang;

class PaceModel {
    const WINDOW_SEC = 1200;    // moyenne glissante 20 min (§5.2)
    const VAM_MIN = 200;        // m/h — bornes de sécurité
    const VAM_MAX = 900;
    const CLIMB_GRADE = 3.0;    // % — sous ce seuil, pas de mesure
    const MOVING_SPEED = 0.3;   // m/s — sous ce seuil, à l'arrêt
    const SLOTS = 64;           // tampon circulaire : taille FIXE, zéro alloc

    private var tBuf as Lang.Array<Lang.Number>;
    private var gBuf as Lang.Array<Lang.Float>;
    private var head as Lang.Number = 0;
    private var count as Lang.Number = 0;
    private var cumGain as Lang.Float = 0.0;
    private var lastEle as Lang.Float = 0.0;
    private var haveEle as Lang.Boolean = false;
    private var initial as Lang.Number;
    public var vam as Lang.Float;

    function initialize(initialVAM as Lang.Number) {
        initial = initialVAM;
        vam = initialVAM.toFloat();
        // `new [n]` produit un Array<Null> : on type explicitement, sinon
        // l'affectation aux membres typés est refusée.
        tBuf = new [SLOTS] as Lang.Array<Lang.Number>;
        gBuf = new [SLOTS] as Lang.Array<Lang.Float>;
        for (var i = 0; i < SLOTS; i += 1) { tBuf[i] = 0; gBuf[i] = 0.0; }
    }

    /**
     * @param tSec  Activity.Info.timerTime / 1000. Ce compteur NE COURT PAS quand
     *              l'activité est en pause : les arrêts longs sont neutralisés
     *              sans code supplémentaire (§6.3).
     */
    function update(tSec as Lang.Number, ele as Lang.Float,
                    grade as Lang.Float, speed as Lang.Float) as Void {
        if (haveEle) {
            var dz = ele - lastEle;
            if (dz > 0) { cumGain += dz; }
        }
        lastEle = ele;
        haveEle = true;

        // On n'échantillonne QU'EN MONTÉE EFFECTIVE. Sans ce garde-fou, un long
        // faux plat — ou un arrêt debout au ravito avec le timer qui tourne —
        // noierait la moyenne et ferait plonger la VAM au plancher, rendant
        // l'ETA absurdement pessimiste juste au moment où on la consulte.
        if (grade >= CLIMB_GRADE && speed >= MOVING_SPEED) {
            tBuf[head] = tSec;
            gBuf[head] = cumGain;
            head = (head + 1) % SLOTS;
            if (count < SLOTS) { count += 1; }
        }
        recompute();
    }

    private function recompute() as Void {
        if (count < 2) { vam = initial.toFloat(); return; }
        var newest = (head - 1 + SLOTS) % SLOTS;
        var tNew = tBuf[newest];
        var gNew = gBuf[newest];
        var oldest = newest;
        var found = false;
        for (var k = 1; k < count; k += 1) {
            var i = (newest - k + SLOTS) % SLOTS;
            if (tNew - tBuf[i] > WINDOW_SEC) { break; }
            oldest = i;
            found = true;
        }
        if (!found) { vam = initial.toFloat(); return; }
        var dt = tNew - tBuf[oldest];
        if (dt < 60) { return; }              // trop peu de recul : on garde la valeur
        var v = ((gNew - gBuf[oldest]) / dt) * 3600.0;
        if (v < VAM_MIN) { v = VAM_MIN.toFloat(); }
        if (v > VAM_MAX) { v = VAM_MAX.toFloat(); }
        vam = v;
    }

    /** Secondes estimées pour avaler `gainRemaining` mètres de D+. */
    function etaSeconds(gainRemaining as Lang.Float) as Lang.Number {
        if (gainRemaining <= 0) { return 0; }
        return ((gainRemaining / vam) * 3600.0).toNumber();
    }
}
