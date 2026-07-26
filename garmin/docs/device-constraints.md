# Contraintes device

## Relevé (compiler.json du SDK)

| | valeur |
|---|---|
| SDK de développement | **9.2.0** |
| Identifiant Connect IQ | **`fenix847mm`** |
| Connect IQ du device | **6.0.2** (firmware 2235) |
| Écran | **454 x 454**, rond, **AMOLED**, 16 bpp |
| deviceFamily | `round-454x454` |
| **Budget mémoire data field** | **131 072 o (128 Ko)** — cible §9 : < 91 750 o (70 %) |
| Budget watchApp (comparaison) | 786 432 o |
| Icône de lancement | **65 x 65** |
| Icône de complication | 45 x 45 |
| Rotation écran gérée | non (`screenRotationSupport: false`) |
| Alpha blending / graphismes étendus | oui / oui |
| `minApiLevel` retenu | `4.0.0` (le code n'utilise que Graphics, Activity, Application.Properties, Time) |

L'image `fenix847mm` couvre aussi les 51 mm, tactix 8 et quatix 8 : compatibles
sans travail supplémentaire. Les autres variantes (`fenix843mm`,
`fenix8pro47mm`, `fenix8solar47mm/51mm`) sont hors périmètre v1 (§11) — le
Solar est en MIP, donc contraste et coût de redessin différents.

## Mesuré au simulateur (profiler, pack RT 2026)

| | v1 (couples/dicts) | **v2 (tableaux plats)** |
|---|---:|---:|
| Pic mémoire | 95,9 Ko (**77 %**) | **63,9 Ko (51 %)** ✅ |
| Régime établi | 40,9 Ko (33 %) | 40,8 Ko (33 %) |
| Pic d'objets | 1 019 | **109** |

Cible du §9 (< 70 % du budget, soit 87 Ko) : **atteinte**, avec ~23 Ko de marge.

Ce qui a fait la différence : le profil était encodé en 436 couples `[d, e]`,
soit 436 objets Monkey C avec chacun son surcoût, plus un dictionnaire par côte
et par POI. Le pack v2 passe tout en tableaux plats parallèles (457 sous-objets
→ 0), et `CoursePack` les référence directement au lieu de les recopier.

Le levier restant, si un parcours plus lourd que RT 2026 posait problème :
baisser `trackMaxPoints` dans l'exporteur. **Cela ne dégrade que le tracé,
jamais les distances**, grâce à la clé `dd`.

Note : un `BufferedBitmap` plein écran (§6.2) reste hors de portée — à 454x454
en 16 bpp il coûterait ~412 Ko, très au-delà des 128 Ko. Le pré-rendu devra être
partiel ou abandonné ; le culling de `MapRenderer` joue déjà ce rôle.

## Reste à observer (non bloquant)

Au simulateur puis sur la montre :

| question | réponse |
|---|---|
| Fréquence de `compute()` écran allumé | *à observer* |
| Fréquence de `compute()` écran éteint / always-on | |
| `onUpdate()` est-il appelé écran éteint ? | |
| Contraintes anti-burn-in (AMOLED) | |

Conditionne le §6.2 (ne rien calculer ni rendre en basse conso) et le test
batterie du §9 (surcoût < 8 %).

## Compiler

```powershell
cd garmin
.\build.ps1          # Windows
```
```bash
cd garmin && ./build.sh   # macOS / Linux
```
