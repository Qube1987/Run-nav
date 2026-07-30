// Edge Function « runnav-pois » — calcule les points d'intérêt d'un parcours.
//
// Appelée par l'application juste après l'import d'un GPX. Interroge Overpass
// (OpenStreetMap, ODbL), projette chaque POI sur la trace pour obtenir son
// abscisse curviligne, et met le résultat en cache dans runnav_pois.
//
// Pourquoi ici et pas dans le navigateur : Overpass est limité en débit et
// répond en plusieurs secondes. Un calcul unique côté serveur, mis en cache,
// évite que chaque ouverture d'épreuve — a fortiori en course — ne déclenche
// une requête qui peut être rejetée (429/504).

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const MAX_OFF = 500;        // m — au-delà, le POI n'est plus « sur le parcours »
const QUERY_SPACING = 400;  // m — pas d'échantillonnage pour la requête `around`
const QUERY_RADIUS = 550;   // m — un peu plus que le pas, pour ne pas trouer
const MAX_PTS = 20000;      // garde-fou sur la taille du payload

type Pt = [number, number, number]; // [lat, lon, d]

function categorize(g: Record<string, string>): string | null {
  const a = g.amenity, s = g.shop, t = g.tourism;
  if (a === 'drinking_water' || a === 'water_point' || g.natural === 'spring') return 'eau';
  if (s === 'bakery') return 'boul';
  if (s === 'supermarket' || s === 'convenience' || s === 'kiosk' || s === 'butcher' || s === 'greengrocer') return 'alim';
  if (a === 'cafe' || a === 'ice_cream') return 'cafe';
  if (a === 'restaurant' || a === 'fast_food' || a === 'pub' || a === 'bar') return 'resto';
  if (a === 'toilets') return 'wc';
  if (a === 'fuel') return 'essence';
  if (a === 'vending_machine') return 'distri';
  if (a === 'shelter') return 'abri';
  if (t === 'alpine_hut' || t === 'wilderness_hut') return 'refuge';
  if (t === 'hotel' || t === 'guest_house' || t === 'hostel') return 'heberg';
  if (t === 'camp_site') return 'camping';
  if (s === 'bicycle') return 'velo';
  return null;
}

/** Sous-échantillonne la trace à pas régulier pour la requête `around`. */
function sample(pts: Pt[], spacing: number): Pt[] {
  const out: Pt[] = [pts[0]];
  let last = pts[0][2];
  for (const p of pts) {
    if (p[2] - last >= spacing) { out.push(p); last = p[2]; }
  }
  const end = pts[pts.length - 1];
  if (out[out.length - 1] !== end) out.push(end);
  return out;
}

function buildQuery(pts: Pt[]): string {
  const around = pts.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(',');
  const a = `(around:${QUERY_RADIUS},${around})`;
  return `[out:json][timeout:180];
(
  node["amenity"~"^(drinking_water|water_point|toilets|cafe|restaurant|fast_food|ice_cream|fuel|shelter|vending_machine|pub|bar)$"]${a};
  node["shop"~"^(supermarket|bakery|convenience|kiosk|bicycle|butcher|greengrocer)$"]${a};
  node["tourism"~"^(alpine_hut|wilderness_hut|hotel|guest_house|camp_site|hostel)$"]${a};
  node["natural"="spring"]["drinking_water"="yes"]${a};
);
out tags center;`;
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
    if (!gpxKey || !Array.isArray(pts) || pts.length < 2 || pts.length > MAX_PTS) {
      return new Response(JSON.stringify({ error: 'payload invalide' }), { status: 400, headers: cors });
    }

    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const hdr = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

    // Déjà calculé ? On ne refait jamais le travail : c'est ce qui rend l'appel
    // à l'import inoffensif, y compris quand plusieurs athlètes importent le
    // même GPX (même empreinte, donc même clé).
    const seen = await fetch(`${url}/rest/v1/runnav_pois?gpx_key=eq.${encodeURIComponent(gpxKey)}&select=gpx_key`, { headers: hdr });
    if (seen.ok) {
      const rows = await seen.json();
      if (Array.isArray(rows) && rows.length) {
        return new Response(JSON.stringify({ status: 'cached' }), { headers: cors });
      }
    }

    // --- Overpass ---
    const q = buildQuery(sample(pts, QUERY_SPACING));
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'run-nav/1.0 (+https://run-nav.netlify.app)' },
      body: 'data=' + encodeURIComponent(q),
    });
    if (!res.ok) {
      // 429 / 504 : Overpass sature. On ne stocke rien, l'app réessaiera plus tard.
      return new Response(JSON.stringify({ status: 'overpass', code: res.status }), { status: 503, headers: cors });
    }
    const osm = await res.json();

    // --- projection sur la trace, en mètres (plan local équirectangulaire) ---
    const R = 6371000, rad = Math.PI / 180;
    const cosLat = Math.cos(pts[0][0] * rad);
    const xs = new Float64Array(pts.length), ys = new Float64Array(pts.length);
    for (let i = 0; i < pts.length; i++) { xs[i] = pts[i][1] * rad * cosLat * R; ys[i] = pts[i][0] * rad * R; }

    const out: Record<string, unknown>[] = [];
    for (const e of (osm.elements || [])) {
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      if (lat == null || lon == null) continue;
      const c = categorize(e.tags || {});
      if (!c) continue;
      const px = lon * rad * cosLat * R, py = lat * rad * R;
      let best = Infinity, bd = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = xs[i], ay = ys[i], dx = xs[i + 1] - ax, dy = ys[i + 1] - ay;
        const l2 = dx * dx + dy * dy;
        let u = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
        u = u < 0 ? 0 : (u > 1 ? 1 : u);
        const cx = ax + u * dx, cy = ay + u * dy;
        const d2 = (px - cx) ** 2 + (py - cy) ** 2;
        if (d2 < best) { best = d2; bd = pts[i][2] + u * (pts[i + 1][2] - pts[i][2]); }
      }
      const off = Math.sqrt(best);
      if (off > MAX_OFF) continue;
      const row: Record<string, unknown> = {
        d: Math.round(bd), o: Math.round(off), c,
        lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      };
      const tags = e.tags || {};
      if (tags.name) row.n = String(tags.name).slice(0, 48);
      if (tags.opening_hours) row.h = String(tags.opening_hours).slice(0, 40);
      out.push(row);
    }
    out.sort((a, b) => (a.d as number) - (b.d as number));

    const data = { v: 1, src: 'OpenStreetMap (ODbL) via Overpass', maxOff: MAX_OFF, pois: out };
    const put = await fetch(`${url}/rest/v1/runnav_pois`, {
      method: 'POST',
      headers: { ...hdr, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ gpx_key: gpxKey, data, updated_at: new Date().toISOString() }),
    });
    if (!put.ok) {
      return new Response(JSON.stringify({ error: 'ecriture', code: put.status }), { status: 500, headers: cors });
    }
    return new Response(JSON.stringify({ status: 'built', count: out.length }), { headers: cors });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: cors });
  }
});
