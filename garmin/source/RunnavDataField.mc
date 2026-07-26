// Data field « carte + côte en cours ».
//
// Câble l'ensemble : CoursePack (données) → Locator (abscisse) → PaceModel
// (estimations) → MapRenderer (zone A, 2/3 haut) + ClimbRenderer (zone B, 1/3 bas).
// Garantit le mode dégradé (§6.4) : jamais d'écran vide, jamais de crash.
//
// ⚠ NON COMPILÉ : écrit sans accès au SDK Connect IQ.

using Toybox.WatchUi;
using Toybox.Graphics;
using Toybox.Application;
using Toybox.Activity;
using Toybox.Math;

class RunnavDataField extends WatchUi.DataField {

    private var pack as CoursePack;
    private var locator as Locator or Null = null;
    private var climbView as ClimbRenderer or Null = null;
    private var mapView as MapRenderer or Null = null;
    private var pace as PaceModel or Null = null;
    private var heading as Lang.Float or Null = null;
    private var speed as Lang.Float = 1.5;

    // projection plane (reprise du pack pour convertir lat/lon → mètres)
    private var cosLat as Lang.Float = 1.0;
    private const RAD = Math.PI / 180.0;
    private const R = 6371000.0;

    private var lastDistance as Lang.Float = 0.0;   // elapsedDistance du tick précédent
    private var haveFix as Lang.Boolean = false;

    function initialize() {
        DataField.initialize();
        pack = new CoursePack();
        // Mode A (statique) : le pack est compilé dans les ressources.
        // Le chargement ne doit jamais faire échouer le démarrage (§6.4).
        try {
            var raw = Application.loadResource(Rez.JsonData.CoursePackData);
            if (pack.load(raw)) {
                locator = new Locator(pack);
                cosLat = Math.cos((raw["o"][0] / 100000.0) * RAD).toFloat();
                climbView = new ClimbRenderer(pack);
                mapView = new MapRenderer(pack);
                pace = new PaceModel(getSetting("initialVAM", 450));
                mapView.northUp = getSetting("orientation", 0) == 1;
                mapView.showPoi = getSetting("showPOI", true);
                mapView.offThreshold = getSetting("offCourseThreshold", 60);
            }
        } catch (e) {
            // pack absent ou illisible → mode dégradé, surtout pas de crash
            locator = null;
        }
    }

    // --- boucle de calcul (1×/s) : aucune allocation ici (§6.1) ---
    function compute(info as Activity.Info) as Void {
        if (locator == null) { return; }

        var dist = 0.0;
        if (info has :elapsedDistance && info.elapsedDistance != null) {
            dist = info.elapsedDistance;
        }

        var loc = null;
        if (info has :currentLocation && info.currentLocation != null) {
            loc = info.currentLocation.toDegrees();
        }

        var t = 0;
        if (info has :timerTime && info.timerTime != null) { t = info.timerTime / 1000; }

        if (info has :currentHeading && info.currentHeading != null) {
            heading = info.currentHeading;
        } else if (info has :track && info.track != null) {
            heading = info.track;               // repli (§5.1)
        }
        if (info has :currentSpeed && info.currentSpeed != null) { speed = info.currentSpeed; }

        if (loc != null) {
            var px = (loc[1] * RAD * cosLat * R).toFloat();
            var py = (loc[0] * RAD * R).toFloat();
            locator.update(px, py, t);
            haveFix = true;
        } else if (haveFix) {
            // GPS perdu : on continue d'avancer à l'estime avec la distance
            // de l'activité, la position se fige côté affichage (§6.3).
            locator.coast(dist - lastDistance);
        }
        lastDistance = dist;

        // modèle VAM : alimenté par l'altitude du PROFIL à notre abscisse plutôt
        // que par l'altimètre brut — déjà lissé, et cohérent avec le D+ restant
        // affiché juste à côté.
        if (pace != null) {
            var sN = locator.s.toNumber();
            pace.update(t, pack.eleAt(sN).toFloat(), pack.gradeAt(sN), speed);
        }
    }

    // --- rendu ---
    function onUpdate(dc as Graphics.Dc) as Void {
        dc.setColor(Graphics.COLOR_TRANSPARENT, Graphics.COLOR_BLACK);
        dc.clear();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);

        var w = dc.getWidth();
        var h = dc.getHeight();

        if (locator == null) {
            // §6.4 — mode dégradé : jamais d'écran vide.
            dc.drawText(w / 2, h / 2, Graphics.FONT_SMALL, "Pas de parcours",
                        Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
            return;
        }

        // 2/3 haut : carte vectorielle · 1/3 bas : côte en cours (§5)
        var split = (h * 2) / 3;
        mapView.draw(dc, split, locator, heading, speed);
        climbView.draw(dc, split, locator.s.toNumber(), pace, locator.stale);
    }

    /** Lecture d'un réglage avec repli (§7) : jamais de crash si absent. */
    private function getSetting(key as Lang.String, dflt) {
        try {
            var v = Application.Properties.getValue(key);
            if (v != null) { return v; }
        } catch (e) {
            // propriété absente (réglages non publiés, firmware ancien)
        }
        return dflt;
    }
}
