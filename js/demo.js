// Parcours de démonstration : une boucle vallonnée synthétique (~14 km, 2 côtes)
// centrée dans le Vercors, pour tester l'appli sans fichier GPX.

export function demoGpx() {
  const lat0 = 45.05, lon0 = 5.55;
  const pts = [];
  const N = 560;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    // trajet : boucle en forme de haricot
    const ang = t * Math.PI * 2;
    const lat = lat0 + 0.05 * Math.sin(ang) + 0.012 * Math.sin(ang * 3);
    const lon = lon0 + 0.07 * Math.cos(ang) * (0.7 + 0.3 * Math.cos(ang));
    // profil : deux côtes marquées + faux-plats
    const ele =
      420 +
      160 * Math.max(0, Math.sin(ang - 0.4)) +          // grande côte
      90 * Math.max(0, Math.sin(ang * 2 + 1)) +         // seconde côte
      25 * Math.sin(ang * 5);                           // ondulations
    pts.push({ lat, lon, ele });
  }
  // referme la boucle
  pts.push({ ...pts[0] });

  const trkpts = pts
    .map((p) => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.ele.toFixed(1)}</ele></trkpt>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Run-Nav demo">
  <trk><name>Boucle démo — Vercors</name><trkseg>
${trkpts}
  </trkseg></trk>
</gpx>`;
}
