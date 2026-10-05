(()=>{
  'use strict';
  const q=s=>document.querySelector(s),opening=q('#opening'),app=q('#app'),rain=q('#rain-plane');
  const supports=typeof Element.prototype.animate==='function';
  const params=new URLSearchParams(location.search);let openingPrefs={};
  try{if(params.get('demoSettings')==='1')openingPrefs=JSON.parse(localStorage.getItem('now.opening.settings.demo.main.f1'))||{}}catch{}
  const reduce=!supports||matchMedia('(prefers-reduced-motion:reduce)').matches||openingPrefs.enabled===false;
  const motion=new Set(),timers=new Set();
  let serial=0,appReady=false,requestReady=false,finished=false,failed=false,held=false,startTime=0,exitAnimation=null,rainSeed=0,glassRain=null;
  const tell=(type,extra={})=>{if(parent!==window)parent.postMessage({type,...extra},location.origin)};
  const elapsed=()=>performance.now()-startTime;
  function later(fn,ms){const token=serial,t=setTimeout(()=>{timers.delete(t);if(token===serial)fn()},ms);timers.add(t);return t}
  function clear(){glassRain?.dispose();glassRain=null;exitAnimation?.cancel();exitAnimation=null;timers.forEach(clearTimeout);timers.clear();motion.forEach(a=>a.cancel());motion.clear();rain.replaceChildren()}
  function anim(el,frames,options={}){
    if(!supports){Object.entries(frames[frames.length-1]).forEach(([k,v])=>{if(k!=='offset')el.style[k]=v});return null}
    const a=el.animate(frames,{duration:reduce?1:1000,easing:'cubic-bezier(.22,.7,.2,1)',fill:'forwards',...options});
    motion.add(a);return a;
  }
  function animate(sel,frames,options={}){document.querySelectorAll(sel).forEach(el=>anim(el,frames,options))}
  function draw(){
    animate('.scene',[{opacity:0,transform:'scale(1.025)'},{opacity:.72,transform:'scale(1)'}]);
    animate('.light',[{opacity:0},{opacity:.6,offset:.6},{opacity:.32}]);
    animate('.terrain',[{opacity:0,transform:'translateY(12px)'},{opacity:.25,transform:'translateY(0)',offset:.5},{opacity:0,transform:'translateY(0)'}],{duration:reduce?1:800});
    animate('.mist-front',[{opacity:1,transform:'translateX(-3%)'},{opacity:.55,transform:'translateX(2%)'}]);
    animate('.mist-back',[{opacity:1},{opacity:.35}],{duration:reduce?1:900});
    animate('.bamboo',[{opacity:0,transform:'rotate(1.2deg)'},{opacity:.25,transform:'rotate(0)'}],{duration:reduce?1:850});
    animate('.stem',[{strokeDashoffset:480},{strokeDashoffset:0}],{duration:reduce?1:750});
    animate('.leaves',[{opacity:0},{opacity:.75}],{duration:reduce?1:700,delay:reduce?0:180});
    animate('.arc',[{opacity:0,strokeDashoffset:420},{opacity:.52,strokeDashoffset:95,offset:.75},{opacity:.3,strokeDashoffset:0}],{duration:reduce?1:900});
    animate('.ring',[{opacity:0,transform:'scale(.9)',transformOrigin:'100px 100px'},{opacity:.35,transform:'scale(1)'}],{duration:reduce?1:650});
    animate('.name',[{opacity:0,transform:'translateY(8px)',filter:'blur(4px)'},{opacity:1,transform:'translateY(0)',filter:'blur(0px)'}],{duration:reduce?1:580,delay:reduce?0:90});
    animate('.seal',[{opacity:0},{opacity:.7}],{duration:reduce?1:400,delay:reduce?0:320});
    animate('.dew',[{opacity:0},{opacity:.55}],{duration:reduce?1:300,delay:reduce?0:450});
    animate('.ripple',[{opacity:0,transform:'scale(.65)'},{opacity:.38,offset:.5},{opacity:.16,transform:'scale(1.13)'}],{duration:reduce?1:780,delay:reduce?0:650});
    if(reduce)return;
    animate('.glass-light',[{opacity:0,transform:'translateX(-10%) rotate(-5deg)'},{opacity:.85,offset:.2},{opacity:.38,offset:.68},{opacity:.08,transform:'translateX(92%) rotate(-5deg)'}],{delay:600,duration:4400});
    // Continuous layers overlap the first reveal without resetting at 1s or 5s.
    animate('.mist-front',[{opacity:.55,transform:'translateX(2%)'},{opacity:.36,transform:'translateX(-1%)'}],{delay:1000,duration:7300,iterations:Infinity,direction:'alternate',easing:'ease-in-out'});
    animate('.mist-back',[{opacity:.35,transform:'translateX(0)'},{opacity:.52,transform:'translateX(2.7%)'}],{delay:1000,duration:11300,iterations:Infinity,direction:'alternate',easing:'ease-in-out'});
    animate('.bamboo',[{opacity:.25,transform:'rotate(0)'},{opacity:.28,transform:'rotate(-.65deg)'}],{delay:1000,duration:9100,iterations:Infinity,direction:'alternate',easing:'ease-in-out'});
    animate('.dew',[{opacity:.55},{opacity:.25}],{delay:1000,duration:3700,iterations:Infinity,direction:'alternate',easing:'ease-in-out'});
    animate('.ripple',[{opacity:.16,transform:'scale(.92)'},{opacity:.28,transform:'scale(1.18)'}],{delay:1430,duration:5700,iterations:Infinity,direction:'alternate',easing:'ease-in-out'});
  }
  function freshSeed(){return params.has('seed')?Number(params.get('seed'))>>>0:GlassRain.freshSeed()}
  function rainLive(sample=null){
    if(reduce)return;
    const canvas=document.createElement('canvas');canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%';rain.append(canvas);
    let config=GlassRain.validate(openingPrefs.config||GlassRain.defaults);try{if(params.has('rainConfig'))config=GlassRain.validate(JSON.parse(params.get('rainConfig')))}catch{}
    glassRain=new GlassRain(canvas,config,rainSeed);const mobile=innerWidth<=760;glassRain.setBackground('../uiux-current-polish-r8/assets/app-background-'+(mobile?'mobile':'desktop')+'.png',{opacity:.72,maskStart:mobile?.4:.23,maskEnd:mobile?1:.9});
    if(sample!==null)glassRain.seek(sample);else glassRain.start();
  }
  function ready(){if(failed||finished)return;requestReady=true;tell('api-ready',{elapsed:elapsed()});enter()}
  function enter(){
    if(!appReady||!requestReady||finished||held||failed)return;
    finished=true;timers.forEach(clearTimeout);timers.clear();opening.classList.add('exiting');
    opening.setAttribute('aria-busy','false');app.inert=false;app.removeAttribute('aria-hidden');app.classList.add('ready');q('#status').textContent='';
    tell('enter',{elapsed:elapsed()});
    if(!supports){opening.hidden=true;clear();tell('complete',{elapsed:elapsed()});return}
    const generation=serial;exitAnimation=opening.animate([{opacity:1},{opacity:0}],{duration:reduce?0:140,easing:'ease-out',fill:'forwards'});
    exitAnimation.finished.then(()=>{if(generation!==serial)return;opening.hidden=true;clear();tell('complete',{elapsed:elapsed()})}).catch(()=>{});
  }
  function fail(){if(finished||held)return;failed=true;timers.forEach(clearTimeout);timers.clear();motion.forEach(a=>a.pause());glassRain?.pause();opening.setAttribute('aria-busy','false');q('#recovery').hidden=false;q('#long-retry').hidden=true;q('#status').textContent='';q('#retry').focus();tell('failure')}
  function replay(ms=900,failMode=false,holdAt=null){
    serial++;clear();if(holdAt===null||!rainSeed)rainSeed=freshSeed();requestReady=false;finished=false;failed=false;held=holdAt!==null;startTime=performance.now();
    opening.hidden=false;opening.className='';opening.setAttribute('aria-busy','true');q('#recovery').hidden=true;q('#long-retry').hidden=true;
    q('#status').textContent='正在打开此刻';q('#status').style.opacity='0';app.classList.remove('ready');app.inert=true;app.setAttribute('aria-hidden','true');
    draw();tell('start',{delay:ms,held,seed:rainSeed});
    if(held){
      motion.forEach(a=>{a.pause();a.currentTime=holdAt});
      rainLive(holdAt);
      if(holdAt>=3500){q('#status').textContent='连接比平时慢，正在继续尝试';q('#status').style.opacity='1'}
      return;
    }
    rainLive();if(Number.isFinite(ms)){later(()=>{if(!finished){q('#status').textContent='连接比平时慢，正在继续尝试';q('#status').style.opacity='1'}},3500);
    // User-approved extended wait design: 10s no longer cuts off the ambient scene.
    later(()=>{if(!finished){q('#status').textContent='仍在连接，可以重新尝试';q('#long-retry').hidden=false;tell('long-wait')}},10000);
    later(fail,30000);}
    if(Number.isFinite(ms))later(()=>failMode?fail():ready(),ms);
  }
  const appPoll=setInterval(()=>{try{const doc=app.contentDocument;if(doc?.body?.dataset.scene==='home'&&doc.querySelector('#home-view')?.hidden===false){appReady=true;clearInterval(appPoll);enter()}}catch{}},32);
  app.addEventListener('load',()=>{appReady=true;clearInterval(appPoll);enter()});app.addEventListener('error',fail);
  q('#retry').onclick=q('#long-retry').onclick=()=>replay(900,false);
  addEventListener('message',e=>{
    if(e.origin!==location.origin||e.source!==parent)return;const m=e.data;
    if(m?.type==='replay')replay(m.manual?Infinity:Math.min(30000,Math.max(0,m.delay??900)),!!m.failure);
    if(m?.type==='ready'){held=false;motion.forEach(a=>a.play());glassRain?.start();ready()}
    if(m?.type==='frame')replay(0,false,Math.min(20000,Math.max(0,m.ms)));
  });
  addEventListener('pagehide',()=>{clearInterval(appPoll);clear()});
  replay(params.get('manual')==='1'?Infinity:Math.min(30000,Math.max(0,Number(params.get('delay')??900))),params.get('failure')==='1',params.has('frame')?Number(params.get('frame')):null);
})();
