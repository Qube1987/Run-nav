import { readFileSync } from 'fs';
import { buildTrack } from '../../js/gpx.js';
import { Locator } from './locator-reference.mjs';
const pack = JSON.parse(readFileSync('fixtures/rt2026-pack.json','utf8'));
const t = JSON.parse(readFileSync('fixtures/rt2026-track.json','utf8'));
const track = buildTrack(t.pts.map(a=>({lat:a[0],lon:a[1],ele:a[2]})));
const P = track.points;
console.log('pack:',pack.n,'| sommets',pack.dd.length+1,'| total',pack.d,'m | vrai',Math.round(track.total),'m\n');

// bruit GPS déterministe (pas de Math.random : test reproductible)
let seed=12345; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff-0.5;};
const jitter=(p,m)=>({lat:p.lat+rnd()*m/111320, lon:p.lon+rnd()*m/(111320*Math.cos(p.lat*Math.PI/180))});

function run(label, feed) {
  const L=new Locator(pack); const errs=[]; let rejected=0, maxErr=0;
  for (const step of feed(L)) {
    if (step.err!=null){ errs.push(step.err); if(step.err>maxErr) maxErr=step.err; }
    if (step.rejected) rejected++;
  }
  errs.sort((a,b)=>a-b);
  const p50=errs[Math.floor(errs.length*0.5)]||0, p95=errs[Math.floor(errs.length*0.95)]||0;
  console.log(label);
  console.log('   erreur abscisse  médiane',p50.toFixed(1),'m | p95',p95.toFixed(1),'m | max',maxErr.toFixed(1),'m', maxErr<50?'✓':'✗');
  if(rejected) console.log('   sauts rejetés    :',rejected);
  return maxErr;
}

// 1) progression normale, bruit GPS 8 m, 1 point/s
run('1) Progression normale (bruit GPS 8 m)', function*(L){
  for(let i=0;i<P.length;i+=3){ const j=jitter(P[i],8); const r=L.update(j.lat,j.lon,i);
    yield {err:Math.abs(r.s-P[i].d), rejected:r.rejected}; }
});

// 2) ALLER-RETOUR : on repart en arrière sur 3 km puis on repart (cas §6.3)
run('2) Aller-retour sur la trace (§6.3)', function*(L){
  const turn=Math.floor(P.length*0.5); let tt=0;
  for(let i=0;i<turn;i+=3){ const j=jitter(P[i],8); const r=L.update(j.lat,j.lon,tt++);
    yield {err:Math.abs(r.s-P[i].d), rejected:r.rejected}; }
  // demi-tour : on redescend
  let back=turn; const backTo=turn-Math.floor(3000/ (track.total/P.length));
  for(let i=turn;i>backTo;i-=3){ const j=jitter(P[i],8); const r=L.update(j.lat,j.lon,tt++);
    yield {err:Math.abs(r.s-P[i].d), rejected:r.rejected}; }
  // puis on repart en avant
  for(let i=backTo;i<turn+2000&&i<P.length;i+=3){ const j=jitter(P[i],8); const r=L.update(j.lat,j.lon,tt++);
    yield {err:Math.abs(r.s-P[i].d), rejected:r.rejected}; }
});

// 3) perte GPS 10 min : coast() sur la distance d'activité, puis reprise
run('3) Perte GPS prolongée puis reprise', function*(L){
  let tt=0; const cut=Math.floor(P.length*0.3), back=cut+Math.floor(P.length*0.05);
  for(let i=0;i<cut;i+=3){ const j=jitter(P[i],8); const r=L.update(j.lat,j.lon,tt++);
    yield {err:Math.abs(r.s-P[i].d), rejected:r.rejected}; }
  for(let i=cut;i<back;i+=3){ L.coast(P[i].d-P[i-3].d); yield {err:Math.abs(L.s-P[i].d)}; } // à l'estime
  for(let i=back;i<back+3000&&i<P.length;i+=3){ const j=jitter(P[i],8); const r=L.update(j.lat,j.lon,tt++);
    yield {err:Math.abs(r.s-P[i].d), rejected:r.rejected}; }
});

// 4) téléportation aberrante (glitch) : doit être rejetée
run('4) Glitch GPS (téléportation 5 km)', function*(L){
  let tt=0;
  for(let i=0;i<600;i+=3){ const j=jitter(P[i],8); const r=L.update(j.lat,j.lon,tt++);
    yield {err:Math.abs(r.s-P[i].d), rejected:r.rejected}; }
  const far=P[Math.floor(P.length*0.8)];
  const r=L.update(far.lat,far.lon,tt++);           // saut impossible en 1 s
  yield {err:null, rejected:r.rejected};
  if(!r.rejected) console.log('   ✗ le glitch N\'A PAS été rejeté');
  for(let i=600;i<1200;i+=3){ const j=jitter(P[i],8); const r2=L.update(j.lat,j.lon,tt++);
    yield {err:Math.abs(r2.s-P[i].d), rejected:r2.rejected}; }
});

// 5) coût CPU (§9 : compute() < 5 ms)
const L=new Locator(pack); L.update(P[0].lat,P[0].lon,0);
const t0=process.hrtime.bigint(); let nn=0;
for(let i=0;i<P.length;i+=3){ const j=jitter(P[i],8); L.update(j.lat,j.lon,i); nn++; }
const us=Number(process.hrtime.bigint()-t0)/1000/nn;
console.log('5) Coût par appel (JS, ordre de grandeur) :',us.toFixed(1),'µs sur',nn,'appels');
console.log('   fenêtre de recherche : ±'+40+' segments =',(2*40*(track.total/pack.dd.length)/1000).toFixed(1),'km explorés');
