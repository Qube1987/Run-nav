# ⛰️ Run-Nav

Application web de **suivi live** pour trails et épreuves vélo. Charge ta trace
GPX et vois exactement **où tu en es dans chaque côte** : position GPS sur la
carte, profil altimétrique détaillé, pente en cours, distance au sommet et
temps de passage recalculés selon ta vitesse.

Tout tourne **dans le navigateur** — aucune donnée n'est envoyée à un serveur.

## Fonctionnalités

- **Chargement GPX** (traces `trkpt` ou routes `rtept`), avec nettoyage des
  points aberrants, lissage de l'altitude et calcul du D+/D-.
- **Carte** Leaflet avec trois fonds : **Topographique** (OpenTopoMap),
  **Plan** (OpenStreetMap) et **Vélo** (CyclOSM).
- **Position GPS en temps réel** (`watchPosition`), projetée sur la trace, avec
  portion parcourue surlignée et alerte « hors trace ».
- **Profil altimétrique** proéminent, coloré par pente, avec :
  - marqueur de ta position actuelle,
  - surlignage des côtes + pente moyenne / catégorie,
  - points de passage,
  - mode plein parcours **ou** zoom sur la côte en cours,
  - lecture au doigt (scrub) synchronisée avec la carte.
- **Bandeau « côte en cours »** : distance au sommet, D+ restant, pente
  moyenne et **% de progression** dans la montée.
- **Détection automatique des côtes** avec catégorisation façon cyclisme
  (Cat. 4 → HC).
- **Temps de passage** calculés à partir d'un modèle tenant compte de la pente,
  recalculés en continu selon :
  - la **vitesse live**,
  - une **vitesse moyenne fixe**,
  - ou un **temps cible** sur le parcours.
  Heure de départ « maintenant » ou fixée, et **heure d'arrivée estimée**.
- **Points de passage manuels** : touche la carte près de la trace ou pose un
  point à ta position.
- Installable comme **PWA** (ajout à l'écran d'accueil).

## Utilisation

C'est un site **100 % statique** — pas de build, pas de dépendance à installer.

### En local

Sers le dossier via un serveur HTTP (la géolocalisation et les modules ES
nécessitent `http(s)://`, pas `file://`) :

```bash
python3 -m http.server 8000
# puis ouvre http://localhost:8000
```

Sur mobile, l'accès GPS exige **HTTPS** (ou `localhost`).

### Déploiement

Pousse le contenu du dépôt sur **GitHub Pages** (branche + dossier racine), ou
sur n'importe quel hébergement statique (Netlify, Cloudflare Pages…). Le fond de
carte et la géoloc fonctionnent immédiatement en HTTPS.

### Essai rapide

Sur l'écran d'accueil, clique sur **« Essayer avec un parcours démo »** pour
charger une boucle synthétique vallonnée et explorer l'interface sans GPX.

## Structure

```
index.html            # structure de la page
styles.css            # thème sombre, mobile-first
manifest.webmanifest  # PWA
js/
  app.js              # orchestration, UI, géolocalisation
  gpx.js              # parsing GPX + préparation de la trace
  geo.js              # distances, projection sur la trace
  climbs.js           # détection & catégorisation des côtes
  profile.js          # rendu du profil altimétrique (canvas)
  pacing.js           # modèle de temps / temps de passage
  map.js              # carte Leaflet
  demo.js             # parcours de démonstration
```

## Notes techniques

- Le **modèle de temps** part d'une vitesse « à plat » et applique un facteur
  selon la pente (on ralentit en montée, léger gain en descente), puis se
  calibre pour respecter la vitesse moyenne / le temps cible demandé. Ce n'est
  pas une prédiction physiologique fine, mais un repère cohérent qui se met à
  jour avec ton allure réelle.
- La **projection GPS** utilise une fenêtre glissante autour du dernier point
  connu pour rester performante, avec repli sur la trace entière si tu t'en
  éloignes.
- Fonds de carte © OpenTopoMap (CC-BY-SA), © OpenStreetMap, © CyclOSM.
