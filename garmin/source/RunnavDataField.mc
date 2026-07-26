// Data field « carte + côte en cours ».
//
// Ce fichier est le SQUELETTE du jalon 1 : il câble CoursePack + Locator et
// garantit le mode dégradé (§6.4). Les renderers (zones A et B, jalons 4 et 5)
// ne sont pas encore écrits — onUpdate() se contente aujourd'hui d'un rendu
// minimal de contrôle.
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

        // Rendu de contrôle en attendant MapRenderer (zone A) et ClimbRenderer
        // (zone B) : distance restante + côte en cours.
        var remKm = locator.remaining() / 1000.0;
        dc.drawText(w / 2, h / 3, Graphics.FONT_NUMBER_MEDIUM, remKm.format("%.1f") + " km",
                    Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        var s = locator.s.toNumber();
        var ci = pack.climbAt(s);
        var line;
        if (ci >= 0) {
            var done = 0;
            var span = pack.climbE[ci] - pack.climbS[ci];
            if (span > 0) { done = ((s - pack.climbS[ci]) * 100) / span; }
            line = "COTE " + (ci + 1) + " - " + done.format("%d") + "%";
        } else {
            var ni = pack.nextClimb(s);
            if (ni >= 0) {
                line = "cote dans " + ((pack.climbS[ni] - s) / 1000.0).format("%.1f") + " km";
            } else {
                line = "plus de cote";
            }
        }
        dc.drawText(w / 2, (h * 2) / 3, Graphics.FONT_SMALL, line,
                    Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }
}
