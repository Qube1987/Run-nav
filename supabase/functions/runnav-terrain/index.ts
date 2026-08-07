// Edge Function « runnav-terrain » — reconnaissance de la nature du sol.
//
// Pendant manquant de « runnav-pois » : l'application savait LIRE runnav_terrain
// mais rien ne le REMPLISSAIT (la seule trace renseignée l'avait été à la main).
// Appelée à l'import d'un GPX, exactement comme les POI.
//
// Principe : on échantillonne la trace, on demande à Overpass les chemins
// (`highway`) proches, on rattache chaque échantillon au chemin le plus proche,
// et on lit ses tags pour en déduire une nature de sol. Le résultat est encodé
// en segments [début, fin, code] et mis en cache dans runnav_terrain.
//
// Pourquoi côté serveur : Overpass est limité en débit et répond en plusieurs
// secondes ; la réponse `out geom` pèse plusieurs Mo. Hors de question de la
// faire transiter par un téléphone en course.

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const SAMPLE = 100;         // m — pas d'analyse (granularité des segments)
const ANCHOR_SPACING = 250; // m — pas des ancres `around` (taille de la requête)
// Rayon d'appariement. Les deux erreurs ne se valent pas :
//   - trop serré  → un sentier cartographié ressort « inconnu ». Gênant, honnête.
//   - trop large  → un sentier NON cartographié longeant une route est annoncé
//     « goudron ». Là on ment, et le mensonge se propage : la courabilité des
//     descentes se calcule à partir de la nature du sol (route = 1.0).
// La seconde est donc la faute à éviter. Mesure sur une trace posée sur des
// chemins réels (GR20, 16.6 km), avec bruit GPS injecté : écart P90 de 9 m à
// ±10 m de bruit, 23 m à ±25 m, 35 m à ±40 m — couverture 100 % dans les trois
// cas. 40 m couvre donc déjà un bruit irréaliste, sans tendre la main à la
// route d'à côté.
const RADIUS = 40;
const MIN_SEG = 150;        // m — en deçà, on absorbe dans le voisin (bruit d'appariement)
const MAX_PTS = 20000;

type Pt = [number, number, number]; // [lat, lon, d]
type Tags = Record<string, string>;

/* ---- classification ---------------------------------------------------- */
/* Ordre de priorité : sac_scale (difficulté alpine) > surface > tracktype >
   highway. `surface` est le tag le plus fiable quand il est présent ; on ne
   retombe sur le type de voie que faute de mieux. */

const SURFACE: Record<string, string> = {
  asphalt: 'route', paved: 'route', concrete: 'route', 'concrete:plates': 'route',
  concrete_plates: 'route', paving_stones: 'route', sett: 'route', cobblestone: 'route',
  chipseal: 'route', metal: 'route', wood: 'route', bricks: 'route',
  compacted: 'compacte', fine_gravel: 'compacte',
  gravel: 'gravier', pebblestone: 'gravier',
  ground: 'terre', dirt: 'terre', earth: 'terre', mud: 'terre', grass: 'terre',
  sand: 'terre', woodchips: 'terre', grass_paver: 'terre',
  rock: 'rocaille', stone: 'rocaille', scree: 'rocaille',
};
const TRACKTYPE: Record<string, string> = {
  grade1: 'route', grade2: 'compacte', grade3: 'gravier', grade4: 'terre', grade5: 'terre',
};
const HIGHWAY: Record<string, string> = {
  motorway: 'route', motorway_link: 'route', trunk: 'route', trunk_link: 'route',
  primary: 'route', primary_link: 'route', secondary: 'route', secondary_link: 'route',
  tertiary: 'route', tertiary_link: 'route', unclassified: 'route', residential: 'route',
  living_street: 'route', service: 'route', pedestrian: 'route', cycleway: 'route',
  track: 'compacte', path: 'sentier', footway: 'sentier', bridleway: 'sentier',
  steps: 'technique', via_ferrata: 'technique',
};
// Randonnée alpine : T3 et au-delà — main courante, passages rocheux.
const HARD_SAC = new Set([
  'demanding_mountain_hiking', 'alpine_hiking',
  'demanding_alpine_hiking', 'difficult_alpine_hiking',
]);

function classify(t: Tags): string {
  if (t.sac_scale && HARD_SAC.has(t.sac_scale)) return 'technique';
  if (t.via_ferrata_scale) return 'technique';
  const s = (t.surface || '').toLowerCase();
  if (s && SURFACE[s]) return SURFACE[s];
  const tt = (t.tracktype || '').toLowerCase();
  if (tt && TRACKTYPE[tt]) return TRACKTYPE[tt];
  // `unpaved` seul ne dit pas grand-chose : on le rabat sur le type de voie.
  const h = (t.highway || '').toLowerCase();
  if (s === 'unpaved') return h === 'track' ? 'compacte' : 'terre';
  if (h && HIGHWAY[h]) return HIGHWAY[h];
  return 'inconnu';
}

/* ---- géométrie --------------------------------------------------------- */

function sampleAt(pts: Pt[], spacing: number): Pt[] {
  const out: Pt[] = [pts[0]];
  let last = pts[0][2];
  for (const p of pts) if (p[2] - last >= spacing) { out.push(p); last = p[2]; }
  const end = pts[pts.length - 1];
  if (out[out.length - 1][2] !== end[2]) out.push(end);
  return out;
}

function buildQuery(anchors: Pt[]): string {
  const around = anchors.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(',');
  // `out tags geom` : il FAUT la géométrie pour savoir lequel des chemins
  // voisins on suit réellement — `center` désignerait le milieu d'une route de
  // 3 km, sans rapport avec le point de la trace.
  return `[out:json][timeout:180];
way["highway"](around:${RADIUS},${around});
out tags geom;`;
}

Deno.serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const body = await req.json();
    const gpxKey: string = String(body.gpxKey || '').trim();
    const pts: Pt[] = body.pts;
    const force = body.force === true;   // recalcul explicite (bouton « relancer »)
    if (!gpxKey || !Array.isArray(pts) || pts.length < 2 || pts.length > MAX_PTS) {
      return new Response(JSON.stringify({ error: 'payload invalide' }), { status: 400, headers: cors });
    }

    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const hdr = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

    // Idempotent : deux athlètes important le même GPX partagent le calcul.
    if (!force) {
      const seen = await fetch(`${url}/rest/v1/runnav_terrain?gpx_key=eq.${encodeURIComponent(gpxKey)}&select=gpx_key`, { headers: hdr });
      if (seen.ok) {
        const rows = await seen.json();
        if (Array.isArray(rows) && rows.length) {
          return new Response(JSON.stringify({ status: 'cached' }), { headers: cors });
        }
      }
    }

    const samples = sampleAt(pts, SAMPLE);
    const anchors = sampleAt(pts, ANCHOR_SPACING);

    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'run-nav/1.0 (+https://run-nav.netlify.app)',
      },
      body: 'data=' + encodeURIComponent(buildQuery(anchors)),
    });
    if (!res.ok) {
      // 429 / 504 : Overpass sature. On ne stocke rien, l'app réessaiera.
      return new Response(JSON.stringify({ status: 'overpass', code: res.status }), { status: 503, headers: cors });
    }
    const osm = await res.json();
    const ways = (osm.elements || []).filter((e: { type: string; geometry?: unknown[] }) =>
      e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length >= 2);

    // Plan local équirectangulaire : à cette échelle l'erreur est négligeable
    // et l'appariement descend de trigonométrie sphérique à des soustractions.
    const R = 6371000, rad = Math.PI / 180;
    const cosLat = Math.cos(pts[0][0] * rad);
    const X = (lon: number) => lon * rad * cosLat * R;
    const Y = (lat: number) => lat * rad * R;

    // Pré-projection des chemins + boîte englobante, pour écarter d'emblée
    // ceux qui ne peuvent pas être les plus proches.
    const prepped = ways.map((w: { tags?: Tags; geometry: { lat: number; lon: number }[] }) => {
      const gx = new Float64Array(w.geometry.length), gy = new Float64Array(w.geometry.length);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < w.geometry.length; i++) {
        const x = X(w.geometry[i].lon), y = Y(w.geometry[i].lat);
        gx[i] = x; gy[i] = y;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      return { code: classify(w.tags || {}), gx, gy, x0, x1, y0, y1 };
    });

    const R2 = RADIUS * RADIUS;
    const codes: string[] = [];
    const offs: number[] = [];   // écarts trace ↔ chemin retenu, pour diagnostic
    for (const s of samples) {
      const px = X(s[1]), py = Y(s[0]);
      let best = R2, code = 'inconnu';
      for (const w of prepped) {
        if (px < w.x0 - RADIUS || px > w.x1 + RADIUS || py < w.y0 - RADIUS || py > w.y1 + RADIUS) continue;
        for (let i = 0; i < w.gx.length - 1; i++) {
          const ax = w.gx[i], ay = w.gy[i];
          const dx = w.gx[i + 1] - ax, dy = w.gy[i + 1] - ay;
          const l2 = dx * dx + dy * dy;
          let u = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
          u = u < 0 ? 0 : (u > 1 ? 1 : u);
          const cx = ax + u * dx, cy = ay + u * dy;
          const d2 = (px - cx) ** 2 + (py - cy) ** 2;
          if (d2 < best) { best = d2; code = w.code; }
        }
      }
      codes.push(code);
      if (code !== 'inconnu') offs.push(Math.sqrt(best));
    }

    // --- encodage en segments, puis absorption du bruit --------------------
    // Un échantillon isolé rattaché à un chemin parallèle produirait un segment
    // de 100 m aberrant. En deçà de MIN_SEG on le fond dans le voisin le plus
    // long : la nature du sol ne change pas tous les 100 m.
    type Seg = [number, number, string];
    let segs: Seg[] = [];
    for (let i = 0; i < codes.length; i++) {
      const start = samples[i][2];
      let j = i;
      while (j + 1 < codes.length && codes[j + 1] === codes[i]) j++;
      const end = j + 1 < samples.length ? samples[j + 1][2] : samples[samples.length - 1][2];
      segs.push([start, end, codes[i]]);
      i = j;
    }
    let changed = true;
    while (changed && segs.length > 1) {
      changed = false;
      for (let i = 0; i < segs.length; i++) {
        if (segs[i][1] - segs[i][0] >= MIN_SEG) continue;
        const prev = segs[i - 1], next = segs[i + 1];
        const lp = prev ? prev[1] - prev[0] : -1;
        const ln = next ? next[1] - next[0] : -1;
        if (lp < 0 && ln < 0) break;
        if (lp >= ln) { prev[1] = segs[i][1]; } else { next[0] = segs[i][0]; }
        segs.splice(i, 1);
        changed = true;
        break;
      }
    }
    // fusionne les voisins devenus identiques après absorption
    const merged: Seg[] = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && last[2] === s[2]) last[1] = s[1];
      else merged.push([s[0], s[1], s[2]]);
    }

    const total = pts[pts.length - 1][2];
    if (merged.length) merged[merged.length - 1][1] = total;
    const known = merged.filter((s) => s[2] !== 'inconnu').reduce((a, s) => a + (s[1] - s[0]), 0);

    const data = {
      v: 1, src: 'OpenStreetMap (ODbL) via Overpass', total,
      coverage: total ? +(known / total).toFixed(3) : 0,
      segs: merged,
    };
    const put = await fetch(`${url}/rest/v1/runnav_terrain`, {
      method: 'POST',
      headers: { ...hdr, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ gpx_key: gpxKey, data, updated_at: new Date().toISOString() }),
    });
    if (!put.ok) {
      return new Response(JSON.stringify({ error: 'ecriture', code: put.status }), { status: 500, headers: cors });
    }
    // Écarts d'appariement : dit si le rayon est le bon, ou si la trace est
    // simplement hors des chemins cartographiés.
    offs.sort((a, b) => a - b);
    const pct = (q: number) => offs.length ? Math.round(offs[Math.min(offs.length - 1, Math.floor(q * offs.length))]) : null;
    return new Response(JSON.stringify({
      status: 'built', segs: merged.length, ways: ways.length, coverage: data.coverage,
      samples: samples.length, matched: offs.length,
      offP50: pct(0.5), offP90: pct(0.9), offMax: offs.length ? Math.round(offs[offs.length - 1]) : null,
    }), { headers: cors });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: cors });
  }
});
