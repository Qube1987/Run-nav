// Zone B — relief de la côte, coloré par la pente, avec position courante.
//
// Reprend la lecture du profil de run-nav sur téléphone : silhouette remplie,
// colorée segment par segment selon la pente, curseur à la position courante.
// L'échelle de couleurs est IDENTIQUE à celle de js/profile.js (gradeColor),
// pour qu'un coup d'œil à la montre et un coup d'œil au téléphone racontent
// exactement la même chose.
//
// Deux états (§5.2) :
//   EN MONTÉE   : côte entière + curseur + D+ restant et durée jusqu'au sommet
//   HORS CÔTE   : distance à la prochaine côte, ses caractéristiques, et son
//                 relief en aperçu
//
// Règles d'affichage (§5.3) : rien de critique dans les 12 % extérieurs, fort
// contraste, chiffres clés en gros.
//
// Compile avec le SDK 9.2.0 pour fenix847mm.

using Toybox.Lang;
using Toybox.Graphics;
using Toybox.System;
using Toybox.Time;
using Toybox.Time.Gregorian;

class ClimbRenderer {

    // Nombre de tranches du relief. Borné : le coût de dessin doit rester
    // constant quelle que soit la longueur de la côte (§6.2).
    const STEPS_MAX = 56;

    private var pack as CoursePack;

    function initialize(p as CoursePack) {
        pack = p;
    }

    /**
     * Couleur selon la pente (%), reprise à l'identique de run-nav
     * (js/profile.js, gradeColor) : bleu en descente, puis vert → rouge.
     */
    static function gradeColor(g as Lang.Float) as Lang.Number {
        if (g < -1.0) { return 0x4AA3FF; }      // descente : bleu
        var a = (g < 0) ? -g : g;
        if (a < 3.0)  { return 0x3FBF6F; }      // vert
        if (a < 6.0)  { return 0xC9D43F; }      // jaune-vert
        if (a < 9.0)  { return 0xF0A63A; }      // orange
        if (a < 12.0) { return 0xE8613C; }      // orange-rouge
        return 0xD23B3B;                        // rouge
    }

    function draw(dc as Graphics.Dc, top as Lang.Number, s as Lang.Number,
                  pace as PaceModel, stale as Lang.Boolean) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var zh = h - top;

        dc.setClip(0, top, w, h - top);

        // séparateur zone A / zone B
        var padTop = MapRenderer.chordInset(w, h, top, 2) + 6;
        dc.setColor(Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawLine(padTop, top, w - padTop, top);

        var ci = pack.climbAt(s);
        if (ci >= 0) {
            drawInClimb(dc, top, zh, s, ci, pace, stale);
        } else {
            drawNextClimb(dc, top, zh, s);
        }
        dc.clearClip();
    }

    // ------------------------------------------------------------- EN MONTÉE
    private function drawInClimb(dc as Graphics.Dc, top as Lang.Number, zh as Lang.Number,
                                 s as Lang.Number, ci as Lang.Number,
                                 pace as PaceModel, stale as Lang.Boolean) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();

        // --- bandeau 1 : identité de la côte, D+ total, avancement ---
        var yTitle = top + (zh * 4) / 100;
        var fh = Graphics.getFontHeight(Graphics.FONT_XTINY);
        var padT = MapRenderer.chordInset(w, h, yTitle, fh) + 6;
        var span = pack.climbE[ci] - pack.climbS[ci];
        var frac = 0.0;
        if (span > 0) { frac = (s - pack.climbS[ci]).toFloat() / span; }
        if (frac < 0.0) { frac = 0.0; } else if (frac > 1.0) { frac = 1.0; }

        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        var label = "COTE " + (ci + 1);
        var nm = pack.climbN[ci];
        if (nm != null && !nm.equals("")) { label = nm; }
        dc.drawText(padT, yTitle, Graphics.FONT_XTINY, label, Graphics.TEXT_JUSTIFY_LEFT);
        dc.drawText(w - padT, yTitle, Graphics.FONT_XTINY,
                    (frac * 100).format("%d") + "%", Graphics.TEXT_JUSTIFY_RIGHT);

        // --- le relief de TOUTE la côte, avec la position courante ---
        var yProf = top + (zh * 26) / 100;
        var hProf = (zh * 42) / 100;
        var padP = MapRenderer.chordInset(w, h, yProf, hProf) + 6;
        drawRelief(dc, padP, yProf, w - 2 * padP, hProf,
                   pack.climbS[ci], pack.climbE[ci], s);

        // --- bandeau 2 : ce qui reste à monter, et en combien de temps ---
        var yFig = top + (zh * 72) / 100;
        var fhN = Graphics.getFontHeight(Graphics.FONT_NUMBER_MEDIUM);
        var padF = MapRenderer.chordInset(w, h, yFig, fhN) + 6;
        var gainLeft = pack.gainRemaining(ci, s);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(padF, yFig, Graphics.FONT_NUMBER_MEDIUM,
                    gainLeft.format("%d") + "m", Graphics.TEXT_JUSTIFY_LEFT);

        // GPS perdu : la position est figée, les valeurs dérivées ne sont plus
        // fiables — on les grise plutôt que de les donner pour des certitudes.
        var eta = pace.etaSeconds(gainLeft.toFloat());
        dc.setColor(stale ? Graphics.COLOR_LT_GRAY : Graphics.COLOR_WHITE,
                    Graphics.COLOR_TRANSPARENT);
        dc.drawText(w - padF, yFig, Graphics.FONT_NUMBER_MEDIUM, fmtDuration(eta),
                    Graphics.TEXT_JUSTIFY_RIGHT);
    }

    // ------------------------------------------------------------ HORS CÔTE
    private function drawNextClimb(dc as Graphics.Dc, top as Lang.Number,
                                   zh as Lang.Number, s as Lang.Number) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var cx = w / 2;
        var ni = pack.nextClimb(s);

        var y = top + (zh * 6) / 100;
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        if (ni < 0) {
            dc.drawText(cx, top + zh / 2, Graphics.FONT_SMALL, "Plus de cote",
                        Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
            return;
        }

        // Une SEULE ligne centrée : en gauche/droite, les deux textes se
        // télescopaient au milieu (constaté au simulateur).
        var away = (pack.climbS[ni] - s) / 1000.0;
        var len = (pack.climbE[ni] - pack.climbS[ni]) / 1000.0;
        dc.drawText(cx, y, Graphics.FONT_XTINY,
                    "COTE DANS " + away.format("%.1f") + " km", Graphics.TEXT_JUSTIFY_CENTER);
        y += (zh * 22) / 100;
        dc.drawText(cx, y, Graphics.FONT_XTINY,
                    pack.climbG[ni] + "m  " + len.format("%.1f") + "km  "
                    + (pack.climbP[ni] / 10.0).format("%.1f") + "%",
                    Graphics.TEXT_JUSTIFY_CENTER);

        // aperçu du relief de la côte à venir (même code, sans curseur)
        var yProf = top + (zh * 52) / 100;
        var hProf = (zh * 34) / 100;
        var padP = MapRenderer.chordInset(w, h, yProf, hProf) + 6;
        drawRelief(dc, padP, yProf, w - 2 * padP, hProf,
                   pack.climbS[ni], pack.climbE[ni], -1);
    }

    /**
     * Relief entre deux abscisses : silhouette remplie, colorée par la pente,
     * échelle verticale automatique, plus un curseur à `curD` (< 0 = aucun).
     *
     * Dessiné en tranches verticales pleines plutôt qu'en polygone : c'est ce
     * qui permet de changer de couleur en continu le long de la pente, sans
     * allouer quoi que ce soit.
     */
    private function drawRelief(dc as Graphics.Dc, x as Lang.Number, y as Lang.Number,
                                w as Lang.Number, h as Lang.Number,
                                from as Lang.Number, to as Lang.Number,
                                curD as Lang.Number) as Void {
        if (to <= from || h < 6 || w < 8) { return; }
        var span = to - from;
        var steps = w / 6;
        if (steps > STEPS_MAX) { steps = STEPS_MAX; }
        if (steps < 4) { steps = 4; }

        // bornes d'altitude sur la portion, pour l'échelle verticale
        var lo = 1000000;
        var hi = -1000000;
        for (var i = 0; i <= steps; i += 1) {
            var e = pack.eleAt(from + (span * i) / steps);
            if (e < lo) { lo = e; }
            if (e > hi) { hi = e; }
        }
        var range = hi - lo;
        if (range < 10) { range = 10; }          // côte plate : évite l'aplat

        // ligne de base
        dc.setColor(Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawLine(x, y + h, x + w, y + h);

        var bw = (w / steps) + 1;
        for (var i = 0; i < steps; i += 1) {
            var d0 = from + (span * i) / steps;
            var d1 = from + (span * (i + 1)) / steps;
            var e0 = pack.eleAt(d0);
            var e1 = pack.eleAt(d1);
            var run = d1 - d0;
            var g = (run > 0) ? (((e1 - e0).toFloat() / run) * 100.0) : 0.0;

            var eMid = (e0 + e1) / 2;
            var bh = ((eMid - lo) * h) / range;
            if (bh < 2) { bh = 2; }
            if (bh > h) { bh = h; }

            dc.setColor(gradeColor(g), Graphics.COLOR_TRANSPARENT);
            dc.fillRectangle(x + (w * i) / steps, y + h - bh, bw, bh);
        }

        // --- position courante dans la côte ---
        if (curD >= from && curD <= to) {
            var xc = x + ((w * (curD - from)) / span);
            dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
            dc.setPenWidth(2);
            dc.drawLine(xc, y - 2, xc, y + h + 2);
            dc.setPenWidth(1);
            // repère triangulaire en tête, pour le retrouver d'un coup d'œil
            dc.fillPolygon([[xc - 5, y - 9], [xc + 5, y - 9], [xc, y - 2]]);
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
