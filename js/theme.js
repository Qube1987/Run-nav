// Thème clair / sombre.
//
// Trois choix utilisateur : 'auto' (réglage du téléphone), 'light', 'dark'.
// Un seul est *résolu* et posé en [data-theme] sur <html> — le CSS n'a donc
// qu'une variante à écrire (`:root[data-theme="light"]`) au lieu de dupliquer
// la palette dans un `@media (prefers-color-scheme)`.
//
// La pose initiale est faite par un script en tête d'index.html, AVANT le
// premier rendu : sans lui, l'écran clignote en sombre au chargement.

const KEY = 'runnav:theme';
export const THEMES = ['auto', 'light', 'dark'];
export const THEME_LABEL = { auto: 'Auto', light: 'Clair', dark: 'Sombre' };
export const THEME_ICON = { auto: '🌗', light: '☀️', dark: '🌙' };

const listeners = new Set();
const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

/** Choix enregistré ('auto' par défaut). */
export function getTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : 'auto';
  } catch (_) { return 'auto'; }
}

/** Thème réellement appliqué : 'light' ou 'dark'. */
export function resolvedTheme() {
  const t = getTheme();
  if (t !== 'auto') return t;
  return mq && mq.matches ? 'light' : 'dark';
}

function apply() {
  const r = resolvedTheme();
  document.documentElement.dataset.theme = r;
  // La barre système d'Android/iOS reprend cette couleur : sans mise à jour,
  // elle resterait sombre au-dessus d'une appli claire.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', getComputedStyle(document.documentElement)
      .getPropertyValue('--bg').trim() || (r === 'light' ? '#f4f7fa' : '#0f1419'));
  }
  for (const fn of listeners) { try { fn(r); } catch (_) { /* un abonné ne doit pas bloquer les autres */ } }
}

export function setTheme(t) {
  if (!THEMES.includes(t)) t = 'auto';
  try { localStorage.setItem(KEY, t); } catch (_) { /* mode privé */ }
  apply();
}

/** Bascule auto → clair → sombre → auto (bouton unique en course). */
export function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
  setTheme(next);
  return next;
}

/** Appelé à chaque changement effectif (y compris quand le téléphone bascule). */
export function onThemeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// En mode auto, suivre le réglage du téléphone à chaud (nuit qui tombe, mode
// sombre programmé…). addEventListener n'existe pas sur les vieux Safari.
if (mq) {
  const onSys = () => { if (getTheme() === 'auto') apply(); };
  if (mq.addEventListener) mq.addEventListener('change', onSys);
  else if (mq.addListener) mq.addListener(onSys);
}

apply();
