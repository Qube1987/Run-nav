# Course pack — format et décisions d'architecture

Le *course pack* est le JSON compact produit par `run-nav` et consommé par le data
field Garmin `runnav-df`. Généré par `tools/coursepack.js` (module pur, sans DOM),
exécuté en Node (voir `tools/`) : l’export depuis l’application téléphone a été retiré.

## Format (v1)

```jsonc
{
  "v": 1,
  "n": "RT 2026",           // nom de l'épreuve
  "d": 108310,              // distance totale VRAIE, m
  "a": 6852,                // D+ total, m
  "o": [4230906, 914970],   // origine : lat, lon en 1e-5 deg
  "t": [dLat, dLon, ...],   // polyline delta-encodée, 1e-5 deg (~1,1 m)
  "dd": [92, 88, ...],      // échelle de distances vraies (voir plus bas), m
  "p": [[dist_m, alt_m]],   // profil simplifié
  "c": [{ "s":744, "e":8108, "g":1389, "pc":189, "n":"…" }],  // côtes, pc = ‰
  "i": [{ "d":1112, "k":"ravito", "n":"…", "cut":1830 }]      // POI
}
```

Toutes les valeurs du payload sont des **entiers**. La clé `n` d'une côte est
omise quand elle est vide (la montre retombe sur l'index).

## Décision 1 — la clé `dd` : forme et mesure sont deux problèmes distincts

**C'est l'écart le plus important vis-à-vis du cahier des charges initial, et il
est délibéré.**

Le cahier des charges demandait deux choses simultanément :

- §4.1 — polyline de **1 500 à 2 500 points** (tolérance Douglas-Peucker 8–12 m) ;
- §4.2 — **écart de distance < 0,5 %** entre la polyline simplifiée et l'originale.

Mesuré sur une trace réelle (RT 2026 : 108 km, 6 852 m D+, 13 887 points), ces
deux contraintes sont **incompatibles**. Douglas-Peucker préserve la *forme* mais
raccourcit systématiquement la *longueur* : il coupe les lacets, et un trail
technique n'est presque que des lacets.

| tolérance | points | taille | écart de distance |
|---:|---:|---:|---:|
| 10 m | 1 170 | 14,1 Ko | **3,20 %** |
| 4 m | 2 490 | 21,9 Ko | 1,43 % |
| 2 m | 4 032 | 30,6 Ko | 0,70 % |
| 1 m | 6 106 | 41,4 Ko | 0,34 % ✓ |
| 0,5 m | 8 558 | 53,1 Ko | 0,11 % ✓ |

Atteindre 0,5 % par la seule tolérance demande ~6 100 points — **2,4× le budget**,
et 41 Ko à charger en mémoire d'un data field.

La solution retenue sépare les deux rôles que joue la polyline :

- **dessiner** la carte (zone A) → les sommets simplifiés suffisent largement,
  une erreur de forme de ~10 m est invisible aux zooms de travail ;
- **mesurer** l'avancement → on joint à la polyline la clé `dd` : la distance
  **réellement parcourue sur la trace d'origine** entre deux sommets conservés.

La montre projette sa position sur le segment *k* à la fraction *t*, puis lit
l'abscisse curviligne :

```
s = cum[k] + t · (cum[k+1] − cum[k])        avec  cum = somme cumulée de dd
```

`s` est alors une distance vraie, et « restant = `d` − `s` » reste juste jusqu'à
l'arrivée. Résultat sur la trace réelle : **1 170 points, 18,4 Ko, écart 0,000 %**.
Le coût est de ~4 Ko (un entier court par sommet) contre 23 Ko pour la voie
« tolérance fine », et le budget de points est respecté avec une large marge.

L'écart de forme résiduel (3,2 % sur les cordes) est reporté séparément par
l'exporteur sous le nom `chordDriftPct` : il n'affecte que le tracé à l'écran,
plus jamais les distances affichées.

> Conséquence pour `runnav-df` : le `Locator` **doit** utiliser `dd` pour
> l'abscisse. Mesurer les distances directement sur les cordes de `t`
> réintroduirait l'erreur de 3 %, soit ~3,4 km sur RT 2026.

## Décision 2 — espace d'abscisses unique

Côtes (`c.s`, `c.e`), profil (`p[i][0]`) et POI (`i.d`) sont exprimés dans
l'abscisse **d'origine**, la même que celle reconstruite via `dd`. Aucun
remappage n'est nécessaire côté montre : toutes les valeurs sont directement
comparables à `s`.

## Décision 3 — budgets adaptatifs plutôt que tolérance figée

`simplifyToBudget()` part de la tolérance cible (10 m pour la trace, 5 m vertical
pour le profil) et ne la relâche (doublement puis dichotomie) que si le plafond
de points est dépassé. Une épreuve courte conserve donc une tolérance fine et un
pack léger, au lieu d'être dégradée inutilement.

Vérifié sur une trace synthétique de 233 km à lacets serrés : 2 104 points,
26,7 Ko, écart 0,000 % — le budget tient au-delà de la Diagonale.

## Décision 4 — profil simplifié en écart vertical

Le profil est simplifié par Douglas-Peucker sur l'**écart vertical** au segment
(et non la distance perpendiculaire 2D) : les échelles horizontale (10⁵ m) et
verticale (10³ m) sont trop dissemblables pour qu'une distance euclidienne ait un
sens. La tolérance de 5 m est ainsi directement lisible en mètres de dénivelé.

## Décision 5 — POI retenus

Les sommets automatiques sont déjà décrits par `c` : ils sont exclus de `i` pour
ne pas payer deux fois. Sont retenus les repères porteurs d'information — nommés
à la main, porteurs d'un pictogramme, ou d'une barrière horaire. Le champ `k`
est déduit des pictogrammes (`ravito`, `barriere`, `arrivee`, `secours`, `base`,
`poi`) et `cut` est converti en minutes depuis l'heure de départ.

## Contrôle de cohérence

`buildCoursePack()` renvoie `{ pack, report }`. Le rapport est affiché dans
l'interface après export :

| champ | signification |
|---|---|
| `bytes` / `sizeWarn` | taille UTF-8 et dépassement du seuil |
| `trackPoints` / `trackTol` | budget polyline effectivement atteint |
| `profilePoints` / `profileTol` | idem profil |
| `driftPct` / `driftOk` | **critère jalon 2** : distance reconstruite vs origine, < 0,5 % |
| `chordDriftPct` | écart de forme des cordes (dessin uniquement) |
| `budgetOk` | plafonds de points respectés |

## Point ouvert — `SIZE_WARN_BYTES`

Le seuil d'alerte de taille est **provisoire** (32 Ko). Il doit être recalé sur le
budget mémoire réel d'un data field Fenix 8, à relever depuis le SDK Connect IQ
(cf. `docs/device-constraints.md`, §2.3 du cahier des charges).
