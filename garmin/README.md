# runnav-df — data field Connect IQ (Fenix 8)

Carte vectorielle du parcours + position dans la côte en cours, pour
l'ultra-endurance. Alimenté par les *course packs* produits par `run-nav`.

## ⚠ Ce dossier est destiné à devenir son propre dépôt

Le cahier des charges prévoit `qube1987/runnav-garmin-datafield`. Ce dépôt n'a
pas pu être créé automatiquement (le jeton GitHub de la session n'a pas le droit
de créer des dépôts), donc le projet démarre ici, dans `run-nav/garmin/`.

Pour l'extraire, une fois le dépôt créé sur GitHub :

```bash
# depuis un clone de run-nav
cd garmin
git init && git add . && git commit -m "Import initial depuis run-nav/garmin"
git remote add origin git@github.com:qube1987/runnav-garmin-datafield.git
git push -u origin main
# puis, dans run-nav : git rm -r --cached garmin && rm -rf garmin
```

Rien n'est perdu : c'est un déplacement de fichiers.

## État d'avancement

| jalon | état |
|---|---|
| 1 — squelette, manifest, `docs/device-constraints.md` | ✅ cible `fenix847mm` câblée, contraintes relevées (128 Ko data field, 454x454 AMOLED) |
| 2 — exporteur course pack | ✅ **fait**, dans `tools/coursepack.js` (Node) |
| 3 — `CoursePack` + `Locator` | 🟢 **algorithme validé** et **compile** ; exécution à valider au simulateur |
| 4 — `ClimbRenderer` + `PaceModel` (zone B) | 🟢 **modèle VAM/ETA validé** et **compile** ; rendu à voir au simulateur |
| 5 — `MapRenderer` (zone A) | 🟢 **auto-zoom validé** et **compile** ; rendu à voir au simulateur |
| 6 — optimisation mémoire / batterie | 🟡 **mémoire OK** (pic 51 % du budget) ; batterie non testée |
| 7 — chargement distant | ⬜ à faire |

### Ce qui est réellement vérifié, et ce qui ne l'est pas

**Vérifié** — la logique du `Locator`, en rejouant une trace réelle
(RT 2026 : 108 km, 6 852 m D+, 13 887 points) sur l'implémentation de référence
`tools/locator-reference.mjs` :

| scénario | erreur d'abscisse |
|---|---|
| progression normale (bruit GPS 8 m) | médiane **2,0 m**, p95 5,8 m |
| aller-retour sur la trace (§6.3) | max 39,8 m |
| perte GPS prolongée + reprise | max 22,1 m |
| glitch GPS (téléportation 5 km) | rejeté, max 16,3 m |

soit **2 points au-dessus de 50 m sur 4 629 mises à jour**.

**Vérifié** — le modèle de vitesse ascensionnelle (`tools/pacemodel-test.mjs`),
sur la plus grosse côte de RT 2026 (1 594 m D+, 15,2 %) :

| scénario | résultat |
|---|---|
| grimpeur lent (380 m/h) / rapide (750 m/h) | VAM retrouvée, ETA à 0,1 % / 2,7 % |
| arrêt 15 min, timer en pause | ETA à 0,6 % |
| arrêt 15 min **debout, timer qui tourne** | ETA à 0,6 % |
| VAM absurde (1 800 m/h) | plafonnée à 900 |

**Vérifié** — l'auto-zoom de la zone A (`tools/zoom-test.mjs`) : lookahead
indexé sur la vitesse (~4 min devant), hystérésis par temps de séjour.

| | résultat |
|---|---|
| pompage du zoom | **÷ 15** (785 → 52 changements sur 108 km) |
| ultra-trail (1,5 m/s) | paliers 200/400/800 m, 1 changement / 2 km |
| bikepacking (8 m/s) | paliers 800/1500/3000 m |

Un lookahead **figé** dégénère (92 % du temps bloqué sur un seul palier) : c'est
la mesure qui a imposé de l'indexer sur la vitesse.

```bash
cd tools
node locator-test.mjs && node pacemodel-test.mjs && node zoom-test.mjs   # sans SDK
```

**Compile et tourne** — `monkeyc` (SDK 9.2.0, cible `fenix847mm`) produit le
`.prg` sans erreur ni avertissement, et le data field s'affiche au simulateur.

| mesure (simulateur, pack RT 2026) | valeur |
|---|---|
| pic mémoire | **63,9 Ko / 124,5** (51 %) — cible §9 : < 70 % ✅ |
| régime établi | 40,8 Ko (33 %) |
| pic d'objets | 109 |

**Non vérifié** — le rejeu d'une activité FIT complète (§10), la cadence de
`compute()` écran éteint, et le test batterie réel du §9 (surcoût < 8 %).

## Le point d'architecture à ne pas casser

Le pack porte une clé **`dd`** : la distance *réellement parcourue* entre deux
sommets de la polyline simplifiée. **Le `Locator` doit l'utiliser pour l'abscisse**
— et surtout pas mesurer sur les cordes de `t`.

Raison : Douglas-Peucker préserve la forme mais raccourcit la longueur (il coupe
les lacets). Sur RT 2026, mesurer sur les cordes donne **3,2 % d'erreur, soit
3,4 km** sur la distance restante. Les deux contraintes du cahier des charges
(≤ 2 500 points *et* écart < 0,5 %) sont incompatibles par la seule tolérance :
il faudrait ~6 100 points et 41 Ko. En séparant *dessiner* (sommets simplifiés)
et *mesurer* (échelle `dd`), on obtient **1 170 points, 18,4 Ko, 0,000 % d'écart**.

Détail complet : `run-nav/docs/coursepack.md`.

## Régénérer un course pack

L'export depuis l'application téléphone a été retiré : l'exporteur vit désormais
ici et s'exécute en Node. Il réutilise le pipeline GPX de run-nav
(`../../js/gpx.js`, `../../js/climbs.js`) :

```js
import { buildTrack } from '../../js/gpx.js';
import { detectClimbs } from '../../js/climbs.js';
import { buildCoursePack } from './coursepack.js';

const track = buildTrack(points);          // points : [{lat, lon, ele}]
const { pack, report } = buildCoursePack({ name, track, climbs: detectClimbs(track.points) });
// report.driftPct doit rester < 0,5 % ; écrire `pack` dans resources/json/coursepack.json
```

## Structure

```
source/          un fichier par classe (Monkey C)
  CoursePack.mc  parsing du pack + accès indexé (côtes, POI, profil)
  Locator.mc     projection GPS → abscisse curviligne
resources/       chaînes, réglages
docs/            décisions d'architecture, contraintes device
tools/           exporteur course pack + implémentations de référence et tests
                 rejouables (Node, sans SDK)
  fixtures/      trace et pack réels servant de banc d'essai
```

## Compiler

```bash
# Windows (PowerShell)
.\build.ps1                    # compile pour fenix847mm
.\build.ps1 sim                # + simulateur
.\build.ps1 fit activite.fit   # + rejeu d'une activité

# macOS / Linux
./build.sh   [sim|fit a.fit]
```

La clé développeur est générée au premier appel (et ignorée par git).

## Prochaine étape

Relever les deux dernières valeurs de `docs/device-constraints.md` (budget
mémoire data field, comportement basse conso), puis compiler : c'est la première
confrontation du Monkey C au compilateur, et il faut s'attendre à des
corrections.
