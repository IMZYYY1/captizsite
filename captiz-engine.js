/* Captiz — moteur du "point" (refonte trait / papier).
   Un point d'encre unique traverse la page et trace de fines illustrations.

   Modèle de timing (revu) — chaque chapitre a 3 temps :
     1. APPROCHE  : l'illustration se CONSTRUIT pendant qu'on descend vers la scène,
                    et se termine JUSTE AVANT le centre (DRAW).
     2. LECTURE   : au centre, l'illustration est tracée et « respire » (HOLD) —
                    boucles vivantes, balayages, orbites. C'est le temps de lecture.
     3. SORTIE    : le point repart, l'illustration s'efface, la suivante se construit.
   Les chapitres sont plus longs (cf. CSS .track section) pour laisser le temps de lire. */
(function () {
  'use strict';

  // ── maths ──────────────────────────────────────────────────────────────
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
  const sstep = (e0, e1, x) => smooth((x - e0) / (e1 - e0 || 1e-6));
  const easeInOut = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  const easeOut = (x) => { x = clamp01(x); return 1 - Math.pow(1 - x, 3); };
  const quad = (a, b, c, t) => { const u = 1 - t; return u * u * a + 2 * u * t * b + t * t * c; };
  const TAU = Math.PI * 2;

  function hexToRgb(hex) {
    let h = String(hex).replace('#', '').trim();
    if (h.length === 3) h = h.replace(/./g, (c) => c + c);
    const n = parseInt(h.slice(0, 6), 16);
    if (Number.isNaN(n)) return { r: 224, g: 73, b: 43 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const rgba = (c, a) => `rgba(${c.r},${c.g},${c.b},${a})`;

  // ── couleur : conversions + interpolation HSL (transitions douces) ─────────
  function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let h = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: h * 360, s, l };
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      const hue = (p, q, t) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }
  function mixHsl(a, b, t) {
    let dh = b.h - a.h;
    if (dh > 180) dh -= 360; if (dh < -180) dh += 360;   // chemin de teinte le plus court
    return hslToRgb(a.h + dh * t, lerp(a.s, b.s, t), lerp(a.l, b.l, t));
  }

  // ── config ───────────────────────────────────────────────────────────────
  const NSCENES = 5;
  // palette par chapitre : Signal · Attention · Conversion · Décision · Opportunité
  const DEFAULT_PALETTE = ['#DE4D2C', '#E18B2C', '#C24E73', '#2E8C7C', '#4658B8'];
  const cfg = {
    theme: 'paper',
    ink: { r: 26, g: 25, b: 22 },        // trait neutre (line-art)
    accent: '#e0492b',
    accentRgb: hexToRgb('#e0492b'),       // couleur courante (interpolée)
    palette: DEFAULT_PALETTE.map(hexToRgb),
    paletteHsl: DEFAULT_PALETTE.map((h) => rgbToHsl(hexToRgb(h))),
    motion: 7,
    smoothK: 9.5,        // taux de lissage (par seconde, indépendant du framerate)
  };
  function setPalette(arr) {
    if (!Array.isArray(arr) || arr.length < 2) return;
    cfg.palette = arr.map(hexToRgb);
    cfg.paletteHsl = arr.map((h) => rgbToHsl(hexToRgb(h)));
  }
  // couleur à la position pos : maintenue pendant la lecture, glisse pendant le voyage
  function colorAt(p) {
    const P = cfg.paletteHsl, n = P.length;
    const i0 = clamp(Math.floor(p), 0, n - 1), i1 = Math.min(n - 1, i0 + 1);
    const frac = clamp01(p - i0);
    const cf = easeInOut(sstep(0.45, 0.95, frac)); // calé sur le voyage du point
    return mixHsl(P[i0], P[i1], cf);
  }

  const canvas = document.getElementById('captiz-canvas');
  const ctx = canvas.getContext('2d', { alpha: true });
  let W = 0, H = 0, DPR = 1;
  let pos = 0;            // position lissée dans [0, NSCENES-1]
  let t = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // DOM
  const root = document.documentElement;
  const layers = [...document.querySelectorAll('.layer')];
  const railBtns = [...document.querySelectorAll('#rail button')];
  const recap = [...document.querySelectorAll('.recap [data-r]')];
  const hint = document.getElementById('scrollHint');

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildScene();
  }

  function scrollPos() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const g = max > 0 ? clamp01(window.scrollY / max) : 0;
    return g * (NSCENES - 1);
  }

  // ── éléments générés ──────────────────────────────────────────────────────
  let leads = [], blips = [], dust = [];
  function buildScene() {
    const mn = cfg.motion / 10;
    // leads : départ dispersé autour du point d'arrivée
    const lc = Math.round(13 + mn * 11);
    leads = [];
    for (let i = 0; i < lc; i++) {
      const a = (i / lc) * TAU + (Math.random() - 0.5) * 0.5;
      const rad = 0.34 + Math.random() * 0.30;
      leads.push({
        sx: Math.cos(a) * rad, sy: Math.sin(a) * rad * 0.82,
        delay: (i / lc) * 0.55, curl: (Math.random() - 0.5) * 1.25,
        r: 1.6 + Math.random() * 1.5, orbit: a, ospd: 0.6 + Math.random() * 0.5,
      });
    }
    // blips radar
    const bc = Math.round(7 + mn * 6);
    blips = [];
    for (let i = 0; i < bc; i++) {
      blips.push({ ang: Math.random() * TAU, rad: 0.26 + Math.random() * 0.64, lit: 0, ping: 0, good: false });
    }
    const g = blips[(Math.random() * blips.length) | 0];
    g.good = true; g.rad = 0.72; g.ang = -Math.PI * 0.30;
    // poussière (hero) — bruit ambiant qui clignote
    dust = [];
    const dc = Math.round(16 + mn * 10);
    for (let i = 0; i < dc; i++) {
      dust.push({ x: Math.random(), y: Math.random(), ph: Math.random() * TAU, sp: 0.4 + Math.random() * 0.8, r: 0.7 + Math.random() * 1.0 });
    }
  }

  // ── wireframe « landing page » (coords locales 0..1 dans une boîte) ─────────
  const WF = [
    [[0.03, 0.05], [0.97, 0.05], [0.97, 0.95], [0.03, 0.95], [0.03, 0.05]], // cadre
    [[0.03, 0.17], [0.97, 0.17]],                                           // barre nav
    [[0.08, 0.11], [0.21, 0.11]],                                           // logo
    [[0.73, 0.11], [0.82, 0.11]],                                           // lien 1
    [[0.86, 0.11], [0.93, 0.11]],                                           // lien 2
    [[0.08, 0.30], [0.60, 0.30]],                                           // titre l.1
    [[0.08, 0.39], [0.48, 0.39]],                                           // titre l.2
    [[0.08, 0.50], [0.39, 0.50]],                                           // sous-texte
    [[0.08, 0.59], [0.29, 0.59], [0.29, 0.67], [0.08, 0.67], [0.08, 0.59]], // bouton CTA
    [[0.62, 0.27], [0.93, 0.27], [0.93, 0.62], [0.62, 0.62], [0.62, 0.27]], // visuel
    [[0.62, 0.27], [0.93, 0.62]],                                           // diag visuel
    [[0.93, 0.27], [0.62, 0.62]],                                           // diag visuel 2
    [[0.08, 0.78], [0.29, 0.78], [0.29, 0.90], [0.08, 0.90], [0.08, 0.78]], // carte 1
    [[0.39, 0.78], [0.60, 0.78], [0.60, 0.90], [0.39, 0.90], [0.39, 0.78]], // carte 2
    [[0.70, 0.78], [0.92, 0.78], [0.92, 0.90], [0.70, 0.90], [0.70, 0.78]], // carte 3
  ];
  let wfLens = null, wfTotal = 0;
  function measureWF() {
    wfLens = WF.map((poly) => {
      let L = 0; const segs = [];
      for (let i = 1; i < poly.length; i++) {
        const l = Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
        segs.push(l); L += l;
      }
      return { L, segs };
    });
    wfTotal = wfLens.reduce((s, p) => s + p.L, 0);
  }
  function drawWireframe(box, dp, alpha) {
    if (!wfLens) measureWF();
    const tx = (p) => box.x + p[0] * box.w, ty = (p) => box.y + p[1] * box.h;
    let budget = dp * wfTotal, head = null;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.lineWidth = 1.4;
    ctx.strokeStyle = rgba(cfg.ink, 0.6 * alpha);
    for (let pi = 0; pi < WF.length; pi++) {
      if (budget <= 0) break;
      const poly = WF[pi], info = wfLens[pi];
      ctx.beginPath(); ctx.moveTo(tx(poly[0]), ty(poly[0]));
      let stop = false;
      for (let i = 1; i < poly.length; i++) {
        const segL = info.segs[i - 1];
        if (budget >= segL) {
          ctx.lineTo(tx(poly[i]), ty(poly[i])); budget -= segL;
          head = { x: tx(poly[i]), y: ty(poly[i]) };
        } else {
          const f = budget / segL;
          const px = box.x + lerp(poly[i - 1][0], poly[i][0], f) * box.w;
          const py = box.y + lerp(poly[i - 1][1], poly[i][1], f) * box.h;
          ctx.lineTo(px, py); head = { x: px, y: py }; budget = 0; stop = true; break;
        }
      }
      ctx.stroke();
      if (stop) break;
    }
    return head;
  }

  // ── état du point par scène (fractions) ────────────────────────────────────
  const STATE = [
    { x: 0.50, y: 0.20 }, // 0 hero
    { x: 0.60, y: 0.50 }, // 1 attention (curseur, à gauche du croquis)
    { x: 0.35, y: 0.50 }, // 2 leads (aimant)
    { x: 0.63, y: 0.52 }, // 3 radar
    { x: 0.50, y: 0.60 }, // 4 contact (recalé sur le bouton)
  ];

  // ── dessins (line-art) ─────────────────────────────────────────────────────

  // hero : ondes fines + poussière de signal qui clignote
  function sceneSignal(alpha, px, py, hold) {
    const mn = cfg.motion / 10;
    const speed = reduced ? 0.05 : 0.08 + mn * 0.045;
    const RINGS = 5;
    for (let i = 0; i < RINGS; i++) {
      const ph = ((t * speed + i / RINGS) % 1);
      const rad = 12 + easeOut(ph) * (150 + mn * 90);
      ctx.beginPath(); ctx.arc(px, py, rad, 0, TAU);
      ctx.strokeStyle = rgba(cfg.ink, (1 - ph) * 0.20 * alpha);
      ctx.lineWidth = 1; ctx.stroke();
    }
    // poussière ambiante : petits points qui apparaissent/disparaissent
    for (const d of dust) {
      const fl = 0.5 + 0.5 * Math.sin(t * d.sp + d.ph);
      const dx = d.x * W, dy = d.y * H;
      // ignorer la zone centrale (lisibilité du titre)
      if (Math.abs(d.y - 0.46) < 0.22 && Math.abs(d.x - 0.5) < 0.34) continue;
      ctx.beginPath(); ctx.arc(dx, dy, d.r, 0, TAU);
      ctx.fillStyle = rgba(cfg.ink, 0.10 * fl * fl * alpha);
      ctx.fill();
    }
    // tick rotatif autour du point (vie discrète)
    const ta = t * (reduced ? 0.1 : 0.5);
    for (let i = 0; i < 3; i++) {
      const a = ta + (i / 3) * TAU;
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(a) * 12, py + Math.sin(a) * 12);
      ctx.lineTo(px + Math.cos(a) * 17, py + Math.sin(a) * 17);
      ctx.strokeStyle = rgba(cfg.accentRgb, 0.5 * alpha); ctx.lineWidth = 1.2; ctx.stroke();
    }
  }

  // attention — la maquette se construit, puis « respire » (curseur, scan)
  function sceneWire(alpha, px, py, dp, hold, box) {
    const head = drawWireframe(box, dp, alpha);
    // fil entre le point et la tête du stylo pendant le tracé
    if (head && dp > 0.02 && dp < 0.995) {
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(head.x, head.y);
      ctx.strokeStyle = rgba(cfg.ink, 0.30 * alpha); ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]); ctx.stroke(); ctx.setLineDash([]);
      // petite tête de stylo
      ctx.beginPath(); ctx.arc(head.x, head.y, 2.4, 0, TAU);
      ctx.fillStyle = rgba(cfg.ink, 0.9 * alpha); ctx.fill();
    }
    if (dp < 0.995 || hold < 0.01) return;

    // — phase vivante (maquette tracée) —
    const tx = (a, b) => box.x + a * box.w, ty = (a, b) => box.y + b * box.h;
    // 1) balayage lumineux qui descend (scan)
    const scan = ((t * (reduced ? 0.12 : 0.28)) % 1.4) / 1.4;
    if (scan <= 1) {
      const sy = ty(0, lerp(0.06, 0.94, scan));
      const grad = ctx.createLinearGradient(0, sy - 26, 0, sy + 26);
      grad.addColorStop(0, rgba(cfg.ink, 0));
      grad.addColorStop(0.5, rgba(cfg.ink, 0.06 * hold * alpha));
      grad.addColorStop(1, rgba(cfg.ink, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(tx(0.03, 0), sy - 26, box.w * 0.94, 52);
      ctx.beginPath(); ctx.moveTo(tx(0.03, 0), sy); ctx.lineTo(tx(0.97, 0), sy);
      ctx.strokeStyle = rgba(cfg.accentRgb, 0.18 * hold * alpha); ctx.lineWidth = 1; ctx.stroke();
    }
    // 2) bouton CTA qui se remplit d'accent (pulse)
    const fill = 0.5 + 0.5 * Math.sin(t * 1.6);
    ctx.fillStyle = rgba(cfg.accentRgb, 0.10 * fill * hold * alpha);
    ctx.fillRect(tx(0.08, 0), ty(0, 0.59), box.w * 0.21, box.h * 0.08);
    // 3) curseur qui clique sur le bouton
    const cx = tx(0.245, 0), cy = ty(0, 0.665);
    const click = Math.max(0, Math.sin(t * 1.6));
    ctx.beginPath();
    ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + 13); ctx.lineTo(cx + 3.6, cy + 9.5);
    ctx.lineTo(cx + 8.5, cy + 9.5); ctx.closePath();
    ctx.fillStyle = rgba(cfg.ink, 0.85 * hold * alpha); ctx.fill();
    if (click > 0.6) {
      const rr = (click - 0.6) / 0.4;
      ctx.beginPath(); ctx.arc(cx, cy, 4 + rr * 9, 0, TAU);
      ctx.strokeStyle = rgba(cfg.accentRgb, (1 - rr) * 0.7 * hold * alpha); ctx.lineWidth = 1.3; ctx.stroke();
    }
  }

  // leads : convergence le long de courbes, puis orbite captée autour du point
  function sceneLeads(alpha, px, py, dp, hold) {
    let gathered = 0;
    const n = leads.length;
    for (const L of leads) {
      const span = 1 - L.delay - 0.04;
      const pp = clamp01((dp - L.delay) / (span || 1e-6));
      const e = easeInOut(pp);
      if (e > 0.985) { gathered++; continue; }
      const sx = px + L.sx * W, sy = py + L.sy * H;
      const mx = lerp(sx, px, 0.5), my = lerp(sy, py, 0.5);
      const nx = -(py - sy), ny = (px - sx), nl = Math.hypot(nx, ny) || 1;
      const cx = mx + (nx / nl) * L.curl * 130, cy = my + (ny / nl) * L.curl * 130;
      // traînée courbe derrière la tête
      ctx.beginPath();
      const tailN = 7;
      for (let s = 0; s <= tailN; s++) {
        const te = clamp01(e - (s / tailN) * 0.16);
        const x = quad(sx, cx, px, te), y = quad(sy, cy, py, te);
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = rgba(cfg.ink, 0.16 * e * alpha); ctx.lineWidth = 1; ctx.lineCap = 'round'; ctx.stroke();
      // tête
      const hx = quad(sx, cx, px, e), hy = quad(sy, cy, py, e);
      ctx.beginPath(); ctx.arc(hx, hy, L.r, 0, TAU);
      ctx.fillStyle = rgba(cfg.ink, (0.30 + e * 0.45) * alpha); ctx.fill();
    }
    const gFrac = gathered / Math.max(1, n);

    // — orbite captée (phase de lecture) —
    const settle = hold * easeOut(clamp01((dp - 0.55) / 0.4));
    if (settle > 0.01) {
      const baseR = 22 + 8 * Math.sin(t * 0.8);
      const rot = reduced ? 0 : t * 0.5;
      leads.forEach((L, i) => {
        const a = L.orbit + rot * L.ospd;
        const rr = baseR * (0.7 + 0.4 * ((i % 3) / 2));
        const ox = px + Math.cos(a) * rr, oy = py + Math.sin(a) * rr * 0.92;
        ctx.beginPath(); ctx.arc(ox, oy, L.r * 0.9, 0, TAU);
        const isAccent = i % 5 === 0;
        ctx.fillStyle = isAccent ? rgba(cfg.accentRgb, 0.8 * settle) : rgba(cfg.ink, 0.5 * settle);
        ctx.fill();
        // fil fin vers le centre
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(px, py);
        ctx.strokeStyle = rgba(cfg.ink, 0.05 * settle); ctx.lineWidth = 1; ctx.stroke();
      });
    }
    return gFrac;
  }

  // radar : cercles fins + balayage, blips qui pingent, le bon signal verrouillé
  function sceneRadar(alpha, px, py, dp, hold) {
    const mn = cfg.motion / 10;
    const maxR = Math.min(W, H) * 0.34;
    const RINGS = 4;
    for (let i = 1; i <= RINGS; i++) {
      const rr = (maxR / RINGS) * i;
      const app = clamp01((dp - (i - 1) * 0.10) / 0.38);
      ctx.beginPath(); ctx.arc(px, py, rr, -Math.PI / 2, -Math.PI / 2 + TAU * easeInOut(app));
      ctx.strokeStyle = rgba(cfg.ink, 0.15 * alpha); ctx.lineWidth = 1; ctx.stroke();
    }
    // réticule fin
    const cross = clamp01((dp - 0.2) / 0.4);
    if (cross > 0.01) {
      ctx.strokeStyle = rgba(cfg.ink, 0.08 * cross * alpha); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px - maxR * cross, py); ctx.lineTo(px + maxR * cross, py);
      ctx.moveTo(px, py - maxR * cross); ctx.lineTo(px, py + maxR * cross); ctx.stroke();
    }
    // balayage
    const swA = clamp01((dp - 0.35) / 0.3);
    if (swA <= 0.01) return;
    const sweepSp = reduced ? 0.07 : 0.14 + mn * 0.10;
    const ang = (t * sweepSp) % 1 * TAU - Math.PI / 2;
    // traînée comète
    const TR = 22;
    for (let i = 0; i < TR; i++) {
      const a0 = ang - (i / TR) * 0.62, a1 = ang - ((i + 1) / TR) * 0.62;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.arc(px, py, maxR, a0, a1, true); ctx.closePath();
      ctx.fillStyle = rgba(cfg.ink, 0.05 * (1 - i / TR) * swA * alpha); ctx.fill();
    }
    ctx.beginPath(); ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(ang) * maxR, py + Math.sin(ang) * maxR);
    ctx.strokeStyle = rgba(cfg.ink, 0.32 * swA * alpha); ctx.lineWidth = 1.2; ctx.stroke();
    // blips
    for (const b of blips) {
      const d = ((ang - b.ang) % TAU + TAU) % TAU;
      if (d < 0.10) { if (b.lit < 0.5) b.ping = 1; b.lit = 1; }
      b.lit *= reduced ? 0.975 : 0.955;
      b.ping *= reduced ? 0.97 : 0.94;
      const bx = px + Math.cos(b.ang) * b.rad * maxR, by = py + Math.sin(b.ang) * b.rad * maxR;
      if (b.good) {
        const grow = easeInOut(clamp01((dp - 0.5) / 0.4)) * hold;
        // halo expansif
        if (b.ping > 0.02) {
          ctx.beginPath(); ctx.arc(bx, by, 4 + (1 - b.ping) * 16, 0, TAU);
          ctx.strokeStyle = rgba(cfg.accentRgb, b.ping * 0.6 * alpha); ctx.lineWidth = 1.2; ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(bx, by, 3.2, 0, TAU);
        ctx.fillStyle = rgba(cfg.accentRgb, alpha); ctx.fill();
        ctx.beginPath(); ctx.arc(bx, by, 6 + 5 * grow, 0, TAU * Math.max(grow, 0.001));
        ctx.strokeStyle = rgba(cfg.accentRgb, 0.85 * alpha); ctx.lineWidth = 1.4; ctx.stroke();
        // réticule sur le bon signal + ligne vers le centre (capté)
        if (grow > 0.35) {
          const g2 = (grow - 0.35) / 0.65;
          ctx.strokeStyle = rgba(cfg.accentRgb, 0.5 * g2 * alpha); ctx.lineWidth = 1;
          const k = 9 + 3 * grow;
          ctx.beginPath();
          ctx.moveTo(bx - k, by); ctx.lineTo(bx - k + 4, by);
          ctx.moveTo(bx + k, by); ctx.lineTo(bx + k - 4, by);
          ctx.moveTo(bx, by - k); ctx.lineTo(bx, by - k + 4);
          ctx.moveTo(bx, by + k); ctx.lineTo(bx, by + k - 4);
          ctx.stroke();
          ctx.setLineDash([2, 3]);
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(bx, by);
          ctx.strokeStyle = rgba(cfg.accentRgb, 0.35 * g2 * alpha); ctx.lineWidth = 1; ctx.stroke();
          ctx.setLineDash([]);
        }
      } else {
        if (b.ping > 0.02) {
          ctx.beginPath(); ctx.arc(bx, by, 2 + (1 - b.ping) * 9, 0, TAU);
          ctx.strokeStyle = rgba(cfg.ink, b.ping * 0.3 * alpha); ctx.lineWidth = 1; ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(bx, by, 1.7 + b.lit * 1.7, 0, TAU);
        ctx.fillStyle = rgba(cfg.ink, (0.16 + b.lit * 0.5) * alpha); ctx.fill();
      }
    }
  }

  // ── point + traînée ────────────────────────────────────────────────────────
  const trail = [];
  function pushTrail(x, y) {
    const lastP = trail[trail.length - 1];
    if (!lastP || Math.hypot(x - lastP.x, y - lastP.y) > 2.2) {
      trail.push({ x, y }); if (trail.length > 64) trail.shift();
    }
  }
  function drawTrail() {
    if (trail.length < 2) return;
    ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i++) {
      const f = i / trail.length;
      ctx.beginPath(); ctx.moveTo(trail[i - 1].x, trail[i - 1].y); ctx.lineTo(trail[i].x, trail[i].y);
      ctx.strokeStyle = rgba(cfg.accentRgb, f * 0.16); ctx.lineWidth = 0.5 + f * 1.2; ctx.stroke();
    }
  }
  function drawPoint(x, y, r, accentRing) {
    if (accentRing > 0.01) {
      ctx.beginPath(); ctx.arc(x, y, r + 5 + accentRing * 4, 0, TAU * easeInOut(accentRing));
      ctx.strokeStyle = rgba(cfg.accentRgb, 0.7 * accentRing); ctx.lineWidth = 1.4; ctx.stroke();
    }
    // halo doux de la couleur du chapitre
    const halo = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
    halo.addColorStop(0, rgba(cfg.accentRgb, 0.28));
    halo.addColorStop(1, rgba(cfg.accentRgb, 0));
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, TAU); ctx.fill();
    // point coloré
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = rgba(cfg.accentRgb, 1); ctx.fill();
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────
  function updateDOM() {
    layers.forEach((el, i) => {
      const d = Math.abs(pos - i);
      // plateau de lecture élargi : plein texte jusqu'à d=0.40, fondu jusqu'à 0.62
      const op = 1 - sstep(0.40, 0.62, d);
      el.style.opacity = op.toFixed(3);
      el.style.transform = `translateY(${(pos - i) * -18}px)`;
      el.style.pointerEvents = op > 0.6 ? 'auto' : 'none';
    });
    const active = clamp(Math.round(pos), 0, NSCENES - 1);
    railBtns.forEach((b, i) => { b.dataset.on = i === active ? '1' : '0'; });
    recap.forEach((el, i) => {
      const reached = pos > 3.5 + (i / Math.max(1, recap.length)) * 0.5;
      el.style.color = reached ? 'var(--accent)' : '';
    });
    if (hint) hint.style.opacity = pos < 0.22 ? '1' : '0';
  }

  // ── rendu ─────────────────────────────────────────────────────────────────
  function render() {
    ctx.clearRect(0, 0, W, H);

    // recale le contact sur le bouton
    const slot = document.getElementById('cta-slot');
    if (slot) { const r = slot.getBoundingClientRect(); if (r.width) { STATE[4].x = (r.left + r.width / 2) / W; STATE[4].y = (r.top + r.height / 2) / H; } }

    // position du point : parqué sur STATE[i] pendant la scène, voyage en transition
    const i0 = clamp(Math.floor(pos), 0, NSCENES - 1);
    const i1 = Math.min(NSCENES - 1, i0 + 1);
    const frac = pos - i0;
    const travel = easeInOut(sstep(0.52, 0.96, frac));
    let px = lerp(STATE[i0].x, STATE[i1].x, travel) * W;
    let py = lerp(STATE[i0].y, STATE[i1].y, travel) * H;
    let r = 5.5 + 0.6 * Math.sin(t * 1.4);   // respiration discrète
    let accentRing = 0;

    // couleur du chapitre : pilote le point, les accents canvas ET la variable CSS --accent
    const col = colorAt(pos);
    cfg.accentRgb = col;
    if (root) root.style.setProperty('--accent', `rgb(${col.r},${col.g},${col.b})`);

    // timing par scène
    const DRAW = (i) => sstep(i - 0.58, i - 0.05, pos);          // construction → finie avant le centre
    const HOLD = (i) => 1 - sstep(0.02, 0.46, Math.abs(pos - i)); // 1 au centre (phase de lecture)
    const ALPHA = (i) => 1 - sstep(0.42, 0.66, Math.abs(pos - i));// visibilité

    drawTrail();

    // 0 — hero
    const a0 = ALPHA(0);
    if (a0 > 0.01) sceneSignal(a0, px, py, HOLD(0));

    // 1 — attention : la maquette se construit puis respire
    const a1 = ALPHA(1);
    if (a1 > 0.01) {
      const box = { x: 0.55 * W, y: 0.23 * H, w: 0.36 * W, h: 0.54 * H };
      sceneWire(a1, px, py, DRAW(1), HOLD(1), box);
    }

    // 2 — leads : convergence puis orbite
    const a2 = ALPHA(2);
    if (a2 > 0.01) {
      const g = sceneLeads(a2, px, py, DRAW(2), HOLD(2));
      accentRing = Math.max(accentRing, sstep(0.6, 1, g) * a2 * HOLD(2));
      r += g * 1.8 * a2;
    }

    // 3 — radar
    const a3 = ALPHA(3);
    if (a3 > 0.01) sceneRadar(a3, px, py, DRAW(3), HOLD(3));

    // 4 — contact : anneau d'accent qui se referme et pulse
    const a4 = ALPHA(4);
    if (a4 > 0.01) {
      const close = DRAW(4);
      const pulse = 1 + 0.12 * Math.sin(t * 1.8) * HOLD(4);
      accentRing = Math.max(accentRing, close * a4 * pulse);
    }

    pushTrail(px, py);
    drawPoint(px, py, r, accentRing);

    updateDOM();
  }

  // ── API ──────────────────────────────────────────────────────────────────
  function applyTheme() {
    cfg.ink = cfg.theme === 'ink' ? { r: 237, g: 235, b: 228 } : { r: 26, g: 25, b: 22 };
  }
  window.Captiz = {
    setOptions(o) {
      if (!o) return;
      if (o.palette) setPalette(o.palette);
      if (o.accent) { cfg.accent = o.accent; cfg.accentRgb = hexToRgb(o.accent); }
      if (o.theme) { cfg.theme = o.theme; applyTheme(); }
      if (typeof o.motion === 'number') { const ch = o.motion !== cfg.motion; cfg.motion = o.motion; if (ch) buildScene(); }
      if (o.transition) cfg.smoothK = o.transition === 'direct' ? 16 : o.transition === 'ample' ? 6 : 9.5;
    },
    debug(p, time) { if (typeof p === 'number') pos = p; if (typeof time === 'number') t = time; render(); },
    freeze(on, p) { _frozen = !!on; if (typeof p === 'number') pos = p; },
  };
  let _frozen = false;

  // ── init ────────────────────────────────────────────────────────────────
  applyTheme(); buildScene(); measureWF();
  resize();
  pos = scrollPos();
  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('tweakchange', (e) => window.Captiz.setOptions(e.detail));
  let prev = performance.now();
  function tick(now) {
    const dt = Math.min(0.05, (now - prev) / 1000); prev = now; t += dt;
    if (!_frozen) pos += (scrollPos() - pos) * (1 - Math.exp(-cfg.smoothK * dt));
    render();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
