// Orchestration de l'application Run-Nav.

import { parseGpx, buildTrack } from './gpx.js';
import { projectOnTrack, pointAtDistance } from './geo.js';
import { detectClimbs, currentClimb } from './climbs.js';
import { ProfileChart } from './profile.js';
import { RaceMap } from './map.js';
import { demoGpx } from './demo.js';
import {
  buildTimeModel, calibrateForAvgSpeed, calibrateForTotalTime,
  timeAtDistance, fmtDuration, fmtClock,
} from './pacing.js';

const $ = (id) => document.getElementById(id);

const state = {
  track: null,
  climbs: [],
  waypoints: [],       // { d, lat, lon, ele, label }
  map: null,
  profile: null,
  // position live
  watchId: null,
  lastFix: null,       // { lat, lon, d, index, acc, t }
  hint: 0,
  follow: true,
  // vitesse
  speedSamples: [],    // {t, d}
  liveSpeed: 0,        // m/s
  // pacing
  paceMode: 'live',    // live | manual | target
  manualKmh: 12,
  targetSec: 4.5 * 3600,
  startMode: 'now',    // now | clock
  startClock: null,    // ms
  startedAt: null,     // ms du démarrage réel du suivi
  refSpeedFlat: null,  // m/s à plat (modèle)
  cumTime: null,
};

// ------------------------------------------------------------------ INIT UI
function init() {
  $('gpx-input').addEventListener('change', onFilePicked);
  $('demo-btn').addEventListener('click', () => loadGpxText(demoGpx(), 'Parcours démo'));

  $('act-load').addEventListener('click', () => $('gpx-input').click());
  $('act-start').addEventListener('click', toggleTracking);
  $('act-wpt').addEventListener('click', addWaypointAtCursor);
  $('act-pace').addEventListener('click', () => openSheet(true));

  $('pf-full').addEventListener('click', () => setProfileView('full'));
  $('pf-zoom').addEventListener('click', () => setProfileView('climb'));
  $('pf-follow').addEventListener('click', () => {
    state.follow = !state.follow;
    $('pf-follow').classList.toggle('active', state.follow);
    if (state.follow && state.lastFix) recenter();
  });

  // panneau allure
  document.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', () => openSheet(false)));
  document.querySelectorAll('[data-pacemode]').forEach((b) =>
    b.addEventListener('click', () => setPaceMode(b.dataset.pacemode)));
  document.querySelectorAll('[data-startmode]').forEach((b) =>
    b.addEventListener('click', () => setStartMode(b.dataset.startmode)));
  $('manual-speed').addEventListener('input', (e) => {
    state.manualKmh = parseFloat(e.target.value) || 12; recomputePacing();
  });
  $('target-time').addEventListener('input', (e) => {
    const s = parseHHMM(e.target.value); if (s) { state.targetSec = s; recomputePacing(); }
  });
  $('start-clock').addEventListener('input', (e) => {
    state.startClock = clockToMs(e.target.value); recomputePacing();
  });

  window.addEventListener('resize', () => {
    if (state.profile) state.profile.resize();
    if (state.map) state.map.invalidate();
  });
}

// ------------------------------------------------------------------ CHARGEMENT GPX
function onFilePicked(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadGpxText(reader.result, file.name.replace(/\.gpx$/i, ''));
  reader.onerror = () => showWelcomeError('Impossible de lire le fichier.');
  reader.readAsText(file);
  e.target.value = '';
}

function loadGpxText(text, fallbackName) {
  try {
    const { points, name } = parseGpx(text);
    const track = buildTrack(points);
    track.name = name || fallbackName || 'Parcours';
    startApp(track);
  } catch (err) {
    showWelcomeError(err.message || 'Erreur de lecture du GPX.');
  }
}

function showWelcomeError(msg) {
  const el = $('welcome-error');
  el.textContent = msg;
  el.hidden = false;
}

// ------------------------------------------------------------------ DÉMARRAGE APP
function startApp(track) {
  state.track = track;
  state.climbs = detectClimbs(track.points);
  state.waypoints = autoWaypoints(track);

  $('welcome').hidden = true;
  $('app').hidden = false;

  // Carte : isolée dans un try/catch pour que le profil fonctionne même si
  // la librairie carto n'est pas disponible (réseau coupé, etc.).
  try {
    if (typeof L === 'undefined') throw new Error('Leaflet indisponible');
    if (!state.map) {
      state.map = new RaceMap('map');
      state.map.onMapTap = (latlng) => onMapTap(latlng);
    }
    state.map.clearWaypoints();
    state.map.setTrack(track.points);
    state.map.invalidate();
  } catch (err) {
    state.map = null;
    $('map').innerHTML = '<div class="map-fallback">🗺️ Carte indisponible (hors ligne)</div>';
    console.warn('Carte non initialisée :', err.message);
  }

  if (!state.profile) {
    state.profile = new ProfileChart($('profile'), $('profile-tip'));
    state.profile.onScrub = (d, pt) => onScrub(d, pt);
    state.profile.onScrubEnd = () => { if (!state.lastFix && state.map) { state.map.clearCursor(); } };
  }
  state.profile.setTrack(track, state.climbs);
  requestAnimationFrame(() => state.profile.resize());

  renderWaypointMarkers();
  recomputePacing();
  updateStatbar(0);
  setProfileView('full');
  toast(`${track.name} · ${(track.total / 1000).toFixed(1)} km · ${track.gain} m D+`);
}

// ------------------------------------------------------------------ POINTS DE PASSAGE AUTO
function autoWaypoints(track) {
  const wpts = [];
  // un point tous les 5 km si le parcours est long, sinon tous les 2 km
  const stepKm = track.total > 30000 ? 5 : track.total > 12000 ? 2 : 1;
  for (let km = stepKm; km * 1000 < track.total; km += stepKm) {
    const pt = pointAtDistance(track.points, km * 1000);
    wpts.push({ d: km * 1000, lat: pt.lat, lon: pt.lon, ele: pt.ele, label: `${km} km`, auto: true });
  }
  // sommets de côtes
  for (const c of state.climbs) {
    const pt = pointAtDistance(track.points, c.endD);
    wpts.push({ d: c.endD, lat: pt.lat, lon: pt.lon, ele: pt.ele, label: `Sommet (${c.gain} m)`, auto: true, summit: true });
  }
  wpts.sort((a, b) => a.d - b.d);
  return wpts;
}

function renderWaypointMarkers() {
  if (state.map) {
    state.map.clearWaypoints();
    for (const w of state.waypoints) {
      if (!w.auto || w.summit) state.map.addWaypointMarker(w);
    }
  }
  state.profile.setWaypoints(state.waypoints);
}

// ------------------------------------------------------------------ SUIVI GPS
function toggleTracking() {
  if (state.watchId != null) { stopTracking(); return; }
  if (!('geolocation' in navigator)) { toast('Géolocalisation non disponible.'); return; }

  state.startedAt = Date.now();
  if (state.startMode === 'now') state.startClock = state.startedAt;
  recomputePacing();

  state.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 15000,
  });
  const btn = $('act-start');
  btn.classList.add('tracking');
  btn.querySelector('.act-ico').textContent = '⏸';
  btn.querySelector('span:last-child').textContent = 'Suivi actif';
  toast('Suivi GPS démarré.');
}

function stopTracking() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  const btn = $('act-start');
  btn.classList.remove('tracking');
  btn.querySelector('.act-ico').textContent = '▶';
  btn.querySelector('span:last-child').textContent = 'Démarrer suivi GPS';
  toast('Suivi arrêté.');
}

function onGeoError(err) {
  toast(err.code === 1 ? 'Accès à la position refusé.' : 'Signal GPS indisponible.');
}

function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy, heading, speed } = pos.coords;
  const now = pos.timestamp || Date.now();

  const proj = projectOnTrack({ lat, lon }, state.track.points, state.hint);
  state.hint = proj.index;
  const projected = pointAtDistance(state.track.points, proj.along);

  state.lastFix = { lat, lon, d: proj.along, index: proj.index, acc: accuracy, off: proj.dist, t: now };

  // vitesse : préfère la vitesse GPS si dispo, sinon dérive de la distance parcourue
  if (speed != null && isFinite(speed) && speed >= 0 && speed <= MAX_PLAUSIBLE_MS) {
    state.liveSpeed = speed;
  } else {
    updateLiveSpeedFromTrack(proj.along, now);
  }

  // carte
  if (state.map) {
    state.map.setPosition(lat, lon, accuracy, heading);
    state.map.setProgress(proj.index, projected);
    if (state.follow) recenter();
    state.map.highlightCursor(projected.lat, projected.lon);
  }

  // profil
  state.profile.setCursor(proj.along);

  updateStatbar(proj.along, proj.dist);
  updateClimbBanner(proj.along);
  if (state.paceMode === 'live') recomputePacing();
}

const MAX_PLAUSIBLE_MS = 30; // 108 km/h : au-delà = glitch GPS, on ignore

function updateLiveSpeedFromTrack(d, t) {
  state.speedSamples.push({ d, t });
  // fenêtre glissante de 20 s
  const cutoff = t - 20000;
  while (state.speedSamples.length > 2 && state.speedSamples[0].t < cutoff) state.speedSamples.shift();
  const a = state.speedSamples[0], b = state.speedSamples[state.speedSamples.length - 1];
  const dt = (b.t - a.t) / 1000;
  const dd = b.d - a.d;
  if (dt > 2 && dd >= 0) {
    const v = dd / dt;
    if (v <= MAX_PLAUSIBLE_MS) state.liveSpeed = v;
  }
}

function recenter() {
  if (state.map && state.lastFix) state.map.panTo(state.lastFix.lat, state.lastFix.lon);
}

// ------------------------------------------------------------------ BANDEAU STATS
function updateStatbar(d, off) {
  const t = state.track;
  const remainKm = Math.max(0, (t.total - d) / 1000);
  $('st-dist').textContent = `${(d / 1000).toFixed(2)} / ${(t.total / 1000).toFixed(1)}`;

  // D+ restant
  const remainGain = remainingGain(d);
  $('st-climb').textContent = `${remainGain} m`;

  // pente locale
  const here = pointAtDistance(t.points, d);
  const grade = gradeAt(d);
  const gEl = $('st-grade');
  gEl.textContent = `${grade >= 0 ? '+' : ''}${grade.toFixed(1)} %`;
  gEl.style.color = gradeCss(grade);

  // vitesse
  const kmh = state.liveSpeed * 3.6;
  $('st-speed').textContent = state.watchId != null ? `${kmh.toFixed(1)} km/h` : '–';

  // ETA arrivée
  $('st-eta').textContent = etaText(d);

  // avertissement hors-trace
  const btn = $('act-start');
  if (off != null && off > 40 && state.watchId != null) {
    btn.classList.add('offtrack');
  } else {
    btn.classList.remove('offtrack');
  }
}

function remainingGain(d) {
  const pts = state.track.points;
  let gain = 0;
  // trouve l'index de départ
  let i = 1;
  while (i < pts.length && pts[i].d < d) i++;
  for (; i < pts.length; i++) {
    const dz = pts[i].ele - pts[i - 1].ele;
    if (dz > 0) gain += dz;
  }
  return Math.round(gain);
}

function gradeAt(d) {
  const pts = state.track.points;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].d < d) lo = mid; else hi = mid;
  }
  return pts[lo].grade || 0;
}

function etaText(d) {
  if (!state.cumTime) return '–';
  const remainSec = state.cumTime[state.cumTime.length - 1] - timeAtDistance(state.track.points, state.cumTime, d);
  if (!isFinite(remainSec)) return '–';
  const base = state.startClock || Date.now();
  const arrival = (state.startedAt ? Date.now() : base) + remainSec * 1000;
  return fmtClock(arrival);
}

// ------------------------------------------------------------------ BANDEAU CÔTE
function updateClimbBanner(d) {
  const banner = $('climb-banner');
  const cur = currentClimb(state.climbs, d);
  if (!cur) { banner.hidden = true; return; }
  banner.hidden = false;

  const c = cur.climb;
  if (cur.state === 'in') {
    const togo = c.endD - d;
    const doneRatio = (d - c.startD) / Math.max(1, c.length);
    const here = pointAtDistance(state.track.points, d);
    const ascentLeft = Math.max(0, Math.round(c.topEle - here.ele));
    $('cb-name').textContent = `Côte en cours${c.category ? ' · ' + (c.category === 'HC' ? 'HC' : 'Cat. ' + c.category) : ''}`;
    $('cb-togo').textContent = fmtDist(togo);
    $('cb-ascent').textContent = `${ascentLeft} m`;
    $('cb-avg').textContent = `${c.avgGrade.toFixed(1)} %`;
    const pct = Math.round(doneRatio * 100);
    $('cb-fill').style.width = `${Math.max(3, Math.min(100, pct))}%`;
    $('cb-pct').textContent = `${pct} %`;
  } else {
    const togo = c.startD - d;
    $('cb-name').textContent = `Prochaine côte${c.category ? ' · ' + (c.category === 'HC' ? 'HC' : 'Cat. ' + c.category) : ''}`;
    $('cb-togo').textContent = fmtDist(togo);
    $('cb-ascent').textContent = `${c.gain} m`;
    $('cb-avg').textContent = `${c.avgGrade.toFixed(1)} %`;
    $('cb-fill').style.width = '0%';
    $('cb-pct').textContent = 'à venir';
  }
}

// ------------------------------------------------------------------ VUE PROFIL
function setProfileView(view) {
  $('pf-full').classList.toggle('active', view === 'full');
  $('pf-zoom').classList.toggle('active', view === 'climb');
  if (view === 'climb') {
    const d = state.lastFix ? state.lastFix.d : 0;
    const cur = currentClimb(state.climbs, d);
    if (cur) {
      const c = cur.climb;
      const pad = Math.max(200, c.length * 0.15);
      state.profile.setView('climb', [Math.max(0, c.startD - pad), Math.min(state.track.total, c.endD + pad)]);
    } else {
      // pas de côte : zoome autour de la position
      const w = 2000;
      state.profile.setView('climb', [Math.max(0, d - w / 2), Math.min(state.track.total, d + w / 2)]);
      toast('Aucune côte détectée ici — zoom sur ta position.');
    }
  } else {
    state.profile.setView('full');
  }
}

// ------------------------------------------------------------------ SCRUB (lecture manuelle sur profil)
function onScrub(d, pt) {
  state.scrubD = d;
  const p = pointAtDistance(state.track.points, d);
  if (state.map) state.map.highlightCursor(p.lat, p.lon);
  if (!state.lastFix) state.profile.setCursor(d);
}

// ------------------------------------------------------------------ POINTS DE PASSAGE MANUELS
function onMapTap(latlng) {
  const proj = projectOnTrack({ lat: latlng.lat, lon: latlng.lng }, state.track.points, 0);
  if (proj.dist > 120) { toast('Touche plus près de la trace pour poser un point.'); return; }
  addWaypoint(proj.along);
}

function addWaypointAtCursor() {
  const d = state.lastFix ? state.lastFix.d : (state.scrubD || 0);
  addWaypoint(d);
}

function addWaypoint(d) {
  const pt = pointAtDistance(state.track.points, d);
  const label = `Passage ${(d / 1000).toFixed(1)} km`;
  const w = { d, lat: pt.lat, lon: pt.lon, ele: pt.ele, label, auto: false };
  state.waypoints.push(w);
  state.waypoints.sort((a, b) => a.d - b.d);
  if (state.map) state.map.addWaypointMarker(w);
  state.profile.setWaypoints(state.waypoints);
  recomputePacing();
  toast(`Point ajouté à ${(d / 1000).toFixed(1)} km.`);
}

// ------------------------------------------------------------------ ALLURE / TEMPS DE PASSAGE
function setPaceMode(mode) {
  state.paceMode = mode;
  document.querySelectorAll('[data-pacemode]').forEach((b) =>
    b.classList.toggle('active', b.dataset.pacemode === mode));
  $('field-manual').hidden = mode !== 'manual';
  $('field-target').hidden = mode !== 'target';
  recomputePacing();
}

function setStartMode(mode) {
  state.startMode = mode;
  document.querySelectorAll('[data-startmode]').forEach((b) =>
    b.classList.toggle('active', b.dataset.startmode === mode));
  $('start-clock').hidden = mode !== 'clock';
  if (mode === 'now') state.startClock = Date.now();
  recomputePacing();
}

function recomputePacing() {
  if (!state.track) return;
  const pts = state.track.points;

  // détermine la vitesse de référence à plat selon le mode
  let ref;
  if (state.paceMode === 'live' && state.liveSpeed > 0.6) {
    // calibre le modèle pour que la vitesse moyenne globale ≈ vitesse live actuelle.
    const avgKmh = state.liveSpeed * 3.6;
    ref = calibrateForAvgSpeed(pts, Math.max(3, Math.min(45, avgKmh)));
  } else if (state.paceMode === 'manual') {
    ref = calibrateForAvgSpeed(pts, state.manualKmh);
  } else if (state.paceMode === 'target') {
    ref = calibrateForTotalTime(pts, state.targetSec);
  } else {
    ref = calibrateForAvgSpeed(pts, state.manualKmh); // repli
  }
  state.refSpeedFlat = ref;
  state.cumTime = buildTimeModel(pts, ref);

  renderPaceTable();
  if (state.lastFix) { updateStatbar(state.lastFix.d, state.lastFix.off); }
  else { $('st-eta').textContent = etaText(0); }
}

function renderPaceTable() {
  const tbl = $('pace-table');
  const pts = state.track.points;
  const cum = state.cumTime;
  if (!cum) { tbl.innerHTML = ''; return; }

  const start = state.startClock || Date.now();
  const totalSec = cum[cum.length - 1];
  const avgKmh = (state.track.total / totalSec) * 3.6;
  $('pace-summary').textContent =
    `Total estimé ${fmtDuration(totalSec)} · ${avgKmh.toFixed(1)} km/h moy. · départ ${fmtClock(start)}`;

  // lignes : points de passage + arrivée
  const rows = state.waypoints.map((w) => ({ d: w.d, label: w.label, summit: w.summit }));
  rows.push({ d: state.track.total, label: '🏁 Arrivée', summit: false });

  const posD = state.lastFix ? state.lastFix.d : -1;
  let html = `<div class="pace-row head"><span>Point</span><span>km</span><span>Passage</span><span>Δ</span></div>`;
  for (const r of rows) {
    const tSec = timeAtDistance(pts, cum, r.d);
    const clock = fmtClock(start + tSec * 1000);
    const passed = posD >= r.d - 20;
    let delta = '';
    if (state.lastFix && !passed) {
      const nowSec = timeAtDistance(pts, cum, posD);
      delta = '+' + fmtDuration(tSec - nowSec);
    } else if (passed) {
      delta = '✓';
    }
    html += `<div class="pace-row${passed ? ' passed' : ''}${r.summit ? ' summit' : ''}">
      <span class="pr-label">${r.label}</span>
      <span>${(r.d / 1000).toFixed(1)}</span>
      <span class="pr-clock">${clock}</span>
      <span class="pr-delta">${delta}</span>
    </div>`;
  }
  tbl.innerHTML = html;
}

// ------------------------------------------------------------------ FEUILLE / SHEET
function openSheet(open) {
  $('pace-sheet').hidden = !open;
  if (open) renderPaceTable();
}

// ------------------------------------------------------------------ UTILS UI
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => (el.hidden = true), 300); }, 2600);
}

function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}
function gradeCss(g) {
  const a = Math.abs(g);
  if (g < -1) return '#4aa3ff';
  if (a < 3) return '#3fbf6f';
  if (a < 6) return '#c9d43f';
  if (a < 9) return '#f0a63a';
  if (a < 12) return '#e8613c';
  return '#ff5a4a';
}
function parseHHMM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  return (parseInt(m[1]) * 3600) + (parseInt(m[2]) * 60);
}
function clockToMs(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return Date.now();
  const d = new Date();
  d.setHours(parseInt(m[1]), parseInt(m[2]), 0, 0);
  return d.getTime();
}

init();
