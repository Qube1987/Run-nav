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

## Ce que le budget de 128 Ko implique

Le régime établi est confortable : pour RT 2026 (1 170 sommets), `xs`/`ys` en
Float et `cum` en Number pèsent ~14 Ko, profil et côtes quelques Ko de plus.

**Le point sensible est le pic au chargement.** Le dictionnaire JSON décodé
coexiste un instant avec les tableaux typés, et sa représentation Monkey C vaut
plusieurs fois les 18,4 Ko du texte source. Mitigations déjà en place :

- `CoursePack` recopie tout dans des tableaux typés et expose `cosLat`, pour que
  `RunnavDataField.initialize` puisse mettre le dictionnaire à `null`
  **avant** d'allouer le `Locator` et les renderers ;
- `SIZE_WARN_BYTES` (exporteur run-nav) reste à 32 Ko, marge volontairement large.

**À mesurer au profiler** : le pic réel à l'`initialize()`. C'est le seul chiffre
qui manque encore. S'il dépasse, le levier est `trackMaxPoints` dans
l'exporteur — et le baisser **ne dégrade que le tracé, jamais les distances**,
grâce à la clé `dd`. C'est précisément ce que cette architecture achète.

Le `BufferedBitmap` du §6.2 (pré-rendu du fond de carte) n'est envisageable
qu'après cette mesure : à 454x454 en 16 bpp, un tampon plein écran coûterait
~412 Ko, très au-delà du budget. Il faudra donc soit un tampon partiel, soit
s'en passer — d'où l'intérêt du culling déjà en place dans `MapRenderer`.

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
