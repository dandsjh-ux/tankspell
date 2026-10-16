// Procedural art: tanks, rocks, trees, grass. Everything is drawn with canvas paths — no image files.
(function () {
  'use strict';
  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function shade(hex, amt) {
    const [r, g, b] = hexToRgb(hex);
    const f = (c) => Math.max(0, Math.min(255, Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt)));
    return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
  }
  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // Body proportions per tank type (facing +x, centred on 0,0)
  const SHAPES = {
    scout:    { L: 40, W: 26, tread: 7,  tr: 9,  barrels: [[0, 24, 5]], turretShape: 'round', fins: true },
    striker:  { L: 46, W: 32, tread: 8,  tr: 12, barrels: [[0, 28, 7]], turretShape: 'round' },
    titan:    { L: 54, W: 42, tread: 11, tr: 15, barrels: [[-4.5, 30, 6], [4.5, 30, 6]], turretShape: 'square' },
    longshot: { L: 46, W: 30, tread: 8,  tr: 11, barrels: [[0, 46, 5]], turretShape: 'round', brake: true },
    lexicon:  { L: 46, W: 32, tread: 8,  tr: 12, barrels: [[0, 25, 7]], turretShape: 'hex', antenna: true }
  };

  function drawTank(ctx, type, color, a, ta, opts) {
    opts = opts || {};
    const S = SHAPES[type] || SHAPES.striker;
    const L = S.L, W = S.W, T = S.tread;
    const dark = shade(color, -0.45), mid = shade(color, -0.18), light = shade(color, 0.25);
    ctx.save();
    if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
    // shadow
    ctx.save();
    ctx.rotate(a);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    rrect(ctx, -L / 2 + 4, -W / 2 + 5, L, W, 8); ctx.fill();
    // treads
    const phase = (opts.tread || 0) % 6;
    for (const side of [-1, 1]) {
      const ty = side * (W / 2 - T / 2);
      ctx.fillStyle = '#1d1f1a';
      rrect(ctx, -L / 2 - 2, ty - T / 2, L + 4, T, 3); ctx.fill();
      ctx.strokeStyle = '#3d4036'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let x = -L / 2 + phase; x < L / 2 + 1; x += 6) { ctx.moveTo(x, ty - T / 2 + 1); ctx.lineTo(x, ty + T / 2 - 1); }
      ctx.stroke();
    }
    // hull
    const hw = W - T * 2 + 6;
    ctx.fillStyle = dark;
    rrect(ctx, -L / 2 + 1, -hw / 2 - 1, L - 2, hw + 2, 6); ctx.fill();
    const g = ctx.createLinearGradient(0, -hw / 2, 0, hw / 2);
    g.addColorStop(0, light); g.addColorStop(0.5, color); g.addColorStop(1, mid);
    ctx.fillStyle = g;
    rrect(ctx, -L / 2 + 3, -hw / 2 + 1, L - 6, hw - 2, 5); ctx.fill();
    // hull details
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L / 2 - 9, -hw / 2 + 3); ctx.lineTo(L / 2 - 9, hw / 2 - 3);
    ctx.moveTo(-L / 2 + 8, -hw / 2 + 3); ctx.lineTo(-L / 2 + 8, hw / 2 - 3); ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(-L / 2 + 3, -4, 4, 8); // exhaust
    if (S.fins) { ctx.fillStyle = dark; ctx.beginPath(); ctx.moveTo(-L / 2 + 2, -hw / 2); ctx.lineTo(-L / 2 - 6, -hw / 2 - 4); ctx.lineTo(-L / 2 + 8, -hw / 2); ctx.fill(); ctx.beginPath(); ctx.moveTo(-L / 2 + 2, hw / 2); ctx.lineTo(-L / 2 - 6, hw / 2 + 4); ctx.lineTo(-L / 2 + 8, hw / 2); ctx.fill(); }
    if (opts.teamColor) { ctx.fillStyle = opts.teamColor; ctx.fillRect(L / 2 - 8, -hw / 2 + 2, 4, hw - 4); }
    ctx.restore();

    // turret
    ctx.save();
    ctx.rotate(ta);
    for (const [oy, len, bw] of S.barrels) {
      ctx.fillStyle = dark;
      rrect(ctx, 0, oy - bw / 2 - 1, len + 1, bw + 2, 2); ctx.fill();
      ctx.fillStyle = mid;
      rrect(ctx, 0, oy - bw / 2, len, bw, 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(2, oy - bw / 2 + 1, len - 4, 1.5);
      if (S.brake) { ctx.fillStyle = dark; ctx.fillRect(len - 6, oy - bw / 2 - 2.5, 7, bw + 5); }
      else { ctx.fillStyle = dark; ctx.fillRect(len - 3, oy - bw / 2 - 1, 4, bw + 2); }
    }
    const r = S.tr;
    ctx.fillStyle = dark;
    if (S.turretShape === 'square') { rrect(ctx, -r - 1, -r - 1, r * 2 + 2, r * 2 + 2, 5); ctx.fill(); }
    else if (S.turretShape === 'hex') { hex(ctx, r + 1.5); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(0, 0, r + 1.5, 0, Math.PI * 2); ctx.fill(); }
    const tg = ctx.createRadialGradient(-r * 0.3, -r * 0.4, 1, 0, 0, r);
    tg.addColorStop(0, light); tg.addColorStop(1, color);
    ctx.fillStyle = tg;
    if (S.turretShape === 'square') { rrect(ctx, -r + 1, -r + 1, r * 2 - 2, r * 2 - 2, 4); ctx.fill(); }
    else if (S.turretShape === 'hex') { hex(ctx, r - 0.5); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(0, 0, r - 0.5, 0, Math.PI * 2); ctx.fill(); }
    // hatch
    ctx.fillStyle = mid; ctx.beginPath(); ctx.arc(-r * 0.3, 0, r * 0.38, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = dark; ctx.lineWidth = 1; ctx.stroke();
    if (S.antenna) {
      ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(-r * 0.5, r * 0.5); ctx.lineTo(-r * 1.6, r * 1.3); ctx.stroke();
      ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.arc(-r * 1.6, r * 1.3, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.rotate(Math.PI / 2); ctx.fillStyle = '#f3e6c2'; ctx.font = '800 9px Rubik, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('A', 0, -r * 0.3 + 0.5 - 0); ctx.restore();
    }
    ctx.restore();
    ctx.restore();
  }
  function hex(ctx, r) { ctx.beginPath(); for (let i = 0; i < 6; i++) { const an = i * Math.PI / 3 + Math.PI / 6; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(an) * r, Math.sin(an) * r); } ctx.closePath(); }

  // --- rocks: irregular polygons, cached as sprites
  const rockCache = new Map();
  function rockSprite(r, v) {
    const key = Math.round(r) + ':' + Math.round(v * 1000);
    let c = rockCache.get(key);
    if (c) return c;
    const pad = 10, size = Math.ceil(r * 2.3 + pad * 2);
    c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d');
    const rng = WT.mulberry32(Math.floor(v * 1e6) + 7);
    const cx = size / 2, cy = size / 2;
    const n = 9 + Math.floor(rng() * 4), pts = [];
    for (let i = 0; i < n; i++) { const an = (i / n) * Math.PI * 2 + rng() * 0.3; const rr = r * (0.95 + rng() * 0.28); pts.push([Math.cos(an) * rr, Math.sin(an) * rr]); }
    const path = () => { ctx.beginPath(); pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](cx + p[0], cy + p[1])); ctx.closePath(); };
    ctx.save(); ctx.translate(6, 8); ctx.fillStyle = 'rgba(0,0,0,0.3)'; path(); ctx.fill(); ctx.restore();
    const tone = 0.85 + rng() * 0.3;
    const base = [Math.round(122 * tone), Math.round(124 * tone), Math.round(118 * tone)];
    ctx.fillStyle = 'rgb(' + base.map((x) => x - 45).join(',') + ')'; path(); ctx.fill();
    ctx.save(); path(); ctx.clip();
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r * 1.2);
    g.addColorStop(0, 'rgb(' + base.map((x) => x + 45).join(',') + ')'); g.addColorStop(0.6, 'rgb(' + base.join(',') + ')'); g.addColorStop(1, 'rgb(' + base.map((x) => x - 35).join(',') + ')');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx - 2, cy - 3, r * 1.25, 0, Math.PI * 2); ctx.fill();
    // cracks and moss
    ctx.strokeStyle = 'rgba(40,40,36,0.45)'; ctx.lineWidth = 1.5;
    for (let k = 0; k < 2 + rng() * 2; k++) { ctx.beginPath(); let x = cx + (rng() - 0.5) * r, y = cy + (rng() - 0.5) * r; ctx.moveTo(x, y); for (let s = 0; s < 3; s++) { x += (rng() - 0.5) * r * 0.6; y += (rng() - 0.5) * r * 0.6; ctx.lineTo(x, y); } ctx.stroke(); }
    ctx.fillStyle = 'rgba(96,140,60,0.45)';
    for (let k = 0; k < 5; k++) { ctx.beginPath(); ctx.arc(cx + (rng() - 0.3) * r, cy + (rng() * 0.3 + 0.3) * r, r * (0.12 + rng() * 0.15), 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    rockCache.set(key, c);
    return c;
  }

  // --- trees: trunk drawn under tanks, canopy sprite drawn above
  const canopyCache = new Map();
  function canopySprite(r, v) {
    const key = Math.round(r) + ':' + Math.round(v * 1000);
    let c = canopyCache.get(key);
    if (c) return c;
    const R = r * 3.6, size = Math.ceil(R * 2.4 + 20);
    c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d');
    const rng = WT.mulberry32(Math.floor(v * 1e6) + 99);
    const cx = size / 2, cy = size / 2;
    const hue = 95 + rng() * 35, conifer = rng() < 0.3;
    const blobs = [];
    const n = conifer ? 1 : 6 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) { const an = rng() * Math.PI * 2, d = rng() * R * 0.45; blobs.push([cx + Math.cos(an) * d, cy + Math.sin(an) * d, R * (0.45 + rng() * 0.25)]); }
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    if (conifer) star(ctx, cx + 8, cy + 10, R * 0.95, R * 0.6, 9); else blobs.forEach((b) => { ctx.beginPath(); ctx.arc(b[0] + 8, b[1] + 10, b[2], 0, Math.PI * 2); ctx.fill(); });
    if (conifer) {
      for (let k = 0; k < 3; k++) {
        const rr = R * (0.95 - k * 0.25);
        ctx.fillStyle = 'hsl(' + (hue + 10) + ',42%,' + (18 + k * 7) + '%)';
        star(ctx, cx, cy, rr, rr * 0.62, 9 - k); ctx.fill();
      }
    } else {
      blobs.forEach((b) => { ctx.fillStyle = 'hsl(' + hue + ',45%,20%)'; ctx.beginPath(); ctx.arc(b[0], b[1], b[2], 0, Math.PI * 2); ctx.fill(); });
      blobs.forEach((b) => {
        const g = ctx.createRadialGradient(b[0] - b[2] * 0.35, b[1] - b[2] * 0.4, 2, b[0], b[1], b[2]);
        g.addColorStop(0, 'hsl(' + hue + ',50%,42%)'); g.addColorStop(1, 'hsl(' + hue + ',48%,25%)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b[0], b[1], b[2] * 0.9, 0, Math.PI * 2); ctx.fill();
      });
      ctx.fillStyle = 'hsla(' + (hue - 10) + ',60%,60%,0.25)';
      for (let k = 0; k < 14; k++) { const an = rng() * 6.28, d = rng() * R * 0.8; ctx.beginPath(); ctx.arc(cx + Math.cos(an) * d - 4, cy + Math.sin(an) * d - 4, 2 + rng() * 4, 0, Math.PI * 2); ctx.fill(); }
    }
    canopyCache.set(key, c);
    return c;
  }
  function star(ctx, cx, cy, ro, ri, n) { ctx.beginPath(); for (let i = 0; i < n * 2; i++) { const an = (i / (n * 2)) * Math.PI * 2; const rr = i % 2 ? ri : ro; ctx[i ? 'lineTo' : 'moveTo'](cx + Math.cos(an) * rr, cy + Math.sin(an) * rr); } ctx.closePath(); }

  // --- grass: tileable texture
  function grassTile(seed) {
    const size = 256;
    const c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d');
    const rng = WT.mulberry32(seed || 1);
    ctx.fillStyle = '#4f7d36'; ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 40; i++) {
      const x = rng() * size, y = rng() * size, r = 10 + rng() * 30;
      ctx.fillStyle = rng() < 0.5 ? 'rgba(70,115,45,0.35)' : 'rgba(90,140,58,0.3)';
      for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) { ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.lineWidth = 1.2; ctx.lineCap = 'round';
    for (let i = 0; i < 900; i++) {
      const x = rng() * size, y = rng() * size, l = 3 + rng() * 5, an = -Math.PI / 2 + (rng() - 0.5) * 0.9;
      const shadeV = rng();
      ctx.strokeStyle = shadeV < 0.33 ? 'rgba(40,78,28,0.55)' : shadeV < 0.66 ? 'rgba(112,160,70,0.5)' : 'rgba(138,182,84,0.4)';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(an) * l, y + Math.sin(an) * l); ctx.stroke();
    }
    return c;
  }

  window.ART = { drawTank, shade, rrect, rockSprite, canopySprite, grassTile, SHAPES };
})();
