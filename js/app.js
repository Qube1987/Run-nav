// Orchestration de l'application Run-Nav.

import { parseGpx, buildTrack } from './gpx.js';
import { projectOnTrack, pointAtDistance } from './geo.js';
import { detectClimbs, currentClimb } from './climbs.js';
import { ProfileChart } from './profile.js';
import { RaceMap } from './map.js';
import { demoGpx } from './demo.js';
import {
  buildTimeModel, calibrateForAvgSpeed, calibrateForTotalTime,
  calibrateForTimeAtDistance, avgSpeedFor, setActivityType,
  timeAtDistance, fmtDuration, fmtClock,
} from './pacing.js';
import {
  hashTrack, localSave, localLoad, localGet, localSet,
  cloudSaveFull, cloudSaveConfig, cloudLoad, makeCode,
  cloudListRaces, cloudDeleteRace,
} from './storage.js';
import {
  isLoggedIn, currentUser, signup, login, logout,
} from './auth.js';

const $ = (id) => document.getElementById(id);

// Pictogrammes & couleurs assignables à un point de passage.
const WPT_ICONS = ['📍', '🥤', '🍽️', '⛲', '🚰', '🏨', '🛏️', '⛺', '🪦', '🚻', '⚕️', '🅿️', '⛰️', '🌲', '📷', '⚠️', '🚩', '🏁'];
const WPT_COLORS = ['#ff5a3c', '#f0a63a', '#ffd24a', '#3fbf6f', '#4aa3ff', '#b06fff', '#ffffff'];

const state = {
  track: null,
  climbs: [],
  waypoints: [],       // { d, lat, lon, ele, label }
  map: null,
  profile: null,
  // position live
  watchId: null,
  lastFix: null,       // { lat, lon, d, index, acc, t, onRoute }
  onRoute: null,       // null=inconnu, true/false selon l'éloignement à la trace
  hint: 0,
  follow: true,
  // vitesse
  speedSamples: [],    // {t, d}
  liveSpeed: 0,        // m/s
  // pacing
  paceMode: 'live',    // live | manual | target
  activity: 'run',     // run | bike — modèle de pente
  manualKmh: 10,
  speedCustomized: false, // true dès que l'utilisateur fixe une vitesse
  targetSec: 4.5 * 3600,
  startClock: null,    // ms — heure de départ (planifiée ou réelle)
  nowClockStr: null,   // "HH:MM" saisi manuellement, sinon null = heure du téléphone
  startedAt: null,     // ms du démarrage réel du suivi
  refSpeedFlat: null,  // m/s à plat (modèle)
  cumTime: null,
  // persistance
  gpxKey: null,
  cloudCode: null,
  finishMeta: { info: '', cutoff: null, label: '🏁 Arrivée', icon: '🏁', color: '' },
  _saveT: null,
};

// ------------------------------------------------------------------ INIT UI
function init() {
  $('gpx-input').addEventListener('change', onFilePicked);
  $('demo-btn').addEventListener('click', () => loadGpxText(demoGpx(), 'Parcours démo'));

  $('welcome-restore-btn').addEventListener('click', () => restoreFromCode($('welcome-code').value));
  $('welcome-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') restoreFromCode($('welcome-code').value);
  });

  // Compte : inscription / connexion / mes épreuves
  $('auth-login').addEventListener('click', () => doAuth('login'));
  $('auth-signup').addEventListener('click', () => doAuth('signup'));
  $('auth-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth('login'); });
  $('auth-logout').addEventListener('click', () => { logout(); updateAuthUI(); });
  $('races-refresh').addEventListener('click', loadRaces);
  $('races-list').addEventListener('click', onRacesClick);
  updateAuthUI();

  $('act-load').addEventListener('click', () => $('gpx-input').click());
  $('act-start').addEventListener('click', toggleTracking);
  $('act-wpt').addEventListener('click', addWaypointAtCursor);
  $('act-pace').addEventListener('click', () => openSheet(true));

  $('pf-full').addEventListener('click', () => setProfileView('full'));
  $('pf-zoom').addEventListener('click', () => setProfileView('climb'));
  $('pf-follow').addEventListener('click', () => {
    state.follow = !state.follow;
    $('pf-follow').classList.toggle('active', state.follow);
    if (state.follow && state.lastFix) {
      recenter();
      if (state.lastFix.onRoute && state.profile.isZoomed()) state.profile.centerOn(state.lastFix.d);
    }
  });

  // panneau allure
  document.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', () => openSheet(false)));
  // fiche point de passage
  document.querySelectorAll('[data-wclose]').forEach((el) =>
    el.addEventListener('click', () => { $('wpt-info').hidden = true; }));
  document.querySelectorAll('[data-pacemode]').forEach((b) =>
    b.addEventListener('click', () => setPaceMode(b.dataset.pacemode)));
  $('manual-speed').addEventListener('input', (e) => {
    state.manualKmh = parseFloat(e.target.value) || 10; state.speedCustomized = true;
    recomputePacing(); autosave();
  });
  $('target-time').addEventListener('input', (e) => {
    const s = parseHHMM(e.target.value); if (s) { state.targetSec = s; recomputePacing(); autosave(); }
  });
  $('start-clock').addEventListener('input', (e) => {
    const ms = dtToMs(e.target.value);
    if (isFinite(ms)) { state.startClock = ms; recomputePacing(); autosave(); }
  });
  $('now-clock').addEventListener('input', (e) => {
    state.nowClockStr = e.target.value || null;
  });
  $('now-reset').addEventListener('click', () => {
    state.nowClockStr = null;
    $('now-clock').value = msToDtLocal(Date.now());
  });
  $('recale-now').addEventListener('click', recalibrateFromNow);

  // type d'effort (modèle de pente)
  document.querySelectorAll('[data-activity]').forEach((b) =>
    b.addEventListener('click', () => setActivity(b.dataset.activity)));

  // sauvegarde cloud
  $('cloud-save').addEventListener('click', cloudSaveNow);
  $('cloud-restore').addEventListener('click', cloudRestoreNow);

  // édition noms / infos / barrières dans la table (délégation)
  $('pace-table').addEventListener('change', (e) => {
    const nm = e.target.closest('.pr-name');
    if (nm) { setWaypointName(nm.dataset.wpi, nm.value); return; }
    const cut = e.target.closest('.pr-cutoff');
    if (cut) { setWaypointCutoff(cut.dataset.wpi, cut.value || null); return; }
  });
  $('pace-table').addEventListener('input', (e) => {
    const info = e.target.closest('.pr-info');
    if (info) { setWaypointInfo(info.dataset.wpi, info.value); }
  });
  $('pace-table').addEventListener('click', (e) => {
    const ico = e.target.closest('.pr-icon');
    if (ico) { setWaypointIcon(ico.dataset.wpi, ico.dataset.icon); return; }
    const col = e.target.closest('.pr-color');
    if (col) { setWaypointColor(col.dataset.wpi, col.dataset.color); return; }
  });
  // édition d'un temps de passage cible sur une ligne de la table
  $('pace-table').addEventListener('change', (e) => {
    const inp = e.target.closest('.pr-clock');
    if (!inp || !inp.value) return;
    editWaypointTime(parseFloat(inp.dataset.d), inp.value);
  });

  window.addEventListener('resize', () => {
    if (state.profile) state.profile.resize();
    if (state.map) state.map.invalidate();
  });

  // plein écran carte / profil (paysage)
  $('pf-fs').addEventListener('click', () => toggleFs(document.querySelector('.profile-wrap'), $('pf-fs')));
  $('map-fs').addEventListener('click', (e) => { e.stopPropagation(); toggleFs(document.querySelector('.map-wrap'), $('map-fs')); });
  document.addEventListener('fullscreenchange', onNativeFsChange);
  document.addEventListener('webkitfullscreenchange', onNativeFsChange);
  window.addEventListener('orientationchange', () => { if (fsEl) { fsResize(); updateFsHint(); } });

  // type d'effort par défaut (dernier choisi), reflété sur l'accueil
  state.activity = localGet('activity') || 'run';
  setActivityType(state.activity);
  if (!state.speedCustomized) state.manualKmh = DEFAULT_KMH[state.activity];
  document.querySelectorAll('[data-activity]').forEach((b) =>
    b.classList.toggle('active', b.dataset.activity === state.activity));

  setupPWA();
}

// ------------------------------------------------------------------ PLEIN ÉCRAN
let fsEl = null, fsBtn = null;

function toggleFs(el, btn) {
  if (!el) return;
  if (fsEl === el) { exitFs(); return; }
  if (fsEl) exitFs();
  enterFs(el, btn);
}

async function enterFs(el, btn) {
  fsEl = el; fsBtn = btn || null;
  if (fsBtn) fsBtn.classList.add('active');
  // les overlays (fiche point, indice) doivent vivre DANS l'élément plein écran
  // pour être rendus en plein écran natif et au-dessus en repli CSS.
  el.appendChild($('wpt-info'));
  el.appendChild($('fs-hint'));
  let native = false;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (req) { try { await req.call(el); native = true; } catch (_) { /* iOS : pas de FS sur un div */ } }
  if (!native) { el.classList.add('fs-active'); document.body.classList.add('fs-css'); }
  try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (_) { /* iOS / desktop */ }
  fsResize();
  updateFsHint();
}

function exitFs() {
  if (!fsEl) return;
  const el = fsEl; fsEl = null;
  el.classList.remove('fs-active');
  document.body.classList.remove('fs-css');
  if (fsBtn) { fsBtn.classList.remove('active'); fsBtn = null; }
  // remet les overlays au niveau du body et ferme la fiche
  document.body.appendChild($('wpt-info'));
  document.body.appendChild($('fs-hint'));
  $('wpt-info').hidden = true;
  $('fs-hint').hidden = true;
  try { if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (_) { /* ignore */ }
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (_) { /* ignore */ }
  fsResize();
}

function onNativeFsChange() {
  // sortie du plein écran natif via un geste système
  if (!document.fullscreenElement && !document.webkitFullscreenElement && fsEl && !fsEl.classList.contains('fs-active')) {
    fsEl = null;
    if (fsBtn) { fsBtn.classList.remove('active'); fsBtn = null; }
    document.body.appendChild($('wpt-info'));
    document.body.appendChild($('fs-hint'));
    $('wpt-info').hidden = true;
    $('fs-hint').hidden = true;
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (_) { /* ignore */ }
    fsResize();
  }
}

function fsResize() {
  setTimeout(() => {
    if (state.map) state.map.invalidate();
    if (state.profile) state.profile.resize();
  }, 160);
}

function updateFsHint() {
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  $('fs-hint').hidden = !(fsEl && portrait);
}

// ------------------------------------------------------------------ PWA / HORS-LIGNE
let deferredInstall = null;
function setupPWA() {
  // service worker + mise à jour automatique (recharge une fois quand une
  // nouvelle version prend le contrôle, pour ne jamais rester sur du cache périmé)
  if ('serviceWorker' in navigator) {
    let reloaded = false;
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    }
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* pas bloquant */ });
    });
  }
  // invite d'installation (Android/Chrome)
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $('install-btn').hidden = false;
  });
  $('install-btn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $('install-btn').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('install-btn').hidden = true; });

  // iOS (pas d'invite native) : instructions, sauf si déjà installé
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isIOS && !standalone) $('ios-install').hidden = false;

  // indicateur hors-ligne
  window.addEventListener('offline', () => toastSafe('📴 Hors ligne — la carte et l’appli restent dispo (zones déjà vues).'));
}

// toast utilisable avant qu'un parcours soit chargé
function toastSafe(msg) { try { toast(msg); } catch (_) { /* ignore */ } }

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
    state.rawPoints = points; // conservés pour la sauvegarde cloud de la trace
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

  // persistance : clé du parcours + restauration des réglages sauvegardés.
  // On conserve le type d'activité choisi (accueil / dernier défaut) ; une config
  // sauvegardée pour ce parcours peut le surcharger.
  state.gpxKey = hashTrack(track);
  state.finishMeta = { info: '', cutoff: null, label: '🏁 Arrivée', icon: '🏁', color: '' };
  const saved = localLoad(state.gpxKey);
  if (saved) applyConfig(saved);
  setActivityType(state.activity);
  state.cloudCode = localGet('code:' + state.gpxKey);

  $('welcome').hidden = true;
  $('app').hidden = false;

  // Carte : isolée dans un try/catch pour que le profil fonctionne même si
  // la librairie carto n'est pas disponible (réseau coupé, etc.).
  try {
    if (typeof L === 'undefined') throw new Error('Leaflet indisponible');
    if (!state.map) {
      state.map = new RaceMap('map');
      state.map.onMapTap = (latlng) => onMapTap(latlng);
      state.map.onWaypointClick = (wp) => showWaypointInfo(wp, wp.d);
      state.map.onFinishClick = () => showWaypointInfo(state.finishMeta, state.track.total);
      // déplacement manuel de la carte → coupe le recentrage automatique
      state.map.onUserPan = () => {
        if (!state.follow) return;
        state.follow = false;
        $('pf-follow').classList.remove('active');
        if (!state.panHintShown) { state.panHintShown = true; toast('Recentrage auto coupé — appuie sur 📍 Suivi pour y revenir.'); }
      };
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
    // zoom/pan manuel : on désactive les onglets de vue prédéfinie
    state.profile.onViewChange = () => {
      $('pf-full').classList.remove('active');
      $('pf-zoom').classList.remove('active');
    };
    state.profile.onWaypointTap = (wp) => { highlightAt(wp.d); showWaypointInfo(wp, wp.d); };
    state.profile.onPointSelect = (d) => { highlightAt(d); showPointInfo(d); };
  }
  state.profile.setTrack(track, state.climbs);
  requestAnimationFrame(() => state.profile.resize());

  // synchronise l'UI (type d'effort, mode, vitesse) avec la config restaurée
  document.querySelectorAll('[data-activity]').forEach((b) =>
    b.classList.toggle('active', b.dataset.activity === state.activity));
  document.querySelectorAll('[data-pacemode]').forEach((b) =>
    b.classList.toggle('active', b.dataset.pacemode === state.paceMode));
  $('field-manual').hidden = state.paceMode !== 'manual';
  $('field-target').hidden = state.paceMode !== 'target';
  $('manual-speed').value = state.manualKmh.toFixed(1);
  $('cloud-code').textContent = state.cloudCode || '—';
  $('pf-follow').classList.toggle('active', state.follow);

  renderWaypointMarkers();
  recomputePacing();
  updateStatbar(0);
  setProfileView('full');
  const restored = saved ? ' · réglages restaurés' : '';
  toast(`${track.name} · ${(track.total / 1000).toFixed(1)} km · ${track.gain} m D+${restored}`);
  if (!state.hintShown) {
    state.hintShown = true;
    setTimeout(() => toast('💡 Pince pour zoomer le profil · glisse pour te déplacer · tape pour lire un point'), 3000);
  }
}

// ------------------------------------------------------------------ POINTS DE PASSAGE AUTO
function autoWaypoints(track) {
  const wpts = [];
  // un point tous les 5 km si le parcours est long, sinon tous les 2 km
  const stepKm = track.total > 30000 ? 5 : track.total > 12000 ? 2 : 1;
  for (let km = stepKm; km * 1000 < track.total; km += stepKm) {
    const pt = pointAtDistance(track.points, km * 1000);
    wpts.push({ d: km * 1000, lat: pt.lat, lon: pt.lon, ele: pt.ele, label: `${km} km`, auto: true, info: '', cutoff: null });
  }
  // sommets de côtes
  for (const c of state.climbs) {
    const pt = pointAtDistance(track.points, c.endD);
    wpts.push({ d: c.endD, lat: pt.lat, lon: pt.lon, ele: pt.ele, label: `Sommet (${c.gain} m)`, auto: true, summit: true, info: '', cutoff: null });
  }
  wpts.sort((a, b) => a.d - b.d);
  return wpts;
}

function renderWaypointMarkers() {
  if (state.map) {
    state.map.clearWaypoints();
    for (const w of state.waypoints) {
      if (!w.auto || w.summit || w.icon || w.color) state.map.addWaypointMarker(w);
    }
  }
  state.profile.setWaypoints(state.waypoints);
}

// ------------------------------------------------------------------ SUIVI GPS
function toggleTracking() {
  if (state.watchId != null) { stopTracking(); return; }
  if (!('geolocation' in navigator)) { toast('Géolocalisation non disponible.'); return; }

  state.startedAt = Date.now();
  state.onRoute = null; // réévalué au premier point
  // si aucune heure de départ n'a été fixée, on part de maintenant
  if (state.startClock == null) { state.startClock = state.startedAt; $('start-clock').value = msToDtLocal(state.startClock); }
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
  state.onRoute = null;
  $('offroute-banner').hidden = true;
  const btn = $('act-start');
  btn.classList.remove('tracking');
  btn.querySelector('.act-ico').textContent = '▶';
  btn.querySelector('span:last-child').textContent = 'Démarrer suivi GPS';
  toast('Suivi arrêté.');
}

function onGeoError(err) {
  toast(err.code === 1 ? 'Accès à la position refusé.' : 'Signal GPS indisponible.');
}

// Seuils hors-parcours (m), avec hystérésis pour éviter le clignotement.
const OFF_ROUTE_ENTER = 250;
const OFF_ROUTE_EXIT = 150;

function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy, heading, speed } = pos.coords;
  const now = pos.timestamp || Date.now();

  const proj = projectOnTrack({ lat, lon }, state.track.points, state.hint);
  const projected = pointAtDistance(state.track.points, proj.along);
  const gpsSpeed = (speed != null && isFinite(speed) && speed >= 0 && speed <= MAX_PLAUSIBLE_MS) ? speed : null;

  // état on/off parcours (hystérésis)
  if (state.onRoute == null) state.onRoute = proj.dist <= OFF_ROUTE_ENTER;
  else if (state.onRoute && proj.dist > OFF_ROUTE_ENTER) state.onRoute = false;
  else if (!state.onRoute && proj.dist < OFF_ROUTE_EXIT) state.onRoute = true;

  // position réelle sur la carte (toujours, même hors parcours)
  if (state.map) {
    state.map.setPosition(lat, lon, accuracy, heading);
    if (state.follow) state.map.panTo(lat, lon);
  }
  if (gpsSpeed != null) state.liveSpeed = gpsSpeed;

  if (!state.onRoute) {
    // Hors parcours : on n'invente pas de position sur la trace.
    state.lastFix = { lat, lon, acc: accuracy, off: proj.dist, t: now, onRoute: false };
    if (state.map) { state.map.clearCursor(); state.map.setProgress(-1, null); }
    state.profile.setCursor(null);
    $('offroute-banner').hidden = false;
    $('offroute-text').textContent = `Hors parcours · ${fmtDist(proj.dist)} de la trace`;
    $('climb-banner').hidden = true;
    updateStatbarOffRoute();
    return;
  }

  // Sur le parcours : suivi normal.
  $('offroute-banner').hidden = true;
  state.hint = proj.index;
  state.lastFix = { lat, lon, d: proj.along, index: proj.index, acc: accuracy, off: proj.dist, t: now, onRoute: true };
  if (gpsSpeed == null) updateLiveSpeedFromTrack(proj.along, now);

  if (state.map) {
    state.map.setProgress(proj.index, projected);
    state.map.highlightCursor(projected.lat, projected.lon);
  }
  state.profile.setCursor(proj.along);
  if (state.follow && state.profile.isZoomed()) state.profile.centerOn(proj.along);

  updateStatbar(proj.along, proj.dist);
  updateClimbBanner(proj.along);
  if (state.paceMode === 'live') recomputePacing();
}

/** Barre de stats en mode hors parcours : pas de distance/pente trompeuses. */
function updateStatbarOffRoute() {
  const t = state.track;
  $('st-dist').textContent = `– / ${(t.total / 1000).toFixed(1)}`;
  $('st-climb').textContent = '–';
  const gEl = $('st-grade'); gEl.textContent = '–'; gEl.style.color = '';
  $('st-speed').textContent = state.watchId != null ? `${(state.liveSpeed * 3.6).toFixed(1)} km/h` : '–';
  $('st-eta').textContent = '–';
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
  $('st-eta').textContent = etaText();
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

// ------------------------------------------------------------------ HORAIRES
function baseStart() { return state.startClock != null ? state.startClock : Date.now(); }

/** Heure d'horloge (ms) de passage à une distance donnée = départ + temps de course. */
function clockAt(d) {
  return baseStart() + timeAtDistance(state.track.points, state.cumTime, d) * 1000;
}

/** Heure "actuelle" de référence : saisie manuelle si présente, sinon horloge du téléphone. */
function currentNowMs() {
  if (state.nowClockStr) {
    const ms = dtToMs(state.nowClockStr);
    if (isFinite(ms)) return ms;
  }
  return Date.now();
}

/** "HH:MM" avec suffixe "+1j" si le passage a lieu un jour plus tard que le départ. */
function fmtClockRel(clockMs) {
  const s = fmtClock(clockMs);
  const d0 = new Date(baseStart()); d0.setHours(0, 0, 0, 0);
  const d1 = new Date(clockMs); d1.setHours(0, 0, 0, 0);
  const days = Math.round((d1 - d0) / 86400000);
  return days > 0 ? `${s} +${days}j` : s;
}

function etaText() {
  if (!state.cumTime) return '–';
  return fmtClockRel(clockAt(state.track.total));
}

/** Recale l'allure depuis la position GPS actuelle et l'heure actuelle. */
function recalibrateFromNow() {
  if (!state.track) return;
  if (!state.lastFix || !state.lastFix.onRoute || state.lastFix.d < 30) {
    toast('Rejoins la trace : position GPS hors parcours.'); return;
  }
  if (state.startClock == null) { toast("Renseigne d'abord l'heure de départ."); return; }
  const elapsed = (currentNowMs() - state.startClock) / 1000;
  if (elapsed < 60) { toast('Heure actuelle incohérente avec le départ.'); return; }
  const ref = calibrateForTimeAtDistance(state.track.points, state.lastFix.d, elapsed);
  if (!ref || !isFinite(ref) || ref <= 0) { toast('Recalage impossible.'); return; }
  const avgKmh = avgSpeedFor(state.track.points, ref);
  state.manualKmh = avgKmh;
  state.speedCustomized = true;
  $('manual-speed').value = avgKmh.toFixed(1);
  setPaceMode('manual'); // applique et rafraîchit toute la table
  toast(`Recalé : ${avgKmh.toFixed(1)} km/h de moyenne réelle · ${(state.lastFix.d / 1000).toFixed(1)} km parcourus.`);
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
    const d = state.lastFix && state.lastFix.onRoute ? state.lastFix.d : 0;
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
  if (!state.lastFix || !state.lastFix.onRoute) state.profile.setCursor(d);
}

// ------------------------------------------------------------------ POINTS DE PASSAGE MANUELS
function onMapTap(latlng) {
  const proj = projectOnTrack({ lat: latlng.lat, lon: latlng.lng }, state.track.points, 0);
  if (proj.dist > 120) { toast('Touche plus près de la trace pour poser un point.'); return; }
  addWaypoint(proj.along);
}

function addWaypointAtCursor() {
  const d = state.lastFix && state.lastFix.onRoute ? state.lastFix.d : (state.scrubD || 0);
  addWaypoint(d);
}

function addWaypoint(d) {
  const pt = pointAtDistance(state.track.points, d);
  const label = `Passage ${(d / 1000).toFixed(1)} km`;
  const w = { d, lat: pt.lat, lon: pt.lon, ele: pt.ele, label, auto: false, info: '', cutoff: null };
  state.waypoints.push(w);
  state.waypoints.sort((a, b) => a.d - b.d);
  if (state.map) state.map.addWaypointMarker(w);
  state.profile.setWaypoints(state.waypoints);
  recomputePacing();
  autosave();
  toast(`Point ajouté à ${(d / 1000).toFixed(1)} km.`);
}

// ------------------------------------------------------------------ TYPE D'EFFORT
const DEFAULT_KMH = { run: 10, bike: 20 };

function setActivity(act) {
  state.activity = act === 'bike' ? 'bike' : 'run';
  setActivityType(state.activity);
  localSet('activity', state.activity); // défaut global mémorisé
  // vitesse par défaut réaliste selon l'activité, tant que l'utilisateur n'en a pas fixé
  if (!state.speedCustomized) {
    state.manualKmh = DEFAULT_KMH[state.activity];
    if ($('manual-speed')) $('manual-speed').value = state.manualKmh;
  }
  document.querySelectorAll('[data-activity]').forEach((b) =>
    b.classList.toggle('active', b.dataset.activity === state.activity));
  recomputePacing();
  autosave();
}

// ------------------------------------------------------------------ PERSISTANCE
function buildConfig() {
  return {
    version: 1,
    startStr: state.startClock != null ? msToDtLocal(state.startClock) : null,
    activity: state.activity,
    paceMode: state.paceMode,
    manualKmh: state.manualKmh,
    targetSec: state.targetSec,
    finishMeta: { info: state.finishMeta.info || '', cutoff: state.finishMeta.cutoff || null, label: state.finishMeta.label || '🏁 Arrivée', icon: state.finishMeta.icon || '🏁', color: state.finishMeta.color || '' },
    waypoints: state.waypoints.map((w) => ({
      d: w.d, label: w.label, info: w.info || '', cutoff: w.cutoff || null,
      icon: w.icon || '', color: w.color || '',
      auto: !!w.auto, summit: !!w.summit, manual: !!w.manual,
    })),
  };
}

function applyConfig(cfg) {
  if (!cfg) return;
  if (cfg.activity) { state.activity = cfg.activity; setActivityType(state.activity); }
  if (cfg.paceMode) state.paceMode = cfg.paceMode;
  if (typeof cfg.manualKmh === 'number') { state.manualKmh = cfg.manualKmh; state.speedCustomized = true; }
  if (typeof cfg.targetSec === 'number') state.targetSec = cfg.targetSec;
  if (cfg.startStr) { const ms = dtToMs(cfg.startStr); if (isFinite(ms)) state.startClock = ms; }
  if (cfg.finishMeta) state.finishMeta = { info: cfg.finishMeta.info || '', cutoff: cfg.finishMeta.cutoff || null, label: cfg.finishMeta.label || '🏁 Arrivée', icon: cfg.finishMeta.icon || '🏁', color: cfg.finishMeta.color || '' };
  if (Array.isArray(cfg.waypoints) && cfg.waypoints.length) {
    state.waypoints = cfg.waypoints.map((w) => {
      const pt = pointAtDistance(state.track.points, w.d);
      return {
        d: w.d, lat: pt.lat, lon: pt.lon, ele: pt.ele, label: w.label,
        info: w.info || '', cutoff: w.cutoff || null, icon: w.icon || '', color: w.color || '',
        auto: !!w.auto, summit: !!w.summit, manual: !!w.manual,
      };
    });
  }
}

/** Trace GPX compacte pour le cloud : points bruts [lat, lon, ele]. */
function serializeTrack() {
  const raw = state.rawPoints || state.track.points;
  return {
    name: state.track.name,
    pts: raw.map((p) => [
      +(+p.lat).toFixed(6), +(+p.lon).toFixed(6),
      p.ele == null ? null : +(+p.ele).toFixed(1),
    ]),
  };
}

/** Sauvegarde locale immédiate (débounce) + mise à jour cloud de la config si un code existe. */
function autosave() {
  clearTimeout(state._saveT);
  state._saveT = setTimeout(() => {
    if (!state.track || !state.gpxKey) return;
    const cfg = buildConfig();
    localSave(state.gpxKey, cfg);
    if (state.cloudCode) {
      cloudSaveConfig(state.cloudCode, cfg, new Date().toISOString())
        .catch(() => { /* hors-ligne : le local suffit */ });
    }
  }, 700);
}

async function cloudSaveNow() {
  if (!state.track) return;
  if (!state.cloudCode) {
    state.cloudCode = makeCode();
    localSet('code:' + state.gpxKey, state.cloudCode);
    $('cloud-code').textContent = state.cloudCode;
  }
  const btn = $('cloud-save');
  btn.disabled = true; btn.textContent = '☁️ Sauvegarde…';
  try {
    await cloudSaveFull(state.cloudCode, state.gpxKey, state.track.name,
      buildConfig(), serializeTrack(), new Date().toISOString());
    toast(`Sauvegardé dans le cloud · code ${state.cloudCode}`);
    if (isLoggedIn()) loadRaces(); // rafraîchit « Mes épreuves »
  } catch (e) {
    toast('Échec de la sauvegarde cloud (réseau ?).');
  } finally {
    btn.disabled = false; btn.textContent = '☁️ Sauvegarder dans le cloud';
  }
}

/** Ouvre un parcours complet directement à partir d'un code (écran d'accueil). */
async function restoreFromCode(code) {
  code = (code || '').trim().toUpperCase();
  if (code.length < 4) { showWelcomeError('Saisis un code valide.'); return; }
  const btn = $('welcome-restore-btn');
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    const row = await cloudLoad(code);
    if (!row) { showWelcomeError('Aucune sauvegarde pour ce code.'); return; }
    let track0 = row.track;
    if (typeof track0 === 'string') { try { track0 = JSON.parse(track0); } catch (_) { track0 = null; } }
    if (!track0 || !Array.isArray(track0.pts) || track0.pts.length < 2) {
      showWelcomeError('Cette sauvegarde ne contient pas de parcours. Charge le GPX puis restaure via le panneau Allure.');
      return;
    }
    const rawPoints = track0.pts.map((a) => ({ lat: a[0], lon: a[1], ele: a[2] }));
    const track = buildTrack(rawPoints);
    track.name = track0.name || row.name || 'Parcours';
    state.rawPoints = rawPoints;
    startApp(track);              // construit carte + profil (applique aussi le local éventuel)
    applyConfig(row.data);        // puis on impose la config du cloud
    state.cloudCode = code;
    localSet('code:' + state.gpxKey, code);
    localSave(state.gpxKey, buildConfig());
    afterConfigRestored();
    toast(`« ${track.name} » restauré depuis le cloud.`);
  } catch (e) {
    showWelcomeError('Restauration impossible (réseau ?).');
  } finally {
    btn.disabled = false; btn.textContent = prev;
  }
}

async function cloudRestoreNow() {
  const code = ($('cloud-restore-code').value || '').trim().toUpperCase();
  if (code.length < 4) { toast('Saisis un code valide.'); return; }
  if (!state.track) { toast('Charge d’abord le GPX correspondant.'); return; }
  const btn = $('cloud-restore');
  btn.disabled = true;
  try {
    const row = await cloudLoad(code);
    if (!row) { toast('Aucune sauvegarde pour ce code.'); return; }
    if (row.gpx_key && row.gpx_key !== state.gpxKey) {
      toast('Ce code correspond à un autre parcours.'); return;
    }
    applyConfig(row.data);
    state.cloudCode = code;
    localSet('code:' + state.gpxKey, code);
    localSave(state.gpxKey, buildConfig());
    afterConfigRestored();
    toast('Réglages restaurés depuis le cloud.');
  } catch (e) {
    toast('Restauration impossible (réseau ?).');
  } finally {
    btn.disabled = false;
  }
}

/** Rafraîchit toute l'UI après application d'une config restaurée. */
function afterConfigRestored() {
  setActivityType(state.activity);
  document.querySelectorAll('[data-activity]').forEach((b) =>
    b.classList.toggle('active', b.dataset.activity === state.activity));
  document.querySelectorAll('[data-pacemode]').forEach((b) =>
    b.classList.toggle('active', b.dataset.pacemode === state.paceMode));
  $('field-manual').hidden = state.paceMode !== 'manual';
  $('field-target').hidden = state.paceMode !== 'target';
  $('manual-speed').value = state.manualKmh.toFixed(1);
  if (state.startClock != null) $('start-clock').value = msToDtLocal(state.startClock);
  renderWaypointMarkers();
  recomputePacing();
}

// ------------------------------------------------------------------ COMPTE / MES ÉPREUVES
function showAuthError(msg) {
  const el = $('auth-error');
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg; el.hidden = false;
}

async function doAuth(kind) {
  const user = ($('auth-user').value || '').trim();
  const pass = $('auth-pass').value || '';
  if (!user || pass.length < 4) {
    showAuthError('Saisis un identifiant et un mot de passe (4 caractères min).');
    return;
  }
  showAuthError('');
  const btn = kind === 'signup' ? $('auth-signup') : $('auth-login');
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    if (kind === 'signup') await signup(user, pass);
    else await login(user, pass);
    $('auth-pass').value = '';
    updateAuthUI();
  } catch (e) {
    showAuthError(e.message || 'Connexion impossible.');
  } finally {
    btn.disabled = false; btn.textContent = prev;
  }
}

function updateAuthUI() {
  const on = isLoggedIn();
  $('auth-out').hidden = on;
  $('auth-in').hidden = !on;
  showAuthError('');
  if (on) {
    $('auth-name').textContent = currentUser() || '—';
    loadRaces();
  }
}

async function loadRaces() {
  if (!isLoggedIn()) return;
  const list = $('races-list');
  const empty = $('races-empty');
  list.innerHTML = '<li class="hint" style="padding:6px 0">Chargement…</li>';
  empty.hidden = true;
  try {
    const rows = await cloudListRaces();
    list.innerHTML = '';
    if (!rows.length) { empty.hidden = false; return; }
    for (const r of rows) {
      const li = document.createElement('li');
      li.className = 'race-item';
      const when = fmtRaceDate(r.updated_at);
      li.innerHTML =
        `<button class="race-open" data-code="${escAttr(r.code)}">` +
        `${escHtml(r.name || 'Parcours')}` +
        `<span class="race-sub">code ${escHtml(r.code)}${when ? ' · ' + when : ''}</span>` +
        `</button>` +
        `<button class="race-del" data-del="${escAttr(r.code)}" data-name="${escAttr(r.name || 'Parcours')}" title="Supprimer">🗑️</button>`;
      list.appendChild(li);
    }
  } catch (e) {
    list.innerHTML = '';
    showAuthError('Impossible de charger tes épreuves (réseau ?).');
  }
}

function onRacesClick(e) {
  const open = e.target.closest('[data-code]');
  if (open) { restoreFromCode(open.dataset.code); return; }
  const del = e.target.closest('[data-del]');
  if (del) { deleteRace(del.dataset.del, del.dataset.name || ''); }
}

async function deleteRace(code, name) {
  // Sécurité anti-fausse-manip : il faut retaper le nom de l'épreuve (ou, si le
  // nom est long, ses 6 premiers caractères) pour confirmer la suppression.
  const full = (name || '').trim();
  const longName = full.length > 6;
  const challenge = longName ? full.slice(0, 6) : full;
  const norm = (s) => (s || '').trim().toLowerCase();
  const answer = prompt(
    `Suppression définitive de « ${full || code} ».\n\n` +
    `Pour confirmer, tape ${longName ? 'les 6 premiers caractères du nom' : 'le nom de l’épreuve'} :\n` +
    `${challenge}`
  );
  if (answer == null) return; // Annuler
  if (norm(answer) !== norm(challenge) && norm(answer) !== norm(full)) {
    showAuthError('Suppression annulée : le texte saisi ne correspond pas.');
    return;
  }
  try {
    await cloudDeleteRace(code);
    showAuthError('');
    loadRaces();
  } catch (e) {
    showAuthError('Suppression impossible (réseau ?).');
  }
}

function fmtRaceDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}
function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function escAttr(s) { return escHtml(s).replace(/'/g, '&#39;'); }

// ------------------------------------------------------------------ INFOS / BARRIÈRES
function getWpMeta(wpi) {
  return wpi === 'finish' ? state.finishMeta : state.waypoints[+wpi];
}
function setWaypointName(wpi, val) {
  const m = getWpMeta(wpi); if (!m) return;
  m.label = val.trim() || m.label;
  renderWaypointMarkers(); // met à jour l'étiquette sur la carte
  autosave();              // pas de re-render de la table (ne pas casser la saisie)
}
function setWaypointCutoff(wpi, val) {
  const m = getWpMeta(wpi); if (!m) return;
  m.cutoff = val;
  renderPaceTable(); // met à jour l'état danger
  autosave();
}
function setWaypointInfo(wpi, val) {
  const m = getWpMeta(wpi); if (!m) return;
  m.info = val;
  autosave(); // pas de re-render (ne pas casser la saisie)
}
function setWaypointIcon(wpi, icon) {
  const m = getWpMeta(wpi); if (!m) return;
  m.icon = (m.icon === icon) ? '' : icon; // re-tap = désélectionne
  renderWaypointMarkers(); renderPaceTable(); autosave();
}
function setWaypointColor(wpi, color) {
  const m = getWpMeta(wpi); if (!m) return;
  m.color = (m.color === color) ? '' : color;
  renderWaypointMarkers(); renderPaceTable(); autosave();
}

// ------------------------------------------------------------------ ALLURE / TEMPS DE PASSAGE
function setPaceMode(mode) {
  state.paceMode = mode;
  document.querySelectorAll('[data-pacemode]').forEach((b) =>
    b.classList.toggle('active', b.dataset.pacemode === mode));
  $('field-manual').hidden = mode !== 'manual';
  $('field-target').hidden = mode !== 'target';
  recomputePacing();
  autosave();
}

// ------------------------------------------------------------------ FICHE POINT
/** Surligne un point (par distance) sur la carte. */
function highlightAt(d) {
  if (!state.map) return;
  const p = pointAtDistance(state.track.points, d);
  state.map.highlightCursor(p.lat, p.lon);
}

/** Fiche d'un point quelconque de la courbe (sans nom/notes/barrière). */
function showPointInfo(d) {
  showWaypointInfo({ label: `Point · ${(d / 1000).toFixed(1)} km`, info: '', cutoff: null, summit: false, _pt: true }, d);
}

/** Affiche la fiche d'un point de passage (depuis la carte ou le profil). */
function showWaypointInfo(meta, d) {
  if (!state.track || !state.cumTime) return;
  const pts = state.track.points, cum = state.cumTime;
  const here = pointAtDistance(pts, d);
  const tSec = timeAtDistance(pts, cum, d);
  const predMs = clockAt(d);

  const onRouteNow = state.lastFix && state.lastFix.onRoute;
  const curD = onRouteNow ? state.lastFix.d : 0;
  const toPointM = Math.max(0, d - curD);
  const toGoSec = Math.max(0, tSec - timeAtDistance(pts, cum, curD));
  const toFinishM = Math.max(0, state.track.total - d);
  const passed = onRouteNow && curD >= d - 20;

  const rows = [];
  rows.push(['Distance / départ', `${(d / 1000).toFixed(1)} km`]);
  if (onRouteNow) {
    rows.push(['Distance / ma position', passed
      ? '✓ déjà passé'
      : `${(toPointM / 1000).toFixed(1)} km · dans ${fmtDuration(toGoSec)}`]);
  }
  rows.push(['Jusqu’à l’arrivée', `${(toFinishM / 1000).toFixed(1)} km`]);
  const g = gradeAt(d);
  rows.push(['Altitude · pente', `${Math.round(here.ele)} m · ${g >= 0 ? '+' : ''}${g.toFixed(1)} %`]);
  rows.push(['Temps de course', fmtDuration(tSec)]);
  rows.push(['Arrivée estimée', fmtClockRel(predMs)]);

  // barrière horaire
  let cutoffRow = '';
  const cutMs = dtToMs(meta.cutoff);
  if (isFinite(cutMs)) {
    const marginSec = (cutMs - predMs) / 1000;
    const late = marginSec < 0;
    cutoffRow = `<div class="wi-row ${late ? 'danger' : 'ok'}">
      <span class="wi-k">Barrière · ${fmtClockRel(cutMs)}</span>
      <span class="wi-v">${late ? '⚠ retard +' + fmtDuration(-marginSec) : '✓ marge ' + fmtDuration(marginSec)}</span>
    </div>`;
  }

  const rowsHtml = rows.map(([k, v]) =>
    `<div class="wi-row"><span class="wi-k">${k}</span><span class="wi-v">${v}</span></div>`).join('');
  const notes = (meta.info || '').trim();
  const notesHtml = notes
    ? `<div class="wi-notes"><span class="wi-k">Notes</span>${escapeHtml(notes)}</div>` : '';

  const sub = meta.summit ? '⛰️ Sommet' : (meta._pt ? 'point du parcours' : 'point de passage');
  const titleIco = meta.icon ? meta.icon + ' ' : '';
  $('wi-body').innerHTML = `
    <h3 class="wi-title"${meta.color ? ` style="color:${meta.color}"` : ''}>${titleIco}${escapeHtml(meta.label || 'Point')}</h3>
    <p class="wi-sub">${sub}</p>
    <div class="wi-rows">${rowsHtml}${cutoffRow}</div>
    ${notesHtml}`;
  $('wpt-info').hidden = false;
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
  if (state.lastFix && state.lastFix.onRoute) { updateStatbar(state.lastFix.d, state.lastFix.off); }
  else { $('st-eta').textContent = etaText(); }
}

function renderPaceTable() {
  const tbl = $('pace-table');
  const pts = state.track.points;
  const cum = state.cumTime;
  if (!cum) { tbl.innerHTML = ''; return; }

  const totalSec = cum[cum.length - 1];
  const avgKmh = (state.track.total / totalSec) * 3.6;
  $('pace-summary').textContent =
    `Durée estimée ${fmtDuration(totalSec)} · ${avgKmh.toFixed(1)} km/h moy. · départ ${fmtClock(baseStart())} → arrivée ${etaText()}`;

  // lignes : chaque point de passage + l'arrivée. wpi = index (ou 'finish').
  const rows = state.waypoints.map((w, i) => ({ d: w.d, label: w.label, summit: w.summit, meta: w, wpi: String(i) }));
  rows.push({ d: state.track.total, label: '🏁 Arrivée', summit: false, meta: state.finishMeta, wpi: 'finish' });

  // position/instant de référence pour "temps restant jusqu'au point"
  const onRouteNow = state.lastFix && state.lastFix.onRoute;
  const posD = onRouteNow ? state.lastFix.d : -1;
  const refSec = onRouteNow ? timeAtDistance(pts, cum, state.lastFix.d) : 0;

  let html = '';
  for (const r of rows) {
    const tSec = timeAtDistance(pts, cum, r.d);          // temps de course cumulé (depuis le départ)
    const predMs = clockAt(r.d);                         // heure d'arrivée estimée
    const passed = posD >= r.d - 20;
    const toGoSec = tSec - refSec;                        // temps estimé jusqu'à ce point
    const info = r.meta.info || '';
    const cutoffVal = cutoffToDtValue(r.meta.cutoff);

    // état barrière horaire (jour + heure)
    let danger = false, badge = '';
    const cutMs = dtToMs(r.meta.cutoff);
    if (isFinite(cutMs)) {
      const marginSec = (cutMs - predMs) / 1000;
      if (marginSec < 0) { danger = true; badge = `<span class="pc-warn">⚠ barrière +${fmtDuration(-marginSec)}</span>`; }
      else badge = `<span class="pc-ok">✓ marge ${fmtDuration(marginSec)}</span>`;
    }

    const toGo = passed ? '✓ passé'
      : (toGoSec > 0 ? `⏱ dans ${fmtDuration(toGoSec)}` : '⏱ imminent');

    const name = r.meta.label || r.label;
    const headIco = r.meta.icon || (r.summit ? '⛰️' : '');
    const dotColor = r.meta.color || '';
    html += `<div class="pace-card${passed ? ' passed' : ''}${r.summit ? ' summit' : ''}${danger ? ' danger' : ''}"${dotColor ? ` style="border-left:4px solid ${dotColor}"` : ''}>
      <div class="pc-head">
        ${headIco ? `<span class="pc-ico">${headIco}</span>` : ''}
        <input class="pr-name" type="text" value="${escapeHtml(name)}" data-wpi="${r.wpi}" aria-label="Nom du point" spellcheck="false">
        <span class="pc-km">${(r.d / 1000).toFixed(1)} km · ${fmtDuration(tSec)}</span>
      </div>
      <div class="pc-deco">
        <div class="pc-icons">${WPT_ICONS.map((ic) =>
          `<button class="pr-icon${r.meta.icon === ic ? ' sel' : ''}" data-wpi="${r.wpi}" data-icon="${ic}" type="button">${ic}</button>`).join('')}</div>
        <div class="pc-colors">${WPT_COLORS.map((co) =>
          `<button class="pr-color${r.meta.color === co ? ' sel' : ''}" data-wpi="${r.wpi}" data-color="${co}" style="background:${co}" type="button" aria-label="couleur"></button>`).join('')}</div>
      </div>
      <label class="pc-field">
        <span class="pc-flabel">Arrivée estimée ✎ <em class="pc-togo">${toGo}</em></span>
        <input class="pr-clock" type="datetime-local" value="${msToDtLocal(predMs)}" data-d="${r.d}" aria-label="Heure d'arrivée estimée">
      </label>
      <label class="pc-field">
        <span class="pc-flabel">Barrière horaire (jour &amp; heure) ✎ ${badge}</span>
        <input class="pr-cutoff" type="datetime-local" value="${cutoffVal}" data-wpi="${r.wpi}" aria-label="Barrière horaire">
      </label>
      <input class="pr-info" type="text" value="${escapeHtml(info)}" data-wpi="${r.wpi}" placeholder="ℹ️ ravito, note, matériel…">
    </div>`;
  }
  tbl.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Édite un temps de passage cible sur un point : on recalibre l'allure pour
 * atteindre ce point à l'heure demandée, et tout le reste se recalcule.
 */
function editWaypointTime(d, value) {
  const start = state.startClock || Date.now();
  const targetMs = dtToMs(value);
  if (!isFinite(targetMs)) return;
  const targetSec = (targetMs - start) / 1000;
  if (targetSec <= 60) { toast('Heure d’arrivée antérieure au départ.'); renderPaceTable(); return; }

  const ref = calibrateForTimeAtDistance(state.track.points, d, targetSec);
  if (!ref || !isFinite(ref) || ref <= 0) { toast('Heure impossible pour ce point.'); return; }

  const avgKmh = avgSpeedFor(state.track.points, ref);
  state.manualKmh = avgKmh;                       // précision complète => temps exact
  state.speedCustomized = true;
  $('manual-speed').value = avgKmh.toFixed(1);    // affichage arrondi
  setPaceMode('manual'); // recalcule tout et affiche la table à jour
  toast(`Allure calée : ${avgKmh.toFixed(1)} km/h moy. pour passer à ${fmtClockRel(targetMs)}.`);
}

// ------------------------------------------------------------------ FEUILLE / SHEET
function openSheet(open) {
  $('pace-sheet').hidden = !open;
  if (!open) return;
  // pré-remplissage des dates/heures
  if (state.startClock == null) state.startClock = Date.now();
  $('start-clock').value = msToDtLocal(state.startClock);
  $('now-clock').value = state.nowClockStr || msToDtLocal(Date.now());
  // le recalage nécessite une position GPS
  const canRecale = !!(state.lastFix && state.lastFix.onRoute);
  $('recale-now').disabled = !canRecale;
  $('recale-hint').textContent = canRecale
    ? "Depuis ta position GPS et l'heure actuelle, l'appli déduit ton allure réelle et met à jour tous les temps de passage."
    : 'Démarre le suivi GPS pour pouvoir recaler sur ta position.';
  $('cloud-code').textContent = state.cloudCode || '—';
  renderPaceTable();
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

/** ms → valeur d'un <input datetime-local> local ("YYYY-MM-DDTHH:MM"). */
function msToDtLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Chaîne horaire → ms. Gère le nouveau format datetime-local ("YYYY-MM-DDTHH:MM")
 * et l'ancien format heure seule ("HH:MM", rattaché au jour du départ pour
 * rester rétro-compatible avec les sauvegardes existantes).
 */
function dtToMs(v) {
  if (!v) return NaN;
  v = v.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return new Date(v).getTime();
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (m) {
    const d = new Date(state.startClock != null ? state.startClock : Date.now());
    d.setHours(parseInt(m[1]), parseInt(m[2]), 0, 0);
    return d.getTime();
  }
  return NaN;
}

/** Valeur affichable dans un input datetime-local à partir d'une barrière stockée. */
function cutoffToDtValue(cutoff) {
  const ms = dtToMs(cutoff);
  return isFinite(ms) ? msToDtLocal(ms) : '';
}

init();
