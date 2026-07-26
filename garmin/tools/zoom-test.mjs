import { readFileSync } from 'fs';
import { Locator } from './locator-reference.mjs';
import { buildTrack } from '../../js/gpx.js';
import { ZoomPicker, spreadAhead, lookaheadFor, PALIERS } from './zoom-reference.mjs';
const pack=JSON.parse(readFileSync('fixtures/rt2026-pack.json','utf8'));
const t=JSON.parse(readFileSync('fixtures/rt2026-track.json','utf8'));
const P=buildTrack(t.pts.map(a=>({lat:a[0],lon:a[1],ele:a[2]}))).points;
const jitG=()=>{let seed=999; return (p,m)=>{seed=(seed*1103515245+12345)&0x7fffffff;
  const r=seed/0x7fffffff-0.5; return {lat:p.lat+r*m/111320, lon:p.lon+r*m/(111320*Math.cos(p.lat*Math.PI/180))};};};
function sim(speed, hyst){
  const jit=jitG(); const Z=new ZoomPicker(); const L=new Locator(pack); const hist=[];
  for(let i=0;i<P.length;i+=3){ const j=jit(P[i],8); const r=L.update(j.lat,j.lon,i);
    const sp=spreadAhead(L.xs,L.ys,L.cum,r.idx,r.s,L.n,lookaheadFor(speed));
    hist.push(Z.update(sp,hyst)); }
  const c={}; for(const h of hist) c[h]=(c[h]||0)+1;
  return {changes:Z.changes,n:hist.length,rep:PALIERS.map((p,i)=>p+'m:'+Math.round((c[i]||0)/hist.length*100)+'%').filter(x=>!x.endsWith(':0%')).join(' ')};
}
console.log('--- ultra-trail (1,5 m/s) ---');
const a=sim(1.5,false), b=sim(1.5,true);
console.log('  sans hystérésis :',a.changes,'changements | avec :',b.changes,'  (÷'+(a.changes/b.changes).toFixed(1)+')');
console.log('  paliers :',b.rep, '→ 1 changement tous les', Math.round(108310/b.changes),'m');
console.log('--- bikepacking (8 m/s) ---');
const c=sim(8,true);
console.log('  paliers :',c.rep,'| ',c.changes,'changements');
