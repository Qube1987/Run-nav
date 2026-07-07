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
    const list = (icons && icons.length ? icons : (wpt.icon ? [wpt.icon] : [])).slice(0, 4);
    const color = wpt.color || (isBar ? '#e0484a' : '#ff5a3c');
    const badge = isBar ? '<span class="wpt-bar">⏱</span>' : '';
    let html, size, anchor;
    if (list.length <= 1) {
      const ico = list[0] || (wpt.summit ? '⛰️' : (isBar ? '⏱️' : '📍'));
      html = `<div class="wpt-pin${isBar ? ' has-bar' : ''}" style="background:${color}"><span>${ico}</span>${badge}</div>`;
      size = [28, 28]; anchor = [14, 28];
    } else {
      // plusieurs dispos → icônes EN COLONNE (l'une au-dessus de l'autre),
      // chacune distincte, sans chevauchement. Le repère grandit vers le haut.
      const inner = list.map((i) => `<span>${i}</span>`).join('');
      const w = 26, h = list.length * 18 + 6;
      html = `<div class="wpt-col${isBar ? ' has-bar' : ''}" style="background:${color}">${inner}${badge}</div>`;
      size = [w, h]; anchor = [w / 2, h];
    }
    const m = L.marker([wpt.lat, wpt.lon], {
      icon: L.divIcon({ className: 'wpt-icon', html, iconSize: size, iconAnchor: anchor }),
    }).addTo(this.wptLayer);
    const tip = isBar
      ? `${wpt.label || 'Point'}<br>⏱ Barrière ${barrierText}`
      : wpt.label;
    if (tip) m.bindTooltip(tip, { direction: 'top' });
    m.on('click', () => { if (this.onWaypointClick) this.onWaypointClick(wpt); });
    return m;
  }

  clearWaypoints() { this.wptLayer.clearLayers(); }

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
