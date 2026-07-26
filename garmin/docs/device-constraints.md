# Contraintes device

## Connu

| | valeur |
|---|---|
| SDK de développement | **9.2.0** |
| API level du device | **6.0** |
| Cible v1 | **fēnix 8 AMOLED 47 mm** |
| Identifiant Connect IQ | **`fenix847mm`** |
| `minApiLevel` retenu | `4.0.0` (conservateur : le code n'utilise que Graphics, Activity, Application.Properties, Time) |

L'image `fenix847mm` couvre aussi les 51 mm, tactix 8 et quatix 8 : ces modèles
seront compatibles sans travail supplémentaire. Les autres variantes
(`fenix843mm`, `fenix8pro47mm`, `fenix8solar47mm/51mm`) sont hors périmètre v1
(§11) — le Solar est en MIP, donc contraste et coût de redessin différents.

## Reste à relever — 2 choses seulement

Tout est dans le dossier device du SDK. Une seule commande donne l'essentiel :

```bash
# macOS
cat ~/Library/Application\ Support/Garmin/ConnectIQ/Devices/fenix847mm/compiler.json
# Windows (PowerShell)
type $env:APPDATA\Garmin\ConnectIQ\Devices\fenix847mm\compiler.json
# Linux
cat ~/.Garmin/ConnectIQ/Devices/fenix847mm/compiler.json
```

### 1. Budget mémoire d'un data field — **la contrainte dure**

Dans `compiler.json`, la mémoire est déclarée **par type d'application** :
prendre la valeur du type `datafield` (bien plus serrée que `watch-app`).

| | valeur | cible §9 (70 %) |
|---|---|---|
| budget data field | *à relever* | |

Ce que ça pilote :

- `SIZE_WARN_BYTES` dans `run-nav/js/coursepack.js` — **provisoire à 32 Ko**.
- `trackMaxPoints` de l'exporteur. Empreinte mesurée côté producteur pour
  RT 2026 (108 km) : **18,4 Ko de JSON**, plus ~**14 Ko** une fois matérialisé
  par `CoursePack` (3 tableaux de 1 170 éléments : `xs`, `ys` en Float, `cum` en
  Number). Poste probablement dominant, à confirmer au profiler.
- La faisabilité du `BufferedBitmap` du §6.2 (pré-rendu du fond de carte). S'il
  ne rentre pas, on redessine la trace à chaque `onUpdate()` — d'où l'intérêt
  du culling déjà en place dans `MapRenderer`.

> Si le budget est trop serré, **baisser `trackMaxPoints` est sans danger pour
> les distances** : la clé `dd` garantit une abscisse exacte même avec une
> polyline grossière. Seul le tracé se dégrade. C'est tout l'intérêt de cette
> architecture.

### 2. Comportement AMOLED en basse consommation

Pas dans un fichier : à observer au simulateur et sur la montre.

| question | réponse |
|---|---|
| Fréquence de `compute()` écran allumé | *à observer* |
| Fréquence de `compute()` écran éteint / always-on | |
| `onUpdate()` est-il appelé écran éteint ? | |
| Contraintes anti-burn-in (AMOLED) | |

Conditionne le §6.2 (ne rien calculer ni rendre en basse conso) et le test
batterie du §9 (surcoût < 8 %).

## Résolution

Non bloquante : `MapRenderer` et `ClimbRenderer` travaillent en **proportions**
de `dc.getWidth()` / `dc.getHeight()`, avec la marge de 12 % du §5.3. La valeur
exacte servira surtout à figer le choix des polices — à vérifier à l'œil dans le
simulateur, plus fiable qu'un calcul.

## Une fois relevé

1. Recaler `SIZE_WARN_BYTES` côté run-nav.
2. `./build.sh` puis `./build.sh sim` — première compilation.
3. Rejouer les bancs d'essai hors SDK : `cd tools && node locator-test.mjs && node pacemodel-test.mjs && node zoom-test.mjs`
