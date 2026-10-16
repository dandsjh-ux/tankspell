// Word Tanks — app shell: networking, tank select, lobby, room settings, results.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };

  const state = {
    myId: null, profile: store.get('wt_profile', { name: '', tank: 'striker', color: WT.COLORS[0] }),
    room: null, rooms: [], screen: 'select', profileSent: false, lastCreate: store.get('wt_settings', null)
  };
  if (!WT.TANKS[state.profile.tank]) state.profile.tank = 'striker';

  // ================================================================ networking
  let ws = null, retry = 0, outbox = [];
  const net = {
    send(o) { const s = JSON.stringify(o); if (ws && ws.readyState === 1) ws.send(s); else if (o.t !== 'st' && o.t !== 'fire') outbox.push(s); }
  };
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = () => {
      retry = 0; $('netBanner').classList.add('hidden');
      if (state.profileSent) sendProfile();
      outbox.forEach((s) => ws.send(s)); outbox = [];
      net.send({ t: 'list' });
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } onMessage(m); };
    ws.onclose = () => {
      $('netBanner').classList.remove('hidden');
      if (GAME.isRunning()) GAME.stop();
      if (state.room) { state.room = null; if (state.screen !== 'select') show('lobby'); }
      closeModal();
      setTimeout(connect, Math.min(5000, 500 * Math.pow(2, retry++)));
    };
  }

  function onMessage(m) {
    switch (m.t) {
      case 'welcome': state.myId = m.id; break;
      case 'profileOk': state.profile = { name: m.name, tank: m.tank, color: m.color }; store.set('wt_profile', state.profile); renderChips(); break;
      case 'rooms': state.rooms = m.rooms; renderRooms(); break;
      case 'joined': break;
      case 'room': onRoom(m.room); break;
      case 'left': state.room = null; show('lobby'); net.send({ t: 'list' }); break;
      case 'kicked': state.room = null; if (GAME.isRunning()) GAME.stop(); show('lobby'); closeModal(); toast('The host removed you from the battle.'); break;
      case 'error':
        if (m.needPassword) askPassword(m.id, true);
        else toast(m.msg);
        break;
      case 'gameStart':
        closeModal();
        show('game');
        GAME.start(m, net);
        break;
      case 's': GAME.snapshot(m); break;
      case 'wordResult': GAME.wordResult(m); break;
      case 'gameOver': GAME.setOver(); showResults(m); break;
    }
  }

  // ================================================================ screens
  function show(name) {
    state.screen = name;
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
    if (name !== 'game' && GAME.isRunning()) GAME.stop();
    if (name === 'select') startPreview(); else stopPreview();
  }
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3200);
  }
  function modal(html) { $('modalCard').innerHTML = html; $('modal').classList.remove('hidden'); return $('modalCard'); }
  function closeModal() { $('modal').classList.add('hidden'); }

  // ================================================================ tank select
  const STAT_DEFS = [
    ['Armour', (T) => T.hp, 80, 165],
    ['Speed', (T) => T.speed, 165, 265],
    ['Fire rate', (T) => 1 / T.reload, 1 / 0.7, 1 / 0.32],
    ['Range', (T) => T.range * (T.bulletSpeed / 800), 850 * 0.9, 1350 * 1.44],
    ['Letters', (T) => T.tray * 10 + T.pickup, 44, 100]
  ];
  function drawTankIn(canvas, tank, color, angle, turret, tread, zoom) {
    const c = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!canvas._css) canvas._css = [canvas.width, canvas.height]; // attribute size = fallback when hidden
    const w = canvas.clientWidth || canvas._css[0], h = canvas.clientHeight || canvas._css[1];
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, canvas.width, canvas.height);
    const z = (zoom || Math.min(w, h) / 70) * dpr;
    c.setTransform(z, 0, 0, z, canvas.width / 2, canvas.height / 2);
    ART.drawTank(c, tank, color, angle, turret, { tread: tread || 0 });
  }
  function allowedTanks() { return state.room ? state.room.settings.allowedTanks : Object.keys(WT.TANKS); }
  function buildSelect() {
    const grid = $('tankGrid'); grid.innerHTML = '';
    const allowed = allowedTanks();
    for (const key of Object.keys(WT.TANKS)) {
      const T = WT.TANKS[key];
      const card = document.createElement('button');
      card.className = 'tank-card' + (key === state.profile.tank ? ' sel' : '') + (allowed.includes(key) ? '' : ' locked');
      card.innerHTML = '<canvas></canvas><h3>' + T.name + '</h3>' + STAT_DEFS.map(([n, f, lo, hi]) =>
        '<div class="stat">' + n + '<i><b style="width:' + Math.round(Math.max(0.08, Math.min(1, (f(T) - lo) / (hi - lo))) * 100) + '%"></b></i></div>').join('');
      card.onclick = () => { state.profile.tank = key; buildSelect(); };
      grid.appendChild(card);
      requestAnimationFrame(() => drawTankIn(card.querySelector('canvas'), key, state.profile.color, -Math.PI / 2 + 0.5, -Math.PI / 2 + 0.2, 0, 1.6));
    }
    const sw = $('swatches'); sw.innerHTML = '';
    WT.COLORS.forEach((col) => {
      const s = document.createElement('div'); s.className = 'swatch' + (col === state.profile.color ? ' sel' : ''); s.style.background = col;
      s.onclick = () => { state.profile.color = col; buildSelect(); };
      sw.appendChild(s);
    });
    const T = WT.TANKS[state.profile.tank];
    $('previewName').textContent = T.name; $('previewDesc').textContent = T.desc;
    $('btnContinue').textContent = state.room ? 'Back to battle room ▸' : 'Deploy ▸';
  }
  let previewRaf = null;
  function startPreview() {
    buildSelect();
    if (previewRaf) return;
    const cv = $('tankPreview');
    const tick = (t) => {
      previewRaf = requestAnimationFrame(tick);
      const a = t / 2200;
      drawTankIn(cv, state.profile.tank, state.profile.color, a, a + Math.sin(t / 900) * 0.9, t / 40, (cv.clientWidth || 260) / 85);
    };
    previewRaf = requestAnimationFrame(tick);
  }
  function stopPreview() { if (previewRaf) cancelAnimationFrame(previewRaf); previewRaf = null; }
  $('nameInput').value = state.profile.name || '';
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnContinue').click(); });
  $('btnContinue').onclick = () => {
    GAME.unlockAudio();
    const name = $('nameInput').value.trim();
    if (!name) { $('nameInput').focus(); toast('Enter a commander name first.'); return; }
    state.profile.name = name;
    store.set('wt_profile', state.profile);
    sendProfile();
    show(state.room ? 'room' : 'lobby');
    if (state.room) renderRoom();
    net.send({ t: 'list' });
  };
  function sendProfile() { state.profileSent = true; net.send({ t: 'profile', name: state.profile.name, tank: state.profile.tank, color: state.profile.color }); renderChips(); }
  function renderChips() {
    for (const id of ['lobbyProfile', 'roomProfile']) {
      const el = $(id);
      el.innerHTML = '<canvas width="38" height="38"></canvas><span>' + esc(state.profile.name || 'Player') + ' <small>· ' + WT.TANKS[state.profile.tank].name + ' ✎</small></span>';
      requestAnimationFrame(() => drawTankIn(el.querySelector('canvas'), state.profile.tank, state.profile.color, -Math.PI / 2, -Math.PI / 2, 0, 0.7));
    }
  }
  $('lobbyProfile').onclick = () => show('select');
  $('roomProfile').onclick = () => show('select');

  // ================================================================ lobby
  function renderDmgTable() {
    const s = WT.defaults();
    $('dmgTable').innerHTML = [3, 4, 5, 6, 7, 8].map((n) => '<span>' + n + ' letters <b>' + WT.damageFor(n, s) + '</b></span>').join('');
  }
  function renderRooms() {
    const list = $('roomList');
    if (!state.rooms.length) { list.innerHTML = '<div class="empty">No battles right now.<br>Create one and invite your friends!</div>'; return; }
    const sizeName = { small: 'Small', medium: 'Medium', large: 'Large', huge: 'Huge' };
    list.innerHTML = '';
    state.rooms.slice().sort((a, b) => (b.joinable - a.joinable) || (b.players - a.players)).forEach((r) => {
      const el = document.createElement('div'); el.className = 'room-item';
      el.innerHTML = '<div><h3>' + (r.locked ? '🔒 ' : '') + esc(r.name) + '</h3><div class="meta">' +
        '<span class="tag ' + (r.state === 'playing' ? 'live' : 'wait') + '">' + (r.state === 'playing' ? '● In battle' : r.state === 'ended' ? 'Results' : 'Waiting') + '</span>' +
        '<span class="tag">👥 ' + r.players + '/' + r.max + '</span><span class="tag">' + (r.mode === 'teams' ? 'Red vs Blue' : 'Free-for-all') + '</span>' +
        '<span class="tag">🗺️ ' + (sizeName[r.map] || r.map) + '</span><span>Host: ' + esc(r.host) + '</span></div></div>';
      const b = document.createElement('button'); b.className = 'btn primary'; b.textContent = r.state === 'playing' ? 'Join battle' : 'Join';
      b.disabled = !r.joinable;
      b.onclick = () => { GAME.unlockAudio(); if (r.locked) askPassword(r.id); else net.send({ t: 'join', id: r.id }); };
      el.appendChild(b);
      list.appendChild(el);
    });
  }
  function askPassword(id, wrong) {
    const card = modal('<h2>Password</h2><p class="muted">' + (wrong ? 'That password was wrong — try again.' : 'This battle is private.') + '</p><input id="pwInput" type="text" maxlength="16" autocomplete="off" style="width:100%"><div class="modal-actions"><button class="btn ghost" id="pwCancel">Cancel</button><button class="btn primary" id="pwGo">Join</button></div>');
    const inp = card.querySelector('#pwInput'); inp.focus();
    const go = () => { net.send({ t: 'join', id, password: inp.value }); closeModal(); };
    card.querySelector('#pwGo').onclick = go;
    inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    card.querySelector('#pwCancel').onclick = closeModal;
  }
  $('btnCreate').onclick = () => {
    const s = Object.assign(WT.defaults(), state.lastCreate || {});
    s.roomName = (state.profile.name || 'Player') + "'s battle"; s.password = '';
    createValues = s;
    buildForm($('createForm'), createValues, true, (v) => { createValues = v; });
    show('create');
  };
  let createValues = null;
  $('btnCreateCancel').onclick = () => show('lobby');
  $('btnCreateGo').onclick = () => {
    const s = Object.assign({}, createValues);
    const remember = Object.assign({}, s); delete remember.roomName; delete remember.password;
    state.lastCreate = remember; store.set('wt_settings', remember);
    net.send({ t: 'create', settings: s });
  };

  // ================================================================ settings form
  function fmtVal(d, v) {
    if (d.key === 'timeLimit' || d.key === 'killLimit') return v === 0 ? 'None' : v;
    if (d.step < 1) return (Math.round(v * 100) / 100) + (/Mult|Duration|Growth|Density|Boost|Frequency/.test(d.key) ? '×' : '');
    return v;
  }
  function buildForm(root, values, editable, onChange, opts) {
    opts = opts || {};
    const wasOpen = Array.from(root.querySelectorAll('details')).map((d) => [d.querySelector('summary').textContent, d.open]);
    const openMap = wasOpen.length ? Object.fromEntries(wasOpen) : null;
    root.innerHTML = '';
    root.classList.toggle('readonly', !editable);
    const groups = {};
    for (const d of WT.SETTINGS) {
      if (opts.skip && opts.skip.includes(d.key)) continue;
      (groups[d.group] = groups[d.group] || []).push(d);
    }
    let first = true;
    for (const g of Object.keys(groups)) {
      const det = document.createElement('details');
      det.open = openMap && g in openMap ? openMap[g] : (first || !!opts.openAll); first = false;
      det.innerHTML = '<summary>' + g + '</summary>';
      const grid = document.createElement('div'); grid.className = 'set-grid';
      for (const d of groups[g]) grid.appendChild(settingControl(d, values, editable, onChange, opts));
      det.appendChild(grid);
      root.appendChild(det);
    }
  }
  function settingControl(d, values, editable, onChange, opts) {
    const wrap = document.createElement('div'); wrap.className = 'set';
    const emit = () => onChange && onChange(values);
    if (d.type === 'range') {
      wrap.innerHTML = '<div class="lab"><span>' + d.label + '</span><b>' + fmtVal(d, values[d.key]) + '</b></div>';
      const r = document.createElement('input'); r.type = 'range'; r.min = d.min; r.max = d.max; r.step = d.step; r.value = values[d.key]; r.disabled = !editable;
      r.oninput = () => { values[d.key] = Number(r.value); wrap.querySelector('b').textContent = fmtVal(d, values[d.key]); if (d.key === 'damageBase' || d.key === 'damageGrowth') showDmgHint(); emit(); };
      wrap.appendChild(r);
      if (d.key === 'damageGrowth') {
        const hint = document.createElement('div'); hint.className = 'muted dmg-hint'; hint.style.fontSize = '12px'; wrap.appendChild(hint);
        const showDmgHint = () => { hint.textContent = [3, 4, 5, 6, 7].map((n) => n + '→' + WT.damageFor(n, values)).join('  ·  '); };
        showDmgHint();
        wrap._hint = showDmgHint;
      }
      function showDmgHint() { const h = wrap.parentElement && wrap.parentElement.querySelector('.dmg-hint'); if (h) h.textContent = [3, 4, 5, 6, 7].map((n) => n + '→' + WT.damageFor(n, values)).join('  ·  '); }
    } else if (d.type === 'toggle') {
      wrap.className = 'set toggle';
      wrap.innerHTML = '<span class="muted">' + d.label + '</span>';
      const lab = document.createElement('label'); lab.className = 'switch';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!values[d.key]; cb.disabled = !editable;
      cb.onchange = () => { values[d.key] = cb.checked; emit(); };
      lab.appendChild(cb); lab.appendChild(document.createElement('span'));
      wrap.appendChild(lab);
    } else if (d.type === 'select') {
      wrap.innerHTML = '<div class="lab"><span>' + d.label + '</span></div>';
      const sel = document.createElement('select'); sel.disabled = !editable;
      d.options.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (values[d.key] === v) o.selected = true; sel.appendChild(o); });
      sel.onchange = () => { values[d.key] = sel.value; emit(); };
      wrap.appendChild(sel);
    } else if (d.type === 'text') {
      wrap.innerHTML = '<div class="lab"><span>' + d.label + '</span></div>';
      const inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = d.max; inp.disabled = !editable;
      if (d.key === 'password' && opts.passwordPlaceholder) { inp.placeholder = opts.passwordPlaceholder; inp.value = ''; }
      else inp.value = values[d.key] || '';
      inp.oninput = () => { values[d.key] = inp.value; if (d.key === 'password') values.keepPassword = false; emit(); };
      wrap.appendChild(inp);
    } else if (d.type === 'multi') {
      wrap.innerHTML = '<div class="lab"><span>' + d.label + '</span></div>';
      const chips = document.createElement('div'); chips.className = 'chips';
      d.options.forEach(([v, l]) => {
        const c = document.createElement('span'); c.className = 'chip' + (values[d.key].includes(v) ? ' on' : ''); c.textContent = l;
        c.onclick = () => {
          if (!editable) return;
          const arr = values[d.key];
          if (arr.includes(v)) { if (d.key === 'allowedTanks' && arr.length === 1) return toast('At least one tank must be allowed.'); values[d.key] = arr.filter((x) => x !== v); }
          else values[d.key] = arr.concat([v]);
          c.classList.toggle('on');
          emit();
        };
        chips.appendChild(c);
      });
      wrap.appendChild(chips);
    }
    return wrap;
  }

  // ================================================================ room
  let roomValues = null, roomFormKey = '', settingsTimer = null;
  function onRoom(room) {
    const prevState = state.room ? state.room.state : null;
    state.room = room;
    const me = room.players.find((p) => p.id === state.myId);
    if (me && me.tank !== state.profile.tank) { state.profile.tank = me.tank; renderChips(); }
    if (room.state === 'lobby' && (state.screen === 'game' || state.screen === 'lobby' || state.screen === 'create')) { closeModal(); show('room'); }
    if (room.state === 'lobby' && prevState === 'ended') closeModal();
    if (state.screen === 'select') buildSelect();
    renderRoom();
  }
  function renderRoom() {
    const room = state.room; if (!room) return;
    const S = room.settings;
    const isHost = room.hostId === state.myId;
    $('roomTitle').textContent = (S.hasPassword ? '🔒 ' : '') + (S.roomName || 'Battle room');
    $('roomSub').textContent = (S.mode === 'teams' ? 'Red vs Blue' : 'Free-for-all') + ' · ' + room.players.length + '/' + S.maxPlayers + ' commanders · ' +
      (S.killLimit ? 'first to ' + S.killLimit + ' kills' : 'no kill limit') + ' · ' + (S.timeLimit ? S.timeLimit + ' min' : 'no time limit');
    const pc = $('roomPlayers'); pc.innerHTML = '';
    const card = (p) => {
      const el = document.createElement('div'); el.className = 'pcard' + (p.id === state.myId ? ' me' : '');
      el.innerHTML = '<canvas width="54" height="54"></canvas><div><div class="nm">' + esc(p.name) + (p.id === room.hostId ? '<span class="badge">HOST</span>' : '') + '</div><div class="sub">' + WT.TANKS[p.tank].name + '</div></div>';
      if (isHost && p.id !== state.myId) { const k = document.createElement('button'); k.className = 'kick'; k.title = 'Remove'; k.textContent = '✕'; k.onclick = () => net.send({ t: 'kick', id: p.id }); el.appendChild(k); }
      const col = S.mode === 'teams' && p.team >= 0 ? WT.TEAM_COLORS[p.team] : p.color;
      requestAnimationFrame(() => drawTankIn(el.querySelector('canvas'), p.tank, col, -Math.PI / 2, -Math.PI / 2 + 0.3, 0, 0.95));
      return el;
    };
    if (S.mode === 'teams') {
      pc.className = 'room-players teams';
      [0, 1].forEach((team) => {
        const col = document.createElement('div'); col.className = 'team-col'; col.style.borderColor = WT.TEAM_COLORS[team];
        const mine = room.players.find((p) => p.id === state.myId);
        col.innerHTML = '<h3 style="color:' + WT.TEAM_COLORS[team] + '">' + WT.TEAM_NAMES[team] + '</h3>';
        if (mine && mine.team !== team && room.state !== 'playing') { const b = document.createElement('button'); b.className = 'btn ghost'; b.textContent = 'Switch here'; b.style.padding = '4px 10px'; b.onclick = () => net.send({ t: 'team', team }); col.querySelector('h3').appendChild(b); }
        room.players.filter((p) => p.team === team).forEach((p) => col.appendChild(card(p)));
        pc.appendChild(col);
      });
    } else {
      pc.className = 'room-players';
      room.players.forEach((p) => pc.appendChild(card(p)));
    }
    const startBtn = $('btnStart');
    startBtn.classList.toggle('hidden', !isHost);
    startBtn.textContent = room.state === 'playing' ? 'Battle in progress…' : 'Start battle ▸';
    startBtn.disabled = room.state === 'playing';
    $('roomWaitMsg').textContent = isHost ? (room.players.length < 2 ? 'Tip: you can start solo to explore the map, or wait for others to join from the lobby.' : '') : 'Waiting for the host to start the battle…';
    $('roomSettingsTitle').textContent = isHost ? 'Settings (you can edit)' : 'Settings';
    // only rebuild the form when settings change from outside (avoid fighting the host's slider)
    const key = JSON.stringify(S) + isHost;
    if (key !== roomFormKey && !(isHost && settingsTimer)) {
      roomFormKey = key;
      roomValues = Object.assign({}, S, { password: '', keepPassword: true });
      buildForm($('roomForm'), roomValues, isHost && room.state !== 'playing', (v) => {
        clearTimeout(settingsTimer);
        settingsTimer = setTimeout(() => { settingsTimer = null; net.send({ t: 'settings', settings: v }); }, 350);
      }, { passwordPlaceholder: S.hasPassword ? '(unchanged)' : 'none' });
    }
  }
  $('btnLeaveRoom').onclick = () => net.send({ t: 'leave' });
  $('btnStart').onclick = () => { GAME.unlockAudio(); net.send({ t: 'start' }); };

  // ================================================================ in-game menu & results
  $('btnMenu').onclick = () => {
    const isHost = state.room && state.room.hostId === state.myId;
    const card = modal('<h2>Menu</h2><p class="muted">' + esc(state.room ? state.room.settings.roomName : '') + '</p><div class="modal-actions" style="justify-content:stretch;flex-direction:column">' +
      '<button class="btn primary" id="mResume">Resume</button>' +
      '<button class="btn" id="mHow">How to play</button>' +
      (isHost ? '<button class="btn danger" id="mEnd">End battle for everyone</button>' : '') +
      '<button class="btn ghost" id="mLeave">Leave battle</button></div>');
    card.querySelector('#mResume').onclick = closeModal;
    card.querySelector('#mHow').onclick = () => {
      modal('<h2>How to play</h2>' + document.querySelector('.howto ol').outerHTML + document.querySelector('.controls-grid').outerHTML + '<div class="modal-actions"><button class="btn primary" id="mBack">Got it</button></div>').querySelector('#mBack').onclick = closeModal;
    };
    if (isHost) card.querySelector('#mEnd').onclick = () => { closeModal(); net.send({ t: 'end' }); };
    card.querySelector('#mLeave').onclick = () => { closeModal(); net.send({ t: 'leave' }); };
  };
  function showResults(m) {
    const isHost = state.room && state.room.hostId === state.myId;
    let html = '<h2>Battle over</h2><div class="winner">' + esc(m.winner) + '</div>';
    if (m.mode === 'teams') html += '<p style="text-align:center;font-weight:800;margin-top:0"><span style="color:#ff8a7a">Red ' + m.teamScore[0] + '</span> · <span style="color:#8fb6ff">Blue ' + m.teamScore[1] + '</span></p>';
    html += '<table class="scores"><tr><th>#</th><th>Commander</th><th>Kills</th><th>Deaths</th><th>Words</th><th>Best word</th></tr>';
    m.standings.forEach((p, i) => {
      const col = m.mode === 'teams' ? WT.TEAM_COLORS[p.team] : p.color;
      html += '<tr class="' + (p.id === state.myId ? 'me' : '') + '"><td>' + (i + 1) + '</td><td><span class="dot" style="background:' + col + '"></span>' + esc(p.name) + '</td><td>' + p.kills + '</td><td>' + p.deaths + '</td><td>' + p.words + '</td><td>' + esc(p.best || '—') + '</td></tr>';
    });
    html += '</table><div class="modal-actions">' + (isHost ? '<button class="btn primary" id="rBack">Back to room</button>' : '<span class="muted" style="align-self:center">Returning to the room shortly…</span>') + '<button class="btn ghost" id="rLeave">Leave</button></div>';
    const card = modal(html);
    if (isHost) card.querySelector('#rBack').onclick = () => net.send({ t: 'backToRoom' });
    card.querySelector('#rLeave').onclick = () => { closeModal(); net.send({ t: 'leave' }); };
  }

  // ================================================================ boot
  if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');
  renderDmgTable();
  renderChips();
  show('select');
  connect();
})();
