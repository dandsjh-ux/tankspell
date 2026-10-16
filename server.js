// Word Tanks — multiplayer word-powered tank battles. Zero dependencies: `node server.js`.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { attach } = require('./ws');
const WT = require('./public/shared.js');

const PORT = process.env.PORT || 3000;
const TICK_HZ = 20;
const DT = 1 / TICK_HZ;
const PUBLIC = path.join(__dirname, 'public');

// ---------------------------------------------------------------- dictionaries
const DICTS = {};
const DICT_GZ = {};
for (const name of ['all', 'root']) {
  const txt = fs.readFileSync(path.join(__dirname, 'data', 'words_' + name + '.txt'), 'utf8');
  DICTS[name] = new Set(txt.split('\n').map((w) => w.trim()).filter(Boolean));
  DICT_GZ[name] = zlib.gzipSync(txt);
}
console.log('Dictionary loaded:', DICTS.all.size, 'words (', DICTS.root.size, 'root words )');

// ---------------------------------------------------------------- static http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const staticCache = new Map();
function serveStatic(req, res) {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const m = url.match(/^\/words\/(all|root)\.txt$/);
  if (m) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=86400' });
    return res.end(DICT_GZ[m[1]]);
  }
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  let entry = staticCache.get(file);
  if (!entry) {
    try {
      const raw = fs.readFileSync(file);
      entry = { raw, gz: zlib.gzipSync(raw), type: MIME[path.extname(file)] || 'application/octet-stream' };
      if (process.env.NODE_ENV === 'production') staticCache.set(file, entry);
    } catch (e) { res.writeHead(404); return res.end('Not found'); }
  }
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-cache', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
  res.end(gzip ? entry.gz : entry.raw);
}
const server = http.createServer(serveStatic);

// ---------------------------------------------------------------- helpers
let nextId = 1;
const uid = () => (nextId++).toString(36);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
const cleanName = (s, n) => String(s || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const now = () => Date.now() / 1000;

const LETTER_FREQ = { E: 12, A: 9, I: 9, O: 8, N: 6, R: 6, T: 6, L: 4, S: 4, U: 4, D: 4, G: 3, B: 2, C: 2, M: 2, P: 2, F: 2, H: 2, V: 2, W: 2, Y: 2, K: 1, J: 1, X: 1, Q: 1, Z: 1 };
const VOWELS = 'AEIOU';

const clients = new Map(); // id -> client
const rooms = new Map();   // id -> room
let lobbyDirty = true;

function send(c, msg) { if (c && c.ws.open) c.ws.send(JSON.stringify(msg)); }
function roomBroadcast(room, msg) { const s = JSON.stringify(msg); for (const id of room.members) { const c = clients.get(id); if (c && c.ws.open) c.ws.send(s); } }

// ---------------------------------------------------------------- lobby
function roomSummary(r) {
  return {
    id: r.id, name: r.settings.roomName || (hostName(r) + "'s game"), host: hostName(r),
    players: r.members.size, max: r.settings.maxPlayers, state: r.state,
    mode: r.settings.mode, map: r.settings.mapSize, locked: !!r.settings.password,
    joinable: r.members.size < r.settings.maxPlayers && (r.state === 'lobby' || (r.state === 'playing' && r.settings.lateJoin))
  };
}
function hostName(r) { const h = clients.get(r.hostId); return h ? h.name : '—'; }
function roomsList() { return Array.from(rooms.values()).map(roomSummary); }
function sendRoomState(room) {
  roomBroadcast(room, {
    t: 'room', room: {
      id: room.id, hostId: room.hostId, state: room.state, settings: publicSettings(room.settings),
      players: Array.from(room.members).map((id) => { const c = clients.get(id); return { id, name: c.name, tank: c.tank, color: c.color, team: c.team }; })
    }
  });
  lobbyDirty = true;
}
function publicSettings(s) { const o = Object.assign({}, s); o.hasPassword = !!s.password; delete o.password; return o; }

function joinRoom(c, room) {
  if (c.roomId) leaveRoom(c);
  room.members.add(c.id);
  c.roomId = room.id;
  if (!room.settings.allowedTanks.includes(c.tank)) c.tank = room.settings.allowedTanks[0];
  assignTeam(room, c);
  send(c, { t: 'joined', roomId: room.id });
  if (room.state === 'playing' && room.game) room.game.addPlayer(c);
  sendRoomState(room);
}
function assignTeam(room, c) {
  if (room.settings.mode !== 'teams') { c.team = -1; return; }
  const counts = [0, 0];
  for (const id of room.members) { const o = clients.get(id); if (o && o !== c && o.team >= 0) counts[o.team]++; }
  c.team = counts[0] <= counts[1] ? 0 : 1;
}
function leaveRoom(c) {
  const room = rooms.get(c.roomId);
  c.roomId = null;
  if (!room) return;
  room.members.delete(c.id);
  if (room.game) room.game.removePlayer(c.id);
  if (room.members.size === 0) { if (room.game) room.game.stop(); rooms.delete(room.id); lobbyDirty = true; return; }
  if (room.hostId === c.id) room.hostId = room.members.values().next().value;
  sendRoomState(room);
}

// ---------------------------------------------------------------- game
class Game {
  constructor(room) {
    this.room = room;
    this.s = room.settings;
    const S = this.s;
    this.w = this.h = WT.MAP_SIZES[S.mapSize] || 5000;
    this.seed = (Math.random() * 1e9) | 0;
    this.rng = WT.mulberry32(this.seed);
    this.players = new Map();
    this.bullets = [];
    this.mines = [];
    this.letters = new Map();
    this.pups = new Map();
    this.pendingLetters = []; // [time]
    this.pendingPups = [];
    this.events = [];
    this.lAdd = []; this.lRem = []; this.pAdd = []; this.pRem = [];
    this.startedAt = now();
    this.endsAt = S.timeLimit > 0 ? this.startedAt + S.timeLimit * 60 : 0;
    this.over = false;
    this.teamScore = [0, 0];
    this.genMap();
    this.dict = DICTS[S.dictionary] || DICTS.all;
    const area = this.w * this.h;
    this.letterTarget = Math.round((area / 38000) * S.letterDensity);
    this.pupTarget = S.powerups.length ? Math.round((area / 900000) * S.powerupFrequency) : 0;
    this.buildLetterBag();
    for (let i = 0; i < this.letterTarget; i++) this.spawnLetter();
    for (let i = 0; i < this.pupTarget; i++) this.spawnPup();
    this.lAdd = []; this.pAdd = [];
    for (const id of room.members) this.addPlayer(clients.get(id), true);
    this.timer = setInterval(() => this.tick(), 1000 / TICK_HZ);
  }

  genMap() {
    const S = this.s, rng = this.rng, w = this.w, h = this.h, area = w * h;
    const obs = [];
    const fits = (x, y, r, pad) => {
      if (x < r + 40 || y < r + 40 || x > w - r - 40 || y > h - r - 40) return false;
      for (const o of obs) { const m = o.r + r + pad; if (dist2(x, y, o.x, o.y) < m * m) return false; }
      return true;
    };
    // Trees: mix of forests (clusters) and lone trees
    const nTrees = Math.round((area / 85000) * S.treeDensity);
    const clusters = Math.max(1, Math.round(nTrees / 14));
    let placed = 0, guard = 0;
    for (let c = 0; c < clusters && placed < nTrees; c++) {
      const cx = rng() * w, cy = rng() * h, spread = 140 + rng() * 260;
      const n = 6 + ((rng() * 12) | 0);
      for (let i = 0; i < n && placed < nTrees; i++) {
        const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * spread;
        const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d, r = 13 + rng() * 7;
        if (fits(x, y, r, 34)) { obs.push({ id: obs.length, type: 1, x, y, r, v: rng() }); placed++; }
      }
    }
    guard = 0;
    while (placed < nTrees && guard++ < nTrees * 20) {
      const x = rng() * w, y = rng() * h, r = 13 + rng() * 7;
      if (fits(x, y, r, 60)) { obs.push({ id: obs.length, type: 1, x, y, r, v: rng() }); placed++; }
    }
    // Rocks: boulders, some in small groups
    const nRocks = Math.round((area / 170000) * S.rockDensity);
    placed = 0; guard = 0;
    while (placed < nRocks && guard++ < nRocks * 30) {
      const x = rng() * w, y = rng() * h, r = 26 + Math.pow(rng(), 1.6) * 52;
      if (!fits(x, y, r, 70)) continue;
      obs.push({ id: obs.length, type: 0, x, y, r, v: rng() }); placed++;
      if (rng() < 0.35) {
        for (let k = 0; k < 2; k++) {
          const a = rng() * 6.283, d = r + 24 + rng() * 20, r2 = 14 + rng() * 16;
          const x2 = x + Math.cos(a) * (d + r2), y2 = y + Math.sin(a) * (d + r2);
          if (fits(x2, y2, r2, 8)) { obs.push({ id: obs.length, type: 0, x: x2, y: y2, r: r2, v: rng() }); placed++; }
        }
      }
    }
    obs.forEach((o, i) => { o.id = i; });
    this.obstacles = obs;
    this.grid = WT.buildGrid(obs, w, h);
  }

  // openSky: also keep clear of tree canopies so pickups are never hidden under leaves
  freeSpot(r, tries, openSky) {
    for (let i = 0; i < (tries || 40); i++) {
      const x = 60 + Math.random() * (this.w - 120), y = 60 + Math.random() * (this.h - 120);
      const near = WT.nearby(this.grid, x, y, r + 90);
      if (near.every((o) => { const m = (openSky && o.type === 1 ? o.r * 3.3 : o.r) + r; return dist2(x, y, o.x, o.y) > m * m; })) return [x, y];
    }
    return [this.w / 2, this.h / 2];
  }

  buildLetterBag() {
    this.bag = [];
    for (const [ch, f] of Object.entries(LETTER_FREQ)) {
      const n = Math.round(f * (VOWELS.includes(ch) ? this.s.vowelBoost : 1) * 2);
      for (let i = 0; i < n; i++) this.bag.push(ch);
    }
  }
  spawnLetter(x, y, ch) {
    if (x === undefined) [x, y] = this.freeSpot(18, 40, true);
    ch = ch || this.bag[(Math.random() * this.bag.length) | 0];
    const l = { id: uid(), x: Math.round(x), y: Math.round(y), c: ch };
    this.letters.set(l.id, l);
    this.lAdd.push([l.id, l.x, l.y, l.c]);
    return l;
  }
  spawnPup() {
    const [x, y] = this.freeSpot(22, 40, true);
    const types = this.s.powerups;
    const p = { id: uid(), x: Math.round(x), y: Math.round(y), k: types[(Math.random() * types.length) | 0] };
    this.pups.set(p.id, p);
    this.pAdd.push([p.id, p.x, p.y, p.k]);
  }

  spawnPoint(p) {
    let best = null, bestScore = -1;
    for (let i = 0; i < 24; i++) {
      let [x, y] = this.freeSpot(40);
      if (this.s.mode === 'teams' && p.team >= 0) {
        // prefer own half
        const half = this.w / 2;
        if ((p.team === 0 && x > half) || (p.team === 1 && x < half)) x = this.w - x;
        const near = WT.nearby(this.grid, x, y, 140);
        if (!near.every((o) => dist2(x, y, o.x, o.y) > (o.r + 40) * (o.r + 40))) continue;
      }
      let minD = 1e12;
      for (const o of this.players.values()) if (o !== p && o.alive && this.isEnemy(p, o)) minD = Math.min(minD, dist2(x, y, o.x, o.y));
      if (minD > bestScore) { bestScore = minD; best = [x, y]; }
    }
    return best || this.freeSpot(40);
  }

  addPlayer(c, initial) {
    if (!c || this.players.has(c.id)) return;
    const T = WT.TANKS[c.tank] || WT.TANKS.striker;
    const S = this.s;
    const p = {
      id: c.id, name: c.name, tank: c.tank, color: c.color, team: S.mode === 'teams' ? c.team : -1,
      T, maxHp: Math.round(T.hp * S.hpMult), hp: 0, x: 0, y: 0, a: 0, ta: 0, alive: false,
      respawnAt: 0, protectUntil: 0, lastFire: 0, lastSt: now(),
      tray: [], ammo: [], inv: [], fx: {}, shieldHp: 0,
      kills: 0, deaths: 0, words: 0, best: '', dmgDealt: 0, used: new Set(),
      spawnSeq: 0, fix: null, sentInit: false
    };
    this.players.set(c.id, p);
    this.respawn(p);
    const pi = this.playerInfo(p);
    this.events.push({ k: 'join', p: pi });
    if (!initial) send(c, this.initMessage(c.id));
  }
  playerInfo(p) { return { id: p.id, name: p.name, tank: p.tank, color: p.color, team: p.team, maxHp: p.maxHp, r: p.T.radius }; }
  initMessage(forId) {
    return {
      t: 'gameStart', you: forId, seed: this.seed, w: this.w, h: this.h, settings: publicSettings(this.s),
      obstacles: this.obstacles.map((o) => [o.type, Math.round(o.x), Math.round(o.y), Math.round(o.r * 10) / 10, Math.round(o.v * 1000) / 1000]),
      letters: Array.from(this.letters.values()).map((l) => [l.id, l.x, l.y, l.c]),
      pups: Array.from(this.pups.values()).map((p) => [p.id, p.x, p.y, p.k]),
      players: Array.from(this.players.values()).map((p) => this.playerInfo(p)),
      timeLeft: this.endsAt ? Math.max(0, this.endsAt - now()) : -1,
      teamScore: this.teamScore
    };
  }
  start() {
    for (const p of this.players.values()) send(clients.get(p.id), this.initMessage(p.id));
  }
  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.alive) this.dropLetters(p);
    this.players.delete(id);
    this.mines = this.mines.filter((m) => m.owner !== id);
    this.events.push({ k: 'leave', id });
  }
  stop() { clearInterval(this.timer); this.over = true; }

  respawn(p) {
    const [x, y] = this.spawnPoint(p);
    p.x = x; p.y = y; p.hp = p.maxHp; p.alive = true; p.fx = {}; p.shieldHp = 0;
    p.protectUntil = now() + this.s.spawnProtection;
    p.spawnSeq++; p.lastSt = now();
    p.a = Math.random() * 6.283; p.ta = p.a;
  }
  isEnemy(a, b) { return this.s.mode !== 'teams' || a.team !== b.team; }
  canHurt(attacker, victim) { if (attacker.id === victim.id) return false; return this.isEnemy(attacker, victim) || this.s.friendlyFire; }
  has(p, k) { return p.fx[k] && p.fx[k] > now(); }

  // ---- client messages
  onState(p, m) {
    if (!p.alive || m.seq !== p.spawnSeq) return;
    let x = Number(m.x), y = Number(m.y);
    if (!isFinite(x) || !isFinite(y)) return;
    const t = now(), dt = Math.min(1, t - p.lastSt);
    p.lastSt = t;
    const speed = p.T.speed * this.s.speedMult * (this.has(p, 'speed') ? 1.55 : 1);
    const maxD = speed * dt * 1.6 + 30;
    if (dist2(x, y, p.x, p.y) > maxD * maxD) { p.fix = [p.x, p.y]; return; }
    const r = WT.resolve(this.grid, x, y, p.T.radius);
    if (dist2(r[0], r[1], x, y) > 64) p.fix = r;
    p.x = r[0]; p.y = r[1];
    if (isFinite(m.a)) p.a = Number(m.a);
    if (isFinite(m.ta)) p.ta = Number(m.ta);
  }
  onFire(p, m) {
    if (!p.alive) return;
    const t = now();
    let reload = p.T.reload * this.s.reloadMult * (this.has(p, 'rapid') ? 0.45 : 1);
    if (t - p.lastFire < reload * 0.9) return;
    if (isFinite(m.ta)) p.ta = Number(m.ta);
    let dmg, word = '';
    if (p.ammo.length) {
      const top = p.ammo[p.ammo.length - 1];
      dmg = top.d; word = top.w;
      if (--top.n <= 0) p.ammo.pop();
    } else if (this.s.basicCannon > 0) dmg = this.s.basicCannon;
    else return;
    dmg = dmg * p.T.dmgMult * (this.has(p, 'damage') ? 2 : 1);
    p.lastFire = t;
    p.protectUntil = 0;
    if (p.fx.cloak) delete p.fx.cloak;
    const sp = p.T.bulletSpeed * this.s.bulletSpeedMult;
    const cos = Math.cos(p.ta), sin = Math.sin(p.ta), off = p.T.radius + 14;
    this.bullets.push({
      id: uid(), owner: p.id, x: p.x + cos * off, y: p.y + sin * off, vx: cos * sp, vy: sin * sp,
      dmg: Math.round(dmg), life: p.T.range / sp, r: 4 + Math.min(11, Math.sqrt(dmg) * 0.95), w: word
    });
    this.events.push({ k: 'fire', id: p.id, d: Math.round(dmg) });
  }
  onWord(p, m, c) {
    const fail = (reason) => send(c, { t: 'wordResult', ok: false, reason });
    if (!p.alive) return fail('You are destroyed');
    const idx = Array.isArray(m.idx) ? m.idx.map(Number) : [];
    let w = String(m.w || '').toUpperCase();
    if (idx.length !== w.length || !/^[A-Z]+$/.test(w)) return fail('Invalid word');
    if (new Set(idx).size !== idx.length || idx.some((i) => !(i >= 0 && i < p.tray.length))) return fail('Invalid tiles');
    for (let i = 0; i < idx.length; i++) { const ch = p.tray[idx[i]]; if (ch !== w[i] && ch !== '?') return fail('Tiles do not match'); }
    if (w.length < this.s.minWordLength) return fail('Need at least ' + this.s.minWordLength + ' letters');
    const lw = w.toLowerCase();
    if (!this.dict.has(lw)) return fail('"' + w + '" is not in the dictionary');
    if (this.s.noRepeatWords && p.used.has(lw)) return fail('You already used "' + w + '"');
    p.used.add(lw);
    p.tray = p.tray.filter((_, i) => !idx.includes(i));
    const d = WT.damageFor(w.length, this.s);
    p.ammo.push({ w, d, n: this.s.shellsPerWord });
    if (p.ammo.length > 6) p.ammo.shift();
    p.words++;
    if (w.length > p.best.length) p.best = w;
    this.events.push({ k: 'word', id: p.id, w, d, n: this.s.shellsPerWord });
    send(c, { t: 'wordResult', ok: true, w, d, n: this.s.shellsPerWord });
  }
  onDrop(p, m) {
    const i = Number(m.i);
    if (!p.alive || !(i >= 0 && i < p.tray.length)) return;
    const ch = p.tray.splice(i, 1)[0];
    if (ch === '?') return; // wildcards vanish
    const a = p.a + Math.PI, d = p.T.radius + 60;
    let x = clamp(p.x + Math.cos(a) * d, 30, this.w - 30), y = clamp(p.y + Math.sin(a) * d, 30, this.h - 30);
    const l = this.spawnLetter(x, y, ch);
    l.noPick = p.id; l.noPickUntil = now() + 2;
  }
  onSelectAmmo(p, m) {
    const i = Number(m.i);
    if (!(i >= 0 && i < p.ammo.length)) return;
    const [a] = p.ammo.splice(i, 1);
    p.ammo.push(a);
  }
  onUse(p, m) {
    const i = Number(m.i);
    if (!p.alive || !(i >= 0 && i < p.inv.length)) return;
    const k = p.inv[i], S = this.s, t = now();
    const dur = (WT.PU_BASE_DURATION[k] || 0) * S.powerupDuration;
    switch (k) {
      case 'shield': p.fx.shield = t + dur; p.shieldHp = 60; break;
      case 'speed': p.fx.speed = t + dur; break;
      case 'damage': p.fx.damage = t + dur; break;
      case 'rapid': p.fx.rapid = t + dur; break;
      case 'magnet': p.fx.magnet = t + dur; break;
      case 'cloak': p.fx.cloak = t + dur; break;
      case 'repair':
        if (p.hp >= p.maxHp) return;
        p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.5)); break;
      case 'wildcard':
        if (p.tray.length >= this.trayCap(p)) return;
        p.tray.push('?'); break;
      case 'mine': {
        if (this.mines.filter((mn) => mn.owner === p.id).length >= 3) this.mines.splice(this.mines.findIndex((mn) => mn.owner === p.id), 1);
        const a = p.a + Math.PI, d = p.T.radius + 12;
        this.mines.push({ id: uid(), owner: p.id, team: p.team, x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d, armAt: t + 1, until: t + 90 });
        break;
      }
      default: return;
    }
    p.inv.splice(i, 1);
    this.events.push({ k: 'use', id: p.id, p: k });
  }
  trayCap(p) { return this.s.trayCapacity + (p.T.tray || 0); }

  dropLetters(p) {
    if (!this.s.dropLetters) { p.tray = []; return; }
    const real = p.tray.filter((c) => c !== '?');
    real.forEach((ch, i) => {
      const a = (i / Math.max(1, real.length)) * Math.PI * 2 + Math.random() * 0.5, d = 50 + Math.random() * 70;
      let [x, y] = WT.resolve(this.grid, clamp(p.x + Math.cos(a) * d, 30, this.w - 30), clamp(p.y + Math.sin(a) * d, 30, this.h - 30), 14);
      this.spawnLetter(x, y, ch);
    });
    p.tray = [];
  }

  damage(victim, attacker, amount, x, y, how) {
    const t = now();
    if (!victim.alive || victim.protectUntil > t) return;
    let dmg = amount;
    if (this.has(victim, 'shield') && victim.shieldHp > 0) {
      const absorbed = Math.min(victim.shieldHp, dmg);
      victim.shieldHp -= absorbed; dmg -= absorbed;
      if (victim.shieldHp <= 0) delete victim.fx.shield;
      this.events.push({ k: 'shieldHit', id: victim.id, x: Math.round(x), y: Math.round(y) });
    }
    if (dmg <= 0) return;
    victim.hp -= dmg;
    if (attacker) attacker.dmgDealt += dmg;
    this.events.push({ k: 'hit', id: victim.id, by: attacker ? attacker.id : null, d: Math.round(dmg), x: Math.round(x), y: Math.round(y) });
    if (victim.hp <= 0) {
      victim.hp = 0; victim.alive = false; victim.deaths++;
      victim.respawnAt = t + this.s.respawnTime;
      victim.ammo = []; victim.fx = {};
      this.dropLetters(victim);
      if (attacker && attacker !== victim) {
        if (this.isEnemy(attacker, victim)) {
          attacker.kills++;
          if (this.s.mode === 'teams' && attacker.team >= 0) this.teamScore[attacker.team]++;
        } else {
          attacker.kills = Math.max(0, attacker.kills - 1); // team kill penalty
        }
      }
      this.events.push({ k: 'kill', by: attacker ? attacker.id : null, id: victim.id, how: how || '', x: Math.round(victim.x), y: Math.round(victim.y) });
      this.checkWin();
    }
  }

  checkWin() {
    const L = this.s.killLimit;
    if (L <= 0 || this.over) return;
    if (this.s.mode === 'teams') { if (this.teamScore.some((s) => s >= L)) this.finish(); }
    else for (const p of this.players.values()) if (p.kills >= L) { this.finish(); return; }
  }

  finish() {
    if (this.over) return;
    this.over = true;
    clearInterval(this.timer);
    const standings = Array.from(this.players.values())
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.dmgDealt - a.dmgDealt)
      .map((p) => ({ id: p.id, name: p.name, tank: p.tank, color: p.color, team: p.team, kills: p.kills, deaths: p.deaths, words: p.words, best: p.best, dmg: Math.round(p.dmgDealt) }));
    let winner;
    if (this.s.mode === 'teams') winner = this.teamScore[0] === this.teamScore[1] ? 'Draw!' : WT.TEAM_NAMES[this.teamScore[0] > this.teamScore[1] ? 0 : 1] + ' team wins!';
    else winner = standings.length ? standings[0].name + ' wins!' : 'Game over';
    roomBroadcast(this.room, { t: 'gameOver', standings, winner, teamScore: this.teamScore, mode: this.s.mode });
    const room = this.room;
    room.state = 'ended';
    room.game = null;
    sendRoomState(room);
    setTimeout(() => { if (rooms.get(room.id) === room && room.state === 'ended') { room.state = 'lobby'; sendRoomState(room); } }, 20000);
  }

  // ---- simulation
  tick() {
    const t = now(), S = this.s;
    if (this.endsAt && t >= this.endsAt) { this.finish(); return; }

    // respawns & effect expiry
    for (const p of this.players.values()) {
      if (!p.alive && t >= p.respawnAt) this.respawn(p);
      for (const k in p.fx) if (p.fx[k] <= t) { delete p.fx[k]; if (k === 'shield') p.shieldHp = 0; }
    }

    // pickups
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const pr = this.has(p, 'magnet') ? 230 : p.T.pickup;
      const cap = this.trayCap(p);
      if (p.tray.length < cap) {
        for (const l of this.letters.values()) {
          if (Math.abs(l.x - p.x) > pr || Math.abs(l.y - p.y) > pr) continue;
          if (l.noPick === p.id && t < l.noPickUntil) continue;
          if (dist2(l.x, l.y, p.x, p.y) > pr * pr) continue;
          p.tray.push(l.c);
          this.letters.delete(l.id);
          this.lRem.push([l.id, p.id]);
          if (this.letters.size + this.pendingLetters.length < this.letterTarget) this.pendingLetters.push(t + S.letterRespawn);
          if (p.tray.length >= cap) break;
        }
      }
      if (p.inv.length < S.inventorySlots) {
        for (const u of this.pups.values()) {
          const r = p.T.radius + 22;
          if (dist2(u.x, u.y, p.x, p.y) > r * r) continue;
          p.inv.push(u.k);
          this.pups.delete(u.id);
          this.pRem.push([u.id, p.id]);
          this.pendingPups.push(t + 12 + Math.random() * 10);
          break;
        }
      }
    }
    // respawn letters / pups
    this.pendingLetters = this.pendingLetters.filter((at) => { if (at <= t) { if (this.letters.size < this.letterTarget) this.spawnLetter(); return false; } return true; });
    while (this.letters.size + this.pendingLetters.length < this.letterTarget * 0.6) this.pendingLetters.push(t + S.letterRespawn);
    this.pendingPups = this.pendingPups.filter((at) => { if (at <= t) { if (this.pups.size < this.pupTarget) this.spawnPup(); return false; } return true; });

    // bullets
    const keep = [];
    for (const b of this.bullets) {
      const nx = b.x + b.vx * DT, ny = b.y + b.vy * DT;
      b.life -= DT;
      let hitT = 2, hitTank = null;
      for (const o of WT.nearby(this.grid, (b.x + nx) / 2, (b.y + ny) / 2, 100)) {
        const tt = WT.segCircle(b.x, b.y, nx, ny, o.x, o.y, o.r + b.r * 0.5);
        if (tt >= 0 && tt < hitT) { hitT = tt; hitTank = null; }
      }
      const owner = this.players.get(b.owner);
      for (const p of this.players.values()) {
        if (!p.alive || p.id === b.owner) continue;
        if (owner && !this.canHurt(owner, p)) continue;
        const tt = WT.segCircle(b.x, b.y, nx, ny, p.x, p.y, p.T.radius + b.r);
        if (tt >= 0 && tt < hitT) { hitT = tt; hitTank = p; }
      }
      if (hitT <= 1) {
        const hx = b.x + (nx - b.x) * hitT, hy = b.y + (ny - b.y) * hitT;
        if (hitTank) this.damage(hitTank, owner, b.dmg, hx, hy, b.w);
        else this.events.push({ k: 'impact', x: Math.round(hx), y: Math.round(hy), d: b.dmg });
        continue;
      }
      if (b.life <= 0 || nx < 0 || ny < 0 || nx > this.w || ny > this.h) { this.events.push({ k: 'fizzle', x: Math.round(nx), y: Math.round(ny) }); continue; }
      b.x = nx; b.y = ny;
      keep.push(b);
    }
    this.bullets = keep;

    // mines
    this.mines = this.mines.filter((m) => {
      if (t > m.until) return false;
      if (t < m.armAt) return true;
      const owner = this.players.get(m.owner);
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (owner ? !this.canHurt(owner, p) : p.id === m.owner) continue;
        if (dist2(p.x, p.y, m.x, m.y) < (p.T.radius + 16) * (p.T.radius + 16)) {
          this.events.push({ k: 'boom', x: Math.round(m.x), y: Math.round(m.y), r: 100 });
          for (const q of this.players.values()) {
            if (!q.alive || (owner && !this.canHurt(owner, q))) continue;
            const d = Math.sqrt(dist2(q.x, q.y, m.x, m.y));
            if (d < 100 + q.T.radius) this.damage(q, owner, Math.round(45 * (1 - Math.max(0, d - q.T.radius) / 140)), q.x, q.y, 'MINE');
          }
          return false;
        }
      }
      return true;
    });

    this.broadcast();
  }

  broadcast() {
    const t = now();
    const plist = Array.from(this.players.values());
    const flagsOf = (p) => (this.has(p, 'shield') ? 1 : 0) | (this.has(p, 'speed') ? 2 : 0) | (this.has(p, 'damage') ? 4 : 0) |
      (this.has(p, 'rapid') ? 8 : 0) | (this.has(p, 'magnet') ? 16 : 0) | (this.has(p, 'cloak') ? 32 : 0) | (p.protectUntil > t ? 64 : 0) | (p.alive ? 0 : 128);
    const pRows = plist.map((p) => [p.id, Math.round(p.x), Math.round(p.y), Math.round(p.a * 100) / 100, Math.round(p.ta * 100) / 100, Math.round(p.hp), flagsOf(p), p.kills, p.deaths]);
    const timeLeft = this.endsAt ? Math.max(0, Math.round(this.endsAt - t)) : -1;
    const common = { lA: this.lAdd, lR: this.lRem, pA: this.pAdd, pR: this.pRem, ev: this.events, tl: timeLeft, ts: this.teamScore };
    for (const me of plist) {
      const c = clients.get(me.id);
      if (!c || !c.ws.open) continue;
      const VIEW = 1700;
      const ps = [];
      for (let i = 0; i < plist.length; i++) {
        const o = plist[i];
        if (o !== me && (pRows[i][6] & 32) && this.isEnemy(me, o) && dist2(o.x, o.y, me.x, me.y) > 160 * 160) continue; // cloaked
        ps.push(pRows[i]);
      }
      const bs = [];
      for (const b of this.bullets) if (Math.abs(b.x - me.x) < VIEW && Math.abs(b.y - me.y) < VIEW) bs.push([b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), Math.round(b.r * 10) / 10, b.dmg]);
      const ms = [];
      for (const m of this.mines) if (m.owner === me.id || (this.s.mode === 'teams' && m.team === me.team)) ms.push([m.id, Math.round(m.x), Math.round(m.y), t >= m.armAt ? 1 : 0]);
      const fx = {};
      for (const k in me.fx) fx[k] = Math.round((me.fx[k] - t) * 10) / 10;
      const msg = Object.assign({
        t: 's', p: ps, b: bs, m: ms,
        me: {
          seq: me.spawnSeq, x: Math.round(me.x), y: Math.round(me.y), hp: Math.round(me.hp), alive: me.alive,
          rs: me.alive ? 0 : Math.max(0, Math.round((me.respawnAt - t) * 10) / 10),
          tray: me.tray, cap: this.trayCap(me), ammo: me.ammo.map((a) => [a.w, a.d, a.n]), inv: me.inv, slots: this.s.inventorySlots,
          fx, sh: me.shieldHp, fix: me.fix
        }
      }, common);
      me.fix = null;
      c.ws.sendVolatile(JSON.stringify(msg));
    }
    this.events = []; this.lAdd = []; this.lRem = []; this.pAdd = []; this.pRem = [];
  }
}

// ---------------------------------------------------------------- connections
attach(server, (ws) => {
  const c = { id: uid(), ws, name: 'Player', tank: 'striker', color: WT.COLORS[0], roomId: null, team: -1, lastMsg: 0, msgCount: 0 };
  clients.set(c.id, c);
  send(c, { t: 'welcome', id: c.id });

  ws.on('message', (raw) => {
    // light flood protection
    const t = Date.now();
    if (t - c.lastMsg > 1000) { c.lastMsg = t; c.msgCount = 0; }
    if (++c.msgCount > 120) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    handle(c, m);
  });
  ws.on('close', () => { leaveRoom(c); clients.delete(c.id); lobbyDirty = true; });
});

function handle(c, m) {
  const room = c.roomId ? rooms.get(c.roomId) : null;
  const game = room && room.game;
  const p = game ? game.players.get(c.id) : null;
  switch (m.t) {
    case 'profile':
      c.name = cleanName(m.name, 16) || 'Player';
      if (WT.TANKS[m.tank]) c.tank = m.tank;
      if (/^#[0-9a-f]{6}$/i.test(m.color)) c.color = m.color;
      if (room) { if (!room.settings.allowedTanks.includes(c.tank)) c.tank = room.settings.allowedTanks[0]; sendRoomState(room); }
      send(c, { t: 'profileOk', name: c.name, tank: c.tank, color: c.color });
      break;
    case 'list': send(c, { t: 'rooms', rooms: roomsList() }); break;
    case 'create': {
      const settings = WT.sanitize(m.settings);
      const r = { id: uid(), hostId: c.id, settings, members: new Set(), state: 'lobby', game: null };
      rooms.set(r.id, r);
      joinRoom(c, r);
      break;
    }
    case 'join': {
      const r = rooms.get(m.id);
      if (!r) return send(c, { t: 'error', msg: 'That game no longer exists.' });
      if (r.members.has(c.id)) return;
      if (r.members.size >= r.settings.maxPlayers) return send(c, { t: 'error', msg: 'That game is full.' });
      if (r.state === 'playing' && !r.settings.lateJoin) return send(c, { t: 'error', msg: 'That game is already in progress.' });
      if (r.settings.password && String(m.password || '') !== r.settings.password) return send(c, { t: 'error', msg: 'Wrong password.', needPassword: true, id: r.id });
      joinRoom(c, r);
      break;
    }
    case 'leave': leaveRoom(c); send(c, { t: 'left' }); break;
    case 'settings':
      if (!room || room.hostId !== c.id || room.state === 'playing') return;
      {
        const pw = room.settings.password;
        const incoming = Object.assign({}, m.settings);
        if (incoming.keepPassword) incoming.password = pw;
        room.settings = WT.sanitize(incoming, room.settings);
        for (const id of room.members) {
          const o = clients.get(id);
          if (!room.settings.allowedTanks.includes(o.tank)) o.tank = room.settings.allowedTanks[0];
          if (room.settings.mode === 'teams' && o.team < 0) assignTeam(room, o);
          if (room.settings.mode !== 'teams') o.team = -1;
        }
        sendRoomState(room);
      }
      break;
    case 'team':
      if (!room || room.state === 'playing' || room.settings.mode !== 'teams') return;
      if (m.team === 0 || m.team === 1) { c.team = m.team; sendRoomState(room); }
      break;
    case 'kick':
      if (!room || room.hostId !== c.id || m.id === c.id) return;
      { const o = clients.get(m.id); if (o && o.roomId === room.id) { leaveRoom(o); send(o, { t: 'kicked' }); } }
      break;
    case 'start':
      if (!room || room.hostId !== c.id || room.state === 'playing') return;
      room.state = 'playing';
      room.game = new Game(room);
      room.game.start();
      sendRoomState(room);
      break;
    case 'end':
      if (game && room.hostId === c.id) game.finish();
      break;
    case 'backToRoom':
      if (room && room.hostId === c.id && room.state === 'ended') { room.state = 'lobby'; sendRoomState(room); }
      break;
    case 'st': if (p) game.onState(p, m); break;
    case 'fire': if (p) game.onFire(p, m); break;
    case 'word': if (p) game.onWord(p, m, c); break;
    case 'drop': if (p) game.onDrop(p, m); break;
    case 'use': if (p) game.onUse(p, m); break;
    case 'ammo': if (p) game.onSelectAmmo(p, m); break;
  }
}

// lobby list broadcast + keepalive
setInterval(() => {
  if (!lobbyDirty) return;
  lobbyDirty = false;
  const msg = JSON.stringify({ t: 'rooms', rooms: roomsList() });
  for (const c of clients.values()) if (!c.roomId && c.ws.open) c.ws.send(msg);
}, 700);
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.ws.alive) { c.ws.close(1001); continue; }
    c.ws.alive = false;
    c.ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log('Word Tanks running on http://localhost:' + PORT));
