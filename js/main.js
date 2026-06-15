/* ============================================================
   captiz — moteur d'animation « fou furieux »
   1) Scroll inertiel (Lenis)
   2) CHAMP D'INTERFÉRENCE : grille de signaux déformée par le point
   3) LUMIÈRE LIQUIDE : le point = metaballs mercure, s'étire au scroll
   4) Reveals de texte au caractère (GSAP)
   Piloté par le TEMPS + le SCROLL. Jamais par la souris.
   ============================================================ */
(function(){
  const reduce = matchMedia('(prefers-reduced-motion:reduce)').matches;
  const isMobile = matchMedia('(max-width:820px)').matches || matchMedia('(pointer:coarse)').matches;
  const MAXDPR = isMobile ? 1.0 : 1.75;      // limite le nb de pixels du shader sur mobile
  const nav = document.getElementById('nav');

  /* ---------- 1. SCROLL INERTIEL (Lenis) ---------- */
  let lenis = null;
  if(window.Lenis && !reduce){
    lenis = new Lenis({ duration:1.15, easing:t=>1-Math.pow(1-t,3), smoothWheel:true });
    document.querySelectorAll('a[href^="#"]').forEach(a=>{
      a.addEventListener('click', e=>{
        const id = a.getAttribute('href'); if(id.length<2) return;
        const el = document.querySelector(id);
        if(el){ e.preventDefault(); lenis.scrollTo(el, { duration:1.4 }); }
      });
    });
  }

  /* ---------- 2+3. FOND WEBGL ---------- */
  const cv = document.getElementById('bg');
  const gl = cv.getContext('webgl', { antialias:!isMobile, alpha:false, powerPreference:'high-performance' });

  // calque de LIAISONS (2D) par-dessus le contenu
  const lc = document.createElement('canvas');
  Object.assign(lc.style, { position:'fixed', inset:'0', zIndex:'6', pointerEvents:'none' });
  document.body.appendChild(lc);
  const lctx = lc.getContext('2d');
  const LINK = 1300;                         // portée des liaisons (px) — réseau rayonnant
  const NB = isMobile ? 6 : 10; // nombre de metaballs (point + traînée)

  const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;

  const FRAG = `
    precision ${isMobile ? 'mediump' : 'highp'} float;
    uniform vec2  uRes;
    uniform float uTime;
    uniform float uEnergy;          // 0..1 énergie de scroll (booste tout)
    uniform float uDepth;           // 0..1 profondeur : 1 = la boule avance vers toi
    uniform float uFade;            // 0..1 proximité d'un texte -> atténue le halo
    uniform vec2  uBlobs[${NB}];
    uniform float uBlobR[${NB}];
    uniform int   uN;

    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }

    float field(vec2 frag){
      float m=0.0;
      for(int i=0;i<${NB};i++){
        if(i>=uN) break;
        vec2 d = frag - uBlobs[i];
        m += (uBlobR[i]*uBlobR[i]) / max(dot(d,d), 1.0);
      }
      return m;
    }

    void main(){
      vec2 frag = gl_FragCoord.xy;
      vec2 uv   = frag/uRes;
      vec3 col  = vec3(0.027,0.039,0.062);

      // influence du point principal
      vec2 P = uBlobs[0];
      vec2 toP = frag - P;
      float dist = length(toP);
      vec2 dir = dist>0.001 ? toP/dist : vec2(0.0);
      float infl = exp(-dist/280.0);

      // ---------- CHAMP D'INTERFÉRENCE ----------
      float cell = 34.0;
      float ripple = sin(dist*0.045 - uTime*3.2) * infl * (26.0 + uEnergy*48.0);
      vec2  warp   = frag + dir*ripple - dir*infl*(55.0 + uEnergy*70.0);
      vec2  gp  = warp / cell;
      float dd  = length(fract(gp) - 0.5);
      float dotR = 0.09 + infl*0.20;
      float dots = smoothstep(dotR, dotR-0.06, dd);
      float tw   = 0.5 + 0.5*sin(uTime*2.0 + hash(floor(gp))*6.2831);
      // énergie concentrée près du point : champ très discret au loin, vif autour du signal
      float fieldI = dots * (0.035 + infl*infl*2.2) * (0.55+0.45*tw);
      col += vec3(0.50,0.66,1.0) * fieldI;

      // ---------- LUMIÈRE LIQUIDE (metaballs) ----------
      float m  = field(frag);
      ${isMobile
        ? 'float mR = m; float mB = m;'                  // mobile : pas d'aberration (perf)
        : 'float ca = 2.5 + uEnergy*7.0; float mR = field(frag + dir*ca); float mB = field(frag - dir*ca);'}
      vec3  liquid = vec3(smoothstep(0.70,1.30,mR),
                          smoothstep(0.80,1.40,m),
                          smoothstep(0.90,1.50,mB));
      float core = smoothstep(0.95,1.7,m);
      float glow = pow(clamp(m,0.0,1.0), 2.1);            // halo plus resserré (lisibilité)
      float dim  = 1.0 - uFade*0.78;                      // s'efface quand on est sur un titre
      col += liquid * 0.5 * dim;
      col += vec3(1.0) * core;                            // le noyau reste net
      col += vec3(0.56,0.69,1.0) * glow * (0.24 + uEnergy*0.38 + uDepth*0.38) * dim;

      // ---------- vignette + grain ----------
      col *= 1.0 - 0.30*distance(uv, vec2(0.5,0.6));
      col += (hash(frag+uTime)-0.5)*0.03;

      gl_FragColor = vec4(col,1.0);
    }
  `;

  let prog, uni = {};
  let DPR = Math.min(devicePixelRatio||1, MAXDPR);
  // point : ressort avec dépassement (lag liquide) + historique pour la traînée
  const pt = { x:0,y:0, vx:0,vy:0, tx:0,ty:0 };
  const hist = [];
  const blobPos = new Float32Array(NB*2);
  const blobRad = new Float32Array(NB);
  let anchors = [], scrollP = 0, scrollVel = 0, lastY = 0, energy = 0, clock = 0;
  let reactive = [];                       // éléments qui réagissent au passage de la boule
  let charNodes = [], charMeasurers = [];  // caractères des titres qui s'allument
  let textProx = 0;                        // proximité boule ↔ texte (0..1) -> atténue le halo
  let storySections = [], storyScale = 1, scaleCur = 1, chapter = 0, chapterProg = 0;

  // SCÉNARIO de la boule, chapitre par chapitre {x,y en fractions d'écran, s=échelle}
  const STORY = [
    { x:0.50, y:0.42, s:0.85 },            // 0 Signal      — au centre, le signal seul
    { x:0.32, y:0.54, s:1.05 },            // 1 Attention   — part à gauche
    { x:0.68, y:0.54, s:1.20 },            // 2 Leads       — file à droite (convergence)
    { x:0.34, y:0.54, s:1.00 },            // 3 Bon signal  — revient à gauche (radar)
    { x:0.50, y:0.55, s:1.30 },            // 4 Opportunité — recentre, amarrage sur le CTA
  ];
  const railBtns   = [...document.querySelectorAll('#rail button')];
  const recapSpans = [...document.querySelectorAll('#recap [data-r]')];

  // ── line-art des scènes (repris de la version d'origine) ──
  const TAU = Math.PI*2;
  const clamp01 = v => v<0?0:v>1?1:v;
  const lerp = (a,b,t) => a+(b-a)*t;
  const smooth = x => { x=clamp01(x); return x*x*(3-2*x); };
  const easeInOut = x => { x=clamp01(x); return x<0.5 ? 4*x*x*x : 1-Math.pow(-2*x+2,3)/2; };
  const ACCENT = { r:224, g:73, b:43 };                 // bon signal — accent orangé
  let leads = [], blips = [];
  const burst = [], shocks = []; let burstArmed = true; // explosion finale

  function buildScene(){
    leads = []; const N = isMobile ? 8 : 15;
    for(let i=0;i<N;i++){
      const a = (i/N)*TAU + Math.random()*0.4, rad = 0.22 + Math.random()*0.18;
      leads.push({ sx:Math.cos(a)*rad, sy:Math.sin(a)*rad*0.8, delay:(i/N)*0.45,
                   curl:(Math.random()-0.5)*1.1, r:1.8+Math.random()*1.2 });
    }
    blips = []; const M = isMobile ? 4 : 7;
    for(let i=0;i<M;i++) blips.push({ ang:Math.random()*TAU, rad:0.30+Math.random()*0.6, lit:0, good:false });
    const gb = blips[(Math.random()*blips.length)|0]; gb.good = true; gb.rad = 0.74; gb.ang = -Math.PI*0.30;
  }

  // visibilité (fondu) + progression d'une scène selon sa section
  function sceneAlpha(idx){
    const sec = storySections[idx]; if(!sec) return { a:0, dp:0 };
    const r = sec.getBoundingClientRect();
    const center = r.top + r.height/2;
    const dmid = Math.abs((center - innerHeight*0.5)/innerHeight);
    const a = 1 - smooth((dmid - 0.16)/0.32);
    const dp = clamp01((innerHeight*0.5 - r.top)/r.height);
    return { a:clamp01(a), dp };
  }

  // dessine les scènes line-art autour de la boule (sur le calque de liaisons)
  function drawScenes(){
    const W = innerWidth, H = innerHeight, px = pt.x, py = pt.y;

    // — Ch.2 LEADS : convergence de fils + dots vers la boule —
    const L2 = sceneAlpha(2);
    if(L2.a > 0.01){
      const dp = L2.dp, al = L2.a;
      for(const Ld of leads){
        const pp = clamp01((dp - Ld.delay)/(1 - Ld.delay - 0.04)), e = easeInOut(pp);
        const sx = px + Ld.sx*W, sy = py + Ld.sy*H;
        const bx = lerp(sx,px,e), by = lerp(sy,py,e);
        const nx = -(py-sy), ny = (px-sx), nl = Math.hypot(nx,ny)||1;
        const curl = Math.sin(e*Math.PI)*Ld.curl*48;
        const x = bx + (nx/nl)*curl, y = by + (ny/nl)*curl;
        if(e > 0.985) continue;
        lctx.strokeStyle = 'rgba(170,195,255,'+(0.12*e*al).toFixed(3)+')'; lctx.lineWidth = 1;
        lctx.beginPath(); lctx.moveTo(x,y); lctx.lineTo(lerp(x,px,0.55),lerp(y,py,0.55)); lctx.stroke();
        lctx.fillStyle = 'rgba(212,226,255,'+((0.30+e*0.4)*al).toFixed(3)+')';
        lctx.beginPath(); lctx.arc(x,y,Ld.r,0,TAU); lctx.fill();
      }
    }

    // — Ch.3 RADAR : cercles + balayage + blips, le bon signal en accent —
    const L3 = sceneAlpha(3);
    if(L3.a > 0.01){
      const dp = L3.dp, al = L3.a, maxR = Math.min(W,H)*0.30;
      for(let i=1;i<=3;i++){
        const rr = (maxR/3)*i, app = clamp01((dp-(i-1)*0.12)/0.4);
        lctx.strokeStyle = 'rgba(160,185,255,'+(0.18*al).toFixed(3)+')'; lctx.lineWidth = 1;
        lctx.beginPath(); lctx.arc(px,py,rr,-Math.PI/2,-Math.PI/2+TAU*easeInOut(app)); lctx.stroke();
      }
      const swA = clamp01((dp-0.3)/0.3);
      if(swA > 0.01){
        const ang = ((clock*0.16)%1)*TAU - Math.PI/2;
        for(let i=0;i<16;i++){
          const a0 = ang-(i/16)*0.5, a1 = ang-((i+1)/16)*0.5;
          lctx.fillStyle = 'rgba(150,180,255,'+(0.05*(1-i/16)*swA*al).toFixed(3)+')';
          lctx.beginPath(); lctx.moveTo(px,py); lctx.arc(px,py,maxR,a0,a1,true); lctx.closePath(); lctx.fill();
        }
        lctx.strokeStyle = 'rgba(190,210,255,'+(0.35*swA*al).toFixed(3)+')'; lctx.lineWidth = 1.2;
        lctx.beginPath(); lctx.moveTo(px,py); lctx.lineTo(px+Math.cos(ang)*maxR,py+Math.sin(ang)*maxR); lctx.stroke();
        for(const b of blips){
          const d = ((ang-b.ang)%TAU+TAU)%TAU; if(d < 0.12) b.lit = 1; b.lit *= 0.96;
          const bx = px+Math.cos(b.ang)*b.rad*maxR, by = py+Math.sin(b.ang)*b.rad*maxR;
          if(b.good){
            const grow = easeInOut(clamp01((dp-0.5)/0.35));
            lctx.fillStyle = 'rgba('+ACCENT.r+','+ACCENT.g+','+ACCENT.b+','+al.toFixed(3)+')';
            lctx.beginPath(); lctx.arc(bx,by,3.2,0,TAU); lctx.fill();
            lctx.strokeStyle = 'rgba('+ACCENT.r+','+ACCENT.g+','+ACCENT.b+','+(0.85*al).toFixed(3)+')'; lctx.lineWidth = 1.4;
            lctx.beginPath(); lctx.arc(bx,by,6+5*grow,0,TAU*grow); lctx.stroke();
          } else {
            lctx.fillStyle = 'rgba(190,210,255,'+((0.18+b.lit*0.5)*al).toFixed(3)+')';
            lctx.beginPath(); lctx.arc(bx,by,1.8+b.lit*1.6,0,TAU); lctx.fill();
          }
        }
      }
    }
  }

  function compile(t,s){ const sh=gl.createShader(t); gl.shaderSource(sh,s); gl.compileShader(sh);
    if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(sh)); return sh; }
  function initGL(){
    if(!gl) return false;
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog); gl.useProgram(prog);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog,'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
    ['uRes','uTime','uEnergy','uDepth','uFade','uN'].forEach(n=>uni[n]=gl.getUniformLocation(prog,n));
    uni.uBlobs = gl.getUniformLocation(prog,'uBlobs[0]');
    uni.uBlobR = gl.getUniformLocation(prog,'uBlobR[0]');
    return true;
  }

  function resize(){
    DPR = Math.min(devicePixelRatio||1, MAXDPR);
    cv.width = Math.floor(innerWidth*DPR); cv.height = Math.floor(innerHeight*DPR);
    cv.style.width = innerWidth+'px'; cv.style.height = innerHeight+'px';
    if(gl) gl.viewport(0,0,cv.width,cv.height);
    lc.width = Math.floor(innerWidth*DPR); lc.height = Math.floor(innerHeight*DPR);
    lc.style.width = innerWidth+'px'; lc.style.height = innerHeight+'px';
    if(!pt.x){ pt.x=pt.tx=innerWidth*0.5; pt.y=pt.ty=innerHeight*0.45; }
    cacheReactive(); buildScene();
  }
  function recacheAll(){ cacheReactive(); charMeasurers.forEach(m=>m()); }
  addEventListener('resize', ()=>{ resize(); recacheAll(); });
  addEventListener('load', recacheAll);
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(recacheAll);

  function readAnchors(){
    storySections = [...document.querySelectorAll('main section')];
  }
  function target(){
    // détermine le chapitre actif (section qui contient le milieu de l'écran) + sa progression
    const midY = innerHeight*0.5;
    let active = 0, sp = 0;
    for(let i=0;i<storySections.length;i++){
      const r = storySections[i].getBoundingClientRect();
      if(r.top<=midY && r.bottom>=midY){ active=i; sp=Math.min(1,Math.max(0,(midY-r.top)/r.height)); break; }
      if(r.top>midY){ active=Math.max(0,i-1); sp=1; break; }
      if(i===storySections.length-1){ active=i; sp=1; }
    }
    chapter = active; chapterProg = sp;
    const c = STORY[Math.min(active, STORY.length-1)];

    // cible narrative + dérive horizontale + respiration verticale (vivant dans le chapitre)
    pt.tx = innerWidth*c.x  + Math.sin(clock*0.45)*innerWidth*0.025;
    pt.ty = innerHeight*c.y + Math.sin(clock*0.8)*innerHeight*0.014;
    storyScale = c.s;

    // AMARRAGE : au dernier chapitre, le point vient se loger dans le bouton CTA
    if(active === STORY.length-1){
      const slot = document.getElementById('cta-slot');
      if(slot){
        const r = slot.getBoundingClientRect();
        if(r.width && r.top > -120 && r.top < innerHeight+120){
          pt.tx = r.left + r.width/2;
          pt.ty = r.top + r.height/2;
          storyScale = 0.6;                 // se compacte pour tenir dans le bouton
        }
      }
    }
  }

  // ---- INTERACTION boule ↔ contenu ----
  function cacheReactive(){
    const y = window.scrollY || window.pageYOffset || 0;
    reactive = [...document.querySelectorAll('.chip')].map((el,idx)=>{
      const dot = el.querySelector('.ic, .pt');          // point du nœud (sinon centre)
      const r = (dot||el).getBoundingClientRect();
      return { el, cx:r.left + r.width/2, docY:r.top + y + r.height/2, p:0, ph:idx*0.37 };
    });
  }
  // RÉSEAU : illumine les nœuds + tisse les liaisons hub -> contenu visible
  function network(){
    const y = window.scrollY || window.pageYOffset || 0;
    lctx.setTransform(DPR,0,0,DPR,0,0);
    lctx.clearRect(0,0,innerWidth,innerHeight);
    lctx.globalCompositeOperation = 'lighter';
    lctx.lineWidth = 1.2;
    for(const o of reactive){
      const ex = o.cx, ey = o.docY - y;
      const onScreen = ey > -80 && ey < innerHeight+80;
      let lp = 0;
      if(onScreen){
        const d = Math.hypot(pt.x-ex, pt.y-ey);
        lp = Math.max(0, 1 - d/LINK); lp = lp*lp;             // courbe douce
      }
      o.p += (lp - o.p) * 0.12;                               // lissage
      const a = o.p;
      // écritures DOM (lueur + aimantation) seulement sur desktop (repeints coûteux sur iOS)
      if(!isMobile){
        o.el.style.setProperty('--p', a.toFixed(3));
        if(onScreen){
          const dx = pt.x-ex, dy = pt.y-ey, dd = Math.hypot(dx,dy)||1, pull = a*12;
          o.el.style.setProperty('--tx', (dx/dd*pull).toFixed(2));
          o.el.style.setProperty('--ty', (dy/dd*pull).toFixed(2));
        }
      }
      if(!onScreen || a < 0.03) continue;

      // ligne (dégradée sur desktop, unie sur mobile)
      if(isMobile){
        lctx.strokeStyle = 'rgba(150,180,255,'+(a*0.4).toFixed(3)+')';
      } else {
        const g = lctx.createLinearGradient(pt.x,pt.y,ex,ey);
        g.addColorStop(0,'rgba(195,215,255,'+(a*0.6).toFixed(3)+')');
        g.addColorStop(1,'rgba(120,160,255,'+(a*0.16).toFixed(3)+')');
        lctx.strokeStyle = g;
      }
      lctx.beginPath(); lctx.moveTo(pt.x,pt.y); lctx.lineTo(ex,ey); lctx.stroke();

      // halo + nœud
      lctx.fillStyle = 'rgba(140,175,255,'+(a*0.22).toFixed(3)+')';
      lctx.beginPath(); lctx.arc(ex,ey, 6+a*9, 0, 6.283); lctx.fill();
      lctx.fillStyle = 'rgba(215,228,255,'+(a*0.9).toFixed(3)+')';
      lctx.beginPath(); lctx.arc(ex,ey, 2+a*3.5, 0, 6.283); lctx.fill();

      // signal qui circule le long du lien
      const tt = (clock*0.5 + o.ph) % 1;
      const sx = pt.x+(ex-pt.x)*tt, sy = pt.y+(ey-pt.y)*tt;
      lctx.fillStyle = 'rgba(255,255,255,'+(a*0.85).toFixed(3)+')';
      lctx.beginPath(); lctx.arc(sx,sy, 1.9, 0, 6.283); lctx.fill();
    }
  }

  function syncScroll(){
    const y = window.scrollY || window.pageYOffset || 0;
    const max = document.body.scrollHeight - innerHeight;
    scrollP = max>0 ? Math.min(Math.max(y/max,0),1) : 0;
    const raw = y - lastY; lastY = y;
    scrollVel += (raw - scrollVel)*0.25;            // vitesse lissée
    nav.classList.toggle('solid', y>40);
  }

  function render(now){
    const t = now*0.001; clock = t;
    if(lenis) lenis.raf(now);
    syncScroll();
    target();

    // ressort : ferme + vitesse plafonnée (pas de grand dépassement au scroll rapide)
    pt.vx += (pt.tx-pt.x)*0.018; pt.vx *= 0.80;
    pt.vy += (pt.ty-pt.y)*0.018; pt.vy *= 0.80;
    const MAXV = 60;
    pt.vx = pt.vx<-MAXV?-MAXV:pt.vx>MAXV?MAXV:pt.vx;
    pt.vy = pt.vy<-MAXV?-MAXV:pt.vy>MAXV?MAXV:pt.vy;
    pt.x += pt.vx; pt.y += pt.vy;

    const speed = Math.hypot(pt.vx, pt.vy);
    // énergie atténuée : le scroll rapide ne fait plus exploser la taille/traînée
    energy += (Math.min(1,(speed/28) + Math.abs(scrollVel)/45) - energy)*0.1;

    // historique pour la traînée mercure
    hist.unshift({ x:pt.x, y:pt.y });
    if(hist.length > 120) hist.pop();

    network();                              // illumine les nœuds + tisse les liaisons
    drawScenes();                           // line-art : leads (ch.2) + radar (ch.3)
    drawActiveHeading();                    // la boule souligne le titre actif
    if(!isMobile) reactChars();             // lueur des lettres : desktop seulement

    // EXPLOSION finale : une fois, à l'arrivée sur le dernier chapitre
    if(chapter >= STORY.length-1 && chapterProg > 0.5){
      if(burstArmed){ explode(pt.x, pt.y); burstArmed = false; }
    } else if(chapter < STORY.length-1){ burstArmed = true; }
    updateBurst();

    updateStoryDOM();                       // rail + récap synchronisés

    // respiration douce + échelle du chapitre (lissée)
    const breathe = 1 + Math.sin(clock*1.1)*0.07;
    scaleCur += (storyScale - scaleCur) * 0.05;
    const uDepth  = Math.min(1, (scaleCur-0.8)/0.7);          // plus grosse = halo plus fort

    // traînée BORNÉE : blobs placés à distance constante le long du trajet
    // -> longueur max ≈ NB*SEG, donc plus de "grosse orbe" au scroll rapide
    const baseR = (24 + energy*5) * breathe * scaleCur;    // taille quasi stable
    const SEG = 18;
    let n = 0, acc = 0, want = 0;
    for(let i=0; i<hist.length && n<NB; i++){
      if(i>0) acc += Math.hypot(hist[i].x-hist[i-1].x, hist[i].y-hist[i-1].y);
      if(i===0 || acc >= want){
        blobPos[n*2]   = hist[i].x * DPR;
        blobPos[n*2+1] = (innerHeight - hist[i].y) * DPR;  // origine bas-gauche
        blobRad[n]     = baseR * (1 - n/NB*0.6) * DPR;
        n++; want = n*SEG;
      }
    }

    if(uni.uRes){
      gl.uniform2f(uni.uRes, cv.width, cv.height);
      gl.uniform1f(uni.uTime, t);
      gl.uniform1f(uni.uEnergy, energy);
      gl.uniform1f(uni.uDepth, uDepth);
      gl.uniform1f(uni.uFade, textProx);
      gl.uniform1i(uni.uN, n);
      gl.uniform2fv(uni.uBlobs, blobPos);
      gl.uniform1fv(uni.uBlobR, blobRad);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    requestAnimationFrame(render);
  }

  // rail + récap pilotés par le chapitre
  function updateStoryDOM(){
    for(let i=0;i<railBtns.length;i++) railBtns[i].dataset.on = (i===chapter ? '1' : '0');
    const onContact = chapter >= STORY.length-1;
    for(let i=0;i<recapSpans.length;i++){
      const lit = onContact && chapterProg > (i/recapSpans.length)*0.9;
      recapSpans[i].classList.toggle('lit', lit);
    }
  }
  // clic sur le rail -> scroll vers le chapitre
  railBtns.forEach(b=>b.addEventListener('click',()=>{
    const i = +b.dataset.i, max = document.body.scrollHeight - innerHeight;
    const tgt = (i/(STORY.length-1))*max;
    if(lenis) lenis.scrollTo(tgt,{ duration:1.2 }); else scrollTo({ top:tgt, behavior:'smooth' });
  }));

  /* ---------- 4. SPLIT TEXT (GSAP) ---------- */
  function splitChars(el){
    const nodes = [...el.childNodes]; el.innerHTML='';
    nodes.forEach(node=>{
      if(node.nodeName==='BR'){ el.appendChild(document.createElement('br')); return; }
      node.textContent.split(/(\s+)/).forEach(tok=>{
        if(tok==='') return;
        if(/^\s+$/.test(tok)){ el.appendChild(document.createTextNode(' ')); return; }
        const w=document.createElement('span'); w.className='word';
        [...tok].forEach(ch=>{ const c=document.createElement('span'); c.className='char'; c.textContent=ch; w.appendChild(c); });
        el.appendChild(w);
      });
    });
    return el.querySelectorAll('.char');
  }
  function setupHeadings(){
    document.querySelectorAll('.js-split').forEach(h=>{
      const chars = splitChars(h); h.classList.add('ready');
      // enregistre chaque caractère pour qu'il s'allume au passage de la boule
      const nodes = [...chars].map(el=>({ el, cx:0, docY:0, g:0 }));
      charNodes.push(...nodes);
      const measure = ()=>{ const y=window.scrollY||window.pageYOffset||0;
        nodes.forEach(nd=>{ const r=nd.el.getBoundingClientRect(); nd.cx=r.left+r.width/2; nd.docY=r.top+y+r.height/2; }); };
      measure(); charMeasurers.push(measure);
      if(reduce || !window.gsap) return;
      gsap.set(chars,{ yPercent:110 });
      new IntersectionObserver((es,obs)=>es.forEach(e=>{ if(e.isIntersecting){
        gsap.to(chars,{ yPercent:0, duration:0.9, ease:'expo.out', stagger:0.016, onComplete:measure });
        obs.unobserve(e.target);
      }}),{ threshold:0.3 }).observe(h);
    });
  }
  // les caractères proches de la boule s'illuminent
  function reactChars(){
    const y = window.scrollY || window.pageYOffset || 0;
    let mp = 0;                                            // proximité max au texte
    for(const c of charNodes){
      const ey = c.docY - y;
      if(ey < -50 || ey > innerHeight+50){ if(c.g>0.002){ c.g=0; c.el.style.setProperty('--g','0'); } continue; }
      const d = Math.hypot(pt.x - c.cx, pt.y - ey);
      let g = Math.max(0, 1 - d/250); g = g*g;
      c.g += (g - c.g) * 0.2;
      c.el.style.setProperty('--g', c.g.toFixed(3));
      const pr = Math.max(0, 1 - d/210); if(pr > mp) mp = pr;   // boule sur cette lettre ?
    }
    textProx += (mp - textProx) * 0.15;                   // lissage
  }
  // la boule « écrit » : souligne le titre du chapitre actif
  function drawActiveHeading(){
    const sec = storySections[chapter]; if(!sec) return;
    const h = sec.querySelector('h1,h2'); if(!h) return;
    const r = h.getBoundingClientRect();
    if(r.bottom < 0 || r.top > innerHeight) return;
    const prog = easeInOut(chapter===0 ? 1 : clamp01(chapterProg*1.7));
    const y = r.bottom + 9, x0 = r.left, w = r.width*prog;
    const accent = chapter===3;
    const col = accent ? ACCENT : { r:150, g:185, b:255 };
    lctx.globalCompositeOperation = 'lighter';
    // connecteur : la boule est le stylo
    lctx.strokeStyle = 'rgba(150,180,255,0.10)'; lctx.lineWidth = 1;
    lctx.beginPath(); lctx.moveTo(pt.x,pt.y); lctx.lineTo(x0+w,y); lctx.stroke();
    // trait souligné (dégradé sur desktop, uni sur mobile)
    if(isMobile){
      lctx.strokeStyle = 'rgba('+col.r+','+col.g+','+col.b+',0.6)';
    } else {
      const grad = lctx.createLinearGradient(x0,y,x0+w,y);
      grad.addColorStop(0,'rgba('+col.r+','+col.g+','+col.b+',0)');
      grad.addColorStop(0.16,'rgba('+col.r+','+col.g+','+col.b+',0.75)');
      grad.addColorStop(1,'rgba('+col.r+','+col.g+','+col.b+',0.12)');
      lctx.strokeStyle = grad;
    }
    lctx.lineWidth = 2;
    lctx.beginPath(); lctx.moveTo(x0,y); lctx.lineTo(x0+w,y); lctx.stroke();
    // pointe d'écriture
    lctx.fillStyle = 'rgba(255,255,255,0.85)';
    lctx.beginPath(); lctx.arc(x0+w, y, 2.2, 0, TAU); lctx.fill();
  }

  // EXPLOSION finale — le signal se verrouille
  function explode(x,y){
    for(let i=0;i<100;i++){
      const a = Math.random()*TAU, sp = Math.pow(Math.random(),0.6)*9 + 1.5;
      burst.push({ x, y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp,
        life:1, decay:0.011+Math.random()*0.02, r:1+Math.random()*2.4, acc:Math.random()<0.18 });
    }
    shocks.push({ x, y, r:8, life:1, sp:1 });
    shocks.push({ x, y, r:8, life:1, sp:1.7 });
  }
  function updateBurst(){
    for(let i=shocks.length-1;i>=0;i--){
      const s = shocks[i]; s.r += 11*s.sp; s.life -= 0.02;
      if(s.life<=0){ shocks.splice(i,1); continue; }
      lctx.strokeStyle = 'rgba(190,210,255,'+(s.life*0.5).toFixed(3)+')'; lctx.lineWidth = 1.6*s.life;
      lctx.beginPath(); lctx.arc(s.x,s.y,s.r,0,TAU); lctx.stroke();
    }
    for(let i=burst.length-1;i>=0;i--){
      const p = burst[i];
      p.vx *= 0.95; p.vy *= 0.95; p.vy += 0.13; p.x += p.vx; p.y += p.vy; p.life -= p.decay;
      if(p.life<=0){ burst.splice(i,1); continue; }
      const al = p.life*p.life;
      const col = p.acc ? (ACCENT.r+','+ACCENT.g+','+ACCENT.b) : '235,242,255';
      lctx.fillStyle = 'rgba('+col+','+al.toFixed(3)+')';
      lctx.beginPath(); lctx.arc(p.x,p.y,p.r*(0.6+p.life*0.7),0,TAU); lctx.fill();
    }
  }
  function setupReveals(){
    const io = new IntersectionObserver(es=>es.forEach(e=>{ if(e.isIntersecting) e.target.classList.add('in'); }),{ threshold:0.16 });
    document.querySelectorAll('.reveal').forEach((el,i)=>{ el.style.transitionDelay=(i%3*0.09)+'s'; io.observe(el); });
  }

  /* ---------- démarrage ---------- */
  resize(); readAnchors(); initGL(); syncScroll();
  setupHeadings(); setupReveals();
  requestAnimationFrame(render);
})();
