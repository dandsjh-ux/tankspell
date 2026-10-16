// Word Tanks — in-game client: rendering, input (keyboard/mouse + touch), HUD, sound.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const angLerp = (a, b, t) => { let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI; return a + d * t; };
  const nowMs = () => performance.now();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const INTERP_MS = 110;

  let net = null;          // { send(obj) }
  let G = null;            // current game state
  let dict = null;         // Set of words for live preview (optional)
  let dictName = null;
  let muted = false;
  try { muted = localStorage.getItem('wt_muted') === '1'; } catch (e) { /* ignore */ }

  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const mini = $('minimap');
  const mctx = mini.getContext('2d');
  let W = 0, H = 0, DPR = 1, SCALE = 1;

  // ================================================================ sound
  const SFX = (function () {
    let ac = null, noiseBuf = null, master = null;
    function ensure() {
      if (ac) return true;
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        master = ac.createGain(); master.gain.value = 0.5; master.connect(ac.destination);
        noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.6, ac.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      } catch (e) { ac = null; }
      return !!ac;
    }
    function noise(dur, freq, vol, type) {
      if (muted || !ensure()) return;
      const s = ac.createBufferSource(); s.buffer = noiseBuf;
      const f = ac.createBiquadFilter(); f.type = type || 'lowpass'; f.frequency.value = freq;
      const g = ac.createGain(); const t = ac.currentTime;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur);
    }
    function tone(freq, dur, vol, type, slide) {
      if (muted || !ensure()) return;
      const o = ac.createOscillator(); o.type = type || 'sine';
      const g = ac.createGain(); const t = ac.currentTime;
      o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + dur);
    }
    return {
      unlock() { if (ensure() && ac.state === 'suspended') ac.resume(); },
      fire(v, big) { noise(big ? 0.35 : 0.18, big ? 900 : 1600, 0.35 * v); tone(big ? 90 : 160, 0.15, 0.25 * v, 'square', 40); },
      hit(v) { noise(0.12, 2500, 0.3 * v, 'bandpass'); tone(320, 0.08, 0.12 * v, 'square', 120); },
      boom(v) { noise(0.7, 500, 0.6 * v); tone(70, 0.5, 0.4 * v, 'sawtooth', 30); },
      pickup() { tone(880, 0.07, 0.12, 'triangle', 1320); },
      word(len) { const base = 440; [0, 4, 7, 12].slice(0, Math.min(4, len - 1)).forEach((s, i) => setTimeout(() => tone(base * Math.pow(2, s / 12), 0.18, 0.16, 'triangle'), i * 70)); },
      power() { tone(520, 0.25, 0.15, 'sine', 1040); },
      error() { tone(180, 0.18, 0.15, 'square', 120); },
      shield(v) { tone(1200, 0.12, 0.1 * v, 'sine', 600); }
    };
  })();

  // ================================================================ dictionary for live preview
  function loadDict(name) {
    if (dictName === name) return;
    dictName = name; dict = null;
    fetch('/words/' + name + '.txt').then((r) => r.text()).then((t) => { if (dictName === name) dict = new Set(t.split('\n')); }).catch(() => {});
  }

  // ================================================================ start / stop
  function start(msg, netApi) {
    net = netApi;
    const S = msg.settings;
    loadDict(S.dictionary || 'all');
    const obstacles = msg.obstacles.map((o, i) => ({ id: i, type: o[0], x: o[1], y: o[2], r: o[3], v: o[4] }));
    G = {
      me: msg.you, w: msg.w, h: msg.h, S, seed: msg.seed,
      obstacles, rocks: obstacles.filter((o) => o.type === 0), trees: obstacles.filter((o) => o.type === 1),
      grid: WT.buildGrid(obstacles, msg.w, msg.h),
      info: new Map(), players: new Map(), letters: new Map(), pups: new Map(), bullets: new Map(), mines: [],
      local: { x: 0, y: 0, a: 0, ta: 0, seq: -1, alive: false, tread: 0, lastSend: 0, lastTrack: [0, 0], speed: 0 },
      meState: null, cam: { x: msg.w / 2, y: msg.h / 2, shake: 0 },
      particles: [], tracks: [], floats: [], feed: [],
      timeLeft: msg.timeLeft, teamScore: msg.teamScore || [0, 0],
      builder: [], spell: false, firing: false, nextFire: 0, lastKiller: null,
      hudCache: {}, newTiles: 0, lastMini: 0, over: false, started: nowMs()
    };
    msg.players.forEach((p) => G.info.set(p.id, p));
    msg.letters.forEach((l) => G.letters.set(l[0], { id: l[0], x: l[1], y: l[2], c: l[3], born: 0 }));
    msg.pups.forEach((p) => G.pups.set(p[0], { id: p[0], x: p[1], y: p[2], k: p[3] }));
    G.grass = ctx.createPattern(ART.grassTile(msg.seed), 'repeat');
    buildDecor();
    buildMiniBase();
    resize();
    input.reset();
    $('scoreboard').classList.add('hidden');
    $('deathOverlay').classList.add('hidden');
    $('feed').innerHTML = '';
    renderTray(true);
    if (!G.raf) loop();
  }
  function stop() { if (G) { G.stopped = true; cancelAnimationFrame(G.raf); } G = null; input.reset(); }
  function setOver() { if (G) { G.over = true; G.firing = false; } }

  // decorative ground patches & flowers (seeded, deterministic)
  function buildDecor() {
    const rng = WT.mulberry32(G.seed ^ 0x5bd1e995);
    const area = G.w * G.h;
    G.patches = [];
    for (let i = 0; i < area / 55000; i++) {
      const t = rng();
      G.patches.push({ x: rng() * G.w, y: rng() * G.h, rx: 60 + rng() * 220, ry: 40 + rng() * 140, rot: rng() * Math.PI, c: t < 0.45 ? 'rgba(38,70,24,0.22)' : t < 0.85 ? 'rgba(130,170,70,0.16)' : 'rgba(150,130,80,0.18)' });
    }
    G.flowers = [];
    for (let i = 0; i < area / 9000; i++) {
      const cx = rng() * G.w, cy = rng() * G.h, col = ['#f5e663', '#ffffff', '#e98ad6', '#9bc4ff', '#ffb35c'][Math.floor(rng() * 5)];
      const n = 2 + Math.floor(rng() * 5);
      for (let k = 0; k < n; k++) G.flowers.push({ x: cx + (rng() - 0.5) * 40, y: cy + (rng() - 0.5) * 40, c: col, r: 1.6 + rng() * 1.6 });
    }
  }
  function buildMiniBase() {
    const c = document.createElement('canvas'); c.width = c.height = 180;
    const m = c.getContext('2d'); const k = 180 / G.w;
    m.fillStyle = '#3d6a2c'; m.fillRect(0, 0, 180, 180);
    m.fillStyle = 'rgba(25,55,18,0.9)'; G.trees.forEach((o) => { m.beginPath(); m.arc(o.x * k, o.y * k, Math.max(1.2, o.r * 3 * k), 0, TAU); m.fill(); });
    m.fillStyle = '#9a9c94'; G.rocks.forEach((o) => { m.beginPath(); m.arc(o.x * k, o.y * k, Math.max(1, o.r * k), 0, TAU); m.fill(); });
    G.miniBase = c;
  }

  // ================================================================ network events
  function snapshot(m) {
    if (!G) return;
    const t = nowMs();
    // events first (join adds player info)
    for (const e of m.ev) handleEvent(e);
    const seen = new Set();
    for (const r of m.p) {
      const id = r[0]; seen.add(id);
      let p = G.players.get(id);
      if (!p) { p = { id, buf: [], x: r[1], y: r[2], a: r[3], ta: r[4], tread: 0, lastTrack: [r[1], r[2]] }; G.players.set(id, p); }
      p.hp = r[5]; p.flags = r[6]; p.kills = r[7]; p.deaths = r[8]; p.hidden = false;
      const prev = p.buf[p.buf.length - 1];
      if (prev && (Math.abs(prev.x - r[1]) > 300 || Math.abs(prev.y - r[2]) > 300)) p.buf.length = 0; // teleport/respawn
      p.buf.push({ t, x: r[1], y: r[2], a: r[3], ta: r[4] });
      if (p.buf.length > 12) p.buf.shift();
    }
    for (const p of G.players.values()) if (!seen.has(p.id)) p.hidden = true;

    // letters & power-ups
    for (const l of m.lA) G.letters.set(l[0], { id: l[0], x: l[1], y: l[2], c: l[3], born: t });
    for (const [id, by] of m.lR) {
      const l = G.letters.get(id);
      if (l) {
        G.letters.delete(id);
        const target = by === G.me ? G.local : G.players.get(by);
        if (target) G.particles.push({ type: 'fly', x: l.x, y: l.y, c: l.c, tgt: by, life: 0.35, max: 0.35 });
        if (by === G.me) { SFX.pickup(); G.newTiles++; }
      }
    }
    for (const u of m.pA) G.pups.set(u[0], { id: u[0], x: u[1], y: u[2], k: u[3] });
    for (const [id, by] of m.pR) { const u = G.pups.get(id); G.pups.delete(id); if (u && by === G.me) { SFX.power(); floatText(G.local.x, G.local.y - 40, WT.POWERUPS[u.k].icon + ' ' + WT.POWERUPS[u.k].name, '#fff', 1.4); } }

    // bullets
    const nb = new Map();
    for (const b of m.b) {
      const old = G.bullets.get(b[0]);
      nb.set(b[0], { id: b[0], x: b[1], y: b[2], vx: b[3], vy: b[4], r: b[5], d: b[6], t, trail: old ? old.trail : 0 });
    }
    G.bullets = nb;
    G.mines = m.m;
    G.timeLeft = m.tl; G.teamScore = m.ts;

    // own state
    const me = m.me, L = G.local;
    const wasAlive = G.meState ? G.meState.alive : false;
    G.meState = me;
    if (me.seq !== L.seq) { L.seq = me.seq; L.x = me.x; L.y = me.y; L.alive = me.alive; G.cam.x = L.x; G.cam.y = L.y; }
    if (me.fix) { L.x = me.fix[0]; L.y = me.fix[1]; }
    L.alive = me.alive;
    if (wasAlive && !me.alive) { G.firing = false; G.builder = []; G.spell = false; }
    validateBuilder();
    renderTray();
  }

  function playerName(id) { const i = G.info.get(id); return i ? i.name : '?'; }
  function posOf(id) { if (id === G.me) return G.local; return G.players.get(id); }
  function audible(x, y) { const L = G.local; const d = Math.hypot(x - L.x, y - L.y); return d > 1600 ? 0 : 1 - d / 1700; }

  function handleEvent(e) {
    switch (e.k) {
      case 'join': G.info.set(e.p.id, e.p); if (e.p.id !== G.me) feed('<b>' + esc(e.p.name) + '</b> rolled in'); break;
      case 'leave': feed(esc(playerName(e.id)) + ' left the battle'); G.info.delete(e.id); G.players.delete(e.id); break;
      case 'fire': {
        const p = posOf(e.id); if (!p) break;
        const info = G.info.get(e.id); const S = ART.SHAPES[info ? info.tank : 'striker'];
        const len = S.barrels[0][1] + 4, ta = e.id === G.me ? G.local.ta : p.ta;
        const fx = p.x + Math.cos(ta) * len, fy = p.y + Math.sin(ta) * len;
        G.particles.push({ type: 'flash', x: fx, y: fy, a: ta, life: 0.08, max: 0.08, s: 0.6 + Math.min(1.5, e.d / 40) });
        for (let i = 0; i < 4; i++) G.particles.push({ type: 'smoke', x: fx, y: fy, vx: Math.cos(ta) * 40 + (Math.random() - 0.5) * 40, vy: Math.sin(ta) * 40 + (Math.random() - 0.5) * 40, life: 0.6, max: 0.6, s: 5 + Math.random() * 5 });
        const v = audible(fx, fy); if (v > 0) SFX.fire(v, e.d >= 30);
        if (e.id === G.me) G.cam.shake = Math.max(G.cam.shake, Math.min(6, 1 + e.d / 25));
        break;
      }
      case 'hit': {
        sparks(e.x, e.y, Math.min(24, 6 + e.d / 3), '#ffd27a');
        const col = e.id === G.me ? '#ff6b5a' : e.by === G.me ? '#ffe36b' : '#ffffff';
        floatText(e.x, e.y - 20, '-' + e.d, col, 0.9 + Math.min(1.4, e.d / 60));
        const v = audible(e.x, e.y); if (v > 0) SFX.hit(v);
        if (e.id === G.me) G.cam.shake = Math.max(G.cam.shake, Math.min(16, 4 + e.d / 6));
        break;
      }
      case 'shieldHit': ring(e.x, e.y, 30, '#7cc8ff'); SFX.shield(audible(e.x, e.y)); break;
      case 'impact': sparks(e.x, e.y, 6, '#d8d2b8'); dust(e.x, e.y, 3); break;
      case 'fizzle': dust(e.x, e.y, 2); break;
      case 'boom': explosion(e.x, e.y, 1.2); break;
      case 'kill': {
        explosion(e.x, e.y, 1.6);
        const killer = e.by ? esc(playerName(e.by)) : 'the field';
        const how = e.how ? ' <span style="opacity:.75">(' + esc(e.how) + ')</span>' : '';
        feed('<b>' + killer + '</b> ✹ ' + esc(playerName(e.id)) + how);
        if (e.id === G.me) G.lastKiller = e.by && e.by !== G.me ? playerName(e.by) : null;
        if (e.by === G.me && e.id !== G.me) floatText(G.local.x, G.local.y - 50, 'TANK DESTROYED!', '#ffcc5c', 1.8);
        break;
      }
      case 'word': {
        const p = posOf(e.id);
        if (p) floatText(p.x, p.y - 46, e.w + '  ' + e.n + '×' + e.d, e.id === G.me ? '#b9f2a9' : '#f3e6c2', 1.2 + Math.min(1.5, e.w.length / 6));
        if (e.w.length >= 6 || e.id !== G.me) feed('<b>' + esc(playerName(e.id)) + '</b> spelled <b>' + esc(e.w) + '</b> · ' + e.n + '×' + e.d);
        break;
      }
      case 'use': if (e.id === G.me) SFX.power(); if (e.p === 'shield') { const p = posOf(e.id); if (p) ring(p.x, p.y, 40, '#7cc8ff'); } break;
    }
  }
  function wordResult(m) {
    if (!G) return;
    if (m.ok) {
      G.builder = []; SFX.word(m.w.length);
      setWordInfo('Loaded ' + m.n + ' shell' + (m.n > 1 ? 's' : '') + ' of ' + m.d + ' damage!', 'ok', 1800);
    } else {
      SFX.error(); setWordInfo(m.reason, 'bad', 2200);
      const wl = $('wordLine'); wl.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], { duration: 250 });
    }
    renderTray(true);
  }

  // ================================================================ particles
  function sparks(x, y, n, col) { for (let i = 0; i < n; i++) { const a = Math.random() * TAU, s = 80 + Math.random() * 260; G.particles.push({ type: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.25 + Math.random() * 0.25, max: 0.5, c: col }); } }
  function dust(x, y, n) { for (let i = 0; i < n; i++) G.particles.push({ type: 'smoke', x, y, vx: (Math.random() - 0.5) * 50, vy: (Math.random() - 0.5) * 50, life: 0.5, max: 0.5, s: 4 + Math.random() * 4, c: 'rgba(200,190,150,' }); }
  function ring(x, y, r, c) { G.particles.push({ type: 'ring', x, y, r, c, life: 0.4, max: 0.4 }); }
  function explosion(x, y, k) {
    G.particles.push({ type: 'flashBig', x, y, life: 0.15, max: 0.15, s: k });
    ring(x, y, 90 * k, '#ffb14a');
    for (let i = 0; i < 26 * k; i++) { const a = Math.random() * TAU, s = 60 + Math.random() * 300 * k; G.particles.push({ type: 'fire', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + Math.random() * 0.4, max: 0.8, s: 6 + Math.random() * 10 * k }); }
    for (let i = 0; i < 14 * k; i++) { const a = Math.random() * TAU, s = 20 + Math.random() * 80; G.particles.push({ type: 'smoke', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1.2 + Math.random(), max: 2.2, s: 10 + Math.random() * 16 }); }
    for (let i = 0; i < 10 * k; i++) { const a = Math.random() * TAU, s = 150 + Math.random() * 250; G.particles.push({ type: 'debris', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.7 + Math.random() * 0.4, max: 1.1, rot: Math.random() * TAU }); }
    G.tracks.push({ scorch: true, x, y, r: 40 * k, life: 14, max: 14 });
    const v = audible(x, y); if (v > 0) SFX.boom(v);
    if (Math.hypot(x - G.local.x, y - G.local.y) < 500) G.cam.shake = Math.max(G.cam.shake, 12);
  }
  function floatText(x, y, text, color, size) { G.floats.push({ x, y, text, color, size: size || 1, life: 1.3, max: 1.3 }); }

  // ================================================================ input
  const input = {
    keys: new Set(), mouse: { x: 0, y: 0, in: false }, moveTouch: null, aimTouch: null,
    stickL: { x: 0, y: 0 }, aimAngle: null, touchMode: false,
    reset() { this.keys.clear(); this.moveTouch = this.aimTouch = null; this.stickL.x = this.stickL.y = 0; $('stickL').classList.remove('show'); $('stickR').classList.remove('show'); }
  };
  const isTyping = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA'); };
  window.addEventListener('keydown', (e) => {
    if (!G || isTyping() || !$('modal').classList.contains('hidden')) return;
    SFX.unlock();
    const k = e.key;
    if (k === 'Tab') { e.preventDefault(); $('scoreboard').classList.remove('hidden'); renderScoreboard(); return; }
    if (k === 'Enter') { e.preventDefault(); if (G.spell) { if (G.builder.length) submitWord(); G.spell = false; } else G.spell = true; renderTray(true); return; }
    if (k === 'Escape') { G.builder = []; G.spell = false; renderTray(true); return; }
    if (/^[1-5]$/.test(k)) { useSlot(Number(k) - 1); return; }
    if (G.spell) {
      if (k === 'Backspace') { e.preventDefault(); G.builder.pop(); renderTray(true); return; }
      if (/^[a-zA-Z]$/.test(k)) { typeLetter(k.toUpperCase()); e.preventDefault(); return; }
    }
    if (k === ' ') { e.preventDefault(); G.firing = true; }
    input.keys.add(k.toLowerCase());
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key;
    if (k === 'Tab') { $('scoreboard').classList.add('hidden'); return; }
    if (k === ' ' && G) G.firing = false;
    input.keys.delete(k.toLowerCase());
  });
  window.addEventListener('blur', () => { input.keys.clear(); if (G) G.firing = false; });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (!G) return;
    SFX.unlock();
    if (e.pointerType === 'mouse') {
      input.touchMode = false; document.body.classList.remove('touch');
      if (e.button === 0) G.firing = true;
      return;
    }
    input.touchMode = true; document.body.classList.add('touch');
    canvas.setPointerCapture(e.pointerId);
    if (e.clientX < W * 0.45 && !input.moveTouch) {
      input.moveTouch = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
      showStick('stickL', e.clientX, e.clientY, 0, 0);
    } else if (!input.aimTouch) {
      input.aimTouch = { id: e.pointerId, ox: e.clientX, oy: e.clientY, t: nowMs(), dragged: false };
      showStick('stickR', e.clientX, e.clientY, 0, 0);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!G) return;
    if (e.pointerType === 'mouse') { input.mouse.x = e.clientX; input.mouse.y = e.clientY; input.mouse.in = true; return; }
    const R = W < 700 ? 50 : 60;
    if (input.moveTouch && e.pointerId === input.moveTouch.id) {
      let dx = e.clientX - input.moveTouch.ox, dy = e.clientY - input.moveTouch.oy;
      const d = Math.hypot(dx, dy); if (d > R) { dx *= R / d; dy *= R / d; }
      input.stickL.x = dx / R; input.stickL.y = dy / R;
      showStick('stickL', input.moveTouch.ox, input.moveTouch.oy, dx, dy);
    } else if (input.aimTouch && e.pointerId === input.aimTouch.id) {
      let dx = e.clientX - input.aimTouch.ox, dy = e.clientY - input.aimTouch.oy;
      const d = Math.hypot(dx, dy);
      if (d > 14) { input.aimAngle = Math.atan2(dy, dx); input.aimTouch.dragged = true; G.firing = d > 26; }
      if (d > R) { dx *= R / d; dy *= R / d; }
      showStick('stickR', input.aimTouch.ox, input.aimTouch.oy, dx, dy);
    }
  });
  function endPointer(e) {
    if (!G) return;
    if (e.pointerType === 'mouse') { if (e.button === 0) G.firing = false; return; }
    if (input.moveTouch && e.pointerId === input.moveTouch.id) { input.moveTouch = null; input.stickL.x = input.stickL.y = 0; $('stickL').classList.remove('show'); }
    if (input.aimTouch && e.pointerId === input.aimTouch.id) {
      if (!input.aimTouch.dragged && nowMs() - input.aimTouch.t < 300) tryFire(true); // quick tap = single shot
      input.aimTouch = null; G.firing = false; $('stickR').classList.remove('show');
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  window.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse' && G && e.button === 0) G.firing = false; });
  function showStick(id, x, y, dx, dy) {
    const el = $(id); el.classList.add('show'); el.style.left = x + 'px'; el.style.top = y + 'px';
    el.firstElementChild.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  }

  // HUD buttons
  $('btnSubmit').addEventListener('click', () => { submitWord(); });
  $('btnClear').addEventListener('click', () => { if (G) { G.builder = []; G.spell = false; renderTray(true); } });
  $('btnScores').addEventListener('click', () => { const sb = $('scoreboard'); sb.classList.toggle('hidden'); if (!sb.classList.contains('hidden')) renderScoreboard(); });
  $('scoreboard').addEventListener('click', () => $('scoreboard').classList.add('hidden'));
  $('btnMute').addEventListener('click', () => { muted = !muted; try { localStorage.setItem('wt_muted', muted ? '1' : '0'); } catch (e) { /* ignore */ } $('btnMute').textContent = muted ? '🔇' : '🔊'; });
  $('btnMute').textContent = muted ? '🔇' : '🔊';

  // ================================================================ words / tray
  function validateBuilder() {
    if (!G || !G.meState) return;
    const tray = G.meState.tray;
    if (G.builder.some((b) => tray[b.i] !== b.src)) G.builder = [];
  }
  function typeLetter(ch) {
    const tray = G.meState ? G.meState.tray : [];
    const used = new Set(G.builder.map((b) => b.i));
    let i = tray.findIndex((c, j) => c === ch && !used.has(j));
    if (i < 0) i = tray.findIndex((c, j) => c === '?' && !used.has(j));
    if (i < 0) { SFX.error(); setWordInfo('No "' + ch + '" in your tray', 'bad', 1200); return; }
    G.builder.push({ i, ch, src: tray[i] });
    renderTray(true);
  }
  function addTile(i) {
    const tray = G.meState.tray;
    if (G.builder.some((b) => b.i === i)) { G.builder = G.builder.filter((b) => b.i !== i); renderTray(true); return; }
    if (tray[i] === '?') { pickWildLetter((ch) => { G.builder.push({ i, ch, src: '?' }); renderTray(true); }); return; }
    G.builder.push({ i, ch: tray[i], src: tray[i] });
    renderTray(true);
  }
  function dropTile(i) {
    if (!G || !G.meState || !G.meState.alive) return;
    G.builder = G.builder.filter((b) => b.i !== i).map((b) => (b.i > i ? Object.assign({}, b, { i: b.i - 1 }) : b));
    G.meState.tray.splice(i, 1);
    net.send({ t: 'drop', i });
    renderTray(true);
  }
  function submitWord() {
    if (!G || !G.builder.length) return;
    const w = G.builder.map((b) => b.ch).join('');
    if (w.length < G.S.minWordLength) { SFX.error(); setWordInfo('Need at least ' + G.S.minWordLength + ' letters', 'bad', 1500); return; }
    net.send({ t: 'word', w, idx: G.builder.map((b) => b.i) });
  }
  function useSlot(i) { if (G && G.meState && i < G.meState.inv.length) net.send({ t: 'use', i }); }
  let wordInfoUntil = 0;
  function setWordInfo(text, cls, ms) { const el = $('wordInfo'); el.textContent = text; el.className = 'word-info ' + (cls || ''); wordInfoUntil = ms ? nowMs() + ms : 0; }

  function pickWildLetter(cb) {
    const card = $('modalCard');
    card.innerHTML = '<h2>Wildcard tile</h2><p class="muted">Choose the letter this blank tile becomes.</p><div class="letter-grid"></div><div class="modal-actions"><button class="btn ghost">Cancel</button></div>';
    const grid = card.querySelector('.letter-grid');
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((ch) => {
      const t = document.createElement('div'); t.className = 'tile'; t.textContent = ch;
      t.onclick = () => { $('modal').classList.add('hidden'); cb(ch); };
      grid.appendChild(t);
    });
    card.querySelector('.btn').onclick = () => $('modal').classList.add('hidden');
    $('modal').classList.remove('hidden');
  }

  let lastTrayKey = '';
  function renderTray(force) {
    if (!G || !G.meState) return;
    const me = G.meState;
    const key = JSON.stringify([me.tray, me.cap, G.builder.map((b) => b.i + b.ch), me.ammo, me.inv, me.slots, G.spell, me.alive]);
    if (!force && key === lastTrayKey) return;
    lastTrayKey = key;
    const used = new Set(G.builder.map((b) => b.i));
    // tray
    const tray = $('tray'); tray.innerHTML = '';
    const newFrom = me.tray.length - G.newTiles;
    me.tray.forEach((c, i) => {
      const t = document.createElement('div');
      t.className = 'tile' + (c === '?' ? ' wild' : '') + (used.has(i) ? ' used' : '') + (i >= newFrom && G.newTiles ? ' new' : '');
      t.textContent = c;
      attachTileHandlers(t, i);
      tray.appendChild(t);
    });
    G.newTiles = 0;
    for (let i = me.tray.length; i < me.cap; i++) { const t = document.createElement('div'); t.className = 'tile empty'; tray.appendChild(t); }
    // word line
    const wl = $('wordLine'); wl.innerHTML = '';
    const word = G.builder.map((b) => b.ch).join('');
    if (!G.builder.length) {
      wl.innerHTML = '<span class="hint">' + (input.touchMode ? 'Tap tiles to spell a word' : (G.spell ? 'Type a word…' : 'Click tiles or press Enter to type')) + '</span>';
      wl.className = 'word-line';
    } else {
      G.builder.forEach((b, k) => {
        const t = document.createElement('div'); t.className = 'tile' + (b.src === '?' ? ' wild' : ''); t.textContent = b.ch;
        t.onclick = () => { G.builder.splice(k, 1); renderTray(true); };
        wl.appendChild(t);
      });
      const okLen = word.length >= G.S.minWordLength;
      const isWord = dict ? dict.has(word.toLowerCase()) : null;
      wl.className = 'word-line' + (okLen && isWord === true ? ' valid' : okLen && isWord === false ? ' invalid' : '');
      if (nowMs() > wordInfoUntil) {
        if (!okLen) setWordInfo(word.length + ' letters — need ' + G.S.minWordLength + '+', '');
        else if (isWord === false) setWordInfo('Not in the dictionary yet…', 'bad');
        else setWordInfo(word.length + ' letters → ' + G.S.shellsPerWord + ' × ' + WT.damageFor(word.length, G.S) + ' damage', 'ok');
      }
    }
    if (!G.builder.length && nowMs() > wordInfoUntil) setWordInfo('', '');
    $('spellBadge').classList.toggle('hidden', !G.spell);
    // ammo
    const ab = $('ammoBar'); ab.innerHTML = '';
    if (!me.ammo.length) {
      const c = document.createElement('div'); c.className = 'ammo-chip basic';
      c.innerHTML = G.S.basicCannon > 0 ? '🔩 Basic cannon · <span class="dmg">' + G.S.basicCannon + ' dmg</span>' : '⚠️ No shells — spell a word!';
      ab.appendChild(c);
    } else {
      for (let i = me.ammo.length - 1; i >= 0; i--) {
        const [w, d, n] = me.ammo[i];
        const c = document.createElement('div'); c.className = 'ammo-chip' + (i === me.ammo.length - 1 ? ' loaded' : '');
        c.innerHTML = esc(w) + ' <span class="dmg">' + d + '</span><span class="n">×' + n + '</span>';
        c.title = i === me.ammo.length - 1 ? 'Loaded' : 'Tap to load';
        c.onclick = () => net.send({ t: 'ammo', i });
        ab.appendChild(c);
      }
    }
    // inventory
    const inv = $('inv'); inv.innerHTML = '';
    for (let i = 0; i < me.slots; i++) {
      const k = me.inv[i];
      const s = document.createElement('div'); s.className = 'inv-slot' + (k ? ' full' : '');
      s.innerHTML = (input.touchMode ? '' : '<kbd>' + (i + 1) + '</kbd>') + (k ? WT.POWERUPS[k].icon : '');
      if (k) { s.title = WT.POWERUPS[k].name + ' — ' + WT.POWERUPS[k].desc; s.onclick = () => useSlot(i); }
      inv.appendChild(s);
    }
  }
  // Tile press state lives outside the DOM element because the tray may re-render mid-press.
  let tilePress = null;
  function attachTileHandlers(el, i) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); SFX.unlock();
      if (e.button === 2 || !G || !G.meState) return;
      if (e.pointerType === 'mouse') { addTile(i); return; } // mouse: instant click, right-click drops
      const src = G.meState.tray[i];
      if (tilePress) clearTimeout(tilePress.timer);
      tilePress = { i, src, pid: e.pointerId, timer: setTimeout(() => {
        if (tilePress && G && G.meState && G.meState.tray[i] === src) { el.classList.add('dropping'); dropTile(i); }
        tilePress = null;
      }, 550) };
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); dropTile(i); });
  }
  window.addEventListener('pointerup', (e) => {
    if (!tilePress || e.pointerType === 'mouse' || e.pointerId !== tilePress.pid) return;
    const { i, src, timer } = tilePress;
    clearTimeout(timer); tilePress = null;
    if (G && G.meState && G.meState.tray[i] === src) addTile(i);
  });
  window.addEventListener('pointercancel', () => { if (tilePress) { clearTimeout(tilePress.timer); tilePress = null; } });

  function tryFire(force) {
    if (!G || !G.meState || !G.meState.alive || G.over) return;
    const t = nowMs();
    if (t < G.nextFire) return;
    const me = G.meState;
    if (!me.ammo.length && !(G.S.basicCannon > 0)) { if (force || t - (G.lastNoAmmo || 0) > 1500) { G.lastNoAmmo = t; setWordInfo('No shells! Spell a word to load ammo.', 'bad', 1500); SFX.error(); } return; }
    const T = WT.TANKS[G.info.get(G.me).tank];
    const reload = T.reload * G.S.reloadMult * (me.fx.rapid ? 0.45 : 1);
    G.nextFire = t + reload * 1000;
    net.send({ t: 'fire', ta: Math.round(G.local.ta * 1000) / 1000 });
  }

  // ================================================================ main loop
  let lastFrame = nowMs();
  function loop() {
    if (!G || G.stopped) return;
    G.raf = requestAnimationFrame(loop);
    const t = nowMs();
    const dt = Math.min(0.05, (t - lastFrame) / 1000);
    lastFrame = t;
    update(dt, t);
    render(t, dt);
    hud(t);
  }

  function update(dt, t) {
    const L = G.local, me = G.meState;
    const info = G.info.get(G.me);
    if (!me || !info) return;
    const T = WT.TANKS[info.tank];
    // movement input
    let mx = 0, my = 0;
    const k = input.keys;
    if (!G.over) {
      if (G.spell) { if (k.has('arrowup')) my -= 1; if (k.has('arrowdown')) my += 1; if (k.has('arrowleft')) mx -= 1; if (k.has('arrowright')) mx += 1; }
      else {
        if (k.has('w') || k.has('arrowup')) my -= 1; if (k.has('s') || k.has('arrowdown')) my += 1;
        if (k.has('a') || k.has('arrowleft')) mx -= 1; if (k.has('d') || k.has('arrowright')) mx += 1;
      }
      if (input.moveTouch) { mx = input.stickL.x; my = input.stickL.y; }
    }
    let mag = Math.hypot(mx, my);
    if (mag > 1) { mx /= mag; my /= mag; mag = 1; }
    if (L.alive && !G.over) {
      const speed = T.speed * G.S.speedMult * (me.fx.speed ? 1.55 : 1);
      if (mag > 0.08) {
        const want = Math.atan2(my, mx);
        L.a = angLerp(L.a, want, Math.min(1, dt * 10));
        const ox = L.x, oy = L.y;
        const r = WT.resolve(G.grid, L.x + mx * speed * dt, L.y + my * speed * dt, T.radius);
        L.x = r[0]; L.y = r[1];
        const moved = Math.hypot(L.x - ox, L.y - oy);
        L.tread += moved * 0.5; L.speed = moved / dt;
        if (moved > 0 && Math.random() < 0.25) G.particles.push({ type: 'smoke', x: L.x - Math.cos(L.a) * T.radius, y: L.y - Math.sin(L.a) * T.radius, vx: (Math.random() - 0.5) * 20, vy: (Math.random() - 0.5) * 20, life: 0.6, max: 0.6, s: 4 + Math.random() * 3, c: 'rgba(170,160,120,' });
        if (me.fx.speed && Math.random() < 0.6) G.particles.push({ type: 'spark', x: L.x - Math.cos(L.a) * T.radius, y: L.y - Math.sin(L.a) * T.radius, vx: -mx * 100 + (Math.random() - 0.5) * 60, vy: -my * 100 + (Math.random() - 0.5) * 60, life: 0.3, max: 0.3, c: '#ffd23f' });
      } else L.speed = 0;
      // aim
      if (input.touchMode) { if (input.aimAngle != null) L.ta = input.aimAngle; else if (mag > 0.08) L.ta = angLerp(L.ta, L.a, Math.min(1, dt * 6)); }
      else if (input.mouse.in) { const wx = G.cam.x + (input.mouse.x - W / 2) / SCALE, wy = G.cam.y + (input.mouse.y - H / 2) / SCALE; L.ta = Math.atan2(wy - L.y, wx - L.x); }
      if (G.firing) tryFire(false);
      if (t - L.lastSend > 50) { L.lastSend = t; net.send({ t: 'st', seq: L.seq, x: Math.round(L.x * 10) / 10, y: Math.round(L.y * 10) / 10, a: Math.round(L.a * 100) / 100, ta: Math.round(L.ta * 100) / 100 }); }
    }
    // remote interpolation
    const rt = t - INTERP_MS;
    for (const p of G.players.values()) {
      if (p.id === G.me) continue;
      const b = p.buf;
      if (!b.length) continue;
      let i = b.length - 1;
      while (i > 0 && b[i - 1].t > rt) i--;
      const B = b[i], A = b[i - 1] || B;
      const span = B.t - A.t;
      const f = span > 0 ? clamp((rt - A.t) / span, 0, 1) : 1;
      const ox = p.x, oy = p.y;
      p.x = lerp(A.x, B.x, f); p.y = lerp(A.y, B.y, f); p.a = angLerp(A.a, B.a, f); p.ta = angLerp(A.ta, B.ta, f);
      const mv = Math.hypot(p.x - ox, p.y - oy); p.tread += mv * 0.5;
      trackFor(p, mv);
    }
    if (L.alive) trackFor(L, 1);
    // camera
    let tx = L.x, ty = L.y;
    if (!input.touchMode && input.mouse.in && L.alive) { tx += clamp((input.mouse.x - W / 2) / SCALE * 0.18, -160, 160); ty += clamp((input.mouse.y - H / 2) / SCALE * 0.18, -120, 120); }
    G.cam.x = lerp(G.cam.x, tx, Math.min(1, dt * 6)); G.cam.y = lerp(G.cam.y, ty, Math.min(1, dt * 6));
    G.cam.shake = Math.max(0, G.cam.shake - dt * 40);
    // particles
    for (const p of G.particles) {
      p.life -= dt;
      if (p.type === 'fly') { const tg = posOf(p.tgt); if (tg) { const f = 1 - p.life / p.max; p.x = lerp(p.x, tg.x, f * 0.5); p.y = lerp(p.y, tg.y, f * 0.5); } continue; }
      if (p.vx !== undefined) { p.x += p.vx * dt; p.y += p.vy * dt; const drag = p.type === 'smoke' ? 0.9 : 0.94; p.vx *= Math.pow(drag, dt * 60); p.vy *= Math.pow(drag, dt * 60); }
    }
    G.particles = G.particles.filter((p) => p.life > 0);
    if (G.particles.length > 900) G.particles.splice(0, G.particles.length - 900);
    for (const f of G.floats) { f.life -= dt; f.y -= 30 * dt; }
    G.floats = G.floats.filter((f) => f.life > 0);
    for (const tr of G.tracks) tr.life -= dt;
    if (G.tracks.length && G.tracks[0].life <= 0) G.tracks = G.tracks.filter((x) => x.life > 0);
    if (G.tracks.length > 900) G.tracks.splice(0, G.tracks.length - 900);
  }
  function trackFor(p, mv) {
    if (!mv) return;
    const lt = p.lastTrack || (p.lastTrack = [p.x, p.y]);
    if (Math.hypot(p.x - lt[0], p.y - lt[1]) > 14) { G.tracks.push({ x: p.x, y: p.y, a: p.a, life: 6, max: 6 }); lt[0] = p.x; lt[1] = p.y; }
  }

  // ================================================================ rendering
  const letterSprites = {};
  function letterSprite(c) {
    if (letterSprites[c]) return letterSprites[c];
    const s = document.createElement('canvas'); s.width = s.height = 44;
    const x = s.getContext('2d');
    x.fillStyle = 'rgba(0,0,0,0.3)'; ART.rrect(x, 7, 9, 32, 32, 6); x.fill();
    x.fillStyle = c === '?' ? '#d7dce6' : '#b99a5e'; ART.rrect(x, 5, 6, 32, 33, 6); x.fill();
    const g = x.createLinearGradient(0, 5, 0, 37); g.addColorStop(0, c === '?' ? '#ffffff' : '#fdf3d6'); g.addColorStop(1, c === '?' ? '#e6ebf3' : '#efdfb4');
    x.fillStyle = g; ART.rrect(x, 5, 5, 32, 30, 6); x.fill();
    x.fillStyle = c === '?' ? '#6a40c4' : '#2b2216'; x.font = '800 21px Rubik, system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(c, 21, 21.5);
    letterSprites[c] = s;
    return s;
  }
  const pupSprites = {};
  function pupSprite(k) {
    if (pupSprites[k]) return pupSprites[k];
    const s = document.createElement('canvas'); s.width = s.height = 64;
    const x = s.getContext('2d'); const P = WT.POWERUPS[k];
    const g = x.createRadialGradient(32, 32, 4, 32, 32, 30); g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.5, P.color); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.beginPath(); x.arc(32, 32, 30, 0, TAU); x.fill();
    x.fillStyle = 'rgba(20,28,18,0.85)'; x.beginPath(); x.arc(32, 32, 18, 0, TAU); x.fill();
    x.strokeStyle = P.color; x.lineWidth = 3; x.stroke();
    x.font = '20px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(P.icon, 32, 33);
    pupSprites[k] = s;
    return s;
  }

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    SCALE = clamp(Math.min(W, H) / 820, 0.45, 1.5);
  }
  window.addEventListener('resize', () => { if (G) resize(); });

  function render(t, dt) {
    const L = G.local;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1e2c17'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const sx = (Math.random() - 0.5) * G.cam.shake, sy = (Math.random() - 0.5) * G.cam.shake;
    const cx = G.cam.x + sx, cy = G.cam.y + sy;
    ctx.setTransform(DPR * SCALE, 0, 0, DPR * SCALE, DPR * (W / 2 - cx * SCALE), DPR * (H / 2 - cy * SCALE));
    const vw = W / SCALE, vh = H / SCALE;
    const x0 = cx - vw / 2 - 80, y0 = cy - vh / 2 - 80, x1 = cx + vw / 2 + 80, y1 = cy + vh / 2 + 80;
    const inView = (x, y, m) => x > x0 - m && x < x1 + m && y > y0 - m && y < y1 + m;

    // ground
    ctx.fillStyle = G.grass;
    const gx0 = Math.max(0, x0), gy0 = Math.max(0, y0), gx1 = Math.min(G.w, x1), gy1 = Math.min(G.h, y1);
    ctx.fillRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
    for (const p of G.patches) {
      if (!inView(p.x, p.y, p.rx)) continue;
      ctx.fillStyle = p.c; ctx.beginPath(); ctx.ellipse(p.x, p.y, p.rx, p.ry, p.rot, 0, TAU); ctx.fill();
    }
    for (const f of G.flowers) { if (!inView(f.x, f.y, 4)) continue; ctx.fillStyle = f.c; ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, TAU); ctx.fill(); }
    // border
    ctx.strokeStyle = 'rgba(80,58,30,0.9)'; ctx.lineWidth = 24; ctx.strokeRect(-12, -12, G.w + 24, G.h + 24);
    ctx.strokeStyle = 'rgba(201,180,122,0.55)'; ctx.lineWidth = 3; ctx.setLineDash([18, 14]); ctx.strokeRect(2, 2, G.w - 4, G.h - 4); ctx.setLineDash([]);

    // tracks & scorch
    for (const tr of G.tracks) {
      if (!inView(tr.x, tr.y, 50)) continue;
      const al = tr.life / tr.max;
      if (tr.scorch) { ctx.fillStyle = 'rgba(25,20,12,' + (0.45 * al) + ')'; ctx.beginPath(); ctx.arc(tr.x, tr.y, tr.r, 0, TAU); ctx.fill(); continue; }
      ctx.save(); ctx.translate(tr.x, tr.y); ctx.rotate(tr.a);
      ctx.fillStyle = 'rgba(40,52,24,' + (0.35 * al) + ')';
      ctx.fillRect(-4, -15, 8, 5); ctx.fillRect(-4, 10, 8, 5);
      ctx.restore();
    }

    // tree trunks (under everything that moves)
    for (const o of G.trees) { if (!inView(o.x, o.y, 30)) continue; ctx.fillStyle = '#4a3420'; ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill(); ctx.fillStyle = '#6b4c2d'; ctx.beginPath(); ctx.arc(o.x - 2, o.y - 2, o.r * 0.7, 0, TAU); ctx.fill(); }

    // letters
    const bob = t / 1000;
    for (const l of G.letters.values()) {
      if (!inView(l.x, l.y, 30)) continue;
      const age = l.born ? (t - l.born) / 300 : 1;
      const s = Math.min(1, age) * (1 + Math.sin(bob * 3 + l.x * 0.01) * 0.04);
      const spr = letterSprite(l.c);
      ctx.drawImage(spr, l.x - 22 * s, l.y - 22 * s + Math.sin(bob * 2.4 + l.y) * 1.5, 44 * s, 44 * s);
    }
    // power-ups
    for (const u of G.pups.values()) {
      if (!inView(u.x, u.y, 40)) continue;
      const s = 1 + Math.sin(bob * 4 + u.x) * 0.08;
      ctx.drawImage(pupSprite(u.k), u.x - 32 * s, u.y - 32 * s, 64 * s, 64 * s);
    }
    // mines
    for (const m of G.mines) {
      ctx.fillStyle = '#2c2f2a'; ctx.beginPath(); ctx.arc(m[1], m[2], 11, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#555a50'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = m[3] && Math.floor(t / 400) % 2 ? '#ff3b2f' : '#6a1d18'; ctx.beginPath(); ctx.arc(m[1], m[2], 3.5, 0, TAU); ctx.fill();
    }

    // rocks
    for (const o of G.rocks) {
      if (!inView(o.x, o.y, o.r + 20)) continue;
      const spr = ART.rockSprite(o.r, o.v);
      ctx.drawImage(spr, o.x - spr.width / 2, o.y - spr.height / 2);
    }

    // tanks
    const drawList = [];
    for (const p of G.players.values()) if (p.id !== G.me && !p.hidden && !(p.flags & 128) && G.info.has(p.id) && p.buf.length) drawList.push(p);
    for (const p of drawList) drawTankEntity(p, p.flags, p.hp, t, false);
    if (L.alive && G.meState) drawTankEntity(L, myFlags(), G.meState.hp, t, true);

    // bullets
    for (const b of G.bullets.values()) {
      const age = Math.min(0.12, (t - b.t) / 1000);
      const x = b.x + b.vx * age, y = b.y + b.vy * age;
      if (!inView(x, y, 20)) continue;
      const col = b.d < 8 ? '#ffe9a8' : b.d < 25 ? '#ffb347' : b.d < 70 ? '#ff5e3a' : '#d36bff';
      const sp = Math.hypot(b.vx, b.vy) || 1;
      ctx.strokeStyle = col; ctx.globalAlpha = 0.35; ctx.lineWidth = b.r * 1.4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - b.vx / sp * b.r * 5, y - b.vy / sp * b.r * 5); ctx.stroke();
      ctx.globalAlpha = 0.3; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, b.r * 2, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(x, y, b.r, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, b.r * 0.45, 0, TAU); ctx.fill();
    }

    // particles
    for (const p of G.particles) {
      const f = p.life / p.max;
      switch (p.type) {
        case 'spark': ctx.strokeStyle = p.c; ctx.globalAlpha = f; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke(); break;
        case 'smoke': ctx.fillStyle = (p.c || 'rgba(60,60,55,') + (0.4 * f) + ')'; ctx.beginPath(); ctx.arc(p.x, p.y, p.s * (2 - f), 0, TAU); ctx.fill(); break;
        case 'fire': ctx.fillStyle = f > 0.6 ? '#fff1a8' : f > 0.3 ? '#ff9f2e' : '#c2381b'; ctx.globalAlpha = Math.min(1, f * 1.5); ctx.beginPath(); ctx.arc(p.x, p.y, p.s * f, 0, TAU); ctx.fill(); break;
        case 'debris': ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot + (1 - f) * 8); ctx.fillStyle = '#2b2a24'; ctx.globalAlpha = f; ctx.fillRect(-4, -2.5, 8, 5); ctx.restore(); break;
        case 'ring': ctx.strokeStyle = p.c; ctx.globalAlpha = f; ctx.lineWidth = 4 * f; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1.2 - f * 0.7), 0, TAU); ctx.stroke(); break;
        case 'flash': ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.globalAlpha = f / 0.08 > 0 ? 1 : 0; ctx.fillStyle = '#fff3b0'; ctx.beginPath(); ctx.moveTo(0, -6 * p.s); ctx.lineTo(22 * p.s, 0); ctx.lineTo(0, 6 * p.s); ctx.fill(); ctx.fillStyle = '#ffb347'; ctx.beginPath(); ctx.arc(0, 0, 7 * p.s, 0, TAU); ctx.fill(); ctx.restore(); break;
        case 'flashBig': ctx.fillStyle = 'rgba(255,240,180,' + f + ')'; ctx.beginPath(); ctx.arc(p.x, p.y, 70 * p.s, 0, TAU); ctx.fill(); break;
        case 'fly': { const spr = letterSprite(p.c); const s = 0.5 + f * 0.5; ctx.globalAlpha = Math.min(1, f * 2); ctx.drawImage(spr, p.x - 22 * s, p.y - 22 * s, 44 * s, 44 * s); break; }
      }
      ctx.globalAlpha = 1;
    }

    // tree canopies (tanks can hide underneath)
    for (const o of G.trees) {
      if (!inView(o.x, o.y, o.r * 4.5)) continue;
      const spr = ART.canopySprite(o.r, o.v);
      const under = L.alive && Math.hypot(L.x - o.x, L.y - o.y) < o.r * 3.6;
      ctx.globalAlpha = under ? 0.45 : 0.97;
      ctx.drawImage(spr, o.x - spr.width / 2, o.y - spr.height / 2);
    }
    ctx.globalAlpha = 1;

    // name tags
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (const p of drawList) nameTag(p, p.hp, p.flags);
    if (L.alive && G.meState) nameTag(L, G.meState.hp, myFlags(), true);

    // floating text
    for (const f of G.floats) {
      const a = Math.min(1, f.life / f.max * 2);
      ctx.globalAlpha = a; ctx.font = '800 ' + Math.round(16 * f.size) + 'px Rubik, system-ui, sans-serif';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }
  function myFlags() {
    const fx = G.meState.fx; let f = 0;
    if (fx.shield) f |= 1; if (fx.speed) f |= 2; if (fx.damage) f |= 4; if (fx.rapid) f |= 8; if (fx.magnet) f |= 16; if (fx.cloak) f |= 32;
    return f;
  }
  function teamColorFor(info) { return G.S.mode === 'teams' && info.team >= 0 ? WT.TEAM_COLORS[info.team] : null; }
  function drawTankEntity(p, flags, hp, t, isMe) {
    const id = isMe ? G.me : p.id;
    const info = G.info.get(id); if (!info) return;
    const tc = teamColorFor(info);
    let alpha = 1;
    if (flags & 32) alpha = isMe || !G.info.get(G.me) || (G.S.mode === 'teams' && info.team === G.info.get(G.me).team) ? 0.4 : 0.22;
    if (flags & 64) alpha *= 0.55 + 0.45 * Math.abs(Math.sin(t / 120));
    ctx.save(); ctx.translate(p.x, p.y);
    if (flags & 16) { ctx.strokeStyle = 'rgba(214,107,255,0.35)'; ctx.lineWidth = 2; ctx.setLineDash([6, 8]); ctx.lineDashOffset = -t / 40; ctx.beginPath(); ctx.arc(0, 0, 230, 0, TAU); ctx.stroke(); ctx.setLineDash([]); }
    if (flags & 4) { ctx.fillStyle = 'rgba(255,90,60,' + (0.18 + 0.1 * Math.sin(t / 100)) + ')'; ctx.beginPath(); ctx.arc(0, 0, info.r + 14, 0, TAU); ctx.fill(); }
    if (flags & 8) { ctx.strokeStyle = 'rgba(255,159,28,0.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, info.r + 9, t / 150, t / 150 + 2); ctx.stroke(); }
    ART.drawTank(ctx, info.tank, tc || info.color, p.a, p.ta, { tread: p.tread, alpha, teamColor: tc ? info.color : null });
    if (flags & 1) {
      const pulse = 0.5 + 0.5 * Math.sin(t / 180);
      const g = ctx.createRadialGradient(0, 0, info.r, 0, 0, info.r + 18);
      g.addColorStop(0, 'rgba(90,184,255,0)'); g.addColorStop(1, 'rgba(120,200,255,' + (0.35 + pulse * 0.2) + ')');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, info.r + 18, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(170,225,255,0.8)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    if (isMe) { ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1; ctx.setLineDash([4, 10]); ctx.beginPath(); ctx.moveTo(Math.cos(p.ta) * (info.r + 30), Math.sin(p.ta) * (info.r + 30)); ctx.lineTo(Math.cos(p.ta) * 260, Math.sin(p.ta) * 260); ctx.stroke(); ctx.setLineDash([]); }
    ctx.restore();
  }
  function nameTag(p, hp, flags, isMe) {
    const id = isMe ? G.me : p.id;
    const info = G.info.get(id); if (!info) return;
    if ((flags & 32) && !isMe && G.S.mode !== 'teams') return;
    const y = p.y - info.r - 16;
    ctx.font = '700 13px Rubik, system-ui, sans-serif';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.strokeText(info.name, p.x, y - 6);
    const tc = teamColorFor(info);
    ctx.fillStyle = isMe ? '#ffcc5c' : tc ? (info.team === 0 ? '#ffb0a5' : '#b5ceff') : '#ffffff';
    ctx.fillText(info.name, p.x, y - 6);
    const w = 44, f = clamp(hp / info.maxHp, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(p.x - w / 2 - 1, y - 3, w + 2, 6);
    ctx.fillStyle = f > 0.5 ? '#6ad25a' : f > 0.25 ? '#e8c140' : '#e2553f'; ctx.fillRect(p.x - w / 2, y - 2, w * f, 4);
  }

  // ================================================================ HUD
  function setHTML(id, html) { if (G.hudCache[id] !== html) { G.hudCache[id] = html; $(id).innerHTML = html; } }
  function feed(html) {
    const el = document.createElement('div'); el.innerHTML = html;
    const f = $('feed'); f.prepend(el);
    while (f.children.length > 5) f.lastChild.remove();
    setTimeout(() => el.remove(), 6500);
  }
  function fmtTime(s) { if (s < 0) return '∞'; const m = Math.floor(s / 60), r = Math.floor(s % 60); return m + ':' + (r < 10 ? '0' : '') + r; }
  function hud(t) {
    const me = G.meState; if (!me) return;
    const info = G.info.get(G.me); if (!info) return;
    const hpF = clamp(me.hp / info.maxHp, 0, 1);
    $('hpFill').style.width = (hpF * 100) + '%';
    $('shieldFill').style.width = (me.fx.shield ? clamp(me.sh / info.maxHp, 0, 1) * 100 : 0) + '%';
    setHTML('hpText', Math.max(0, me.hp) + ' / ' + info.maxHp);
    let fx = '';
    for (const k in me.fx) { const P = WT.POWERUPS[k]; if (P) fx += '<div class="fx" style="border-color:' + P.color + '">' + P.icon + ' ' + Math.ceil(me.fx[k]) + 's</div>'; }
    setHTML('fxList', fx);
    const mine = G.players.get(G.me);
    const myKills = mine ? mine.kills : 0;
    let mi = '<span>⏱ ' + fmtTime(G.timeLeft) + '</span>';
    if (G.S.mode === 'teams') mi += '<span class="red">' + G.teamScore[0] + '</span><span>vs</span><span class="blue">' + G.teamScore[1] + '</span>';
    else mi += '<span>💀 ' + myKills + (G.S.killLimit ? ' / ' + G.S.killLimit : '') + '</span>';
    setHTML('matchInfo', mi);
    // death overlay
    const dead = !me.alive && !G.over;
    $('deathOverlay').classList.toggle('hidden', !dead);
    if (dead) setHTML('deathText', (G.lastKiller ? 'by <b>' + esc(G.lastKiller) + '</b> · ' : '') + 'respawning in ' + Math.ceil(me.rs) + 's');
    if (nowMs() > wordInfoUntil && wordInfoUntil) { wordInfoUntil = 0; renderTray(true); }
    if (!$('scoreboard').classList.contains('hidden') && t - (G.lastSB || 0) > 500) { G.lastSB = t; renderScoreboard(); }
    if (t - G.lastMini > 150) { G.lastMini = t; drawMinimap(t); }
  }
  function drawMinimap(t) {
    const k = 180 / G.w;
    mctx.drawImage(G.miniBase, 0, 0);
    for (const u of G.pups.values()) { mctx.fillStyle = WT.POWERUPS[u.k].color; mctx.fillRect(u.x * k - 1.5, u.y * k - 1.5, 3, 3); }
    const myInfo = G.info.get(G.me);
    for (const p of G.players.values()) {
      if (p.id === G.me || p.hidden || (p.flags & 128)) continue;
      const info = G.info.get(p.id); if (!info) continue;
      const friend = G.S.mode === 'teams' && myInfo && info.team === myInfo.team;
      mctx.fillStyle = G.S.mode === 'teams' ? WT.TEAM_COLORS[info.team] : '#ff5a4a';
      mctx.beginPath(); mctx.arc(p.x * k, p.y * k, friend ? 3 : 3.5, 0, TAU); mctx.fill();
      mctx.strokeStyle = 'rgba(0,0,0,0.6)'; mctx.lineWidth = 1; mctx.stroke();
    }
    const vw = W / SCALE, vh = H / SCALE;
    mctx.strokeStyle = 'rgba(255,255,255,0.35)'; mctx.lineWidth = 1;
    mctx.strokeRect((G.cam.x - vw / 2) * k, (G.cam.y - vh / 2) * k, vw * k, vh * k);
    if (G.local.alive) {
      const L = G.local;
      mctx.save(); mctx.translate(L.x * k, L.y * k); mctx.rotate(L.a);
      mctx.fillStyle = '#ffffff'; mctx.beginPath(); mctx.moveTo(6, 0); mctx.lineTo(-4, -4); mctx.lineTo(-2, 0); mctx.lineTo(-4, 4); mctx.closePath(); mctx.fill();
      mctx.restore();
    }
  }
  function renderScoreboard() {
    if (!G) return;
    const rows = Array.from(G.players.values()).filter((p) => G.info.has(p.id))
      .sort((a, b) => (b.kills || 0) - (a.kills || 0) || (a.deaths || 0) - (b.deaths || 0));
    let html = '<h2 style="font-family:var(--display);font-weight:400;color:var(--khaki);margin:0 0 8px">Scoreboard</h2>';
    if (G.S.mode === 'teams') html += '<p style="margin:0 0 8px;font-weight:800"><span style="color:#ff8a7a">Red ' + G.teamScore[0] + '</span> · <span style="color:#8fb6ff">Blue ' + G.teamScore[1] + '</span></p>';
    html += '<table class="scores"><tr><th>Commander</th><th>Tank</th><th>Kills</th><th>Deaths</th></tr>';
    for (const p of rows) {
      const i = G.info.get(p.id);
      const col = G.S.mode === 'teams' ? WT.TEAM_COLORS[i.team] : i.color;
      html += '<tr class="' + (p.id === G.me ? 'me' : '') + '"><td><span class="dot" style="background:' + col + '"></span>' + esc(i.name) + '</td><td>' + WT.TANKS[i.tank].name + '</td><td>' + (p.kills || 0) + '</td><td>' + (p.deaths || 0) + '</td></tr>';
    }
    html += '</table>';
    $('scoreboard').innerHTML = html;
  }

  window.GAME = { start, stop, snapshot, wordResult, setOver, isRunning: () => !!G, unlockAudio: () => SFX.unlock() };
})();
