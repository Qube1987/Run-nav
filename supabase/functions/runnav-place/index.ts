// Edge Function « runnav-place » — enrichissement A LA DEMANDE d'un POI.
//
// Interroge Google Places au moment où l'utilisateur tape une pastille, et
// renvoie les horaires en DIRECT sans les stocker.
//
// Pourquoi ce fonctionnement, et pas un enrichissement en masse mis en cache :
// les conditions Google interdisent de stocker le contenu Places. Seule
// exception utile, le `place_id`, conservable indéfiniment — on le garde donc
// pour ne pas repayer l'appariement à chaque consultation, et c'est tout.
//
// La clé vit ici, en secret d'Edge Function : jamais dans le dépôt, jamais dans
// le bundle servi au navigateur (une clé Google exposée se fait consommer par
// n'importe qui).

const SEARCH = 'https://places.googleapis.com/v1/places:searchText';
const DETAILS = 'https://places.googleapis.com/v1/places';
// Champs de niveau « Pro » : les horaires en font partie. On ne demande PAS les
// notes ni les avis, qui relèvent du niveau Enterprise, plus cher et sans
// intérêt en course.
const DETAIL_FIELDS = 'id,displayName,regularOpeningHours,businessStatus,websiteUri,nationalPhoneNumber';

Deno.serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const key = Deno.env.get('GOOGLE_PLACES_KEY');
  // Pas de clé configurée : on le dit clairement plutôt que d'échouer. L'app
  // masque alors simplement la ligne « horaires ».
  if (!key) return new Response(JSON.stringify({ status: 'nokey' }), { headers: cors });

  try {
    const b = await req.json();
    const lat = Number(b.lat), lon = Number(b.lon);
    const name = String(b.name || '').trim();
    const gpxKey = String(b.gpxKey || '').trim();
    const idx = Number.isInteger(b.idx) ? b.idx : -1;
    let placeId = String(b.placeId || '').trim();
    if (!isFinite(lat) || !isFinite(lon)) {
      return new Response(JSON.stringify({ error: 'coordonnees invalides' }), { status: 400, headers: cors });
    }

    const url = Deno.env.get('SUPABASE_URL')!;
    const srv = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const shdr = { apikey: srv, Authorization: `Bearer ${srv}`, 'Content-Type': 'application/json' };

    // --- 1) appariement OSM → Google, une seule fois par POI ---
    // C'est l'appel le plus cher (Text Search, niveau Pro). Le `place_id` étant
    // le seul champ que Google autorise à conserver, on le stocke pour ne plus
    // jamais repasser par ici.
    if (!placeId) {
      if (!name) return new Response(JSON.stringify({ status: 'nomatch' }), { headers: cors });
      const sres = await fetch(SEARCH, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.id,places.displayName',
        },
        body: JSON.stringify({
          textQuery: name,
          maxResultCount: 1,
          // biais serré : on cherche CE commerce-là, pas un homonyme à 20 km
          locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: 120 } },
        }),
      });
      if (!sres.ok) {
        return new Response(JSON.stringify({ status: 'error', code: sres.status }), { status: 502, headers: cors });
      }
      const sj = await sres.json();
      placeId = sj?.places?.[0]?.id || '';
      if (!placeId) return new Response(JSON.stringify({ status: 'nomatch' }), { headers: cors });

      // mémorise le place_id dans le POI (autorisé sans limite de durée)
      if (gpxKey && idx >= 0) {
        try {
          const r = await fetch(`${url}/rest/v1/runnav_pois?gpx_key=eq.${encodeURIComponent(gpxKey)}&select=data`, { headers: shdr });
          if (r.ok) {
            const rows = await r.json();
            const data = rows?.[0]?.data;
            if (data && Array.isArray(data.pois) && data.pois[idx]) {
              data.pois[idx].g = placeId;
              await fetch(`${url}/rest/v1/runnav_pois?gpx_key=eq.${encodeURIComponent(gpxKey)}`, {
                method: 'PATCH', headers: { ...shdr, Prefer: 'return=minimal' },
                body: JSON.stringify({ data }),
              });
            }
          }
        } catch (_) { /* le cache du place_id est un confort, pas une exigence */ }
      }
    }

    // --- 2) détails en DIRECT, jamais stockés ---
    const dres = await fetch(`${DETAILS}/${encodeURIComponent(placeId)}?fields=${DETAIL_FIELDS}`, {
      headers: { 'X-Goog-Api-Key': key },
    });
    if (!dres.ok) {
      return new Response(JSON.stringify({ status: 'error', code: dres.status }), { status: 502, headers: cors });
    }
    const d = await dres.json();
    const oh = d.regularOpeningHours || null;

    return new Response(JSON.stringify({
      status: 'ok',
      placeId,
      name: d.displayName?.text || name,
      openNow: (oh && typeof oh.openNow === 'boolean') ? oh.openNow : null,
      hours: Array.isArray(oh?.weekdayDescriptions) ? oh.weekdayDescriptions : [],
      businessStatus: d.businessStatus || null,
      website: d.websiteUri || null,
      phone: d.nationalPhoneNumber || null,
      // Attribution exigée par les conditions Google dès qu'on affiche du contenu Places
      attribution: 'Horaires : Google',
    }), { headers: cors });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: cors });
  }
});
