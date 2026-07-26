import { readFileSync } from 'fs';
import { Locator } from './locator-reference.mjs';
import { buildTrack } from '../../js/gpx.js';
import { ZoomPicker, PALIERS } from './zoom-reference.mjs';
const pack=JSON.parse(readFileSync('fixtures/rt2026-pack.json','utf8'));
const t=JSON.parse(readFileSync('fixtures/rt2026-track.json','utf8'));
const P=buildTrack(t.pts.map(a=>({lat:a[0],lon:a[1],ele:a[2]}))).points;
let seed=999; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff-0.5;};
const jit=(p,m)=>({lat:p.lat+rnd()*m/111320, lon:p.lon+rnd()*m/(111320*Math.cos(p.lat*Math.PI/180))});
function spread(L,idx,s,LA){ const sp=L.cum[idx+1]-L.cum[idx]; const tt=sp>0?(s-L.cum[idx])/sp:0;
  const px=L.xs[idx]+tt*(L.xs[idx+1]-L.xs[idx]), py=L.ys[idx]+tt*(L.ys[idx+1]-L.ys[idx]);
  let m=0; for(let k=idx;k<L.n-1&&L.cum[k]-s<LA;k++){const dx=L.xs[k]-px,dy=L.ys[k]-py;const d=Math.hypot(dx,dy); if(d>m)m=d;} return m; }
console.log('lookahead | changements |  répartition des paliers');
for (const LA of [300,400,600,1000]) {
  seed=999; const Z=new ZoomPicker(); const L=new Locator(pack); const hist=[];
  for(let i=0;i<P.length;i+=3){ const j=jit(P[i],8); const r=L.update(j.lat,j.lon,i);
    hist.push(Z.update(spread(L,r.idx,r.s,LA),true)); }
  const c={}; for(const h of hist) c[h]=(c[h]||0)+1;
  const rep=PALIERS.map((p,i)=>p+'m:'+Math.round((c[i]||0)/hist.length*100)+'%').join(' ');
  console.log(String(LA+' m').padStart(9),'|',String(Z.changes).padStart(11),'| ',rep);
}
