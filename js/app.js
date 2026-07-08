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
import {
  broadcastPosition, setLiveActive, fetchLive,
  uploadMedia, fetchMedia, deleteMedia, mediaUrl,
  postCheer, fetchCheers,
  resolveFollow, setFollowCode, getFollowCode,
  fetchMyProfile, saveMyProfile, uploadAvatar, avatarUrl,
  registerFollower, fetchFollowers,
} from './live.js';

const $ = (id) => document.getElementById(id);

// Filet de sécurité : au lieu d'une page blanche, toute erreur non gérée
// s'affiche en bas de l'écran (diagnostic sur le téléphone de l'utilisateur).
function showFatal(msg) {
  try {
    let el = document.getElementById('fatal-err');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fatal-err';
      el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#7a1f1f;color:#fff;padding:10px 12px;font:12px/1.4 system-ui;white-space:pre-wrap;max-height:40vh;overflow:auto';
      el.addEventListener('click', () => el.remove());
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = '⚠️ ' + msg + '\n(touche pour fermer)';
  } catch (_) { /* ignore */ }
}
window.addEventListener('error', (e) => showFatal(e.message + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : '')));
window.addEventListener('unhandledrejection', (e) => showFatal('Promesse rejetée : ' + ((e.reason && e.reason.message) || e.reason)));

// Version applicative (à garder en phase avec VERSION dans sw.js) — affichée sur
// l'accueil pour diagnostiquer facilement quelle version tourne réellement.
const APP_VERSION = 'v48';

// Pictogrammes & couleurs assignables à un point de passage.
const WPT_ICONS = ['📍', '🥤', '🍽️', '⛲', '🚰', '🏨', '🛏️', '⛺', '🪦', '🚻', '⚕️', '🅿️', '🚌', '👜', '⛰️', '🌲', '📷', '⚠️', '🚩', '🏁'];

/** Icônes sélectionnées d'un repère (tableau). Rétro-compat avec l'ancien champ `icon`. */
function metaIcons(m) {
  if (m && Array.isArray(m.icons)) return m.icons;
  if (m && m.icon) return [m.icon];
  return [];
}
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
  // volet live / followers
  mode: 'athlete',      // 'athlete' | 'follower'
  liveOn: false,        // athlète : diffusion de la position en cours
  myFollowCode: null,   // athlète : code de suivi de SON épreuve (distinct du code d'import)
  _liveLastSent: 0,     // throttle diffusion
  followCode: null,     // follower : code de suivi de l'athlète ACTIF
  followPseudo: null,   // follower : pseudo
  follows: [],          // follower : liste [{code, name}] des athlètes suivis
  followActive: 0,      // follower : index de l'athlète affiché
  _followTracks: {},    // cache code → { rawPoints, name }
  _followLive: {},      // dernier live par code (pastilles des onglets)
  _statusT: null,       // timer de statut multi-athlètes
  athleteFix: null,     // follower : dernière position reçue de l'athlète
  mediaMarks: [],       // marqueurs médias sur le profil
  seenMedia: new Set(), // ids de médias déjà vus (notif)
  seenCheers: new Set(),// ids d'encouragements déjà vus (notif)
  lastCheerIso: null,
  newFeed: 0, newInbox: 0,
  myProfile: null,      // athlète connecté : { first_name, last_name, avatar_path }
  _liveT: null, _mediaT: null, _cheerT: null,
  // persistance
  gpxKey: null,
  cloudCode: null,
  finishMeta: { info: '', cutoff: null, label: '🏁 Arrivée', icons: [], color: '' },
  _saveT: null,
};

// ------------------------------------------------------------------ INIT UI
function init() {
  $('gpx-input').addEventListener('change', onFilePicked);
  $('demo-btn').addEventListener('click', () => loadGpxText(demoGpx(), 'Parcours démo'));

  $('welcome-restore-btn').addEventListener('click', () => restoreFromCode($('welcome-code').value, true));
  $('welcome-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') restoreFromCode($('welcome-code').value, true);
  });

  // Volet FOLLOWER : suivre un athlète en live
  $('follow-btn').addEventListener('click', () => {
    const box = $('follow-box');
    box.hidden = !box.hidden;
    if (!box.hidden) $('follow-code').focus();
  });
  $('follow-go').addEventListener('click', () => followRace($('follow-code').value, $('follow-name').value));
  $('follow-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') followRace($('follow-code').value, $('follow-name').value); });
  $('follow-tabs').addEventListener('click', onFollowTabsClick);
  $('resume-follow').addEventListener('click', resumeFollowing);
  state.follows = loadFollows();
  state.followPseudo = localGet('pseudo') || null;
  updateResumeFollow();

  // Athlète : média (photo/vidéo), partage, boîte de réception
  $('act-photo').addEventListener('click', () => $('media-input').click());
  $('media-input').addEventListener('change', onMediaPicked);
  $('act-inbox').addEventListener('click', openInbox);
  $('live-share').addEventListener('click', shareLive);
  $('live-inbox').addEventListener('click', openInbox);
  $('live-feed').addEventListener('click', openMediaFeed);
  $('media-strip').addEventListener('click', (e) => {
    const t = e.target.closest('.ms-thumb');
    if (t) openMediaFromRow(findMedia(t.dataset.id));
  });
  $('mv-del').addEventListener('click', deleteViewedMedia);
  document.querySelectorAll('[data-mclose]').forEach((el) => el.addEventListener('click', () => { $('media-sheet').hidden = true; }));
  document.querySelectorAll('[data-iclose]').forEach((el) => el.addEventListener('click', () => { $('inbox-sheet').hidden = true; }));
  document.querySelectorAll('[data-vclose]').forEach((el) => el.addEventListener('click', () => { $('media-view').hidden = true; $('mv-body').innerHTML = ''; }));
  $('media-list').addEventListener('click', onMediaListClick);

  $('follow-geo').addEventListener('click', toggleFollowerGeo);
  // Follower : encouragements
  $('cheer-like').addEventListener('click', () => sendCheer({ is_like: true }));
  $('cheer-send').addEventListener('click', () => sendCheer({ text: $('cheer-input').value }));
  $('cheer-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCheer({ text: $('cheer-input').value }); });

  // Compte : inscription / connexion / mes épreuves
  $('auth-login').addEventListener('click', () => doAuth('login'));
  $('auth-signup').addEventListener('click', () => doAuth('signup'));
  $('auth-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth('login'); });
  $('auth-logout').addEventListener('click', () => { logout(); updateAuthUI(); });
  $('races-refresh').addEventListener('click', loadRaces);
  $('races-list').addEventListener('click', onRacesClick);
  updateAuthUI();

  // Mon profil (nom, prénom, photo)
  $('profile-btn').addEventListener('click', openProfileSheet);
  $('prof-save').addEventListener('click', saveProfile);
  $('prof-file').addEventListener('change', onProfilePhoto);
  document.querySelectorAll('[data-pclose]').forEach((el) => el.addEventListener('click', closeProfileSheet));

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
    const add = e.target.closest('.pr-addcut');
    if (add) { revealCutoff(add); return; }
    const del = e.target.closest('.pr-del');
    if (del) { armOrDeleteWaypoint(del); return; }
  });
  $('hide-km').addEventListener('click', hideKmWaypoints);
  $('undo-btn').addEventListener('click', runUndo);
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

  const ver = $('app-version'); if (ver) ver.textContent = APP_VERSION;

  // Lien profond : run-nav…?follow=CODE → pré-remplit le suivi d'un athlète
  const followParam = new URLSearchParams(location.search).get('follow');
  if (followParam) {
    $('follow-box').hidden = false;
    $('follow-code').value = followParam.toUpperCase();
    setTimeout(() => $('follow-name').focus(), 100);
  }

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
    state.mode = 'athlete';
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
  stopFollowerPolling(); stopInboxPolling(); // repart propre (changement d'épreuve)
  state.track = track;
  state.climbs = detectClimbs(track.points);
  state.waypoints = autoWaypoints(track);

  // persistance : clé du parcours + restauration des réglages sauvegardés.
  // On conserve le type d'activité choisi (accueil / dernier défaut) ; une config
  // sauvegardée pour ce parcours peut le surcharger.
  state.gpxKey = hashTrack(track);
  state.finishMeta = { info: '', cutoff: null, label: '🏁 Arrivée', icons: [], color: '' };
  const saved = localLoad(state.gpxKey);
  if (saved) applyConfig(saved);
  setActivityType(state.activity);
  state.cloudCode = localGet('code:' + state.gpxKey);
  state.myFollowCode = localGet('follow:' + state.gpxKey);
  state._cloudInit = false; // autorise l'auto-création de la sauvegarde cloud pour cette épreuve

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
    state.profile.onMediaTap = (md) => openMediaFromRow(md);
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
  applyModeUI();
  // athlète déjà partagé : écoute les encouragements + affiche ses photos + bandeau
  if (state.mode === 'athlete' && state.cloudCode && isLoggedIn()) { startInboxPolling(); updateLiveBanner(); }
  if (state.mode === 'follower') return; // le message d'accueil est géré par le suivi live
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
    wpts.push({ d: km * 1000, lat: pt.lat, lon: pt.lon, ele: pt.ele, label: `${km} km`, auto: true, info: '', cutoff: null, icons: [] });
  }
  // sommets de côtes
  for (const c of state.climbs) {
    const pt = pointAtDistance(track.points, c.endD);
    wpts.push({ d: c.endD, lat: pt.lat, lon: pt.lon, ele: pt.ele, label: `Sommet (${c.gain} m)`, auto: true, summit: true, info: '', cutoff: null, icons: [] });
  }
  wpts.sort((a, b) => a.d - b.d);
  return wpts;
}

/** Libellé d'une barrière horaire (heure + éventuel « +Nj »), ou null si absente. */
function barrierText(cutoff) {
  const ms = dtToMs(cutoff);
  return isFinite(ms) ? fmtClockRel(ms) : null;
}

function renderWaypointMarkers() {
  // Mode suivi (follower) : on n'affiche PAS les repères — juste position + photos.
  if (state.mode === 'follower') {
    if (state.map) state.map.clearWaypoints();
    state.profile.setWaypoints([]);
    state.profile.setFinishBarrier(false);
    return;
  }
  if (state.map) {
    state.map.clearWaypoints();
    for (const w of state.waypoints) {
      if (!w.auto || w.summit || metaIcons(w).length || w.color || w.cutoff) {
        state.map.addWaypointMarker(w, barrierText(w.cutoff), metaIcons(w));
      }
    }
    // arrivée : barrière et/ou icônes de dispo
    const fm = state.finishMeta;
    if (state.track && (fm.cutoff || metaIcons(fm).length)) {
      const last = state.track.points[state.track.points.length - 1];
      const m = state.map.addWaypointMarker({
        lat: last.lat, lon: last.lon,
        color: fm.color, label: fm.label || '🏁 Arrivée',
      }, barrierText(fm.cutoff), metaIcons(fm).length ? metaIcons(fm) : ['🏁']);
      if (m) { m.off('click'); m.on('click', () => showWaypointInfo(state.finishMeta, state.track.total)); }
    }
  }
  state.profile.setWaypoints(state.waypoints);
  state.profile.setFinishBarrier(!!state.finishMeta.cutoff);
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
  startLiveBroadcast();
}

function stopTracking() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.onRoute = null;
  $('offroute-banner').hidden = true;
  const btn = $('act-start');
  btn.classList.remove('tracking');
  btn.querySelector('.act-ico').textContent = '▶';
  btn.querySelector('span:last-child').textContent = 'Démarrer';
  toast('Suivi arrêté.');
  stopLiveBroadcast();
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

  // diffusion live pour les followers (position réelle, même hors parcours)
  if (state.liveOn) maybeBroadcast(lat, lon, proj.along, projected.ele);

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
  const w = { d, lat: pt.lat, lon: pt.lon, ele: pt.ele, label, auto: false, info: '', cutoff: null, icons: [] };
  state.waypoints.push(w);
  state.waypoints.sort((a, b) => a.d - b.d);
  renderWaypointMarkers();
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
    finishMeta: { info: state.finishMeta.info || '', cutoff: state.finishMeta.cutoff || null, label: state.finishMeta.label || '🏁 Arrivée', icons: metaIcons(state.finishMeta), color: state.finishMeta.color || '' },
    waypoints: state.waypoints.map((w) => ({
      d: w.d, label: w.label, info: w.info || '', cutoff: w.cutoff || null,
      icons: metaIcons(w), color: w.color || '',
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
  if (cfg.finishMeta) state.finishMeta = { info: cfg.finishMeta.info || '', cutoff: cfg.finishMeta.cutoff || null, label: cfg.finishMeta.label || '🏁 Arrivée', icons: metaIcons(cfg.finishMeta), color: cfg.finishMeta.color || '' };
  if (Array.isArray(cfg.waypoints) && cfg.waypoints.length) {
    state.waypoints = cfg.waypoints.map((w) => {
      const pt = pointAtDistance(state.track.points, w.d);
      return {
        d: w.d, lat: pt.lat, lon: pt.lon, ele: pt.ele, label: w.label,
        info: w.info || '', cutoff: w.cutoff || null, icons: metaIcons(w), color: w.color || '',
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

/** Sauvegarde locale immédiate (débounce) + cloud automatique.
    - Si l'épreuve a déjà un code cloud → on met à jour la config (patch).
    - Sinon, si l'utilisateur est connecté → on crée automatiquement la sauvegarde
      cloud (rattachée au compte) dès la première modification, sans rien cliquer. */
function autosave() {
  if (state.mode === 'follower') return; // un follower ne modifie/sauvegarde rien
  clearTimeout(state._saveT);
  state._saveT = setTimeout(() => {
    if (!state.track || !state.gpxKey) return;
    const cfg = buildConfig();
    localSave(state.gpxKey, cfg);
    if (state.cloudCode) {
      cloudSaveConfig(state.cloudCode, cfg, new Date().toISOString())
        .catch(() => { /* hors-ligne : le local suffit */ });
    } else if (isLoggedIn() && !state._cloudInit) {
      state._cloudInit = true; // évite de créer plusieurs codes en parallèle
      const code = makeCode();
      cloudSaveFull(code, state.gpxKey, state.track.name, cfg, serializeTrack(), new Date().toISOString())
        .then(() => {
          state.cloudCode = code;
          localSet('code:' + state.gpxKey, code);
          const el = $('cloud-code'); if (el) el.textContent = code;
        })
        .catch(() => { state._cloudInit = false; /* réessaie à la prochaine modif */ });
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

/** Ouvre un parcours depuis un code. asCopy=true → import d'une épreuve partagée
    (elle devient une COPIE perso : on n'adopte pas le code du propriétaire, l'athlète
    créera son propre code d'import + de suivi). asCopy=false → réouverture de SA propre épreuve. */
async function restoreFromCode(code, asCopy = false) {
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
    state.mode = 'athlete';
    startApp(track);              // construit carte + profil (applique aussi le local éventuel)
    applyConfig(row.data);        // puis on impose la config du cloud
    if (asCopy) {
      // Import : l'épreuve devient une copie perso. On n'adopte PAS le code du
      // propriétaire (state.cloudCode reste celui déjà éventuellement à soi, ou nul).
      state.myFollowCode = localGet('follow:' + state.gpxKey) || null;
      localSave(state.gpxKey, buildConfig());
      afterConfigRestored();
      toast(`« ${track.name} » importé. Règle-le et partage ton propre code de suivi.`);
    } else {
      state.cloudCode = code;
      localSet('code:' + state.gpxKey, code);
      localSave(state.gpxKey, buildConfig());
      afterConfigRestored();
      toast(`« ${track.name} » restauré depuis le cloud.`);
    }
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
  // Lancer sa course est réservé aux athlètes inscrits ; le suivi reste ouvert à tous.
  const tools = $('athlete-tools'); if (tools) tools.hidden = !on;
  const gate = $('athlete-gate'); if (gate) gate.hidden = on;
  showAuthError('');
  if (on) {
    $('auth-name').textContent = currentUser() || '—';
    loadRaces();
    loadMyProfile();
  } else {
    state.myProfile = null;
  }
}

/** Nom affiché de l'athlète auprès des followers : prénom+nom du profil, sinon identifiant. */
function myDisplayName() {
  const p = state.myProfile;
  if (p) {
    const nm = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
    if (nm) return nm;
  }
  return currentUser() || 'Athlète';
}

/** Charge le profil (nom, prénom, photo) du compte connecté et met à jour le libellé. */
async function loadMyProfile() {
  try {
    state.myProfile = await fetchMyProfile();
    if (state.myProfile) {
      const nm = [state.myProfile.first_name, state.myProfile.last_name].filter(Boolean).join(' ').trim();
      if (nm) $('auth-name').textContent = nm;
    }
  } catch (_) { /* non bloquant */ }
}

// --- Feuille « Mon profil » ---
let _pendingAvatar = null; // chemin d'une photo tout juste téléversée, en attente d'enregistrement

function renderProfAvatar(url) {
  const el = $('prof-avatar');
  if (url) { el.style.backgroundImage = `url('${String(url).replace(/'/g, '%27')}')`; el.classList.add('has-photo'); el.textContent = ''; }
  else { el.style.backgroundImage = ''; el.classList.remove('has-photo'); el.textContent = '🙂'; }
}
function openProfileSheet() {
  const p = state.myProfile || {};
  $('prof-first').value = p.first_name || '';
  $('prof-last').value = p.last_name || '';
  $('prof-error').hidden = true;
  _pendingAvatar = null;
  renderProfAvatar(p.avatar_path ? avatarUrl(p.avatar_path) : null);
  $('profile-sheet').hidden = false;
}
function closeProfileSheet() { $('profile-sheet').hidden = true; }
async function onProfilePhoto(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const err = $('prof-error'); err.hidden = true;
  try {
    renderProfAvatar(URL.createObjectURL(file)); // aperçu immédiat
    _pendingAvatar = await uploadAvatar(file);
  } catch (ex) {
    err.textContent = ex.message || 'Envoi de la photo impossible.'; err.hidden = false;
  }
}
async function saveProfile() {
  const btn = $('prof-save'); const prev = btn.textContent;
  const err = $('prof-error'); err.hidden = true;
  const p = {
    first_name: $('prof-first').value.trim(),
    last_name: $('prof-last').value.trim(),
    avatar_path: _pendingAvatar || (state.myProfile && state.myProfile.avatar_path) || null,
  };
  btn.disabled = true; btn.textContent = 'Enregistrement…';
  try {
    await saveMyProfile(p);
    state.myProfile = p;
    _pendingAvatar = null;
    const nm = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
    $('auth-name').textContent = nm || currentUser() || '—';
    // rediffuse le nom/photo à jour si un live est en cours
    if (state.liveOn && state.myFollowCode) {
      broadcastPosition(state.myFollowCode, { athlete_name: myDisplayName(), active: true }).catch(() => {});
    }
    closeProfileSheet();
    toast('Profil enregistré.');
  } catch (ex) {
    err.textContent = ex.message || 'Enregistrement impossible.'; err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = prev;
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
  renderPaceTable();       // met à jour l'état danger (et masque/affiche la ligne barrière)
  renderWaypointMarkers(); // fait apparaître/disparaître la barrière sur la carte & le profil
  autosave();
}
// Suppression de point : confirmation en 2 temps (anti-fausse-manip) + annulation 5 s.
let armedDel = null, armedT = null;

/** 1er tap = arme le bouton (« Supprimer ? ») ; 2e tap = supprime. Se désarme seul. */
function armOrDeleteWaypoint(btn) {
  if (btn === armedDel) { disarmDel(); deleteWaypoint(btn.dataset.wpi); return; }
  disarmDel();
  armedDel = btn;
  btn.classList.add('armed');
  btn.textContent = 'Supprimer ?';
  armedT = setTimeout(disarmDel, 3200);
}
function disarmDel() {
  clearTimeout(armedT); armedT = null;
  if (armedDel) { armedDel.classList.remove('armed'); armedDel.textContent = '🗑️'; armedDel = null; }
}

/** Réinsère des points au bon endroit (tri par distance). */
function reinsertWaypoints(list) {
  state.waypoints.push(...list);
  state.waypoints.sort((a, b) => a.d - b.d);
  renderWaypointMarkers();
  renderPaceTable();
  autosave();
}

/** Supprime un point de passage (borne km, sommet ou point manuel) — annulable 5 s. */
function deleteWaypoint(wpi) {
  const i = +wpi;
  if (!Number.isInteger(i) || i < 0 || i >= state.waypoints.length) return;
  const [removed] = state.waypoints.splice(i, 1);
  renderWaypointMarkers();
  renderPaceTable();
  autosave();
  showUndo(`Point « ${removed.label} » supprimé`, () => reinsertWaypoints([removed]));
}

/** Un point « borne kilométrique » automatique, non personnalisé (masquable en lot). */
function isPlainKmWaypoint(w) {
  return w.auto && !w.summit && !w.manual
    && !metaIcons(w).length && !w.color && !(w.info && w.info.trim()) && !w.cutoff
    && /^\d+(\.\d+)?\s*km$/.test((w.label || '').trim());
}

/** Masque toutes les bornes kilométriques auto (garde sommets et points personnalisés). */
function hideKmWaypoints() {
  const removed = state.waypoints.filter(isPlainKmWaypoint);
  if (!removed.length) { toast('Aucune borne kilométrique à masquer.'); return; }
  state.waypoints = state.waypoints.filter((w) => !isPlainKmWaypoint(w));
  renderWaypointMarkers();
  renderPaceTable();
  autosave();
  const n = removed.length;
  showUndo(`${n} borne${n > 1 ? 's' : ''} km masquée${n > 1 ? 's' : ''}`, () => reinsertWaypoints(removed));
}

// Barre d'annulation (visible ~5 s après une suppression).
let undoT = null, undoFn = null;
function showUndo(msg, fn) {
  undoFn = fn;
  $('undo-msg').textContent = msg;
  const bar = $('undo-bar');
  bar.hidden = false;
  requestAnimationFrame(() => bar.classList.add('show'));
  clearTimeout(undoT);
  undoT = setTimeout(hideUndo, 5000);
}
function hideUndo() {
  clearTimeout(undoT); undoT = null; undoFn = null;
  const bar = $('undo-bar');
  bar.classList.remove('show');
  setTimeout(() => { if (!bar.classList.contains('show')) bar.hidden = true; }, 250);
}
function runUndo() {
  const fn = undoFn;
  hideUndo();
  if (fn) fn();
}

/** Affiche la ligne « barrière horaire » (cachée par défaut) et ouvre le sélecteur. */
function revealCutoff(btn) {
  const card = btn.closest('.pace-card');
  if (!card) return;
  btn.hidden = true;
  const field = card.querySelector('.pc-cutfield');
  if (!field) return;
  field.hidden = false;
  const input = field.querySelector('.pr-cutoff');
  if (input) { input.focus(); if (input.showPicker) { try { input.showPicker(); } catch (_) { /* ignore */ } } }
}
function setWaypointInfo(wpi, val) {
  const m = getWpMeta(wpi); if (!m) return;
  m.info = val;
  autosave(); // pas de re-render (ne pas casser la saisie)
}
function setWaypointIcon(wpi, icon) {
  const m = getWpMeta(wpi); if (!m) return;
  const arr = metaIcons(m).slice();
  const i = arr.indexOf(icon);
  if (i >= 0) arr.splice(i, 1); else arr.push(icon); // coche / décoche
  m.icons = arr;
  if ('icon' in m) delete m.icon; // migre l'ancien champ mono-icône
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
  const titleIco = metaIcons(meta).length ? metaIcons(meta).join(' ') + ' ' : '';
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
    const headIco = metaIcons(r.meta).join('') || (r.summit ? '⛰️' : '');
    const dotColor = r.meta.color || '';
    html += `<div class="pace-card${passed ? ' passed' : ''}${r.summit ? ' summit' : ''}${danger ? ' danger' : ''}"${dotColor ? ` style="border-left:4px solid ${dotColor}"` : ''}>
      <div class="pc-head">
        ${headIco ? `<span class="pc-ico">${headIco}</span>` : ''}
        <input class="pr-name" type="text" value="${escapeHtml(name)}" data-wpi="${r.wpi}" aria-label="Nom du point" spellcheck="false">
        <span class="pc-km">${(r.d / 1000).toFixed(1)} km · ${fmtDuration(tSec)}</span>
        ${r.wpi === 'finish' ? '' : `<button class="pr-del" data-wpi="${r.wpi}" type="button" title="Supprimer ce point" aria-label="Supprimer ce point">🗑️</button>`}
      </div>
      <div class="pc-deco">
        <div class="pc-icons">${(() => { const sel = metaIcons(r.meta); return WPT_ICONS.map((ic) =>
          `<button class="pr-icon${sel.includes(ic) ? ' sel' : ''}" data-wpi="${r.wpi}" data-icon="${ic}" type="button">${ic}</button>`).join(''); })()}</div>
        <div class="pc-colors">${WPT_COLORS.map((co) =>
          `<button class="pr-color${r.meta.color === co ? ' sel' : ''}" data-wpi="${r.wpi}" data-color="${co}" style="background:${co}" type="button" aria-label="couleur"></button>`).join('')}</div>
      </div>
      <label class="pc-field">
        <span class="pc-flabel">Arrivée estimée ✎ <em class="pc-togo">${toGo}</em>${cutoffVal ? '' : `<button class="pr-addcut" data-wpi="${r.wpi}" type="button">+ barrière horaire</button>`}</span>
        <input class="pr-clock" type="datetime-local" value="${msToDtLocal(predMs)}" data-d="${r.d}" aria-label="Heure d'arrivée estimée">
      </label>
      <label class="pc-field pc-cutfield"${cutoffVal ? '' : ' hidden'}>
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

// ================================================================== VOLET LIVE / FOLLOWERS
function applyModeUI() {
  const follower = state.mode === 'follower';
  const ab = document.querySelector('.actionbar');
  if (ab) ab.hidden = follower;
  $('cheer-bar').hidden = !follower;
  if (!follower) { $('live-banner').hidden = !state.liveOn; }
}

function ensureNotifyPermission() {
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (_) { /* ignore */ }
}

function notify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body: body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
    }
  } catch (_) { /* ignore */ }
  toast(title + (body ? ' · ' + body : ''));
}
function fmtAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'à l’instant';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' h';
  return Math.floor(s / 86400) + ' j';
}

// ------------------------------------------------------- ATHLÈTE : diffusion + partage
/** Crée la sauvegarde cloud (code rattaché au compte) si elle n'existe pas encore. */
async function ensureCloudCode() {
  if (state.cloudCode) return state.cloudCode;
  const code = makeCode();
  await cloudSaveFull(code, state.gpxKey, state.track.name, buildConfig(), serializeTrack(), new Date().toISOString());
  state.cloudCode = code;
  localSet('code:' + state.gpxKey, code);
  const el = $('cloud-code'); if (el) el.textContent = code;
  startInboxPolling(); // dès que la course est partagée, on écoute les encouragements
  updateLiveBanner();  // fait apparaître le bandeau (partage · photos · messages)
  return code;
}

/** Code de SUIVI (follower) de l'athlète — distinct du code d'import. Le crée si besoin. */
async function ensureFollowCode() {
  await ensureCloudCode(); // il faut d'abord une épreuve en cloud (code d'import)
  if (state.myFollowCode) return state.myFollowCode;
  const local = localGet('follow:' + state.gpxKey);
  if (local) { state.myFollowCode = local; return local; }
  // déjà défini côté serveur ? (autre appareil)
  let existing = null;
  try { existing = await getFollowCode(state.cloudCode); } catch (_) { /* ignore */ }
  if (existing) { state.myFollowCode = existing; localSet('follow:' + state.gpxKey, existing); return existing; }
  // sinon on en génère un et on l'enregistre sur l'épreuve
  const fc = makeCode();
  await setFollowCode(state.cloudCode, fc);
  state.myFollowCode = fc;
  localSet('follow:' + state.gpxKey, fc);
  return fc;
}

async function startLiveBroadcast() {
  if (state.mode !== 'athlete') return;
  if (!isLoggedIn()) { toast('Connecte-toi pour partager ton suivi en live à tes supporters.'); return; }
  let fc;
  try { fc = await ensureFollowCode(); } catch (_) { toast('Impossible de démarrer le live (réseau ?).'); return; }
  state.liveOn = true;
  state._liveLastSent = 0;
  broadcastPosition(fc, { athlete_name: myDisplayName(), active: true }).catch(() => {});
  ensureNotifyPermission();
  startInboxPolling();
  updateLiveBanner();
  toast(`🔴 Live activé · partage le code de suivi ${fc} à tes supporters.`);
}
function stopLiveBroadcast() {
  if (!state.liveOn) return;
  state.liveOn = false;
  if (state.myFollowCode) setLiveActive(state.myFollowCode, false).catch(() => {});
  stopInboxPolling();
  updateLiveBanner();
}
function maybeBroadcast(lat, lon, d, ele) {
  if (!state.myFollowCode) return;
  const now = Date.now();
  if (now - state._liveLastSent < 5000) return;
  state._liveLastSent = now;
  broadcastPosition(state.myFollowCode, {
    athlete_name: myDisplayName(),
    lat, lon, d, ele, speed: state.liveSpeed || 0, active: true,
  }).catch(() => {});
}
function updateLiveBanner() {
  if (state.mode === 'follower') return;
  const b = $('live-banner');
  if (!state.cloudCode) { b.hidden = true; return; }
  b.hidden = false;
  $('follow-geo').hidden = true;   // (follower uniquement)
  $('live-share').hidden = false;
  $('live-inbox').hidden = false;
  $('live-feed').hidden = false;
  const suffix = state.myFollowCode ? ` · suivi ${state.myFollowCode}` : '';
  if (state.liveOn) {
    b.classList.remove('offline');
    $('live-text').textContent = `🔴 En live${suffix}`;
  } else {
    b.classList.add('offline');
    $('live-text').textContent = `Partagé${suffix || ' · appuie sur 🔗 pour le code de suivi'}`;
  }
}
async function shareLive() {
  let code;
  if (state.mode === 'follower') { code = state.followCode; }
  else { try { code = await ensureFollowCode(); } catch (_) { toast('Impossible (réseau ?).'); return; } updateLiveBanner(); }
  if (!code) return;
  const url = `${location.origin}${location.pathname}?follow=${code}`;
  const intro = state.mode === 'follower' ? 'Suis cet athlète en live' : 'Suis ma course en live';
  const text = `${intro} : ${url}\nCode de suivi : ${code}`;
  try {
    // On ne passe PAS `url` séparément : sinon Android le rajoute → URL en double.
    if (navigator.share) await navigator.share({ title: 'Run-Nav — suivi live', text });
    else { await navigator.clipboard.writeText(text); toast(`Message copié · code ${code}`); }
  } catch (_) { /* partage annulé */ }
}

// ------------------------------------------------------- ATHLÈTE : médias
async function onMediaPicked(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!isLoggedIn()) { toast('Connecte-toi pour poster une photo/vidéo.'); return; }
  if (file.size > 50 * 1024 * 1024) { toast('Fichier trop lourd (50 Mo max).'); return; }
  let code;
  try { code = await ensureFollowCode(); } catch (_) { toast('Impossible (réseau ?).'); return; }
  const caption = prompt('Légende (optionnel) :', '') || '';
  const d = (state.lastFix && state.lastFix.d != null) ? state.lastFix.d : (state.scrubD || 0);
  const p = pointAtDistance(state.track.points, d);
  const lat = (state.lastFix && state.lastFix.lat != null) ? state.lastFix.lat : p.lat;
  const lon = (state.lastFix && state.lastFix.lon != null) ? state.lastFix.lon : p.lon;
  toast('📤 Envoi du média…');
  try {
    await uploadMedia(code, file, { caption, lat, lon, d });
    toast('📸 Média publié ! Tes followers seront notifiés.');
    try { const media = await fetchMedia(code); state._media = media; refreshMediaMarkers(media); updateFeedBadge(); } catch (_) { /* ignore */ }
  } catch (err) { toast('Échec : ' + (err.message || 'envoi impossible')); }
}

// ------------------------------------------------------- ATHLÈTE : boîte de réception
function startInboxPolling() {
  stopInboxPolling();
  state._inboxLoaded = false;
  pollInbox();
  state._cheerT = setInterval(pollInbox, 12000);
}
function stopInboxPolling() { if (state._cheerT) { clearInterval(state._cheerT); state._cheerT = null; } }
async function pollInbox() {
  const fc = state.myFollowCode;
  if (!fc) return; // pas encore de code de suivi → rien à écouter
  let list;
  try { list = await fetchCheers(fc); } catch (_) { return; }
  state._cheers = list;
  if (state._inboxLoaded) {
    const news = list.filter((c) => !state.seenCheers.has(c.id));
    if (news.length) {
      state.newInbox += news.length;
      const c = news[0];
      notify('💬 ' + (c.author || 'Supporter'), c.is_like ? 'a envoyé un ❤️' : (c.text || ''));
    }
  }
  list.forEach((c) => state.seenCheers.add(c.id));
  state._inboxLoaded = true;
  // liste de ceux qui te suivent
  try {
    state._followers = await fetchFollowers(fc);
    if ($('inbox-sheet') && !$('inbox-sheet').hidden) renderFollowers(state._followers);
  } catch (_) { /* ignore */ }
  updateInboxBadge();
  // l'athlète voit aussi ses propres médias sur la carte / le profil
  try {
    const media = await fetchMedia(fc);
    state._media = media;
    refreshMediaMarkers(media);
    updateFeedBadge();
  } catch (_) { /* ignore */ }
}
function updateInboxBadge() {
  const n = state._cheers ? state._cheers.length : 0;
  $('inbox-count').textContent = n;
  $('live-inbox').classList.toggle('has-new', state.newInbox > 0);
  const b = $('act-inbox-badge');
  if (b) { b.textContent = state.newInbox; b.hidden = state.newInbox === 0; }
}
async function openInbox() {
  if (state.mode !== 'follower' && !state.cloudCode) { toast('Partage ta course (Live ou ☁️) pour recevoir des messages.'); return; }
  let fc = state.myFollowCode;
  if (!fc && state.mode === 'athlete') { try { fc = await ensureFollowCode(); startInboxPolling(); } catch (_) { /* ignore */ } }
  state.newInbox = 0; updateInboxBadge();
  let list = state._cheers;
  if (!list && fc) { try { list = await fetchCheers(fc); } catch (_) { list = []; } }
  if (!list) list = [];
  renderInbox(list);
  let followers = state._followers;
  if (!followers && fc) { try { followers = await fetchFollowers(fc); state._followers = followers; } catch (_) { followers = []; } }
  renderFollowers(followers || []);
  $('inbox-sheet').hidden = false;
}
function renderFollowers(list) {
  list = list || [];
  $('followers-count').textContent = list.length;
  $('followers-empty').hidden = list.length > 0;
  const now = Date.now();
  $('followers-list').innerHTML = list.map((f) => {
    const online = f.updated_at && (now - new Date(f.updated_at).getTime() < 150000);
    return `<div class="follower-row">
      <span class="fw-dot${online ? ' on' : ''}"></span>
      <span class="fw-who">${escapeHtml(f.pseudo || 'Supporter')}</span>
      <span class="fw-when">${online ? 'en ligne' : fmtAgo(f.updated_at)}</span>
    </div>`;
  }).join('');
}
function renderInbox(list) {
  $('inbox-empty').hidden = list.length > 0;
  $('inbox-list').innerHTML = list.map((c) => `<div class="cheer-row${c.is_like ? ' like' : ''}">
      <span class="cheer-who">${escapeHtml(c.author || 'Supporter')}</span>
      <span class="cheer-txt">${c.is_like ? '❤️' : escapeHtml(c.text || '')}</span>
      <span class="cheer-when">${fmtAgo(c.created_at)}</span>
    </div>`).join('');
}

// ------------------------------------------------------- FOLLOWER
function loadFollows() { try { return JSON.parse(localGet('follows') || '[]'); } catch (_) { return []; } }
function saveFollows() { localSet('follows', JSON.stringify(state.follows)); }

/** Entrée depuis l'accueil : valide, résout le code de suivi, ajoute et ouvre. */
/** Affiche/masque le bouton « Reprendre le suivi » selon les suivis en cache. */
function updateResumeFollow() {
  const btn = $('resume-follow');
  if (!btn) return;
  const n = (state.follows || []).length;
  btn.hidden = n === 0;
  if (n === 0) return;
  const sub = $('resume-follow-sub');
  if (sub) {
    if (n === 1) {
      const f = state.follows[0];
      sub.textContent = (f.athleteName || f.name || 'un athlète').trim();
    } else {
      sub.textContent = `${n} athlètes`;
    }
  }
}

/** Reprend le suivi mis en cache (après un rafraîchissement) sans ressaisir les codes. */
async function resumeFollowing() {
  if (!state.follows || !state.follows.length) { updateResumeFollow(); return; }
  const btn = $('resume-follow'); const prev = btn.innerHTML;
  btn.disabled = true; btn.querySelector('.rf-txt').innerHTML = '<b>Reprise…</b>';
  try {
    let idx = parseInt(localGet('followActive'), 10);
    if (!(idx >= 0 && idx < state.follows.length)) idx = 0;
    await openFollowAthlete(idx);
  } catch (_) {
    toast('Reprise impossible (réseau ?).');
  } finally {
    btn.disabled = false; btn.innerHTML = prev;
  }
}

async function followRace(code, pseudo) {
  pseudo = (pseudo || '').trim();
  if (!pseudo) { showWelcomeError('Choisis un prénom / pseudo.'); return; }
  const btn = $('follow-go'); const prev = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try { await followAthlete(code, pseudo); }
  finally { btn.disabled = false; btn.textContent = prev; }
}

/** Ajoute un athlète (par code de suivi) et l'affiche. */
async function followAthlete(code, pseudo) {
  code = (code || '').trim().toUpperCase();
  pseudo = (pseudo || state.followPseudo || '').trim();
  if (code.length < 4) { showWelcomeError('Saisis un code de suivi valide.'); toast('Code de suivi invalide.'); return false; }
  if (!pseudo) { showWelcomeError('Choisis un prénom / pseudo.'); return false; }
  const row = await resolveFollow(code);
  if (!row) { showWelcomeError('Aucun athlète pour ce code de suivi.'); toast('Code de suivi introuvable.'); return false; }
  let t = row.track;
  if (typeof t === 'string') { try { t = JSON.parse(t); } catch (_) { t = null; } }
  if (!t || !Array.isArray(t.pts) || t.pts.length < 2) { showWelcomeError('Cet athlète n’a pas de trace partagée.'); return false; }
  state.followPseudo = pseudo; localSet('pseudo', pseudo);
  state._followTracks[code] = { rawPoints: t.pts.map((a) => ({ lat: a[0], lon: a[1], ele: a[2] })), name: row.name || 'Course' };
  const aName = (row.athlete_name || '').trim() || null;
  const avatar = row.avatar_path || null;
  let idx = state.follows.findIndex((f) => f.code === code);
  if (idx < 0) { state.follows.push({ code, name: row.name || 'Course', athleteName: aName, avatar }); idx = state.follows.length - 1; saveFollows(); }
  else { state.follows[idx].name = row.name || state.follows[idx].name; state.follows[idx].athleteName = aName || state.follows[idx].athleteName; state.follows[idx].avatar = avatar || state.follows[idx].avatar; saveFollows(); }
  await openFollowAthlete(idx);
  return true;
}

/** Affiche l'athlète d'indice idx (recharge sa trace si besoin). */
async function openFollowAthlete(idx) {
  const f = state.follows[idx]; if (!f) return;
  if (!state._followTracks[f.code]) {
    const row = await resolveFollow(f.code);
    let t = row && row.track;
    if (typeof t === 'string') { try { t = JSON.parse(t); } catch (_) { t = null; } }
    if (!t || !Array.isArray(t.pts) || t.pts.length < 2) { toast(`« ${f.name} » indisponible.`); return; }
    state._followTracks[f.code] = { rawPoints: t.pts.map((a) => ({ lat: a[0], lon: a[1], ele: a[2] })), name: (row && row.name) || f.name };
    if (row) {
      if (row.name) f.name = row.name;
      if ((row.athlete_name || '').trim()) f.athleteName = row.athlete_name.trim();
      if (row.avatar_path) f.avatar = row.avatar_path;
      saveFollows();
    }
  }
  const cached = state._followTracks[f.code];
  const track = buildTrack(cached.rawPoints);
  track.name = cached.name || f.name || 'Course';
  state.rawPoints = cached.rawPoints;
  state.mode = 'follower';
  state.followActive = idx;
  state.followCode = f.code;
  localSet('followActive', String(idx));
  startApp(track);
  enterFollowerMode();
}

function enterFollowerMode() {
  applyModeUI();
  state.follow = false;
  state.seenMedia = new Set(); state._mediaLoaded = false;
  state.newFeed = 0; state._media = null;
  refreshMediaMarkers([]);
  ensureNotifyPermission();
  $('live-banner').hidden = false;
  $('follow-geo').hidden = false;
  updateFollowerBanner(state._followLive[state.followCode] || null);
  renderFollowTabs();
  renderAllAthletes();
  // présence immédiate : l'athlète voit tout de suite qui le suit
  if (state.followPseudo) {
    state._lastPresence = Date.now();
    state.follows.forEach((f) => { registerFollower(f.code, state.followPseudo).catch(() => {}); });
  }
  startFollowerPolling();
  toast(`👀 Tu suis « ${state.track.name} » en live.`);
}

// --- Onglets multi-athlètes ---
function renderFollowTabs() {
  const el = $('follow-tabs');
  if (!el) return;
  if (state.mode !== 'follower' || state.follows.length < 1) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = state.follows.map((f, i) => {
    const live = state._followLive[f.code];
    const on = live && live.active && live.updated_at && (Date.now() - new Date(live.updated_at).getTime() < 120000);
    return `<button class="ftab${i === state.followActive ? ' active' : ''}" data-i="${i}">` +
      `<span class="ft-dot${on ? ' on' : ''}" style="background:${athColor(i)}"></span>${escapeHtml(f.athleteName || f.name || f.code)}` +
      `<span class="ft-x" data-x="${i}" title="Retirer">✕</span></button>`;
  }).join('') + `<button class="ftab-add" data-add="1" title="Suivre un autre athlète">＋</button>`;
}
function onFollowTabsClick(e) {
  const x = e.target.closest('[data-x]');
  if (x) { e.stopPropagation(); removeFollow(+x.dataset.x); return; }
  const add = e.target.closest('[data-add]');
  if (add) { const c = prompt('Code de suivi de l’athlète :'); if (c) followAthlete(c, state.followPseudo); return; }
  const tab = e.target.closest('[data-i]');
  if (tab) { const i = +tab.dataset.i; if (i !== state.followActive) openFollowAthlete(i); }
}
function removeFollow(idx) {
  const f = state.follows[idx]; if (!f) return;
  if (!confirm(`Ne plus suivre « ${f.name} » ?`)) return;
  state.follows.splice(idx, 1); saveFollows();
  if (!state.follows.length) { exitFollowerToWelcome(); return; }
  const next = Math.max(0, Math.min(idx, state.follows.length - 1));
  openFollowAthlete(next);
}
function exitFollowerToWelcome() {
  stopFollowerPolling();
  if (state.map) state.map.clearAthletes();
  state.mode = 'athlete';
  $('app').hidden = true;
  $('welcome').hidden = false;
  updateResumeFollow();
}

// --- Géolocalisation du follower : voir si l'athlète s'approche ---
function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function toggleFollowerGeo() {
  if (state.followerWatchId != null) {
    navigator.geolocation.clearWatch(state.followerWatchId);
    state.followerWatchId = null; state.followerPos = null; state._lastDist = null;
    if (state.map) state.map.clearFollowerPosition();
    $('follow-geo').classList.remove('active');
    updateFollowerBanner(state.athleteFix);
    toast('Ta position n’est plus affichée.');
    return;
  }
  if (!('geolocation' in navigator)) { toast('Géolocalisation non disponible.'); return; }
  state.followerWatchId = navigator.geolocation.watchPosition((pos) => {
    state.followerPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    if (state.map) state.map.setFollowerPosition(state.followerPos.lat, state.followerPos.lon);
    $('follow-geo').classList.add('active');
    updateFollowerBanner(state.athleteFix);
  }, () => { toast('Position refusée ou indisponible.'); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  toast('📍 Activation de ta position…');
}
function startFollowerPolling() {
  stopFollowerPolling();
  pollFollower();
  state._liveT = setInterval(pollFollower, 5000);
}
function stopFollowerPolling() {
  if (state._liveT) { clearInterval(state._liveT); state._liveT = null; }
  if (state.map) state.map.clearAthletes();
  if (state.followerWatchId != null) {
    try { navigator.geolocation.clearWatch(state.followerWatchId); } catch (_) { /* ignore */ }
    state.followerWatchId = null; state.followerPos = null; state._lastDist = null;
    if (state.map) state.map.clearFollowerPosition();
  }
}
async function pollFollower() {
  if (state.mode !== 'follower' || !state.follows.length) return;
  try {
    // battement de présence (~toutes les 45 s) : l'athlète voit qui le suit
    const now = Date.now();
    if (state.followPseudo && now - (state._lastPresence || 0) > 45000) {
      state._lastPresence = now;
      state.follows.forEach((f) => { registerFollower(f.code, state.followPseudo).catch(() => {}); });
    }
    // positions de TOUS les athlètes suivis (affichés sur la même carte)
    await Promise.all(state.follows.map(async (f) => {
      try { const live = await fetchLive(f.code); if (live) state._followLive[f.code] = live; } catch (_) { /* ignore */ }
    }));
    renderAllAthletes();
    renderFollowTabs();
    // détail de l'athlète focalisé (profil / stats / bannière / médias)
    const active = state._followLive[state.followCode];
    updateFollowerBanner(active || null);
    if (active && active.lat != null) renderAthletePosition(active);
    const media = await fetchMedia(state.followCode);
    handleFollowerMedia(media);
  } catch (_) { /* réseau : on réessaiera au prochain tick */ }
}

// Couleurs distinctes par athlète suivi.
const ATH_COLORS = ['#4aa3ff', '#ff5a3c', '#3fbf6f', '#b06fff', '#ffd24a', '#ff6fae', '#20c9c9', '#ff9f40'];
function athColor(i) { return ATH_COLORS[i % ATH_COLORS.length]; }

/** Affiche tous les athlètes suivis sur la carte (marqueurs colorés cliquables). */
function renderAllAthletes() {
  if (!state.map) return;
  const now = Date.now();
  const list = state.follows.map((f, i) => {
    const live = state._followLive[f.code];
    if (live && live.athlete_name) f.athleteName = live.athlete_name; // nom réel de l'athlète (live)
    if (!live || live.lat == null) return null;
    const on = live.active && live.updated_at && (now - new Date(live.updated_at).getTime() < 120000);
    const nm = (f.athleteName || f.name || f.code).trim();
    return {
      code: f.code, lat: live.lat, lon: live.lon,
      name: escapeHtml(nm), initial: (nm.charAt(0) || '?').toUpperCase(),
      avatar: f.avatar ? avatarUrl(f.avatar) : null,
      color: athColor(i), active: on, focused: f.code === state.followCode,
    };
  }).filter(Boolean);
  state.map.setAthletes(list, (code) => {
    const i = state.follows.findIndex((f) => f.code === code);
    if (i >= 0 && code !== state.followCode) openFollowAthlete(i);
  });
}
function updateFollowerBanner(live) {
  const b = $('live-banner');
  b.hidden = false;
  $('live-feed').hidden = false;
  $('live-inbox').hidden = true;
  $('live-share').hidden = false;
  $('follow-geo').hidden = false;
  const focused = state.follows.find((f) => f.code === state.followCode);
  const name = (live && (live.athlete_name || '').trim())
    || (focused && (focused.athleteName || '').trim())
    || 'Athlète';
  const fresh = live && live.updated_at && (Date.now() - new Date(live.updated_at).getTime() < 120000);
  // distance athlète ↔ moi (si le follower a activé sa position)
  let meTxt = '';
  if (state.followerPos && live && live.lat != null) {
    const dist = haversine(state.followerPos, { lat: live.lat, lon: live.lon });
    let trend = '';
    if (state._lastDist != null) {
      if (dist < state._lastDist - 15) trend = ' ↓'; // se rapproche
      else if (dist > state._lastDist + 15) trend = ' ↑'; // s'éloigne
    }
    state._lastDist = dist;
    meTxt = ` · 👣 ${dist < 1000 ? Math.round(dist) + ' m' : (dist / 1000).toFixed(1) + ' km'} de toi${trend}`;
  }
  if (live && live.active && fresh) {
    b.classList.remove('offline');
    const km = live.d != null ? ` · ${(live.d / 1000).toFixed(1)} km` : '';
    $('live-text').textContent = `🔴 ${name}${km}${meTxt}`;
  } else {
    b.classList.add('offline');
    $('live-text').textContent = (live ? `${name} · hors ligne` : `${name} · pas encore parti`) + meTxt;
  }
}
function renderAthletePosition(live) {
  state.athleteFix = live;
  const proj = projectOnTrack({ lat: live.lat, lon: live.lon }, state.track.points, state.hint);
  state.hint = proj.index;
  const projected = pointAtDistance(state.track.points, proj.along);
  // la position est portée par le marqueur coloré de l'athlète (setAthletes) ;
  // ici on ne trace que la portion parcourue de la trace de l'athlète focalisé.
  if (state.map) state.map.setProgress(proj.index, projected);
  const d = live.d != null ? live.d : proj.along;
  state.lastFix = { lat: live.lat, lon: live.lon, d, index: proj.index, onRoute: true, t: Date.now() };
  state.liveSpeed = live.speed || 0;
  state.profile.setCursor(d);
  updateStatbar(d, 0);
  updateClimbBanner(d);
}
function handleFollowerMedia(media) {
  state._media = media;
  if (state._mediaLoaded) {
    const news = media.filter((m) => !state.seenMedia.has(m.id));
    if (news.length) {
      state.newFeed += news.length;
      const m = news[0];
      notify(`📸 Nouvelle ${m.kind === 'video' ? 'vidéo' : 'photo'}`, m.caption || `de ${(state.athleteFix && state.athleteFix.athlete_name) || 'l’athlète'}`);
    }
  }
  media.forEach((m) => state.seenMedia.add(m.id));
  state._mediaLoaded = true;
  refreshMediaMarkers(media);
  updateFeedBadge();
}

/** Place les vignettes sur la carte + le profil et met à jour le bandeau photos. */
function refreshMediaMarkers(list) {
  const withUrl = (list || []).map((m) => ({ ...m, url: mediaUrl(m.path) }));
  if (state.map) state.map.setMediaMarkers(withUrl, (md) => openMediaFromRow(md));
  if (state.profile) state.profile.setMedia(withUrl);
  renderMediaStrip(withUrl);
}
function findMedia(id) { return (state._media || []).find((m) => m.id === id) || null; }
function openMediaFromRow(md) {
  if (!md) return;
  state._viewMedia = md;
  const url = md.url || mediaUrl(md.path);
  $('mv-body').innerHTML = md.kind === 'video'
    ? `<video src="${url}" controls autoplay playsinline></video>`
    : `<img src="${url}" alt="">`;
  $('mv-cap').textContent = md.caption || '';
  $('mv-del').hidden = (state.mode !== 'athlete'); // seul l'athlète (propriétaire) supprime
  $('media-view').hidden = false;
}
async function deleteViewedMedia() {
  const md = state._viewMedia; if (!md) return;
  if (!confirm('Supprimer définitivement ce média ?')) return;
  try {
    await deleteMedia(md.id, md.path);
    const media = (state._media || []).filter((m) => m.id !== md.id);
    state._media = media;
    refreshMediaMarkers(media);
    if (!$('media-sheet').hidden) renderMediaList(media);
    updateFeedBadge();
    $('media-view').hidden = true; $('mv-body').innerHTML = '';
    toast('Média supprimé.');
  } catch (e) { toast('Suppression impossible (réseau ?).'); }
}

/** Bandeau horizontal de vignettes (mise en évidence des photos sur le suivi). */
function renderMediaStrip(list) {
  const strip = $('media-strip');
  if (!strip) return;
  const photos = (list || []);
  if (state.mode !== 'follower' || !photos.length) { strip.hidden = true; strip.innerHTML = ''; return; }
  strip.hidden = false;
  strip.innerHTML = `<div class="ms-label">📷 ${photos.length}</div>` + photos.map((m) => {
    const url = m.url || mediaUrl(m.path);
    const inner = m.kind === 'video'
      ? `<video src="${url}#t=0.1" preload="metadata" muted playsinline></video><span class="ms-play">▶</span>`
      : `<img src="${url}" loading="lazy" alt="">`;
    return `<div class="ms-thumb" data-id="${escAttr(m.id)}">${inner}</div>`;
  }).join('');
}
async function sendCheer({ is_like, text }) {
  if (state.mode !== 'follower' || !state.followCode) return;
  text = (text || '').trim();
  if (!is_like && !text) return;
  const ok = await postCheer(state.followCode, {
    author: state.followPseudo || 'Supporter', is_like: !!is_like, text: text || null,
  });
  if (!ok) { toast('Échec de l’envoi (réseau ?).'); return; }
  if (is_like) { const bt = $('cheer-like'); bt.classList.remove('pop'); void bt.offsetWidth; bt.classList.add('pop'); toast('❤️ Envoyé !'); }
  else { $('cheer-input').value = ''; toast('💬 Message envoyé !'); }
}

// ------------------------------------------------------- MÉDIAS : fil + visionneuse (partagé)
function updateFeedBadge() {
  const n = state._media ? state._media.length : 0;
  $('feed-count').textContent = n;
  $('live-feed').classList.toggle('has-new', state.newFeed > 0);
}
async function openMediaFeed() {
  state.newFeed = 0;
  const code = state.mode === 'follower' ? state.followCode : state.myFollowCode;
  const list = state._media || (code ? await fetchMedia(code) : []);
  state._media = list;
  renderMediaList(list);
  $('media-sheet').hidden = false;
  updateFeedBadge();
}
function renderMediaList(list) {
  const owner = state.mode === 'athlete';
  $('media-empty').hidden = list.length > 0;
  $('media-list').innerHTML = list.map((m) => {
    const url = m.url || mediaUrl(m.path);
    const thumb = m.kind === 'video'
      ? `<video src="${url}#t=0.1" preload="metadata" muted playsinline></video><span class="mi-play">▶</span>`
      : `<img src="${url}" loading="lazy" alt="">`;
    const cap = m.caption ? `<span class="mi-cap">${escapeHtml(m.caption)}</span>` : '';
    const del = owner ? `<button class="mi-del" data-del="${escAttr(m.id)}" type="button" title="Supprimer">🗑️</button>` : '';
    return `<div class="media-item" data-id="${escAttr(m.id)}">${thumb}${cap}${del}</div>`;
  }).join('');
}
function onMediaListClick(e) {
  const del = e.target.closest('[data-del]');
  if (del) { e.stopPropagation(); state._viewMedia = findMedia(del.dataset.del); deleteViewedMedia(); return; }
  const it = e.target.closest('.media-item'); if (!it) return;
  openMediaFromRow(findMedia(it.dataset.id));
}

init();
