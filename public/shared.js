// Shared by server (require) and browser (window.WT): tanks, power-ups, settings, physics helpers.
(function (root) {
  'use strict';

  const TANKS = {
    scout:   { name: 'Scout',   desc: 'Fast and nimble, but fragile.',            hp: 80,  speed: 265, reload: 0.32, bulletSpeed: 820,  range: 850,  radius: 20, tray: 0, pickup: 44, dmgMult: 1.0 },
    striker: { name: 'Striker', desc: 'Balanced all-rounder.',                    hp: 110, speed: 215, reload: 0.42, bulletSpeed: 780,  range: 900,  radius: 22, tray: 0, pickup: 44, dmgMult: 1.0 },
    titan:   { name: 'Titan',   desc: 'Heavy armour, slow tracks.',               hp: 165, speed: 165, reload: 0.55, bulletSpeed: 720,  range: 850,  radius: 26, tray: 0, pickup: 48, dmgMult: 1.0 },
    longshot:{ name: 'Longshot',desc: 'Long range, hard-hitting shells.',         hp: 90,  speed: 195, reload: 0.70, bulletSpeed: 1150, range: 1350, radius: 22, tray: 0, pickup: 44, dmgMult: 1.2 },
    lexicon: { name: 'Lexicon', desc: 'Word specialist: +3 letter slots, wider pickup.', hp: 100, speed: 205, reload: 0.48, bulletSpeed: 780, range: 900, radius: 22, tray: 3, pickup: 70, dmgMult: 1.0 }
  };

  const COLORS = ['#3d9a4a', '#d9a431', '#c94b3b', '#3b78c9', '#8a52c7', '#2ba3a3', '#e07a2f', '#6b6f78'];
  const TEAM_COLORS = ['#d24a3c', '#3a73d1'];
  const TEAM_NAMES = ['Red', 'Blue'];

  const POWERUPS = {
    shield:   { name: 'Shield',        icon: '🛡️', color: '#5ab8ff', desc: 'Absorbs 60 damage' },
    speed:    { name: 'Speed Boost',   icon: '⚡', color: '#ffd23f', desc: '+55% speed' },
    repair:   { name: 'Repair Kit',    icon: '🔧', color: '#59d185', desc: 'Restore 50% health' },
    damage:   { name: 'Double Damage', icon: '💥', color: '#ff6b4a', desc: 'Shells hit twice as hard' },
    rapid:    { name: 'Rapid Fire',    icon: '🔥', color: '#ff9f1c', desc: 'Reload much faster' },
    magnet:   { name: 'Letter Magnet', icon: '🧲', color: '#d66bff', desc: 'Pull in letters from afar' },
    wildcard: { name: 'Wildcard Tile', icon: '❓', color: '#ffffff', desc: 'A blank tile = any letter' },
    mine:     { name: 'Land Mine',     icon: '💣', color: '#9aa0a6', desc: 'Hidden mine, 45 damage' },
    cloak:    { name: 'Camouflage',    icon: '👻', color: '#b8c7d9', desc: 'Invisible to enemies (firing reveals)' }
  };
  const PU_BASE_DURATION = { shield: 10, speed: 7, damage: 10, rapid: 8, magnet: 10, cloak: 7 };

  const MAP_SIZES = { small: 2400, medium: 3600, large: 5000, huge: 7000 };

  // Granular host settings. type: text | range | select | toggle
  const SETTINGS = [
    { group: 'Room', key: 'roomName', label: 'Room name', type: 'text', def: '', max: 24 },
    { group: 'Room', key: 'password', label: 'Password (optional)', type: 'text', def: '', max: 16 },
    { group: 'Room', key: 'maxPlayers', label: 'Max players', type: 'range', min: 2, max: 16, step: 1, def: 8 },
    { group: 'Room', key: 'lateJoin', label: 'Allow joining mid-game', type: 'toggle', def: true },

    { group: 'Match', key: 'mode', label: 'Mode', type: 'select', def: 'ffa', options: [['ffa', 'Free-for-all'], ['teams', 'Red vs Blue']] },
    { group: 'Match', key: 'killLimit', label: 'Kill limit (0 = none)', type: 'range', min: 0, max: 60, step: 1, def: 15 },
    { group: 'Match', key: 'timeLimit', label: 'Time limit, minutes (0 = none)', type: 'range', min: 0, max: 30, step: 1, def: 8 },
    { group: 'Match', key: 'respawnTime', label: 'Respawn delay (s)', type: 'range', min: 1, max: 15, step: 1, def: 4 },
    { group: 'Match', key: 'spawnProtection', label: 'Spawn protection (s)', type: 'range', min: 0, max: 6, step: 0.5, def: 2 },
    { group: 'Match', key: 'friendlyFire', label: 'Friendly fire (teams)', type: 'toggle', def: false },

    { group: 'Map', key: 'mapSize', label: 'Map size', type: 'select', def: 'large', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['huge', 'Huge']] },
    { group: 'Map', key: 'rockDensity', label: 'Rocks', type: 'range', min: 0, max: 3, step: 0.25, def: 1 },
    { group: 'Map', key: 'treeDensity', label: 'Trees', type: 'range', min: 0, max: 3, step: 0.25, def: 1 },
    { group: 'Map', key: 'letterDensity', label: 'Letters on map', type: 'range', min: 0.25, max: 3, step: 0.25, def: 1 },
    { group: 'Map', key: 'vowelBoost', label: 'Vowel frequency', type: 'range', min: 0.5, max: 2, step: 0.1, def: 1 },
    { group: 'Map', key: 'letterRespawn', label: 'Letter respawn (s)', type: 'range', min: 0, max: 20, step: 1, def: 3 },

    { group: 'Words & Ammo', key: 'dictionary', label: 'Dictionary', type: 'select', def: 'all', options: [['all', 'All word forms (cats, jumped…)'], ['root', 'Root words only']] },
    { group: 'Words & Ammo', key: 'minWordLength', label: 'Minimum word length', type: 'range', min: 2, max: 5, step: 1, def: 3 },
    { group: 'Words & Ammo', key: 'trayCapacity', label: 'Letter tray size', type: 'range', min: 5, max: 14, step: 1, def: 10 },
    { group: 'Words & Ammo', key: 'damageBase', label: 'Damage of a 3-letter word', type: 'range', min: 2, max: 30, step: 1, def: 10 },
    { group: 'Words & Ammo', key: 'damageGrowth', label: 'Damage × per extra letter', type: 'range', min: 1.2, max: 3, step: 0.1, def: 2 },
    { group: 'Words & Ammo', key: 'shellsPerWord', label: 'Shells per word', type: 'range', min: 1, max: 10, step: 1, def: 3 },
    { group: 'Words & Ammo', key: 'basicCannon', label: 'Basic cannon damage (0 = off)', type: 'range', min: 0, max: 10, step: 1, def: 3 },
    { group: 'Words & Ammo', key: 'noRepeatWords', label: 'No repeating your own words', type: 'toggle', def: false },
    { group: 'Words & Ammo', key: 'dropLetters', label: 'Drop letters on destruction', type: 'toggle', def: true },

    { group: 'Tanks & Combat', key: 'hpMult', label: 'Tank health ×', type: 'range', min: 0.5, max: 3, step: 0.1, def: 1 },
    { group: 'Tanks & Combat', key: 'speedMult', label: 'Tank speed ×', type: 'range', min: 0.5, max: 2, step: 0.1, def: 1 },
    { group: 'Tanks & Combat', key: 'reloadMult', label: 'Reload time ×', type: 'range', min: 0.3, max: 3, step: 0.1, def: 1 },
    { group: 'Tanks & Combat', key: 'bulletSpeedMult', label: 'Shell speed ×', type: 'range', min: 0.5, max: 2, step: 0.1, def: 1 },
    { group: 'Tanks & Combat', key: 'allowedTanks', label: 'Allowed tanks', type: 'multi', def: Object.keys(TANKS), options: Object.keys(TANKS).map(k => [k, TANKS[k].name]) },

    { group: 'Power-ups', key: 'powerupFrequency', label: 'Power-ups on map', type: 'range', min: 0, max: 3, step: 0.25, def: 1 },
    { group: 'Power-ups', key: 'powerupDuration', label: 'Effect duration ×', type: 'range', min: 0.5, max: 2.5, step: 0.1, def: 1 },
    { group: 'Power-ups', key: 'inventorySlots', label: 'Inventory slots', type: 'range', min: 1, max: 5, step: 1, def: 3 },
    { group: 'Power-ups', key: 'powerups', label: 'Enabled power-ups', type: 'multi', def: Object.keys(POWERUPS), options: Object.keys(POWERUPS).map(k => [k, POWERUPS[k].icon + ' ' + POWERUPS[k].name]) }
  ];

  function defaults() {
    const s = {};
    for (const d of SETTINGS) s[d.key] = Array.isArray(d.def) ? d.def.slice() : d.def;
    return s;
  }

  function sanitize(input, base) {
    const s = base ? Object.assign({}, base) : defaults();
    input = input || {};
    for (const d of SETTINGS) {
      if (!(d.key in input)) continue;
      const v = input[d.key];
      if (d.type === 'text') s[d.key] = String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, d.max);
      else if (d.type === 'range') {
        let n = Number(v); if (!isFinite(n)) continue;
        n = Math.min(d.max, Math.max(d.min, n));
        n = Math.round(n / d.step) * d.step;
        s[d.key] = Math.round(n * 100) / 100;
      } else if (d.type === 'toggle') s[d.key] = !!v;
      else if (d.type === 'select') { if (d.options.some(o => o[0] === v)) s[d.key] = v; }
      else if (d.type === 'multi') {
        if (Array.isArray(v)) {
          const ok = v.filter(x => d.options.some(o => o[0] === x));
          if (d.key !== 'allowedTanks' || ok.length) s[d.key] = Array.from(new Set(ok));
        }
      }
    }
    return s;
  }

  // Exponential damage: a 3-letter word does damageBase, each extra letter multiplies by damageGrowth.
  function damageFor(len, s) {
    const L = Math.min(len, 12);
    return Math.max(1, Math.round(s.damageBase * Math.pow(s.damageGrowth, L - 3)));
  }

  // ---- obstacle spatial grid + circle collision (identical on client and server) ----
  const CELL = 160;
  function buildGrid(obstacles, w, h) {
    const cols = Math.ceil(w / CELL) + 1, rows = Math.ceil(h / CELL) + 1;
    const cells = new Array(cols * rows);
    for (let i = 0; i < cells.length; i++) cells[i] = [];
    obstacles.forEach((o) => {
      const r = o.r;
      const x0 = Math.max(0, Math.floor((o.x - r) / CELL)), x1 = Math.min(cols - 1, Math.floor((o.x + r) / CELL));
      const y0 = Math.max(0, Math.floor((o.y - r) / CELL)), y1 = Math.min(rows - 1, Math.floor((o.y + r) / CELL));
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) cells[cy * cols + cx].push(o);
    });
    return { cols, rows, cells, w, h };
  }
  function nearby(grid, x, y, rad, out) {
    out = out || [];
    out.length = 0;
    const x0 = Math.max(0, Math.floor((x - rad) / CELL)), x1 = Math.min(grid.cols - 1, Math.floor((x + rad) / CELL));
    const y0 = Math.max(0, Math.floor((y - rad) / CELL)), y1 = Math.min(grid.rows - 1, Math.floor((y + rad) / CELL));
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const c = grid.cells[cy * grid.cols + cx];
      for (let i = 0; i < c.length; i++) if (out.indexOf(c[i]) < 0) out.push(c[i]);
    }
    return out;
  }
  const _tmp = [];
  // Push a circle out of obstacles and keep it in the map. Returns [x, y].
  function resolve(grid, x, y, r) {
    for (let iter = 0; iter < 3; iter++) {
      const list = nearby(grid, x, y, r + 80, _tmp);
      let moved = false;
      for (const o of list) {
        const dx = x - o.x, dy = y - o.y, min = r + o.r;
        const d2 = dx * dx + dy * dy;
        if (d2 < min * min) {
          const d = Math.sqrt(d2) || 0.001;
          const push = min - d;
          x += (dx / d) * push; y += (dy / d) * push; moved = true;
        }
      }
      x = Math.max(r, Math.min(grid.w - r, x));
      y = Math.max(r, Math.min(grid.h - r, y));
      if (!moved) break;
    }
    return [x, y];
  }
  // Does segment (x1,y1)-(x2,y2) hit a circle (cx,cy,cr)? returns t (0..1) or -1
  function segCircle(x1, y1, x2, y2, cx, cy, cr) {
    const dx = x2 - x1, dy = y2 - y1;
    const fx = x1 - cx, fy = y1 - cy;
    const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - cr * cr;
    if (c <= 0) return 0;
    if (a === 0) return -1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t >= 0 && t <= 1 ? t : -1;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const api = { TANKS, COLORS, TEAM_COLORS, TEAM_NAMES, POWERUPS, PU_BASE_DURATION, MAP_SIZES, SETTINGS, defaults, sanitize, damageFor, buildGrid, nearby, resolve, segCircle, mulberry32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WT = api;
})(typeof window !== 'undefined' ? window : this);
