# Contraintes device — À REMPLIR AVANT DE CODER LES RENDERERS

> **État : NON RENSEIGNÉ.** Ces valeurs doivent être **relevées dans le SDK
> Connect IQ installé**, pas estimées. Le §2.3 du cahier des charges l'exige
> explicitement, et se tromper ici invalide toute l'architecture mémoire.
>
> Rien n'a été inventé dans ce fichier : les cases sont vides parce que
> l'environnement où le projet a été démarré n'avait pas le SDK (téléchargement
> sous licence Garmin, compte développeur requis — gratuit).

## À relever

### 1. SDK et API level

```bash
# version du SDK installé
~/Library/Application\ Support/Garmin/ConnectIQ/Sdks/*/bin/monkeyc --version   # macOS
%APPDATA%\Garmin\ConnectIQ\Sdks\*\bin\monkeyc --version                        # Windows
```

| | valeur |
|---|---|
| Version SDK | |
| API level minimum ciblé | |

### 2. Identifiants et résolutions des variantes Fenix 8

Les identifiants exacts (`fenix8…`) sont **à lire dans le SDK**, pas à deviner :
ils conditionnent `manifest.xml`. Ils se trouvent dans le dossier des devices :

```bash
ls ~/Library/Application\ Support/Garmin/ConnectIQ/Devices/     # un dossier par device
cat ~/Library/Application\ Support/Garmin/ConnectIQ/Devices/<id>/compiler.json
```

| variante | identifiant CIQ | résolution | écran | forme |
|---|---|---|---|---|
| Fenix 8 43 mm | | | AMOLED ? | rond |
| Fenix 8 47 mm | | | | |
| Fenix 8 51 mm | | | | |
| Fenix 8 Solar 47 mm | | | MIP ? | |
| Fenix 8 Solar 51 mm | | | | |

⚠ AMOLED et MIP/Solar n'ont ni la même définition ni le même comportement
d'affichage : le §5.3 (contraste, lisibilité plein soleil) et le §6.2 (coût du
redessin) en dépendent.

### 3. Budget mémoire d'un data field — **la contrainte dure**

Dans `compiler.json` de chaque device, champ de mémoire pour le type
`datafield` (distinct de `widget` / `watch-app`).

| variante | budget data field | 70 % (cible §9) |
|---|---|---|
| | | |

**Ce que ça conditionne directement :**

- `SIZE_WARN_BYTES` dans `run-nav/js/coursepack.js` — aujourd'hui **provisoire à
  32 Ko**, à recaler ici.
- La taille de la polyline embarquée. Ordre de grandeur mesuré côté producteur :
  pack RT 2026 (108 km) = **18,4 Ko de JSON**. Une fois chargé, `CoursePack`
  matérialise 3 tableaux de `n` éléments (`xs`, `ys` en Float, `cum` en Number) :
  pour n = 1 170, compter **~14 Ko** en plus du JSON décodé — à vérifier au
  profiler, c'est probablement le poste dominant.
- Si le budget est trop serré : baisser `trackMaxPoints` dans l'exporteur (la
  clé `dd` garantit que la **distance reste exacte** même avec une polyline
  grossière — seul le tracé se dégrade). C'est précisément ce que cette
  architecture permet.

### 4. Comportement en basse consommation

| question | réponse |
|---|---|
| Fréquence d'appel de `compute()` écran allumé | |
| Fréquence d'appel de `compute()` écran éteint | |
| `onUpdate()` est-il appelé écran éteint ? | |
| Spécificité AMOLED (always-on, burn-in protection) | |

Conditionne le §6.2 (ne rien calculer ni rendre en basse conso) et le test
batterie du §9 (surcoût < 8 %).

## Une fois rempli

1. Recaler `SIZE_WARN_BYTES` côté run-nav.
2. Compléter `manifest.xml` avec les vrais identifiants de produits.
3. Rejouer `tools/locator-test.mjs` (ne dépend pas du SDK) puis lancer le
   simulateur pour valider `CoursePack` + `Locator` sur device réel.
