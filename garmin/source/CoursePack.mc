// Chargement et accès indexé au « course pack » produit par run-nav.
//
// Format et décisions : voir docs/coursepack-format.md (copie du contrat) et,
// côté producteur, run-nav/docs/coursepack.md.
//
// MÉMOIRE — budget data field du fenix847mm : 131 072 octets (128 Ko).
// Le régime établi est modeste : pour RT 2026 (1 170 sommets), xs/ys en Float et
// cum en Number pèsent ~14 Ko. Le point sensible est le PIC AU CHARGEMENT, où le
// dictionnaire JSON décodé coexiste avec les tableaux typés — un dictionnaire
// Monkey C coûte bien plus que les 18,4 Ko du texte source. D'où : on recopie
// tout dans des tableaux typés, puis l'appelant relâche le dictionnaire
// immédiatement (voir RunnavDataField.initialize).
// Si le pic dépasse malgré tout, baisser trackMaxPoints dans l'exporteur : la
// clé "dd" garantit que les DISTANCES restent exactes, seul le tracé se dégrade.
//
// Compile avec le SDK 9.2.0 pour fenix847mm. Comportement à l'exécution
// encore à valider au simulateur. La LOGIQUE est validée à part : voir tools/
// (implémentation de référence rejouée sur trace réelle).

using Toybox.Lang;
using Toybox.Application;
using Toybox.Math;

class CoursePack {
    // --- métadonnées ---
    public var name as Lang.String = "";
    public var total as Lang.Number = 0;        // distance totale VRAIE (m)
    public var ascent as Lang.Number = 0;       // D+ total (m)
    public var loaded as Lang.Boolean = false;
    // Facteur de projection conservé ici pour que l'appelant puisse RELÂCHER le
    // dictionnaire JSON dès la fin de load() (cf. note mémoire ci-dessus).
    public var cosLat as Lang.Float = 1.0;

    // --- polyline projetée en mètres (plan local équirectangulaire) ---
    public var n as Lang.Number = 0;
    public var xs as Lang.Array<Lang.Float> = new [0] as Lang.Array<Lang.Float>;
    public var ys as Lang.Array<Lang.Float> = new [0] as Lang.Array<Lang.Float>;
    // Échelle de distances VRAIES le long de la polyline (clé `dd` du pack).
    // Indispensable : mesurer sur les cordes réintroduirait ~3 % d'erreur.
    public var cum as Lang.Array<Lang.Number> = new [0] as Lang.Array<Lang.Number>;

    // --- profil, côtes, POI ---
    public var profD as Lang.Array<Lang.Number> = new [0] as Lang.Array<Lang.Number>;
    public var profE as Lang.Array<Lang.Number> = new [0] as Lang.Array<Lang.Number>;
    public var climbS as Lang.Array<Lang.Number> = new [0] as Lang.Array<Lang.Number>;
    public var climbE as Lang.Array<Lang.Number> = new [0] as Lang.Array<Lang.Number>;
    public var climbG as Lang.Array<Lang.Number> = new [0] as Lang.Array<Lang.Number>;
    public var climbP as Lang.Array<Lang.Number> = new [0] as Lang.Array<Lang.Number>;   // pente ‰
    public var climbN as Lang.Array<Lang.String> = new [0] as Lang.Array<Lang.String>;
    public var poiD as Lang.Array<Lang.Number> = new [0] as Lang.Array<Lang.Number>;
    public var poiK as Lang.Array<Lang.String> = new [0] as Lang.Array<Lang.String>;
    public var poiN as Lang.Array<Lang.String> = new [0] as Lang.Array<Lang.String>;
    // barrière horaire en minutes depuis le départ, -1 si le POI n'en a pas
    public var poiCut as Lang.Array<Lang.Number> = new [0] as Lang.Array<Lang.Number>;

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

        xs = new [n] as Lang.Array<Lang.Float>;
        ys = new [n] as Lang.Array<Lang.Float>;
        cum = new [n] as Lang.Array<Lang.Number>;

        // Projection plane locale : à cette latitude, 1 rad de longitude vaut
        // R·cos(lat). Suffisant sur l'emprise d'une épreuve, et bien moins cher
        // qu'une vraie géodésique à chaque appel de compute().
        var RAD = Math.PI / 180.0;
        var R = 6371000.0;
        var lat0 = (o[0] / 100000.0) * RAD;
        cosLat = Math.cos(lat0).toFloat();
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

        // Pack v2 : profil, côtes et POI sont des TABLEAUX PLATS parallèles.
        // On les référence directement au lieu de les recopier : cela évite de
        // dupliquer chaque valeur, et `raw = null` chez l'appelant libère
        // ensuite le dictionnaire et les tableaux non retenus (t, dd).
        profD  = flatNum(d["pd"]);
        profE  = flatNum(d["pe"]);
        climbS = flatNum(d["cs"]);
        climbE = flatNum(d["ce"]);
        climbG = flatNum(d["cg"]);
        climbP = flatNum(d["cp"]);
        climbN = flatStr(d["cn"]);
        poiD   = flatNum(d["od"]);
        poiK   = flatStr(d["ok"]);
        poiN   = flatStr(d["on"]);
        poiCut = flatNum(d["oc"]);
        loaded = true;
        return true;
    }

    /** Tableau plat d'entiers issu du JSON, ou tableau vide si absent/invalide. */
    private function flatNum(raw) as Lang.Array<Lang.Number> {
        if (!(raw instanceof Lang.Array)) { return new [0] as Lang.Array<Lang.Number>; }
        return raw as Lang.Array<Lang.Number>;
    }
    /** Idem pour les chaînes. */
    private function flatStr(raw) as Lang.Array<Lang.String> {
        if (!(raw instanceof Lang.Array)) { return new [0] as Lang.Array<Lang.String>; }
        return raw as Lang.Array<Lang.String>;
    }

    // --- accès ---

    /** Index de la côte contenant l'abscisse s, ou -1. */
    function climbAt(s as Lang.Number) as Lang.Number {
        if (climbS.size() == 0) { return -1; }
        for (var i = 0; i < climbS.size(); i += 1) {
            if (s >= climbS[i] && s <= climbE[i]) { return i; }
        }
        return -1;
    }

    /** Index de la prochaine côte devant s, ou -1. */
    function nextClimb(s as Lang.Number) as Lang.Number {
        if (climbS.size() == 0) { return -1; }
        for (var i = 0; i < climbS.size(); i += 1) {
            if (climbS[i] > s) { return i; }
        }
        return -1;
    }

    /** Index du prochain POI devant s, ou -1. */
    function nextPoi(s as Lang.Number) as Lang.Number {
        if (poiD.size() == 0) { return -1; }
        for (var i = 0; i < poiD.size(); i += 1) {
            if (poiD[i] > s) { return i; }
        }
        return -1;
    }

    /** Altitude interpolée du profil à l'abscisse s (m), 0 si indisponible. */
    function eleAt(s as Lang.Number) as Lang.Number {
        if (profD.size() < 2) { return 0; }
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

    /** Pente instantanée (%) lissée sur ±100 m — évite le clignotement (§5.2). */
    function gradeAt(s as Lang.Number) as Lang.Float {
        var a = s - 100;
        var b = s + 100;
        if (a < 0) { a = 0; }
        if (b > total) { b = total; }
        var run = b - a;
        if (run <= 0) { return 0.0; }
        return ((eleAt(b) - eleAt(a)).toFloat() / run) * 100.0;
    }

    /** D+ restant jusqu'au sommet de la côte i. */
    function gainRemaining(i as Lang.Number, s as Lang.Number) as Lang.Number {
        if (i < 0 || i >= climbS.size()) { return 0; }
        var top = eleAt(climbE[i]);
        var here = eleAt(s);
        var r = top - here;
        return (r > 0) ? r : 0;
    }
}
