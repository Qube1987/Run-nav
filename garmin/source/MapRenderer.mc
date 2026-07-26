// Zone A (0 → 66 %) — carte vectorielle du parcours.
//
// Ce n'est PAS le fond de carte Garmin : MapView / MapTrackView sont interdits
// dans un data field (§2.2). On dessine la polyline du course pack dans le Dc.
// Pas de routes, pas de relief, pas de toponymes — « où suis-je sur ma trace,
// où ça tourne, qu'est-ce qui arrive ».
//
// Auto-zoom validé sur RT 2026 (tools/zoom-test.mjs) :
//   - lookahead indexé sur la VITESSE (~4 min devant). Un lookahead figé
//     dégénère : à 600 m le zoom reste bloqué à 92 % sur un seul palier.
//     Indexé sur la vitesse, le même code sert l'ultra-trail (paliers 200-800 m)
//     et le bikepacking (paliers 800-3000 m).
//   - hystérésis par temps de séjour : divise le pompage par 15
//     (785 → 52 changements sur 108 km, soit un tous les ~2 km).
//
// ⚠ NON COMPILÉ : écrit sans accès au SDK Connect IQ.

using Toybox.Graphics;
using Toybox.Math;
using Toybox.System;
using Toybox.Time;
using Toybox.Time.Gregorian;

class MapRenderer {

    public static const PALIERS = [200, 400, 800, 1500, 3000];  // demi-fenêtre (m)
    public static const HORIZON_SEC = 240;
    public static const LOOKAHEAD_MIN = 250;
    public static const LOOKAHEAD_MAX = 2500;
    public static const FILL = 0.80;
    public static const DWELL = 5;          // ticks de confirmation (hystérésis)

    private var pack as CoursePack;
    private var level as Lang.Number = 2;   // palier courant
    private var want as Lang.Number = 2;
    private var dwell as Lang.Number = 0;

    public var northUp as Lang.Boolean = false;
    public var fixedLevel as Lang.Number = -1;   // >= 0 → zoom manuel (réglage)
    public var showPoi as Lang.Boolean = true;
    public var offThreshold as Lang.Number = 60;

    function initialize(p as CoursePack) {
        pack = p;
    }

    // ------------------------------------------------------------ auto-zoom
    private function lookaheadFor(speed as Lang.Float) as Lang.Float {
        var la = speed * HORIZON_SEC;
        if (la < LOOKAHEAD_MIN) { la = LOOKAHEAD_MIN.toFloat(); }
        if (la > LOOKAHEAD_MAX) { la = LOOKAHEAD_MAX.toFloat(); }
        return la;
    }

    /** Étalement géométrique de la trace sur le lookahead (m). */
    private function spreadAhead(px as Lang.Float, py as Lang.Float,
                                 idx as Lang.Number, s as Lang.Float,
                                 lookahead as Lang.Float) as Lang.Float {
        var xs = pack.xs;
        var ys = pack.ys;
        var cum = pack.cum;
        var max = 0.0;
        for (var k = idx; k < pack.n - 1 && cum[k] - s < lookahead; k += 1) {
            var dx = xs[k] - px;
            var dy = ys[k] - py;
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d > max) { max = d; }
        }
        return max;
    }

    /** Palier retenu, avec hystérésis : un changement doit se confirmer DWELL
        ticks de suite, sinon le zoom pompe à chaque seconde (mesuré). */
    private function pickLevel(spread as Lang.Float) as Lang.Number {
        if (fixedLevel >= 0) { return fixedLevel; }
        var w = PALIERS.size() - 1;
        for (var i = 0; i < PALIERS.size(); i += 1) {
            if (spread <= PALIERS[i] * FILL) { w = i; break; }
        }
        if (w == level) { dwell = 0; want = w; return level; }
        if (w != want) { want = w; dwell = 1; return level; }
        dwell += 1;
        if (dwell >= DWELL) { level = w; dwell = 0; }
        return level;
    }

    // --------------------------------------------------------------- rendu
    /**
     * @param bottom ordonnée du bas de la zone A
     * @param loc    Locator (position, abscisse, écart perpendiculaire)
     * @param heading cap en radians (Activity.Info.currentHeading), ou null
     * @param speed  vitesse instantanée (m/s), pour le lookahead
     */
    function draw(dc as Graphics.Dc, bottom as Lang.Number, loc as Locator,
                  heading as Lang.Float or Null, speed as Lang.Float) as Void {
        var w = dc.getWidth();
        var cx = w / 2;
        var cy = bottom / 2;

        var xs = pack.xs;
        var ys = pack.ys;
        var cum = pack.cum;
        var idx = loc.idx;

        // position projetée (interpolée sur le segment courant)
        var sp = cum[idx + 1] - cum[idx];
        var t = (sp > 0) ? (loc.s - cum[idx]) / sp : 0.0;
        var px = xs[idx] + t * (xs[idx + 1] - xs[idx]);
        var py = ys[idx] + t * (ys[idx + 1] - ys[idx]);

        var half = PALIERS[pickLevel(spreadAhead(px, py, idx, loc.s, lookaheadFor(speed)))];
        var scale = (cy.toFloat() * 0.85) / half;   // px par mètre

        // rotation : track-up par défaut (la trace tourne, le triangle reste en
        // haut), north-up en réglage.
        var rot = 0.0;
        if (!northUp && heading != null) { rot = -heading; }
        var cosR = Math.cos(rot);
        var sinR = Math.sin(rot);

        // --- trace : parcourue en gris foncé, restante en couleur vive (§5.1) ---
        // Culling : on ne parcourt que les sommets dont l'abscisse tombe dans la
        // fenêtre visible, borné par le rayon affichable.
        var reach = half * 1.6;
        var kFrom = idx;
        while (kFrom > 0 && loc.s - cum[kFrom] < reach) { kFrom -= 1; }
        var kTo = idx;
        while (kTo < pack.n - 1 && cum[kTo] - loc.s < reach) { kTo += 1; }

        var prevX = 0;
        var prevY = 0;
        var havePrev = false;
        for (var k = kFrom; k <= kTo; k += 1) {
            var dx = xs[k] - px;
            var dy = ys[k] - py;
            // écran : y vers le bas, d'où le signe sur la composante verticale
            var sx = cx + ((dx * cosR - dy * sinR) * scale).toNumber();
            var sy = cy - ((dx * sinR + dy * cosR) * scale).toNumber();
            if (havePrev) {
                if (cum[k] < loc.s) {
                    dc.setColor(Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
                    dc.setPenWidth(2);
                } else {
                    dc.setColor(Graphics.COLOR_ORANGE, Graphics.COLOR_TRANSPARENT);
                    dc.setPenWidth(3);
                }
                dc.drawLine(prevX, prevY, sx, sy);
            }
            prevX = sx;
            prevY = sy;
            havePrev = true;
        }
        dc.setPenWidth(1);

        // --- POI dans la fenêtre ---
        if (showPoi && pack.poiD != null) {
            dc.setColor(Graphics.COLOR_BLUE, Graphics.COLOR_TRANSPARENT);
            for (var i = 0; i < pack.poiD.size(); i += 1) {
                var pd = pack.poiD[i];
                if (pd < loc.s - reach || pd > loc.s + reach) { continue; }
                var pk = poiIndex(pd);
                if (pk < 0) { continue; }
                var ddx = xs[pk] - px;
                var ddy = ys[pk] - py;
                var qx = cx + ((ddx * cosR - ddy * sinR) * scale).toNumber();
                var qy = cy - ((ddx * sinR + ddy * cosR) * scale).toNumber();
                dc.fillCircle(qx, qy, 4);
            }
        }

        // --- hors-trace : bordure rouge + segment de rattachement (§5.1) ---
        if (loc.off > offThreshold) {
            dc.setColor(Graphics.COLOR_RED, Graphics.COLOR_TRANSPARENT);
            dc.setPenWidth(3);
            dc.drawRectangle(2, 2, w - 4, bottom - 4);
            dc.setPenWidth(1);
        }

        // --- position : triangle orienté, toujours au centre de la zone A ---
        drawArrow(dc, cx, cy, loc.stale);

        // --- overlays : distance restante (HG) et heure (HD) ---
        drawOverlays(dc, w, loc);
    }

    /** Sommet le plus proche d'une abscisse (POI : précision au sommet suffit). */
    private function poiIndex(d as Lang.Number) as Lang.Number {
        var cum = pack.cum;
        var lo = 0;
        var hi = pack.n - 1;
        if (d <= cum[0] || d >= cum[hi]) { return (d <= cum[0]) ? 0 : hi; }
        while (hi - lo > 1) {
            var mid = (lo + hi) / 2;
            if (cum[mid] <= d) { lo = mid; } else { hi = mid; }
        }
        return lo;
    }

    /** Triangle de position. Grisé quand la position est figée (GPS perdu). */
    private function drawArrow(dc as Graphics.Dc, cx as Lang.Number, cy as Lang.Number,
                               stale as Lang.Boolean) as Void {
        dc.setColor(stale ? Graphics.COLOR_LT_GRAY : Graphics.COLOR_WHITE,
                    Graphics.COLOR_TRANSPARENT);
        var pts = [[cx, cy - 9], [cx - 6, cy + 7], [cx, cy + 3], [cx + 6, cy + 7]];
        dc.fillPolygon(pts);
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_TRANSPARENT);
        dc.drawLine(cx, cy - 9, cx, cy + 3);
    }

    /**
     * Distance restante et heure du jour, DANS la zone A (§5.1), sur pastille
     * sombre pour rester lisibles par-dessus la trace.
     *
     * La distance vient de l'abscisse (`d` − `s`), surtout PAS de
     * Activity.Info.distanceToDestination, qui n'est renseigné que si un course
     * Garmin est chargé en parallèle — ce qu'on ne peut pas supposer.
     */
    private function drawOverlays(dc as Graphics.Dc, w as Lang.Number, loc as Locator) as Void {
        var remKm = loc.remaining() / 1000.0;
        var txt = (remKm < 100) ? remKm.format("%.1f") : remKm.format("%.0f");
        txt = txt + " km";
        var clock = System.getClockTime();
        var hhmm = clock.hour.format("%02d") + ":" + clock.min.format("%02d");
        var pad = (w * 12) / 100;
        var y = (dc.getHeight() * 4) / 100;      // écran rond : on descend un peu
        var font = Graphics.FONT_TINY;

        // Pastilles MESURÉES sur le texte réel. Des tailles en dur ne survivent
        // pas au changement de police ou de device (454x454 ici, mais la
        // largeur d'un « 108.3 km » dépend aussi de la locale).
        var fh = Graphics.getFontHeight(font);
        var wL = dc.getTextWidthInPixels(txt, font);
        var wR = dc.getTextWidthInPixels(hhmm, font);
        var m = 4;

        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_TRANSPARENT);
        dc.fillRectangle(pad - m, y - m / 2, wL + 2 * m, fh + m);
        dc.fillRectangle(w - pad - wR - m, y - m / 2, wR + 2 * m, fh + m);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(pad, y, font, txt, Graphics.TEXT_JUSTIFY_LEFT);
        dc.drawText(w - pad, y, font, hhmm, Graphics.TEXT_JUSTIFY_RIGHT);
    }
}
