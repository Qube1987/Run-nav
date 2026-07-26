import { readFileSync } from 'fs';
import { buildTrack } from '../../js/gpx.js';
import { detectClimbs } from '../../js/climbs.js';
import { PaceModel, VAM_MIN, VAM_MAX } from './pacemodel-reference.mjs';

const t=JSON.parse(readFileSync('fixtures/rt2026-track.json','utf8'));
const track=buildTrack(t.pts.map(a=>({lat:a[0],lon:a[1],ele:a[2]})));
const P=track.points, climbs=detectClimbs(track.points);
const big=climbs.reduce((a,b)=>b.gain>a.gain?b:a);
console.log('côte de test : D+',big.gain,'m sur',(big.length/1000).toFixed(1),'km, pente moy',big.avgGrade.toFixed(1),'%\n');

// Simule un coureur qui monte à VAM_VRAIE constante, 1 échantillon/s.
function climbSim(vamTrue, {pauseAt=null, pauseSec=0, timerPauses=true}={}) {
  const out=[]; let t=0;
  const idx=[]; for(let i=0;i<P.length;i++) if(P[i].d>=big.startD&&P[i].d<=big.endD) idx.push(i);
  for(let k=1;k<idx.length;k++){
    const a=P[idx[k-1]], b=P[idx[k]];
    const dz=Math.max(0,b.ele-a.ele), dd=b.d-a.d;
    const dt=dz>0 ? (dz/vamTrue)*3600 : dd/1.4;   // temps pour ce tronçon
    for(let s=0;s<Math.max(1,Math.round(dt));s++){
      t+=1;
      out.push({t, ele:a.ele+dz*(s/Math.max(1,dt)), grade:b.grade, speed:dd/Math.max(1,dt)});
    }
    if(pauseAt!=null && b.d>=pauseAt && !out._paused){
      out._paused=true;
      // arrêt long : soit le timer se met en pause (t gelé), soit il tourne
      for(let s=0;s<pauseSec;s++){ if(!timerPauses) t+=1;
        out.push({t, ele:b.ele, grade:b.grade, speed:0}); }
    }
  }
  return out;
}

function run(label, vamTrue, opts={}) {
  const m=new PaceModel(450); const feed=climbSim(vamTrue,opts);
  const topEle=P.find(p=>p.d>=big.endD).ele;
  let etaErr=null;
  for(const f of feed){
    m.update(f.t,f.ele,f.grade,f.speed);
    if(etaErr===null && f.ele>=P.find(p=>p.d>=big.startD).ele+big.gain*0.5){
      // à mi-côte : compare l'ETA prédit au temps réellement restant
      const gainLeft=topEle-f.ele;
      const predicted=m.etaSeconds(gainLeft);
      const actual=(gainLeft/vamTrue)*3600;
      etaErr={predicted,actual,vam:m.vam};
    }
  }
  const pct=etaErr? Math.abs(etaErr.predicted-etaErr.actual)/etaErr.actual*100 : 0;
  console.log(label);
  console.log('   VAM vraie',vamTrue,'→ estimée',Math.round(m.vam),'m/h | ETA mi-côte : prédit',
    Math.round(etaErr.predicted/60),'min vs réel',Math.round(etaErr.actual/60),'min | écart',pct.toFixed(1),'%',
    pct<12?'✓':'✗');
  return m.vam;
}

run('1) Montée régulière, grimpeur lent', 380);
run('2) Montée régulière, grimpeur rapide', 750);
run('3) Arrêt 15 min au ravito (timer en pause)', 550, {pauseAt:big.startD+big.length*0.4, pauseSec:900, timerPauses:true});
run('4) Arrêt 15 min DEBOUT (timer qui tourne)', 550, {pauseAt:big.startD+big.length*0.4, pauseSec:900, timerPauses:false});

// bornes
const m=new PaceModel(450);
for(let i=0;i<3000;i++) m.update(i, 100+i*0.5, 12, 1.0);   // ~1800 m/h, absurde
console.log('\n5) Bornage : VAM extrême plafonnée à', Math.round(m.vam),'m/h', m.vam<=VAM_MAX?'✓':'✗');
const m2=new PaceModel(450);
console.log('6) Sans données : VAM =', Math.round(m2.vam),'m/h (valeur de réglage)', m2.vam===450?'✓':'✗');
