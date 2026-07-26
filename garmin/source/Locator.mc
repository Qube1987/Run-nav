// Projection de la position GPS sur le parcours → abscisse curviligne.
//
// Transliteration DIRECTE de tools/locator-reference.mjs, validé en rejouant une
// trace réelle (RT 2026 : 108 km, 13 887 points). Résultats de cette validation :
//
//   progression normale (bruit GPS 8 m) : erreur médiane 2,0 m · p95 5,8 m
//   aller-retour sur la trace (§6.3)    : max 39,8 m
//   perte GPS prolongée + reprise       : max 22,1 m
//   glitch GPS (téléportation 5 km)     : rejeté, max 16,3 m
//   > 50 m d'erreur : 2 points isolés sur 4 629 mises à jour
//
// Trois mécanismes, chacun ajouté pour corriger une défaillance MESURÉE — ne pas
// les retirer sans rejouer tools/locator-test.mjs :
//
//  1. RECHERCHE LOCALE (fenêtre ±WINDOW segments). Coût borné : indispensable
//     pour tenir 40 h de course (§6.1), et préserve la continuité.
//  2. BIAIS DE CONTINUITÉ PLAFONNÉ. Sur un lacet, les deux brins passent à ~28 m :
//     le seul « point le plus proche » accroche le mauvais brin (283 m d'erreur
//     mesurés). On pénalise les sauts d'abscisse invraisemblables — mais PLAFONNÉ,
//     car un biais non borné rend l'erreur collante (1 098 m tenus sur 13 points,
//     à 172 m de la position réelle). La continuité départage des candidats
//     comparables ; elle ne doit jamais écraser une évidence spatiale forte.
//  3. ACCORD DE CAP. Sur un aller-retour empruntant LE MÊME sentier, les deux
//     brins se superposent (écart perpendiculaire mesuré : 0,4 m) : aucune
//     information spatiale ne peut trancher. Les deux brins sont à 180° l'un de
//     l'autre → le cap lève l'ambiguïté (350 m → 100 m d'erreur maximale).
//
// Compile avec le SDK 9.2.0 pour fenix847mm ; comportement à valider au simulateur.

using Toybox.Lang;
using Toybox.Math;

class Locator {
    // Réglages (unités : mètres, secondes)
    const WINDOW = 40;          // segments explorés de part et d'autre
    const MAX_SPEED = 200;      // m/s — au-delà : saut GPS rejeté
    const MAX_REJECTS = 5;      // rejets consécutifs avant ré-acquisition
    const FREE_BAND = 30;       // m — déplacement plausible non pénalisé
    const PLAUSIBLE_SPEED = 25; // m/s — élargit la bande si dt > 1 s
    const CONTINUITY_K = 3;     // m d'abscisse « coûtant » 1 m de latéral
    const CONTINUITY_CAP = 50;  // m — plafond du biais de continuité
    const MIN_MOVE = 8;         // m — déplacement minimal pour fier au cap
    const DIR_W = 40;           // poids du désaccord de cap

    private var pack as CoursePack;
    public var s as Lang.Float = 0.0;         // abscisse curviligne (m)
    public var off as Lang.Float = 0.0;       // écart perpendiculaire (m)
    public var idx as Lang.Number = 0;        // segment courant
    public var started as Lang.Boolean = false;
    public var stale as Lang.Boolean = false; // position figée (GPS perdu / rejeté)
    private var rejects as Lang.Number = 0;
    private var lastT as Lang.Number = -1;
    private var lastPx as Lang.Float = 0.0;
    private var lastPy as Lang.Float = 0.0;
    private var havePrev as Lang.Boolean = false;

    function initialize(p as CoursePack) {
        pack = p;
        reset();
    }

    function reset() as Void {
        s = 0.0; off = 0.0; idx = 0;
        started = false; stale = false;
        rejects = 0; lastT = -1; havePrev = false;
    }

    /**
     * Met à jour l'abscisse depuis une position GPS.
     * AUCUNE ALLOCATION ici (§6.1) : tout est scalaire.
     * @param px,py position projetée en mètres (voir project())
     * @param tSec  horodatage (s)
     * @return true si la position a été retenue, false si rejetée (glitch)
     */
    function update(px as Lang.Float, py as Lang.Float, tSec as Lang.Number) as Lang.Boolean {
        if (!pack.loaded) { return false; }
        var xs = pack.xs;
        var ys = pack.ys;
        var cum = pack.cum;

        var lo = idx - WINDOW;
        var hi = idx + WINDOW;
        if (!started) { lo = 0; hi = pack.n - 1; }   // 1re acquisition : balayage complet
        if (lo < 0) { lo = 0; }
        if (hi > pack.n - 2) { hi = pack.n - 2; }

        // sens de déplacement (fiable seulement au-delà de MIN_MOVE)
        var mvx = 0.0;
        var mvy = 0.0;
        var haveDir = false;
        if (havePrev) {
            var ddx = px - lastPx;
            var ddy = py - lastPy;
            var mv = Math.sqrt(ddx * ddx + ddy * ddy);
            if (mv > MIN_MOVE) { mvx = ddx / mv; mvy = ddy / mv; haveDir = true; }
        }

        var dt = 1;
        if (lastT >= 0 && tSec > lastT) { dt = tSec - lastT; }
        var free = FREE_BAND;
        if (PLAUSIBLE_SPEED * dt > free) { free = PLAUSIBLE_SPEED * dt; }

        var bestCost = 1.0e30;
        var bestD2 = 1.0e30;
        var bestK = idx;
        var bestT = 0.0;

        for (var k = lo; k <= hi; k += 1) {
            var ax = xs[k];
            var ay = ys[k];
            var dx = xs[k + 1] - ax;
            var dy = ys[k + 1] - ay;
            var len2 = dx * dx + dy * dy;
            var t = 0.0;
            if (len2 > 0) { t = ((px - ax) * dx + (py - ay) * dy) / len2; }
            if (t < 0.0) { t = 0.0; } else if (t > 1.0) { t = 1.0; }
            var cx = ax + t * dx;
            var cy = ay + t * dy;
            var ex = px - cx;
            var ey = py - cy;
            var d2 = ex * ex + ey * ey;
            var cost = d2;

            if (started) {
                var sk = cum[k] + t * (cum[k + 1] - cum[k]);
                var diff = sk - s;
                if (diff < 0) { diff = -diff; }
                var excess = diff - free;
                if (excess > 0) {
                    var pen = excess / CONTINUITY_K;
                    if (pen > CONTINUITY_CAP) { pen = CONTINUITY_CAP; }  // ← plafond
                    cost += pen * pen;
                }
            }
            if (haveDir && len2 > 0) {
                var sl = Math.sqrt(len2);
                var dot = (dx * mvx + dy * mvy) / sl;   // -1 = à contresens
                cost += DIR_W * DIR_W * (1.0 - dot) / 2.0;
            }
            if (cost < bestCost) { bestCost = cost; bestD2 = d2; bestK = k; bestT = t; }
        }

        var ns = cum[bestK] + bestT * (cum[bestK + 1] - cum[bestK]);

        // garde-fou anti-saut, avec ré-acquisition si le décalage persiste :
        // un glitch isolé s'ignore, mais un vrai déplacement (redémarrage,
        // transport en véhicule) doit finir par être accepté.
        if (started && lastT >= 0 && tSec > lastT) {
            var move = ns - s;
            if (move < 0) { move = -move; }
            if (move / (tSec - lastT) > MAX_SPEED && rejects < MAX_REJECTS) {
                rejects += 1;
                stale = true;
                return false;
            }
        }
        rejects = 0;
        idx = bestK;
        s = ns;
        off = Math.sqrt(bestD2);
        started = true;
        stale = false;
        lastT = tSec;
        lastPx = px; lastPy = py; havePrev = true;
        return true;
    }

    /** GPS perdu : on avance à l'estime avec la distance de l'activité (§6.3). */
    function coast(deltaMeters as Lang.Float) as Void {
        stale = true;
        if (deltaMeters <= 0) { return; }
        s += deltaMeters;
        if (s > pack.total) { s = pack.total.toFloat(); }
        var cum = pack.cum;
        while (idx < pack.n - 2 && cum[idx + 1] < s) { idx += 1; }
    }

    function remaining() as Lang.Float {
        var r = pack.total - s;
        return (r > 0) ? r : 0.0;
    }
}
