/* Default parameters confirmed by user: R9.4-F1, 2026-10-05.
   Code-native visual simulation of water on glass. No fluid solver or external library. */
(()=>{'use strict';
const defaults={density:3.5,trailPercent:60,dropSize:7.5,trailWidth:12,speed:85,bend:80,splash:5,trailLife:4,beadLife:9,contrast:119,slideDelay:50,slideLength:145,protectBrand:false};
const limits={slideDelay:[0,250],slideLength:[60,400],density:[0,10],trailPercent:[0,100],dropSize:[2,14],trailWidth:[2,22],speed:[15,180],bend:[0,100],splash:[0,10],trailLife:[1,18],beadLife:[2,25],contrast:[20,140]};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const smooth=t=>t*t*(3-2*t);
const freshSeed=()=>{try{return crypto.getRandomValues(new Uint32Array(1))[0]}catch{return (Date.now()^Math.floor(Math.random()*4294967296))>>>0}};
function validate(value){const c={...defaults};for(const [k,[a,b]]of Object.entries(limits)){if(Number.isFinite(Number(value?.[k])))c[k]=clamp(Number(value[k]),a,b)}if(typeof value?.protectBrand==='boolean')c.protectBrand=value.protectBrand;return c}
function makeRandom(seed){let x=seed>>>0;return()=>{x=(Math.imul(1664525,x)+1013904223)>>>0;return x/4294967296}}
class GlassRain{
 constructor(canvas,config={},seed=freshSeed()){
  this.canvas=canvas;this.ctx=canvas.getContext('2d');this.config=validate(config);this.seed=seed>>>0;this.rng=makeRandom(this.seed);this.drops=[];this.time=0;this.next=.65;this.running=false;this.visible=!document.hidden;this.total=0;this.flows=0;this.last=0;this.accumulator=0;
  this.resize=()=>{const r=canvas.getBoundingClientRect();this.w=r.width;this.h=r.height;this.dpr=Math.min(2,devicePixelRatio||1);canvas.width=Math.round(this.w*this.dpr);canvas.height=Math.round(this.h*this.dpr);this.buildTexture();this.render()};
  this.observer=new ResizeObserver(this.resize);this.observer.observe(canvas);
  this.visibility=()=>{this.visible=!document.hidden;this.last=0};document.addEventListener('visibilitychange',this.visibility);this.resize();
 }
 setBackground(url,options={}){if(this.backgroundUrl===url)return;this.backgroundUrl=url;this.backgroundOptions={opacity:.78,maskStart:.18,maskEnd:.86,...options};const image=new Image();this.image=image;image.onload=()=>{if(this.image!==image)return;this.buildTexture();this.render()};image.src=url}
 buildTexture(){if(!this.image?.naturalWidth||!this.w||!this.h)return;const c=document.createElement('canvas');c.width=Math.ceil(this.w);c.height=Math.ceil(this.h);const ctx=c.getContext('2d'),o=this.backgroundOptions,scale=Math.max(this.w/this.image.naturalWidth,this.h/this.image.naturalHeight),w=this.image.naturalWidth*scale,h=this.image.naturalHeight*scale;ctx.globalAlpha=o.opacity;ctx.drawImage(this.image,(this.w-w)/2,this.h-h,w,h);ctx.globalAlpha=1;ctx.globalCompositeOperation='destination-in';const g=ctx.createLinearGradient(0,0,0,this.h);g.addColorStop(o.maskStart,'rgba(0,0,0,0)');g.addColorStop(o.maskEnd,'rgba(0,0,0,1)');ctx.fillStyle=g;ctx.fillRect(0,0,this.w,this.h);ctx.globalCompositeOperation='destination-over';ctx.fillStyle='#fbfcf7';ctx.fillRect(0,0,this.w,this.h);this.texture=c}
 update(config){const previous=this.config.density;this.config=validate({...this.config,...config});if(this.config.density>0)this.next=previous===0?this.time+1/this.config.density:Math.min(this.next,this.time+1/this.config.density)}
 reset(seed=freshSeed()){this.seed=seed>>>0;this.rng=makeRandom(this.seed);this.drops=[];this.time=0;this.next=.65;this.total=0;this.flows=0;this.accumulator=0;this.render()}
 start(){if(this.running)return;this.running=true;this.last=0;const frame=now=>{if(!this.running)return;const dt=this.last?Math.min(.05,(now-this.last)/1000):0;this.last=now;if(this.visible){this.accumulator+=dt;while(this.accumulator>=1/60){this.advance(1/60);this.accumulator-=1/60}this.render()}this.frame=requestAnimationFrame(frame)};this.frame=requestAnimationFrame(frame)}
 pause(){this.running=false;cancelAnimationFrame(this.frame);this.last=0}
 seek(ms){this.pause();this.reset(this.seed);for(let t=0;t<ms/1000;t+=1/60)this.advance(Math.min(1/60,ms/1000-t));this.render()}
 dispose(){this.pause();if(this.image)this.image.onload=null;this.texture=null;this.observer.disconnect();document.removeEventListener('visibilitychange',this.visibility);this.drops=[];this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height)}
 advance(dt){this.time+=dt;const c=this.config;if(c.density>0&&this.time>=this.next){if(this.drops.length<160)this.spawn();this.next+=(0.38+this.rng()*1.24)/c.density}for(const d of this.drops)this.step(d);this.drops=this.drops.filter(d=>this.time-d.born<d.life)}
 spawn(){const r=this.rng,c={...this.config},flow=r()*100<c.trailPercent;
  // Percentage is assigned before spatial placement: the safe area does not dilute the requested ratio.
  let x=.06+r()*.88,y=.06+r()*.34;const length=Math.min(this.h*.65,c.slideLength*(.7+r()*.6));
  if(c.protectBrand&&flow){x=r()<.5?.08+r()*.22:.72+r()*.20}
  if(c.protectBrand&&!flow&&x>.34&&x<.66&&y>.29)y=.08+r()*.16;
  const size=c.dropSize*(.72+r()*.5),radius=flow?Math.max(size,c.trailWidth*.68):size;
  const hold=flow?c.slideDelay/1000*(.7+r()*.6):0,travel=length/c.speed;
  const d={c,born:this.time,flow,x:x*this.w,y:y*this.h,r:radius,hold,travel,length,life:flow?hold+travel+c.trailLife:c.beadLife*(.75+r()*.5),merges:[],phase:r()*6.28,amp:c.bend*.16*(.55+r()*.55),offset:r()*6.28,points:[],progress:0};
  d.knots=[0];for(let n=1;n<5;n++)d.knots.push(clamp(d.knots[n-1]+r()*.95-.475,-1,1));d.widths=Array.from({length:9},()=>.78+r()*.35);
  d.satellites=Array.from({length:Math.round(c.splash)},()=>({a:r()*6.28,dist:7+r()*radius*2.7,r:.65+r()*1.1,stay:r()<.32,life:1.3+r()*2.5}));
  d.points.push({x:d.x,y:d.y,p:0});this.drops.push(d);this.total++;if(flow)this.flows++;
 }
 point(d,p){const k=p*(d.knots.length-1),i=Math.min(d.knots.length-2,Math.floor(k)),u=smooth(k-i),base=d.knots[0];return {x:d.x+d.amp*(d.knots[i]*(1-u)+d.knots[i+1]*u-base),y:d.y+d.length*p,p}}
 step(d){if(!d.flow)return;const age=this.time-d.born,m=clamp((age-d.hold)/d.travel,0,1);
  // Monotonic movement with uneven speed; no oscillating sprite and no rewind.
  const p=clamp(m+Math.sin(m*Math.PI*6+d.phase)*.021*Math.sin(m*Math.PI),0,1);
  d.progress=Math.max(d.progress,p);const head=this.point(d,d.progress),prev=d.points.at(-1);
  if(age>d.hold&&d.progress<1)for(const other of this.drops){if(other===d||other.flow||other.life<=this.time-other.born)continue;if(Math.hypot(head.x-other.x,head.y-other.y)<(d.r+other.r)*.65){d.r=Math.min(24,Math.cbrt(d.r**3+other.r**3*.65));d.merges.push(d.progress);other.life=this.time-other.born}}
  if(Math.hypot(head.x-prev.x,head.y-prev.y)>1.6||d.progress===1&&prev.p!==1)d.points.push(head);
 }
 width(d,p){const k=p*8,i=Math.min(7,Math.floor(k)),u=smooth(k-i),bulge=d.widths[i]*(1-u)+d.widths[i+1]*u;const pocket=1+Math.min(.3,d.merges.reduce((sum,m)=>sum+.28*Math.exp(-(((p-m)/.026)**2)),0));const wetAge=Math.max(0,this.time-d.born-d.hold-p*d.travel),neck=.34+.66*Math.exp(-wetAge/1.05);return d.c.trailWidth*.5*bulge*pocket*neck*(.7+.3*clamp(p*18,0,1))}
 ribbon(d){const pts=d.points;if(pts.length<2)return;const left=[],right=[];
  for(let i=0;i<pts.length;i++){const a=pts[Math.max(0,i-1)],b=pts[Math.min(pts.length-1,i+1)],len=Math.hypot(b.x-a.x,b.y-a.y)||1,nx=-(b.y-a.y)/len,ny=(b.x-a.x)/len,half=this.width(d,pts[i].p);left.push({x:pts[i].x+nx*half,y:pts[i].y+ny*half});right.push({x:pts[i].x-nx*half,y:pts[i].y-ny*half})}
  const ctx=this.ctx,path=new Path2D();path.moveTo(left[0].x,left[0].y);for(let i=1;i<left.length;i++)path.lineTo(left[i].x,left[i].y);const end=pts.at(-1),last=right.at(-1);path.quadraticCurveTo(end.x,end.y+this.width(d,end.p),last.x,last.y);for(let i=right.length-2;i>=0;i--)path.lineTo(right[i].x,right[i].y);path.quadraticCurveTo(pts[0].x,pts[0].y-this.width(d,0),left[0].x,left[0].y);path.closePath();
  const age=this.time-d.born,after=Math.max(0,age-d.hold-d.travel),fade=1-smooth(clamp(after/d.c.trailLife,0,1));
  ctx.save();ctx.globalAlpha=fade*d.c.contrast/100;
  // Refraction stays on traversed glass; fresh water is wide, older film contracts.
  ctx.save();ctx.clip(path);if(this.texture){ctx.globalAlpha*=.82;ctx.drawImage(this.texture,-2.5,-1,this.w+5,this.h+2)}ctx.restore();
  ctx.save();ctx.shadowColor='rgba(58,94,45,.12)';ctx.shadowBlur=2;ctx.fillStyle='rgba(156,186,129,.065)';ctx.fill(path);ctx.restore();
  const edge=(points,color,width)=>{ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);for(let i=1;i<points.length;i++)ctx.lineTo(points[i].x,points[i].y);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke()};
  edge(left,'rgba(63,99,56,.23)',.72);edge(right,'rgba(97,129,73,.055)',.6);
  // Unequal, interrupted optical edges avoid two parallel outlines resembling a ribbon.
  for(let i=2;i<pts.length;i+=9){const point=pts[i],fresh=Math.exp(-Math.max(0,age-d.hold-point.p*d.travel)/2.1),glint=.35+.65*Math.max(0,Math.sin(point.p*19+d.phase));ctx.save();ctx.globalAlpha*=glint*(.24+.76*fresh);edge(left.slice(Math.max(0,i-2),Math.min(pts.length,i+7)),'rgba(246,255,231,.92)',1.35);if(Math.sin(point.p*27+d.offset)>.3)edge(right.slice(i,Math.min(pts.length,i+5)),'rgba(83,116,60,.20)',.72);ctx.restore()}
  // A few small retained beads break up a drying trail; no pointed arrow at its origin.
  const root=pts[0];this.bead(root.x,root.y,Math.min(2.8,d.c.trailWidth*.3),.32*fade*d.c.contrast/100);
  ctx.restore();
 }
 bead(x,y,r,alpha,stretch=1){const ctx=this.ctx;ctx.save();ctx.globalAlpha=alpha;ctx.translate(x,y);ctx.scale(1,stretch);
  ctx.beginPath();ctx.ellipse(0,0,r,r*1.04,0,0,Math.PI*2);
  const g=ctx.createRadialGradient(-r*.3,-r*.42,r*.12,0,r*.12,r*1.18);g.addColorStop(0,'rgba(248,254,230,.04)');g.addColorStop(.57,'rgba(166,197,137,.13)');g.addColorStop(.80,'rgba(76,115,66,.20)');g.addColorStop(.94,'rgba(62,100,53,.47)');g.addColorStop(1,'rgba(226,242,203,.48)');if(this.texture&&r>2){ctx.save();ctx.clip();const k=1.55;ctx.globalAlpha*=.88;ctx.drawImage(this.texture,x-r/k,y-r/k,2*r/k,2*r/k,-r,-r,2*r,2*r);ctx.restore()}ctx.fillStyle=g;ctx.fill();ctx.strokeStyle='rgba(81,115,63,.4)';ctx.lineWidth=.6;ctx.stroke();
  ctx.beginPath();ctx.ellipse(-r*.18,-r*.1,r*.69,r*.77,-.3,Math.PI*.78,Math.PI*1.37);ctx.strokeStyle='rgba(253,255,239,.94)';ctx.lineWidth=Math.max(.7,r*.10);ctx.lineCap='round';ctx.stroke();
  ctx.beginPath();ctx.ellipse(r*.23,r*.59,r*.40,r*.10,-.15,0,Math.PI*2);ctx.fillStyle='rgba(75,111,55,.38)';ctx.fill();ctx.restore();
 }
 render(){const ctx=this.ctx;if(!this.w||!this.h)return;ctx.setTransform(this.dpr,0,0,this.dpr,0,0);ctx.clearRect(0,0,this.w,this.h);
  for(const d of this.drops){const age=this.time-d.born;this.ribbon(d);
   if(age<3.8)for(const s of d.satellites){const p=clamp(age/.22,0,1),dist=s.dist*(1-(1-p)**3),alpha=s.stay?clamp(1-age/s.life,0,1)*.66:(1-p)*.7;this.bead(d.x+Math.cos(s.a)*dist,d.y+Math.sin(s.a)*dist,s.r,alpha*d.c.contrast/100)}
   const head=d.flow?this.point(d,d.progress):{x:d.x,y:d.y};const fade=d.flow?1-smooth(clamp((age-d.hold-d.travel)/.8,0,1)):1-smooth(clamp((age-d.life+2)/2,0,1));
   const impact=1+.32*Math.sin(clamp(age/.16,0,1)*Math.PI);this.bead(head.x,head.y,d.r*impact,Math.min(1,age/.024)*fade*d.c.contrast/100,d.flow&&age>d.hold&&d.progress<1?1.12:1);
  }
 }
 get stats(){return {active:this.drops.length,sliding:this.drops.filter(d=>d.flow&&d.progress<1&&this.time-d.born>d.hold).length,total:this.total,flows:this.flows,time:this.time,seed:this.seed}}
}
GlassRain.defaults=defaults;GlassRain.validate=validate;GlassRain.freshSeed=freshSeed;window.GlassRain=GlassRain;
})();
