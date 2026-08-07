# Nature du sol, technicité et courabilité

Trois affichages, une seule source : les tags OpenStreetMap des chemins que la
trace emprunte.

| | |
|---|---|
| **Nature du sol** | bandeau coloré en bas du profil + surlignage de la carte |
| **Technicité** | la nature `Technique / rocheux`, déduite de `sac_scale` ≥ T3 |
| **Courabilité** | indice par descente = nature du sol × déclivité |

## Le calcul

L'Edge Function **`runnav-terrain`** (source dans `supabase/functions/`) est
appelée **automatiquement à l'import d'un GPX**, exactement comme `runnav-pois` :

1. la trace est échantillonnée tous les 100 m ;
2. Overpass renvoie les chemins (`highway`) situés à moins de 40 m, **avec leur
   géométrie** — indispensable pour savoir lequel des chemins voisins on suit
   réellement ;
3. chaque échantillon est rattaché au chemin le plus proche, dont les tags
   donnent la nature du sol ;
4. le résultat est encodé en segments `[début, fin, code]` et mis en cache dans
   `runnav_terrain`.

Idempotent : deux athlètes important le même GPX partagent le calcul. La lecture
se fait par la RPC `runnav_get_terrain` ; aucune écriture n'est exposée au
client.

Overpass n'est jamais appelé depuis le navigateur : il est limité en débit, et
la réponse `out geom` pèse plusieurs mégaoctets.

## La classification

Par ordre de priorité — on ne retombe sur le type de voie que faute de mieux :

| tag | exemples | → |
|---|---|---|
| `sac_scale` ≥ T3 | `demanding_mountain_hiking`, `alpine_hiking` | Technique |
| `surface` | `asphalt` → Route · `compacted` → Compacté · `gravel` → Gravier · `ground` → Terre · `rock`, `scree` → Rocailleux |
| `tracktype` | `grade1` → Route … `grade5` → Terre |
| `highway` | `path`/`footway` → Sentier · `track` → Compacté · `steps` → Technique |
| rien d'exploitable | | Inconnu |

## Le rayon d'appariement (40 m)

Les deux erreurs possibles ne se valent pas :

- **trop serré** → un sentier cartographié ressort « Inconnu ». Gênant, mais honnête.
- **trop large** → un sentier *non* cartographié longeant une route est annoncé
  « goudron ». Là on ment — et le mensonge se propage, puisque la courabilité des
  descentes se calcule à partir de la nature du sol (route = 1.0).

La seconde est donc la faute à éviter. Mesure sur une trace posée exactement sur
des chemins réels (16,6 km sur le GR20), avec bruit GPS injecté :

| bruit injecté | couverture | écart P50 | écart P90 | segments |
|---|---|---|---|---|
| 0 m | 100 % | 0 m | 0 m | 5 |
| 10 m | 100 % | 5 m | 9 m | 5 |
| 25 m | 100 % | 10 m | 23 m | 5 |
| 40 m | 100 % | 15 m | 35 m | 7 |

40 m couvre donc déjà un bruit irréaliste sans tendre la main à la route d'à
côté. À l'inverse, une trace *synthétique* (le parcours démo, qui ne suit aucun
chemin) plafonne à 19 % de couverture à 30 m — c'est le comportement attendu :
hors des chemins cartographiés, la bonne réponse est « Inconnu ».

## Couverture

OSM ne cartographie pas tout. La légende affiche donc la part reconnue du
parcours, et propose de **relancer** l'analyse — utile quand la trace a été mieux
cartographiée depuis, ou quand Overpass était saturé à l'import.

## Fichiers concernés

| | |
|---|---|
| `supabase/functions/runnav-terrain/` | analyse OSM à l'import (Overpass → cache) |
| `js/storage.js` | `fetchTerrain`, `buildTerrain` |
| `js/app.js` | `loadTerrain`, `toggleTerrain`, `renderTerrainLegend`, `computeDescents` |
| `js/map.js` | `setTerrain` — surlignage de la trace |
| `js/profile.js` | `setTerrain` — bandeau coloré et étiquettes sous la courbe |
