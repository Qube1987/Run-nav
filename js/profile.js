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
    this.cursorD = null;      // distance de la position courante (m)
    this.view = 'full';       // 'full' | 'climb'
    this.viewRange = null;    // [startD, endD] en mode climb
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.pad = { l: 44, r: 14, t: 16, b: 26 };
    this._bind();
  }

  setTrack(track, climbs) {
    this.track = track;
    this.climbs = climbs || [];
    this.render();
  }
  setWaypoints(wpts) { this.waypoints = wpts; this.render(); }
  setCursor(d) { this.cursorD = d; this.render(); }
  setView(view, range) { this.view = view; this.viewRange = range || null; this.render(); }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, rect.width * this.dpr);
    this.canvas.height = Math.max(1, rect.height * this.dpr);
    this.render();
  }

  _range() {
    if (this.view === 'climb' && this.viewRange) return this.viewRange;
    return [0, this.track ? this.track.total : 1];
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

    // --- zones de côtes (surlignage + étiquette) ---
    for (const c of this.climbs) {
      if (c.endD < d0 || c.startD > d1) continue;
      const cx0 = Math.max(p.l, x(c.startD));
      const cx1 = Math.min(w - p.r, x(c.endD));
      ctx.fillStyle = 'rgba(210,59,59,0.10)';
      ctx.fillRect(cx0, p.t, cx1 - cx0, s.plotH);
      // étiquette pente moyenne au sommet
      if (cx1 - cx0 > 34 * this.dpr) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = `700 ${10.5 * this.dpr}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = `${c.avgGrade.toFixed(1)}%${c.category ? ' · ' + (c.category === 'HC' ? 'HC' : 'Cat.' + c.category) : ''}`;
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

    // --- points de passage ---
    for (const wpt of this.waypoints) {
      if (wpt.d < d0 || wpt.d > d1) continue;
      const wp = pointAtDistance(pts, wpt.d);
      const xx = x(wpt.d), yy = y(wp.ele);
      ctx.strokeStyle = 'rgba(120,190,255,0.5)';
      ctx.setLineDash([3 * this.dpr, 3 * this.dpr]);
      ctx.beginPath(); ctx.moveTo(xx, p.t); ctx.lineTo(xx, h - p.b); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#78beff';
      ctx.beginPath(); ctx.arc(xx, yy, 3.5 * this.dpr, 0, Math.PI * 2); ctx.fill();
    }

    // --- marqueur départ/arrivée ---
    this._flag(x(pts[0].d), y(pts[0].ele), '#3fbf6f', s);
    this._flag(x(pts[pts.length - 1].d), y(pts[pts.length - 1].ele), '#e8613c', s);

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

  // Interaction : survol/tap pour lire un point (renvoie via callback onScrub).
  _bind() {
    const handler = (clientX) => {
      if (!this.track) return;
      const rect = this.canvas.getBoundingClientRect();
      const s = this._scales();
      const relX = (clientX - rect.left) * this.dpr;
      const [d0, d1] = this._range();
      const span = d1 - d0;
      const frac = (relX - s.p.l) / s.plotW;
      const d = Math.max(d0, Math.min(d1, d0 + frac * span));
      const pt = pointAtDistance(this.track.points, d);
      if (this.onScrub) this.onScrub(d, pt);
      this._showTip(d, pt, s);
    };
    const move = (e) => { e.preventDefault(); handler((e.touches ? e.touches[0] : e).clientX); };
    const end = () => { if (this.tip) this.tip.hidden = true; if (this.onScrubEnd) this.onScrubEnd(); };
    this.canvas.addEventListener('mousemove', move);
    this.canvas.addEventListener('mouseleave', end);
    this.canvas.addEventListener('touchstart', move, { passive: false });
    this.canvas.addEventListener('touchmove', move, { passive: false });
    this.canvas.addEventListener('touchend', end);
  }

  _showTip(d, pt, s) {
    if (!this.tip) return;
    const rect = this.canvas.getBoundingClientRect();
    const xCss = s.x(d) / this.dpr;
    this.tip.hidden = false;
    this.tip.innerHTML =
      `<b>${(d / 1000).toFixed(2)} km</b> · ${Math.round(pt.ele)} m · ${(pt.grade || 0).toFixed(1)}%`;
    const half = this.tip.offsetWidth / 2;
    let left = xCss;
    left = Math.max(half + 4, Math.min(rect.width - half - 4, left));
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
