# Ravitaillement : points d'intérêt le long du parcours

Deux sources, deux régimes très différents — c'est la contrainte juridique de la
seconde qui dicte toute l'architecture.

## 1. OpenStreetMap — le socle, mis en cache

Eau potable, commerces, boulangeries, refuges, abris, restauration… récupérés via
Overpass et **stockés** dans `runnav_pois` (clé `gpx_key`).

- Calcul déclenché automatiquement à l'import d'un GPX, par l'Edge Function
  **`runnav-pois`** (source dans `supabase/functions/`).
- Idempotent : une trace déjà traitée renvoie `cached`. Deux athlètes important
  le même GPX partagent donc le même calcul.
- Lecture par la RPC `runnav_get_pois`. Aucune écriture n'est exposée au client.
- Chaque POI porte son **abscisse curviligne**, ce qui permet de l'exprimer en
  distance restante et de le placer sur le profil.
- Licence **ODbL** : l'attribution est affichée en pied de légende.

Overpass n'est jamais appelé depuis le navigateur : il est limité en débit et
répond en plusieurs secondes. Une requête déclenchée en pleine course pourrait
être rejetée (429/504).

## 2. Google Places — horaires, à la demande et sans cache

OSM ne renseigne les horaires que rarement (10 POI sur 135 sur RT 2026). Google
les connaît, mais **ses conditions interdisent de stocker le contenu Places** :
seul le `place_id` est conservable indéfiniment.

D'où le fonctionnement retenu, le seul à la fois conforme et économique :

| | |
|---|---|
| **Quand** | uniquement quand l'utilisateur tape une pastille |
| **Quoi** | horaires, ouvert/fermé, site web, téléphone (niveau *Pro*) |
| **Stocké** | le `place_id` seulement — jamais les horaires |
| **Pas de clé ?** | la ligne « horaires » n'apparaît simplement pas |

Conséquence de coût : l'appariement OSM → Google (Text Search, ~32 $/1000) ne se
paie **qu'une fois par POI** grâce au `place_id` mémorisé ; seuls les détails
(~17 $/1000) sont récurrents. À quelques taps par course, on reste dans le quota
gratuit (5 000 appels *Pro* par mois).

Les notes et avis ne sont volontairement pas demandés : niveau *Enterprise*, plus
cher, et sans intérêt en course.

## Où mettre la clé Google

**Jamais dans le dépôt ni dans le code de l'app** — un fichier JS servi au
navigateur est lisible par tout le monde, et une clé Google exposée se fait
consommer par n'importe qui. Elle vit en **secret d'Edge Function** :

1. Créer un projet sur [Google Cloud Console](https://console.cloud.google.com),
   activer **Places API (New)**, créer une clé API.
2. Restreindre la clé à l'API Places (onglet *Restrictions d'API*). Pas de
   restriction par référent : les appels viennent du serveur, pas du navigateur.
3. Dans Supabase : **Project Settings → Edge Functions → Secrets**, ajouter

   ```
   GOOGLE_PLACES_KEY = <la clé>
   ```

4. Rien à redéployer : la fonction lit le secret à chaque appel. Elle répond
   `nokey` tant qu'il est absent, et l'app masque alors la ligne horaires.

Pour révoquer, il suffit de supprimer le secret : l'app revient au comportement
« OSM seul » sans erreur.

## Fichiers concernés

| | |
|---|---|
| `supabase/functions/runnav-pois/` | calcul OSM à l'import (Overpass → cache) |
| `supabase/functions/runnav-place/` | horaires à la demande (Google, sans cache) |
| `js/storage.js` | `fetchPois`, `buildPois`, `fetchPlace` |
| `js/app.js` | calque, légende filtrable, fiche POI, prochain ravito |
| `js/map.js` | `setPois` — pastilles cliquables |
| `js/profile.js` | `setPois`, `_poiAt` — macarons sur la courbe, cliquables |
