// Zone B (66 % → 100 %) — position dans la côte en cours.
//
// Deux états (§5.2) :
//   EN MONTÉE   : côte + D+ total / barre d'avancement / D+ restant + durée /
//                 pente instantanée + heure d'arrivée au sommet
//   HORS CÔTE   : distance à la prochaine côte, ses caractéristiques,
//                 et un micro-profil de la portion à venir
//
// Règles d'affichage (§5.3) : rien de critique dans les 12 % extérieurs, fort
// contraste (pas de gris moyen sur noir), chiffres clés en FONT_NUMBER_MEDIUM.
//
// ⚠ NON COMPILÉ : écrit sans accès au SDK Connect IQ.

using Toybox.Lang;
using Toybox.Graphics;
using Toybox.System;
using Toybox.Time;
using Toybox.Time.Gregorian;

class ClimbRenderer {

    private var pack as CoursePack;

    function initialize(p as CoursePack) {
        pack = p;
    }

    /**
     * @param dc     contexte de dessin
     * @param top    ordonnée du haut de la zone B
     * @param s      abscisse curviligne (m)
     * @param pace   modèle VAM pour les estimations
     * @param stale  position figée (GPS perdu) → on grise les valeurs dérivées
     */
    function draw(dc as Graphics.Dc, top as Lang.Number, s as Lang.Number,
                  pace as PaceModel, stale as Lang.Boolean) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var zh = h - top;
        // marge latérale : 12 % de la largeur, écran rond oblige (§5.3)
        var pad = (w * 12) / 100;
        var inner = w - 2 * pad;

        // séparateur zone A / zone B
        dc.setColor(Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawLine(pad, top, w - pad, top);

        var ci = pack.climbAt(s);
        if (ci >= 0) {
            drawInClimb(dc, top, zh, pad, inner, s, ci, pace, stale);
        } else {
            drawNextClimb(dc, top, zh, pad, inner, s);
        }
    }

    // ------------------------------------------------------------- EN MONTÉE
    private function drawInClimb(dc as Graphics.Dc, top as Lang.Number, zh as Lang.Number,
                                 pad as Lang.Number, inner as Lang.Number, s as Lang.Number,
                                 ci as Lang.Number, pace as PaceModel, stale as Lang.Boolean) as Void {
        var w = dc.getWidth();
        var cx = w / 2;
        var y = top + zh / 8;

        // --- ligne 1 : identité de la côte + D+ total ---
        var label = "COTE " + (ci + 1);
        var nm = pack.climbN[ci];
        if (nm != null && !nm.equals("")) { label = label + " - " + nm; }
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(pad, y, Graphics.FONT_XTINY, label, Graphics.TEXT_JUSTIFY_LEFT);
        dc.drawText(w - pad, y, Graphics.FONT_XTINY, pack.climbG[ci] + "m",
                    Graphics.TEXT_JUSTIFY_RIGHT);

        // --- ligne 2 : barre d'avancement ---
        y += zh / 5;
        var span = pack.climbE[ci] - pack.climbS[ci];
        var frac = 0.0;
        if (span > 0) { frac = (s - pack.climbS[ci]).toFloat() / span; }
        if (frac < 0.0) { frac = 0.0; } else if (frac > 1.0) { frac = 1.0; }
        var barH = zh / 9;
        if (barH < 6) { barH = 6; }
        dc.setColor(Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.fillRectangle(pad, y, inner, barH);
        dc.setColor(Graphics.COLOR_ORANGE, Graphics.COLOR_TRANSPARENT);
        dc.fillRectangle(pad, y, (inner * frac).toNumber(), barH);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, y + barH + 1, Graphics.FONT_XTINY,
                    (frac * 100).format("%d") + " %", Graphics.TEXT_JUSTIFY_CENTER);

        // --- ligne 3 : D+ restant + durée estimée jusqu'au sommet ---
        y += zh / 3;
        var gainLeft = pack.gainRemaining(ci, s);
        dc.drawText(pad, y, Graphics.FONT_NUMBER_MEDIUM, "^" + gainLeft.format("%d"),
                    Graphics.TEXT_JUSTIFY_LEFT);

        var eta = pace.etaSeconds(gainLeft.toFloat());
        // GPS perdu : la position est figée, les valeurs dérivées ne sont plus
        // fiables — on les grise plutôt que de les afficher comme des certitudes.
        dc.setColor(stale ? Graphics.COLOR_LT_GRAY : Graphics.COLOR_WHITE,
                    Graphics.COLOR_TRANSPARENT);
        dc.drawText(dc.getWidth() - pad, y, Graphics.FONT_NUMBER_MEDIUM, fmtDuration(eta),
                    Graphics.TEXT_JUSTIFY_RIGHT);

        // --- ligne 4 : pente instantanée + heure d'arrivée au sommet ---
        y += zh / 4;
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(pad, y, Graphics.FONT_XTINY,
                    pack.gradeAt(s).format("%.0f") + " %", Graphics.TEXT_JUSTIFY_LEFT);
        dc.setColor(stale ? Graphics.COLOR_LT_GRAY : Graphics.COLOR_WHITE,
                    Graphics.COLOR_TRANSPARENT);
        dc.drawText(dc.getWidth() - pad, y, Graphics.FONT_XTINY, clockIn(eta),
                    Graphics.TEXT_JUSTIFY_RIGHT);
    }

    // ------------------------------------------------------------ HORS CÔTE
    private function drawNextClimb(dc as Graphics.Dc, top as Lang.Number, zh as Lang.Number,
                                   pad as Lang.Number, inner as Lang.Number, s as Lang.Number) as Void {
        var w = dc.getWidth();
        var cx = w / 2;
        var y = top + zh / 8;
        var ni = pack.nextClimb(s);

        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        if (ni < 0) {
            dc.drawText(cx, top + zh / 2, Graphics.FONT_SMALL, "Plus de cote",
                        Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
            return;
        }

        var away = (pack.climbS[ni] - s) / 1000.0;
        dc.drawText(pad, y, Graphics.FONT_XTINY, "PROCHAINE COTE", Graphics.TEXT_JUSTIFY_LEFT);
        dc.drawText(w - pad, y, Graphics.FONT_XTINY, "dans " + away.format("%.1f") + " km",
                    Graphics.TEXT_JUSTIFY_RIGHT);

        y += zh / 4;
        var len = (pack.climbE[ni] - pack.climbS[ni]) / 1000.0;
        var desc = pack.climbG[ni] + "m / " + len.format("%.1f") + "km / "
                 + (pack.climbP[ni] / 10.0).format("%.1f") + "%";
        dc.drawText(cx, y, Graphics.FONT_XTINY, desc, Graphics.TEXT_JUSTIFY_CENTER);

        // --- micro-profil de la portion à venir (jusqu'au sommet suivant) ---
        y += zh / 4;
        drawMicroProfile(dc, pad, y, inner, zh / 3, s, pack.climbE[ni]);
    }

    /** Silhouette du profil entre deux abscisses, échelle verticale auto. */
    private function drawMicroProfile(dc as Graphics.Dc, x as Lang.Number, y as Lang.Number,
                                      w as Lang.Number, h as Lang.Number,
                                      from as Lang.Number, to as Lang.Number) as Void {
        if (to <= from || h < 4) { return; }
        var span = to - from;
        var lo = 100000;
        var hi = -100000;
        var STEPS = 24;                        // borné : coût de dessin constant
        for (var i = 0; i <= STEPS; i += 1) {
            var e = pack.eleAt(from + (span * i) / STEPS);
            if (e < lo) { lo = e; }
            if (e > hi) { hi = e; }
        }
        var range = hi - lo;
        if (range < 1) { range = 1; }
        dc.setColor(Graphics.COLOR_ORANGE, Graphics.COLOR_TRANSPARENT);
        var px = x;
        var py = y + h - ((pack.eleAt(from) - lo) * h) / range;
        for (var i = 1; i <= STEPS; i += 1) {
            var nx = x + (w * i) / STEPS;
            var ny = y + h - ((pack.eleAt(from + (span * i) / STEPS) - lo) * h) / range;
            dc.drawLine(px, py, nx, ny);
            px = nx;
            py = ny;
        }
    }

    // ------------------------------------------------------------- formatage
    /** Durée compacte : « 1h12 » au-delà de l'heure, « 47min » sinon. */
    static function fmtDuration(sec as Lang.Number) as Lang.String {
        if (sec <= 0) { return "--"; }
        var m = sec / 60;
        if (m >= 60) {
            var hh = m / 60;
            var mm = m % 60;
            return hh + "h" + mm.format("%02d");
        }
        return m + "min";
    }

    /** Heure du jour dans `sec` secondes, format 24 h. */
    static function clockIn(sec as Lang.Number) as Lang.String {
        var when = Time.now().add(new Time.Duration(sec));
        var g = Gregorian.info(when, Time.FORMAT_SHORT);
        return g.hour.format("%02d") + ":" + g.min.format("%02d");
    }
}
