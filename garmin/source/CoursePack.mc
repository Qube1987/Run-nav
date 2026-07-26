// Chargement et accès indexé au « course pack » produit par run-nav.
//
// Format et décisions : voir docs/coursepack-format.md (copie du contrat) et,
// côté producteur, run-nav/docs/coursepack.md.
//
// ⚠ NON COMPILÉ : écrit sans accès au SDK Connect IQ. À passer au compilateur
//   et au simulateur avant toute confiance. La LOGIQUE, elle, est validée :
//   voir tools/ (implémentation de référence rejouée sur trace réelle).

using Toybox.Application;
using Toybox.Math;

class CoursePack {
    // --- métadonnées ---
    public var name as Lang.String = "";
    public var total as Lang.Number = 0;        // distance totale VRAIE (m)
    public var ascent as Lang.Number = 0;       // D+ total (m)
    public var loaded as Lang.Boolean = false;

    // --- polyline projetée en mètres (plan local équirectangulaire) ---
    public var n as Lang.Number = 0;
    public var xs as Lang.Array<Lang.Float> or Null = null;
    public var ys as Lang.Array<Lang.Float> or Null = null;
    // Échelle de distances VRAIES le long de la polyline (clé `dd` du pack).
    // Indispensable : mesurer sur les cordes réintroduirait ~3 % d'erreur.
    public var cum as Lang.Array<Lang.Number> or Null = null;

    // --- profil, côtes, POI ---
    public var profD as Lang.Array<Lang.Number> or Null = null;
    public var profE as Lang.Array<Lang.Number> or Null = null;
    public var climbS as Lang.Array<Lang.Number> or Null = null;
    public var climbE as Lang.Array<Lang.Number> or Null = null;
    public var climbG as Lang.Array<Lang.Number> or Null = null;
    public var climbP as Lang.Array<Lang.Number> or Null = null;   // pente ‰
    public var climbN as Lang.Array<Lang.String> or Null = null;
    public var poiD as Lang.Array<Lang.Number> or Null = null;
    public var poiK as Lang.Array<Lang.String> or Null = null;
    public var poiN as Lang.Array<Lang.String> or Null = null;

    function initialize() {}

    // Charge depuis un dictionnaire déjà décodé (resources JSON ou Storage).
    // Renvoie false plutôt que de lever : le data field ne doit JAMAIS planter
    // (§6.4, mode dégradé).
    function load(d as Lang.Dictionary or Null) as Lang.Boolean {
        loaded = false;
        if (d == null) { return false; }
        var t = d["t"];
        var dd = d["dd"];
        var o = d["o"];
        if (t == null || dd == null || o == null) { return false; }
        if (!(t instanceof Lang.Array) || !(dd instanceof Lang.Array) || !(o instanceof Lang.Array)) { return false; }

        name = (d["n"] != null) ? d["n"] : "";
        total = (d["d"] != null) ? d["d"] : 0;
        ascent = (d["a"] != null) ? d["a"] : 0;

        n = dd.size() + 1;
        if (n < 2 || t.size() < (n - 1) * 2) { return false; }

        xs = new [n];
        ys = new [n];
        cum = new [n];

        // Projection plane locale : à cette latitude, 1 rad de longitude vaut
        // R·cos(lat). Suffisant sur l'emprise d'une épreuve, et bien moins cher
        // qu'une vraie géodésique à chaque appel de compute().
        var RAD = Math.PI / 180.0;
        var R = 6371000.0;
        var lat0 = (o[0] / 100000.0) * RAD;
        var cosLat = Math.cos(lat0);
        var la = o[0];
        var lo = o[1];
        xs[0] = ((lo / 100000.0) * RAD * cosLat * R).toFloat();
        ys[0] = ((la / 100000.0) * RAD * R).toFloat();
        cum[0] = 0;
        for (var k = 0; k < n - 1; k += 1) {
            la += t[2 * k];
            lo += t[2 * k + 1];
            xs[k + 1] = ((lo / 100000.0) * RAD * cosLat * R).toFloat();
            ys[k + 1] = ((la / 100000.0) * RAD * R).toFloat();
            cum[k + 1] = cum[k] + dd[k];
        }

        loadProfile(d["p"]);
        loadClimbs(d["c"]);
        loadPois(d["i"]);
        loaded = true;
        return true;
    }

    private function loadProfile(p) as Void {
        if (!(p instanceof Lang.Array)) { profD = null; profE = null; return; }
        var m = p.size();
        profD = new [m];
        profE = new [m];
        for (var i = 0; i < m; i += 1) {
            profD[i] = p[i][0];
            profE[i] = p[i][1];
        }
    }

    private function loadClimbs(c) as Void {
        if (!(c instanceof Lang.Array)) { return; }
        var m = c.size();
        climbS = new [m]; climbE = new [m]; climbG = new [m];
        climbP = new [m]; climbN = new [m];
        for (var i = 0; i < m; i += 1) {
            var e = c[i];
            climbS[i] = e["s"]; climbE[i] = e["e"];
            climbG[i] = (e["g"] != null) ? e["g"] : 0;
            climbP[i] = (e["pc"] != null) ? e["pc"] : 0;
            climbN[i] = (e["n"] != null) ? e["n"] : "";
        }
    }

    private function loadPois(v) as Void {
        if (!(v instanceof Lang.Array)) { return; }
        var m = v.size();
        poiD = new [m]; poiK = new [m]; poiN = new [m];
        for (var i = 0; i < m; i += 1) {
            var e = v[i];
            poiD[i] = e["d"];
            poiK[i] = (e["k"] != null) ? e["k"] : "poi";
            poiN[i] = (e["n"] != null) ? e["n"] : "";
        }
    }

    // --- accès ---

    /** Index de la côte contenant l'abscisse s, ou -1. */
    function climbAt(s as Lang.Number) as Lang.Number {
        if (climbS == null) { return -1; }
        for (var i = 0; i < climbS.size(); i += 1) {
            if (s >= climbS[i] && s <= climbE[i]) { return i; }
        }
        return -1;
    }

    /** Index de la prochaine côte devant s, ou -1. */
    function nextClimb(s as Lang.Number) as Lang.Number {
        if (climbS == null) { return -1; }
        for (var i = 0; i < climbS.size(); i += 1) {
            if (climbS[i] > s) { return i; }
        }
        return -1;
    }

    /** Index du prochain POI devant s, ou -1. */
    function nextPoi(s as Lang.Number) as Lang.Number {
        if (poiD == null) { return -1; }
        for (var i = 0; i < poiD.size(); i += 1) {
            if (poiD[i] > s) { return i; }
        }
        return -1;
    }

    /** Altitude interpolée du profil à l'abscisse s (m), 0 si indisponible. */
    function eleAt(s as Lang.Number) as Lang.Number {
        if (profD == null || profD.size() < 2) { return 0; }
        var m = profD.size();
        if (s <= profD[0]) { return profE[0]; }
        if (s >= profD[m - 1]) { return profE[m - 1]; }
        var lo = 0;
        var hi = m - 1;
        while (hi - lo > 1) {
            var mid = (lo + hi) / 2;
            if (profD[mid] <= s) { lo = mid; } else { hi = mid; }
        }
        var span = profD[hi] - profD[lo];
        if (span <= 0) { return profE[lo]; }
        return profE[lo] + ((profE[hi] - profE[lo]) * (s - profD[lo])) / span;
    }

    /** D+ restant jusqu'au sommet de la côte i. */
    function gainRemaining(i as Lang.Number, s as Lang.Number) as Lang.Number {
        if (climbS == null || i < 0 || i >= climbS.size()) { return 0; }
        var top = eleAt(climbE[i]);
        var here = eleAt(s);
        var r = top - here;
        return (r > 0) ? r : 0;
    }
}
