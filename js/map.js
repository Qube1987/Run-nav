// Gestion de la carte Leaflet : fonds topo/plan, trace, position, marqueurs.

export class RaceMap {
  constructor(elId) {
    this.map = L.map(elId, {
      zoomControl: true,
      attributionControl: true,
      tap: true,
    });
    this.map.setView([46.6, 2.5], 6);

    // Fonds de carte
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '© OpenTopoMap (CC-BY-SA) · © OpenStreetMap',
    });
    const plan = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    });
    const cyclo = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© CyclOSM · © OpenStreetMap',
    });
    topo.addTo(this.map);
    L.control.layers(
      { 'Topographique': topo, 'Plan': plan, 'Vélo (CyclOSM)': cyclo },
      {},
      { position: 'topright', collapsed: true }
    ).addTo(this.map);

    this.trackLine = null;
    this.doneLine = null;
    this.posMarker = null;
    this.accCircle = null;
    this.wptLayer = L.layerGroup().addTo(this.map);
    this.mediaLayer = L.layerGroup().addTo(this.map);
    this.onMapTap = null;
    this.onUserPan = null;

    this.map.on('click', (e) => {
      if (this.onMapTap) this.onMapTap(e.latlng);
    });

    // Déplacement manuel de la carte → coupe le recentrage automatique
    // (exploration libre). 'dragstart' n'est déclenché que par l'utilisateur,
    // jamais par nos panTo/fitBounds programmatiques.
    this.map.on('dragstart', () => { if (this.onUserPan) this.onUserPan(); });
  }

  setTrack(points) {
    const latlngs = points.map((p) => [p.lat, p.lon]);
    if (this.trackLine) this.trackLine.remove();
    if (this.doneLine) this.doneLine.remove();
    this.trackLine = L.polyline(latlngs, {
      color: '#ff5a3c', weight: 4, opacity: 0.9, lineJoin: 'round',
    }).addTo(this.map);
    // portion parcourue (au-dessus)
    this.doneLine = L.polyline([], {
      color: '#ffd24a', weight: 5, opacity: 0.95, lineJoin: 'round',
    }).addTo(this.map);

    // repères départ / arrivée
    L.circleMarker(latlngs[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#3fbf6f', fillOpacity: 1 })
      .bindTooltip('Départ', { direction: 'top' }).addTo(this.map);
    L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: '#e8613c', fillOpacity: 1 })
      .bindTooltip('Arrivée', { direction: 'top' }).addTo(this.map)
      .on('click', () => { if (this.onFinishClick) this.onFinishClick(); });

    this.map.fitBounds(this.trackLine.getBounds(), { padding: [30, 30] });
    this._latlngs = latlngs;
    this._points = points; // pour le calque terrain (découpe par distance)
  }

  /** Calque « nature du sol » : recolore la trace par segments. `data.segs` = [[dA,dB,code]]. */
  setTerrain(data, colors, on) {
    if (this.terrainLayer) { this.terrainLayer.remove(); this.terrainLayer = null; }
    if (this.trackLine) this.trackLine.setStyle({ opacity: on ? 0.15 : 0.9 });
    if (!on || !data || !data.segs || !this._points) { if (this.doneLine) this.doneLine.bringToFront(); return; }
    const pts = this._points;
    this.terrainLayer = L.layerGroup();
    for (const seg of data.segs) {
      const a = seg[0], b = seg[1], code = seg[2];
      const ll = [];
      for (const p of pts) { if (p.d >= a && p.d <= b) ll.push([p.lat, p.lon]); }
      if (ll.length < 2) continue;
      L.polyline(ll, { color: (colors && colors[code]) || '#888', weight: 6, opacity: 0.95, lineJoin: 'round', lineCap: 'round' })
        .addTo(this.terrainLayer);
    }
    this.terrainLayer.addTo(this.map);
    if (this.doneLine) this.doneLine.bringToFront(); // garde la portion parcourue visible
  }

  /** Met à jour la portion parcourue jusqu'à l'index de segment donné. */
  setProgress(index, projected) {
    if (!this._latlngs) return;
    const done = this._latlngs.slice(0, index + 1);
    if (projected) done.push([projected.lat, projected.lon]);
    this.doneLine.setLatLngs(done);
  }

  setPosition(lat, lon, accuracy, heading) {
    const ll = [lat, lon];
    if (!this.posMarker) {
      this.posMarker = L.marker(ll, { icon: this._posIcon(), zIndexOffset: 1000 }).addTo(this.map);
      this.accCircle = L.circle(ll, { radius: accuracy || 0, color: '#4aa3ff', weight: 1, fillColor: '#4aa3ff', fillOpacity: 0.12 }).addTo(this.map);
    } else {
      this.posMarker.setLatLng(ll);
      this.accCircle.setLatLng(ll).setRadius(accuracy || 0);
    }
  }

  _posIcon() {
    return L.divIcon({
      className: 'pos-icon',
      html: '<div class="pos-dot"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }

  addWaypointMarker(wpt, barrierText, icons) {
    const isBar = !!barrierText;
    const list = (icons && icons.length ? icons : (wpt.icon ? [wpt.icon] : [])).slice(0, 8);
    const color = wpt.color || (isBar ? '#e0484a' : '#ff5a3c');
    const badge = isBar ? '<span class="wpt-bar">⏱</span>' : '';
    // Carte : UNE seule icône par repère pour ne pas surcharger. Les autres icônes
    // (dispos, notes, barrière…) s'affichent au clic dans la fiche. Le profil, lui,
    // conserve toutes les icônes. Un petit « +N » signale qu'il y a plus à voir.
    const ico = list[0] || (wpt.summit ? '⛰️' : (isBar ? '⏱️' : '📍'));
    const more = list.length > 1 ? `<span class="wpt-more">+${list.length - 1}</span>` : '';
    const html = `<div class="wpt-pin${isBar ? ' has-bar' : ''}" style="background:${color}"><span>${ico}</span>${badge}${more}</div>`;
    const m = L.marker([wpt.lat, wpt.lon], {
      icon: L.divIcon({ className: 'wpt-icon', html, iconSize: [28, 28], iconAnchor: [14, 28] }),
    }).addTo(this.wptLayer);
    const tip = isBar
      ? `${wpt.label || 'Point'}<br>⏱ Barrière ${barrierText}`
      : wpt.label;
    if (tip) m.bindTooltip(tip, { direction: 'top' });
    m.on('click', () => { if (this.onWaypointClick) this.onWaypointClick(wpt); });
    return m;
  }

  clearWaypoints() { this.wptLayer.clearLayers(); }

  /** Positions de TOUS les athlètes suivis (marqueurs colorés cliquables). */
  setAthletes(list, onSelect) {
    if (!this.athLayer) this.athLayer = L.layerGroup().addTo(this.map);
    this.athLayer.clearLayers();
    for (const a of (list || [])) {
      if (a.lat == null || a.lon == null) continue;
      const cls = 'ath-pin' + (a.focused ? ' focused' : '') + (a.active ? '' : ' off') + (a.avatar ? ' photo' : '');
      const inner = a.avatar
        ? `<div class="${cls}" style="border-color:${a.color};background-image:url('${String(a.avatar).replace(/'/g, '%27')}')"></div>`
        : `<div class="${cls}" style="background:${a.color}"><span>${a.initial}</span></div>`;
      const html = `<div class="ath-wrap">` + inner
        + `<span class="ath-name">${a.name}</span></div>`;
      const mk = L.marker([a.lat, a.lon], {
        icon: L.divIcon({ className: 'ath-icon', html, iconSize: [34, 34], iconAnchor: [17, 17] }),
        zIndexOffset: a.focused ? 1200 : 700,
      }).addTo(this.athLayer);
      mk.on('click', () => { if (onSelect) onSelect(a.code); });
    }
  }
  clearAthletes() { if (this.athLayer) this.athLayer.clearLayers(); }

  /** Position du follower lui-même (marqueur « moi » distinct). */
  setFollowerPosition(lat, lon) {
    const ll = [lat, lon];
    if (!this.meMarker) {
      this.meMarker = L.marker(ll, {
        icon: L.divIcon({ className: 'me-icon', html: '<div class="me-pin">🙂</div>', iconSize: [30, 30], iconAnchor: [15, 15] }),
        zIndexOffset: 800,
      }).addTo(this.map);
    } else {
      this.meMarker.setLatLng(ll);
    }
  }
  clearFollowerPosition() { if (this.meMarker) { this.meMarker.remove(); this.meMarker = null; } }

  /** Marqueurs médias géolocalisés : vraie vignette de la photo (cliquable). */
  setMediaMarkers(list, onClick) {
    this.mediaLayer.clearLayers();
    for (const md of (list || [])) {
      if (md.lat == null || md.lon == null) continue;
      const safeUrl = String(md.url).replace(/["'()\\]/g, '');
      const inner = md.kind === 'video'
        ? `<div class="mm-thumb mm-video"><span>▶</span></div>`
        : `<div class="mm-thumb" style="background-image:url('${safeUrl}')"></div>`;
      const html = `<div class="media-thumb-marker">${inner}<span class="mm-tail"></span></div>`;
      const mk = L.marker([md.lat, md.lon], {
        icon: L.divIcon({ className: 'media-icon', html, iconSize: [46, 54], iconAnchor: [23, 54] }),
        zIndexOffset: 600,
      }).addTo(this.mediaLayer);
      mk.on('click', () => { if (onClick) onClick(md); });
    }
  }
  clearMediaMarkers() { this.mediaLayer.clearLayers(); }

  panTo(lat, lon) { this.map.panTo([lat, lon], { animate: true }); }

  highlightCursor(lat, lon) {
    if (!this._cursor) {
      this._cursor = L.circleMarker([lat, lon], {
        radius: 7, color: '#1a1e26', weight: 2, fillColor: '#ffd24a', fillOpacity: 1,
      }).addTo(this.map);
    } else {
      this._cursor.setLatLng([lat, lon]);
    }
  }
  clearCursor() { if (this._cursor) { this._cursor.remove(); this._cursor = null; } }

  invalidate() { setTimeout(() => this.map.invalidateSize(), 60); }
}
