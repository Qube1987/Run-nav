// Rendu du profil altimétrique sur canvas.
// Coloration par pente, marqueur de position, côtes, points de passage.

import { pointAtDistance } from './geo.js';

/** Couleur selon la pente (%), du vert (plat) au rouge foncé (raide). */
export function gradeColor(grade) {
  const g = Math.abs(grade);
  if (grade < -1) return '#4aa3ff';        // descente : bleu
  if (g < 3) return '#3fbf6f';             // vert
  if (g < 6) return '#c9d43f';             // jaune-vert
  if (g < 9) return '#f0a63a';             // orange
  if (g < 12) return '#e8613c';            // orange-rouge
  return '#d23b3b';                        // rouge
}

export class ProfileChart {
  constructor(canvas, tipEl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tip = tipEl;
    this.track = null;
    this.climbs = [];
    this.waypoints = [];
    this.media = [];            // médias géolocalisés (📷) cliquables
    this.onMediaTap = null;
    this.finishBarrier = false; // barrière horaire à l'arrivée
    this.terrain = null;      // nature du sol : { segs:[[a,b,code]] }
    this.terrainColors = null;// map code → couleur
    this.terrainLabels = null;// map code → libellé
    this.terrainOn = false;   // calque terrain affiché ?
    this.descents = [];       // descentes notées : [{startD,endD,label,color}]
    this.cursorD = null;      // distance de la position courante (m)
    this.win = null;          // [d0, d1] fenêtre visible (m) — source de vérité du zoom
    this.minSpan = 120;       // largeur minimale visible (m)
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.pad = { l: 44, r: 14, t: 16, b: 26 };
    this.onViewChange = null; // notifie l'app quand la vue change (zoom/pan manuel)
    this._pointers = new Map();
    this._pinch = null;
    this._bind();
  }

  setTrack(track, climbs) {
    this.track = track;
    this.climbs = climbs || [];
    this.win = [0, track.total];
    this.render();
  }
  setWaypoints(wpts) { this.waypoints = wpts; this.render(); }
  setMedia(list) {
    this.media = Array.isArray(list) ? list.filter((m) => m.d != null) : [];
    // précharge les vignettes (dessin canvas) ; on ne lit jamais les pixels → le
    // « tainting » cross-origin est sans conséquence.
    if (!this._imgCache) this._imgCache = new Map();
    for (const m of this.media) {
      if (m.kind === 'video' || !m.url || this._imgCache.has(m.url)) continue;
      const img = new Image();
      img.onload = () => { img._ok = true; this.render(); };
      img.onerror = () => { img._err = true; };
      img.src = m.url;
      this._imgCache.set(m.url, img);
    }
    this.render();
  }
  setFinishBarrier(on) { this.finishBarrier = !!on; this.render(); }
  setTerrain(data, colors, labels) { this.terrain = data; this.terrainColors = colors; this.terrainLabels = labels || null; this.render(); }
  setTerrainOn(on) { this.terrainOn = !!on; this.render(); }
  setDescents(list) { this.descents = Array.isArray(list) ? list : []; this.render(); }
  setCursor(d) { this.cursorD = d; this.render(); }
  setView(view, range) {
    if (view === 'climb' && range) this.win = [range[0], range[1]];
    else if (this.track) this.win = [0, this.track.total];
    this._clampWin();
    this.render();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, rect.width * this.dpr);
    this.canvas.height = Math.max(1, rect.height * this.dpr);
    this.render();
  }

  _range() {
    if (this.win) return this.win;
    return [0, this.track ? this.track.total : 1];
  }

  _clampWin() {
    if (!this.track || !this.win) return;
    const total = this.track.total;
    let [d0, d1] = this.win;
    let span = Math.max(this.minSpan, Math.min(total, d1 - d0));
    let mid = (d0 + d1) / 2;
    d0 = mid - span / 2; d1 = mid + span / 2;
    if (d0 < 0) { d1 -= d0; d0 = 0; }
    if (d1 > total) { d0 -= (d1 - total); d1 = total; }
    if (d0 < 0) d0 = 0;
    this.win = [d0, d1];
  }

  /** Recentre la fenêtre sur une distance (utilisé par le suivi GPS). */
  centerOn(d, keepSpan = true) {
    if (!this.track || !this.win) return;
    const span = keepSpan ? (this.win[1] - this.win[0]) : this.minSpan;
    this.win = [d - span / 2, d + span / 2];
    this._clampWin();
    this.render();
  }

  isZoomed() {
    return !!(this.track && this.win && (this.win[1] - this.win[0]) < this.track.total - 1);
  }

  _scales() {
    const w = this.canvas.width, h = this.canvas.height;
    const p = { l: this.pad.l * this.dpr, r: this.pad.r * this.dpr, t: this.pad.t * this.dpr, b: this.pad.b * this.dpr };
    const [d0, d1] = this._range();
    const span = Math.max(1, d1 - d0);

    // bornes altitude sur la plage visible
    let lo = Infinity, hi = -Infinity;
    for (const pt of this.track.points) {
      if (pt.d < d0 - 5 || pt.d > d1 + 5) continue;
      lo = Math.min(lo, pt.ele); hi = Math.max(hi, pt.ele);
    }
    if (!isFinite(lo)) { lo = this.track.minEle; hi = this.track.maxEle; }
    const margin = Math.max(15, (hi - lo) * 0.15);
    lo -= margin; hi += margin;

    const plotW = w - p.l - p.r;
    const plotH = h - p.t - p.b;
    const x = (d) => p.l + ((d - d0) / span) * plotW;
    const y = (e) => p.t + (1 - (e - lo) / Math.max(1, hi - lo)) * plotH;
    return { p, x, y, d0, d1, lo, hi, plotW, plotH, w, h };
  }

  render() {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.track) return;

    const s = this._scales();
    const { p, x, y, d0, d1, lo, hi } = s;
    const pts = this.track.points;

    // --- grille altitude ---
    ctx.font = `${11 * this.dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    const stepE = niceStep((hi - lo) / 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    for (let e = Math.ceil(lo / stepE) * stepE; e <= hi; e += stepE) {
      const yy = y(e);
      ctx.beginPath(); ctx.moveTo(p.l, yy); ctx.lineTo(w - p.r, yy); ctx.stroke();
      ctx.fillText(`${Math.round(e)}`, p.l - 6 * this.dpr, yy);
    }

    // --- surface remplie, colorée par pente (par segments) ---
    const baseY = y(lo);
    const visible = [];
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].d < d0 - 20 || pts[i].d > d1 + 20) continue;
      visible.push(i);
    }
    for (let k = 0; k < visible.length - 1; k++) {
      const i = visible[k], j = visible[k + 1];
      const a = pts[i], b = pts[j];
      ctx.beginPath();
      ctx.moveTo(x(a.d), baseY);
      ctx.lineTo(x(a.d), y(a.ele));
      ctx.lineTo(x(b.d), y(b.ele));
      ctx.lineTo(x(b.d), baseY);
      ctx.closePath();
      const g = (a.grade + b.grade) / 2;
      ctx.fillStyle = withAlpha(gradeColor(g), 0.55);
      ctx.fill();
    }

    // --- ligne de crête ---
    ctx.beginPath();
    let started = false;
    for (const i of visible) {
      const px = x(pts[i].d), py = y(pts[i].ele);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.6 * this.dpr;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // --- calque « nature du sol » : bandeau coloré au bas du profil ---
    if (this.terrainOn && this.terrain && this.terrain.segs) {
      const band = 13 * this.dpr;
      const yTop = (h - p.b) - band;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(p.l, yTop, s.plotW, band);
      for (const seg of this.terrain.segs) {
        const a = seg[0], b = seg[1], code = seg[2];
        if (b < d0 || a > d1) continue;
        const xa = Math.max(p.l, x(a)), xb = Math.min(w - p.r, x(b));
        if (xb <= xa) continue;
        ctx.fillStyle = (this.terrainColors && this.terrainColors[code]) || '#888';
        ctx.fillRect(xa, yTop, xb - xa, band);
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1 * this.dpr;
      ctx.strokeRect(p.l, yTop, s.plotW, band);

      // --- étiquettes de nature du sol (sur les tronçons assez larges) ---
      // on fusionne les segments consécutifs de même nature pour ne pas répéter
      // « Sentier · Sentier · … » et gagner de la place.
      ctx.font = `700 ${9 * this.dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const yMid = yTop + band / 2;
      const segs = this.terrain.segs;
      let r = 0;
      while (r < segs.length) {
        let e = r;
        while (e + 1 < segs.length && segs[e + 1][2] === segs[r][2] && segs[e + 1][0] <= segs[e][1] + 1) e++;
        const a = segs[r][0], b = segs[e][1], code = segs[r][2];
        r = e + 1;
        if (b < d0 || a > d1) continue;
        const xa = Math.max(p.l, x(a)), xb = Math.min(w - p.r, x(b));
        const room = xb - xa - 4 * this.dpr;
        if (room <= 0) continue;
        const label = (this.terrainLabels && this.terrainLabels[code]) || code;
        const shrt = label.split(' / ')[0];       // repli : premier mot avant « / »
        const txt = ctx.measureText(label).width <= room ? label
          : (ctx.measureText(shrt).width <= room ? shrt : null);
        if (!txt) continue;
        // contour sombre + remplissage blanc : lisible sur fonds clairs (gravier) et foncés
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 2.5 * this.dpr;
        ctx.strokeText(txt, (xa + xb) / 2, yMid);
        ctx.fillStyle = 'rgba(255,255,255,0.96)';
        ctx.fillText(txt, (xa + xb) / 2, yMid);
      }

      // --- courabilité des descentes : bandeau juste au-dessus + étiquette ---
      if (this.descents && this.descents.length) {
        const rBand = 7 * this.dpr;
        const rTop = yTop - rBand - 2 * this.dpr;
        for (const dn of this.descents) {
          if (dn.endD < d0 || dn.startD > d1) continue;
          const xa = Math.max(p.l, x(dn.startD)), xb = Math.min(w - p.r, x(dn.endD));
          if (xb <= xa) continue;
          ctx.fillStyle = dn.color;
          ctx.fillRect(xa, rTop, xb - xa, rBand);
          // étiquette « ↓ L km · <niveau> » si la place le permet
          ctx.font = `700 ${9.5 * this.dpr}px system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          const kmD = ((dn.endD - dn.startD) / 1000).toFixed(1);
          const full = `↓ ${kmD} km · ${dn.label}`;
          const room = xb - xa - 4 * this.dpr;
          const txt = ctx.measureText(full).width <= room ? full
            : (ctx.measureText(dn.label).width <= room ? dn.label : null);
          if (txt) {
            ctx.fillStyle = 'rgba(255,255,255,0.92)';
            ctx.fillText(txt, (xa + xb) / 2, rTop - 1 * this.dpr);
          }
        }
      }
    }

    // --- zones de côtes (surlignage + étiquette) ---
    for (const c of this.climbs) {
      if (c.endD < d0 || c.startD > d1) continue;
      const cx0 = Math.max(p.l, x(c.startD));
      const cx1 = Math.min(w - p.r, x(c.endD));
      ctx.fillStyle = 'rgba(210,59,59,0.10)';
      ctx.fillRect(cx0, p.t, cx1 - cx0, s.plotH);
      // étiquette : longueur · pente · catégorie · durée estimée (au sommet)
      ctx.font = `700 ${10.5 * this.dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const km = ((c.endD - c.startD) / 1000).toFixed(1);
      const cat = c.category ? ' · ' + (c.category === 'HC' ? 'HC' : 'Cat.' + c.category) : '';
      const dur = c.durLabel ? ' · ⏱ ' + c.durLabel : '';
      const full = `${km} km · ${c.avgGrade.toFixed(1)}%${cat}${dur}`;
      // sur une côte étroite, on retombe sur une version courte, puis rien
      const short = `${km} km · ${c.avgGrade.toFixed(1)}%`;
      const room = cx1 - cx0 - 4 * this.dpr;
      const label = ctx.measureText(full).width <= room ? full
        : (ctx.measureText(short).width <= room ? short : null);
      if (label) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillText(label, (cx0 + cx1) / 2, p.t + 2 * this.dpr);
      }
    }

    // --- axe distances (km) ---
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = `${11 * this.dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const spanKm = (d1 - d0) / 1000;
    const stepKm = niceStep(spanKm / 5);
    for (let km = Math.ceil((d0 / 1000) / stepKm) * stepKm; km * 1000 <= d1; km += stepKm) {
      const xx = x(km * 1000);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(xx, p.t); ctx.lineTo(xx, h - p.b); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(`${stepKm < 1 ? km.toFixed(1) : Math.round(km)}`, xx, h - p.b + 4 * this.dpr);
    }

    // --- points de passage (couleur + pictogramme si personnalisés) ---
    for (const wpt of this.waypoints) {
      if (wpt.d < d0 || wpt.d > d1) continue;
      const wp = pointAtDistance(pts, wpt.d);
      const xx = x(wpt.d), yy = y(wp.ele);
      const isBar = !!wpt.cutoff;                        // barrière horaire
      const icons = Array.isArray(wpt.icons) ? wpt.icons : (wpt.icon ? [wpt.icon] : []);
      const col = wpt.color || (isBar ? '#e0484a' : '#78beff');
      // ligne verticale : pleine et marquée pour une barrière, pointillée sinon
      ctx.strokeStyle = withAlpha(col, isBar ? 0.85 : 0.5);
      ctx.lineWidth = (isBar ? 1.6 : 1) * this.dpr;
      ctx.setLineDash(isBar ? [] : [3 * this.dpr, 3 * this.dpr]);
      ctx.beginPath(); ctx.moveTo(xx, p.t); ctx.lineTo(xx, h - p.b); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1 * this.dpr;
      ctx.beginPath(); ctx.arc(xx, yy, (icons.length || isBar ? 4.5 : 3.5) * this.dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // ⏱ en haut de la ligne pour signaler une barrière horaire
      if (isBar) {
        ctx.font = `${12 * this.dpr}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText('⏱', xx, p.t + 1 * this.dpr);
      }
      // pictogramme(s) au-dessus du point : EN COLONNE, l'un au-dessus de l'autre,
      // chacun distinct (pas de chevauchement).
      if (icons.length) {
        ctx.font = `${13 * this.dpr}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        const ih = 15 * this.dpr;              // hauteur d'une icône (pas de recouvrement)
        icons.slice(0, 8).forEach((ic, k) => ctx.fillText(ic, xx, yy - 7 * this.dpr - k * ih));
      }
    }

    // --- marqueur départ/arrivée ---
    this._flag(x(pts[0].d), y(pts[0].ele), '#3fbf6f', s);
    this._flag(x(pts[pts.length - 1].d), y(pts[pts.length - 1].ele), '#e8613c', s);
    // barrière horaire à l'arrivée
    if (this.finishBarrier) {
      const fx = x(pts[pts.length - 1].d);
      ctx.strokeStyle = withAlpha('#e0484a', 0.85); ctx.lineWidth = 1.6 * this.dpr;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(fx, p.t); ctx.lineTo(fx, h - p.b); ctx.stroke();
      ctx.fillStyle = '#e0484a';
      ctx.font = `${12 * this.dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('⏱', fx, p.t + 1 * this.dpr);
    }

    // --- médias géolocalisés : vraie vignette (cliquable, en haut de la courbe) ---
    for (const md of this.media) {
      if (md.d < d0 || md.d > d1) continue;
      const xx = x(md.d);
      const sz = 26 * this.dpr;                 // côté de la vignette
      const cy = p.t + sz / 2 + 1 * this.dpr;   // centre vertical (haut du graphe)
      // fine ligne de repère vers la courbe
      ctx.strokeStyle = withAlpha('#eaf0f6', 0.35); ctx.lineWidth = 1 * this.dpr;
      ctx.beginPath(); ctx.moveTo(xx, cy + sz / 2); ctx.lineTo(xx, h - p.b); ctx.stroke();
      this._mediaThumb(xx, cy, sz, md);
    }

    // --- curseur position ---
    if (this.cursorD != null && this.cursorD >= d0 - 30 && this.cursorD <= d1 + 30) {
      const cp = pointAtDistance(pts, this.cursorD);
      const xx = x(this.cursorD), yy = y(cp.ele);
      // ligne verticale
      ctx.strokeStyle = '#ffd24a';
      ctx.lineWidth = 2 * this.dpr;
      ctx.beginPath(); ctx.moveTo(xx, p.t); ctx.lineTo(xx, h - p.b); ctx.stroke();
      // halo + point
      ctx.fillStyle = 'rgba(255,210,74,0.25)';
      ctx.beginPath(); ctx.arc(xx, yy, 9 * this.dpr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffd24a';
      ctx.strokeStyle = '#1a1e26';
      ctx.lineWidth = 2 * this.dpr;
      ctx.beginPath(); ctx.arc(xx, yy, 5.5 * this.dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  _flag(px, py, color, s) {
    const ctx = this.ctx, r = 4 * this.dpr;
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Vignette carrée arrondie d'un média, ombre + bordure blanche + badge vidéo. */
  _mediaThumb(cx, cy, sz, md) {
    const ctx = this.ctx, r = 5 * this.dpr;
    const x0 = cx - sz / 2, y0 = cy - sz / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 4 * this.dpr; ctx.shadowOffsetY = 1 * this.dpr;
    this._roundRect(x0, y0, sz, sz, r);
    ctx.fillStyle = '#20303f'; ctx.fill();
    ctx.restore();
    ctx.save();
    this._roundRect(x0, y0, sz, sz, r); ctx.clip();
    const img = this._imgCache && this._imgCache.get(md.url);
    if (md.kind !== 'video' && img && img._ok && img.naturalWidth) {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const scale = Math.max(sz / iw, sz / ih);
      const dw = iw * scale, dh = ih * scale;
      ctx.drawImage(img, x0 + (sz - dw) / 2, y0 + (sz - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = '#eaf0f6';
      ctx.font = `${13 * this.dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(md.kind === 'video' ? '🎬' : '📷', cx, cy);
    }
    ctx.restore();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * this.dpr;
    this._roundRect(x0, y0, sz, sz, r); ctx.stroke();
    if (md.kind === 'video') {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath(); ctx.arc(cx, cy, 7 * this.dpr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `${9 * this.dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('▶', cx + 0.5 * this.dpr, cy);
    }
  }

  // Interaction : survol/tap pour lire un point (renvoie via callback onScrub).
  // Convertit une position écran (clientX) en distance (m) sur la fenêtre courante.
  _clientXToData(clientX, clamp = false) {
    const rect = this.canvas.getBoundingClientRect();
    const p = this.pad.l * this.dpr;
    const plotW = this.canvas.width - (this.pad.l + this.pad.r) * this.dpr;
    const [d0, d1] = this._range();
    let frac = ((clientX - rect.left) * this.dpr - p) / plotW;
    if (clamp) frac = Math.max(0, Math.min(1, frac));
    return d0 + frac * (d1 - d0);
  }

  _plotGeom() {
    return {
      pL: this.pad.l * this.dpr,
      plotW: this.canvas.width - (this.pad.l + this.pad.r) * this.dpr,
    };
  }

  // Interaction multi-touch :
  //  - 1 doigt qui glisse  => déplacement latéral (pan)
  //  - 2 doigts (pinch)    => zoom + pan simultanés
  //  - tap (sans glisser)  => lecture d'un point (distance / altitude / pente)
  //  - molette (desktop)   => zoom autour du curseur
  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';

    const onDown = (e) => {
      if (!this.track) return;
      try { c.setPointerCapture?.(e.pointerId); } catch (_) { /* pointeur synthétique */ }
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._downX = e.clientX; this._downY = e.clientY;
      this._moved = false;
      this._panLastX = e.clientX;
      if (this._pointers.size === 2) { this._startPinch(); this._grab = null; return; }
      // intention à la pose du doigt : média 📷, repère bleu, point jaune, ou pan
      const md = this._mediaAt(e.clientX, e.clientY);
      const wp = md ? null : this._dotAt(e.clientX, e.clientY);
      const onCursor = this._cursorGrab(e.clientX);
      this._grab = { md, wp, scrub: !md && !!(wp || onCursor) }; // près d'un point/barre => scrub possible
    };

    const onMove = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      e.preventDefault();
      const pt = this._pointers.get(e.pointerId);
      pt.x = e.clientX; pt.y = e.clientY;

      if (this._pointers.size >= 2 && this._pinch) {
        this._applyPinch();
        this._moved = true;
        return;
      }
      // un seul doigt
      const dx = e.clientX - this._downX, dy = e.clientY - this._downY;
      if (!this._moved && Math.hypot(dx, dy) > 6) this._moved = true;
      if (!this._moved) return;
      if (this._grab && this._grab.scrub) {
        this._scrubTo(e.clientX);              // déplace la barre jaune
      } else {
        this._panBy(e.clientX - this._panLastX);
        this._panLastX = e.clientX;
        this._notifyView();
      }
    };

    const onUp = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      try { c.releasePointerCapture?.(e.pointerId); } catch (_) { /* pointeur synthétique */ }
      const wasPinch = this._pointers.size >= 2;
      this._pointers.delete(e.pointerId);

      if (wasPinch) {
        this._pinch = null;
        if (this._pointers.size === 1) {
          const rem = [...this._pointers.values()][0];
          this._panLastX = rem.x; this._downX = rem.x; this._downY = rem.y; this._moved = true;
        }
        return;
      }
      if (!this._moved) {
        // tap : sur un média → photo ; sur un repère → sa fiche ; sinon → point de la courbe
        if (this._grab && this._grab.md) {
          if (this.onMediaTap) this.onMediaTap(this._grab.md);
        } else if (this._grab && this._grab.wp) {
          this.setCursor(this._grab.wp.d);
          if (this.onWaypointTap) this.onWaypointTap(this._grab.wp);
        } else {
          this._scrubTo(e.clientX);
        }
      } else if (this._grab && this._grab.scrub) {
        this._scrubTo(e.clientX); // fin de glissé : fige le point
      }
      this._grab = null;
    };

    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);

    // Molette (desktop) : zoom autour du curseur
    c.addEventListener('wheel', (e) => {
      if (!this.track) return;
      e.preventDefault();
      const dCenter = this._clientXToData(e.clientX, true);
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      this._zoomAround(dCenter, factor);
      this._notifyView();
    }, { passive: false });

    // Double-clic / double-tap : réinitialise
    c.addEventListener('dblclick', () => { this.setView('full'); this._notifyView(); });
  }

  _startPinch() {
    const pts = [...this._pointers.values()];
    const a = pts[0], b = pts[1];
    const g = this._plotGeom();
    const rect = this.canvas.getBoundingClientRect();
    const relA = (a.x - rect.left) * this.dpr;
    const relB = (b.x - rect.left) * this.dpr;
    this._pinch = {
      relA, relB,
      dA: this._clientXToData(a.x),
      dB: this._clientXToData(b.x),
      pL: g.pL, plotW: g.plotW,
    };
  }

  _applyPinch() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2 || !this._pinch) return;
    const rect = this.canvas.getBoundingClientRect();
    const relA = (pts[0].x - rect.left) * this.dpr;
    const relB = (pts[1].x - rect.left) * this.dpr;
    const { dA, dB, pL, plotW } = this._pinch;
    if (Math.abs(dA - dB) < 1) return;
    // sm = px par mètre ; on résout la fenêtre qui garde dA sous relA et dB sous relB
    const sm = (relA - relB) / (dA - dB);
    if (!isFinite(sm) || sm === 0) return;
    const D0 = dA - (relA - pL) / sm;
    const D1 = D0 + plotW / sm;
    this.win = D1 > D0 ? [D0, D1] : [D1, D0];
    this._clampWin();
    this.render();
  }

  _panBy(dxClient) {
    const g = this._plotGeom();
    const [d0, d1] = this._range();
    const sm = g.plotW / Math.max(1, d1 - d0); // px par mètre
    const dd = -(dxClient * this.dpr) / sm;
    this.win = [d0 + dd, d1 + dd];
    this._clampWin();
    this.render();
  }

  _zoomAround(dCenter, factor) {
    const [d0, d1] = this._range();
    const span = (d1 - d0) * factor;
    const frac = (dCenter - d0) / Math.max(1, d1 - d0);
    this.win = [dCenter - span * frac, dCenter + span * (1 - frac)];
    this._clampWin();
    this.render();
  }

  _toCanvasPx(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { px: (clientX - r.left) * this.dpr, py: (clientY - r.top) * this.dpr };
  }

  /** Média 📷 sous le doigt (bande du haut de la courbe), ou null. */
  _mediaAt(clientX, clientY) {
    if (!this.media || !this.media.length) return null;
    const s = this._scales();
    const [d0, d1] = this._range();
    const { px, py } = this._toCanvasPx(clientX, clientY);
    if (py > s.p.t + 30 * this.dpr) return null; // seulement la bande des vignettes en haut
    let best = null, bd = 16 * this.dpr;
    for (const md of this.media) {
      if (md.d == null || md.d < d0 || md.d > d1) continue;
      const dx = Math.abs(s.x(md.d) - px);
      if (dx < bd) { bd = dx; best = md; }
    }
    return best;
  }

  /** Repère (point bleu) sous le doigt, capture serrée en x ET y, ou null. */
  _dotAt(clientX, clientY) {
    if (!this.waypoints || !this.waypoints.length) return null;
    const s = this._scales();
    const [d0, d1] = this._range();
    const { px, py } = this._toCanvasPx(clientX, clientY);
    const r = 15 * this.dpr;
    let best = null, bestDist = r;
    for (const wp of this.waypoints) {
      if (wp.d < d0 || wp.d > d1) continue;
      const wy = s.y(pointAtDistance(this.track.points, wp.d).ele);
      const dist = Math.hypot(s.x(wp.d) - px, wy - py);
      if (dist < bestDist) { bestDist = dist; best = wp; }
    }
    return best;
  }

  /** Le doigt attrape-t-il la barre jaune (curseur) ? Proximité horizontale sur
      toute la hauteur → facile à saisir pour glisser. */
  _cursorGrab(clientX) {
    if (this.cursorD == null || !this.track) return false;
    const s = this._scales();
    const [d0, d1] = this._range();
    if (this.cursorD < d0 || this.cursorD > d1) return false;
    const px = this._toCanvasPx(clientX, 0).px;
    return Math.abs(s.x(this.cursorD) - px) < 16 * this.dpr;
  }

  /** Place le curseur jaune à la position du doigt et remonte le point sélectionné. */
  _scrubTo(clientX) {
    const d = this._clientXToData(clientX, true);
    this.setCursor(d);
    const pt = pointAtDistance(this.track.points, d);
    if (this.onScrub) this.onScrub(d, pt);
    if (this.onPointSelect) this.onPointSelect(d);
  }

  _notifyView() { if (this.onViewChange) this.onViewChange(); }

  _showTip(d, pt) {
    if (!this.tip) return;
    const s = this._scales();
    const rect = this.canvas.getBoundingClientRect();
    const xCss = s.x(d) / this.dpr;
    this.tip.hidden = false;
    this.tip.innerHTML =
      `<b>${(d / 1000).toFixed(2)} km</b> · ${Math.round(pt.ele)} m · ${(pt.grade || 0).toFixed(1)}%`;
    const half = this.tip.offsetWidth / 2;
    let left = Math.max(half + 4, Math.min(rect.width - half - 4, xCss));
    this.tip.style.left = `${left}px`;
  }
}

function niceStep(x) {
  if (x <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / pow;
  let step;
  if (n < 1.5) step = 1; else if (n < 3.5) step = 2; else if (n < 7.5) step = 5; else step = 10;
  return step * pow;
}

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}
