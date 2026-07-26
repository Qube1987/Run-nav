// Point d'entrée de l'application.
//
// Connect IQ n'instancie JAMAIS un data field directement : le point d'entrée
// declaré dans manifest.xml doit être une Application.AppBase, qui retourne le
// data field via getInitialView(). Pointer `entry` sur la DataField elle-même
// compile sans broncher, puis échoue au démarrage avec
// « Unexpected Type Error / Failed to start CIQ Application ».

using Toybox.Lang;
using Toybox.Application;
using Toybox.WatchUi;

class RunnavApp extends Application.AppBase {

    function initialize() {
        AppBase.initialize();
    }

    // Volontairement non typée : la signature exacte de getInitialView varie
    // selon les niveaux d'API, et un typage trop strict casse la compilation
    // sans rien apporter ici.
    function getInitialView() {
        return [ new RunnavDataField() ];
    }

    /** Les réglages (§7) ont changé : on redemande un rendu. */
    function onSettingsChanged() as Void {
        WatchUi.requestUpdate();
    }
}
