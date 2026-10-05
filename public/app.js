// Red vs Blue — browser client: main menu, local play, online play, and the board renderer.

import {
  key, enemy, colorOf, needed, DEFAULT_RULES, computeChanges, place,
  boardToJSON, boardFromJSON, newBoardJSON,
} from './rules.js';

const $ = id => document.getElementById(id);
const NAME = { blue: 'Blue', red: 'Red' };
const fmt = n => Math.round(n).toLocaleString('en-US');
const escapeHTML = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const saved = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// ============================== state ==============================
let mode = 'lobby';                 // 'lobby' | 'local' | 'online'
let view = emptyBoard();            // the board on screen: {tiles, turn, placed, lastPlaced}
let rules = { ...DEFAULT_RULES };
let localRules = { ...DEFAULT_RULES };
let showBadges = true;
let logHTML = '';
let preview = new Map();            // tileKey -> {nb, blob, damage} the end of this turn will apply
let lastResolveAt = 0;              // badges fade back in after a resolution's animation
let undoStack = [];                 // local play only
let lobbyColor = 'blue';

const online = {
  id: null, token: null, v: '', you: null, seats: { blue: null, red: null }, round: 0,
  lastResId: 0, loaded: false, watching: false, toldFull: false,
  queue: Promise.resolve(), pending: 0, latest: null, failed: false,
  timer: null, failures: 0,
};

function emptyBoard() { return decorate(boardFromJSON(newBoardJSON()), 0); }
function decorate(board, born) {
  for (const t of board.tiles.values()) { t.born = born; t.hitAt = 0; t.changeAt = 0; }
  return board;
}
function setMode(m) { mode = m; document.body.dataset.mode = m; }

// ============================== shared turn display ==============================
function animateResolution(last, at) {
  floats.length = 0; // don't let numbers from a previous resolution stack up
  for (const [q, r, c, nb, blob, damage, before, after] of last.changes) {
    const color = c ? 'red' : 'blue';
    const [wx, wy] = hexToWorld(q, r);
    if (nb) floats.push({ wx, wy, ox: -BADGE_X, oy: -BADGE_Y, dir: -1, text: '+' + fmtHp(nb), bg: BADGE.nb.bg, fg: BADGE.nb.fg, t0: at });
    floats.push({ wx, wy, ox: BADGE_X, oy: -BADGE_Y, dir: -1, text: '+' + fmtHp(blob), bg: BADGE.blob.bg, fg: BADGE.blob.fg, t0: at });
    if (damage) floats.push({ wx, wy, ox: 0, oy: BADGE_Y, dir: 1, text: '−' + fmtHp(damage), bg: COLORS[enemy(color)].fill, fg: '#fff', t0: at + 120 });
    const t = view.tiles.get(key(q, r));
    if (after > 0 && t) {
      t.prevHp = before; t.changeAt = at;
      if (damage) t.hitAt = at;
    } else if (after <= 0) {
      ghosts.push({ q, r, color, hp: before, t0: at });
    }
  }
  lastResolveAt = at;
  bump(RESOLVE_DELAY + FLOAT_MS + 400);
}

function summarize(last) {
  const part = col => {
    const s = last.summary[col], d = s.after - s.before;
    let txt = `<b class="${col}">${NAME[col]}</b> ${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}`;
    const extra = [];
    if (s.damage) extra.push(`took ${fmt(s.damage)} damage`);
    if (s.dead) extra.push(`lost ${s.dead} tile${s.dead > 1 ? 's' : ''}`);
    if (extra.length) txt += ` <span class="muted">(${extra.join(', ')})</span>`;
    return txt;
  };
  return `<span class="muted">Turn ${last.turn + 1} resolved</span> · ${part('blue')} · ${part('red')}`;
}

// ============================== local play ==============================
function startLocal() {
  stopPolling();
  setMode('local');
  hideOverlays();
  window.history.replaceState(null, '', '?local');
  rules = { ...localRules };
  view = emptyBoard();
  undoStack = []; logHTML = ''; floats.length = 0; ghosts.length = 0; lastResolveAt = 0;
  resetCamera();
  syncSettingsUI();
  refresh();
}

function localPlace(q, r) {
  const k = key(q, r);
  if (view.tiles.has(k)) return;
  undoStack.push({ board: boardToJSON(view), logHTML });
  if (undoStack.length > 1000) undoStack.shift();
  const now = performance.now();
  const res = place(view, q, r, rules);
  if (!res.ok) { undoStack.pop(); return; }
  const t = view.tiles.get(k);
  if (t) { t.born = now; t.hitAt = 0; t.changeAt = 0; }
  bump(POP_MS + 50);
  if (res.resolution) {
    animateResolution(res.resolution, now + RESOLVE_DELAY);
    logHTML = summarize(res.resolution);
  }
  refresh();
}

function localUndo() {
  const snap = undoStack.pop();
  if (!snap) return;
  view = decorate(boardFromJSON(snap.board), 0);
  logHTML = snap.logHTML;
  floats.length = 0; ghosts.length = 0; lastResolveAt = 0;
  refresh();
}

function localNewGame() {
  if (view.tiles.size && !confirm('Start a new game? The current board will be cleared.')) return;
  view = emptyBoard(); undoStack = []; logHTML = '';
  floats.length = 0; ghosts.length = 0; lastResolveAt = 0;
  resetCamera();
  refresh();
}

// ============================== online play ==============================
function headers(json) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (online.token) h['x-player-token'] = online.token;
  return h;
}

async function request(url, init) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store', ...init });
  } catch {
    throw Object.assign(new Error("Couldn't reach the server. Check your connection."), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Something went wrong (${res.status}).`), { status: res.status });
  return data;
}
const api = body => request('/api/game', { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
const apiGet = v => request(`/api/game?id=${encodeURIComponent(online.id)}${v ? '&v=' + encodeURIComponent(v) : ''}`, { headers: headers(false) });

async function createOnline() {
  const btn = $('btn-create');
  const name = $('in-name').value.trim();
  saved.set('rvb:name', name);
  btn.disabled = true; btn.textContent = 'Creating game…';
  try {
    const data = await api({
      action: 'create', name, color: lobbyColor,
      rules: { damage: Number($('in-damage').value), gapsBlock: $('in-gaps').checked },
    });
    saved.set('rvb:tok:' + data.state.id, data.token);
    window.history.replaceState(null, '', '?g=' + data.state.id);
    await enterOnline(data.state.id, data);
  } catch (e) {
    showLobbyError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Create online game';
  }
}

async function enterOnline(id, data) {
  stopPolling();
  setMode('online');
  hideOverlays();
  Object.assign(online, {
    id, token: saved.get('rvb:tok:' + id), v: '', you: null, seats: { blue: null, red: null }, round: 0,
    lastResId: 0, loaded: false, watching: false, toldFull: false,
    queue: Promise.resolve(), pending: 0, latest: null, failed: false, failures: 0,
  });
  view = emptyBoard(); undoStack = []; logHTML = '';
  floats.length = 0; ghosts.length = 0; lastResolveAt = 0;
  syncSettingsUI();
  refresh();
  try {
    applyServerState(data || await apiGet(''));
  } catch (e) {
    if (e.status === 404 || e.status === 400) { forgetGame(id); return showLobby(e.message); }
    toast(e.message);
  }
  schedulePoll(1200);
}

// Put a state from the server on screen, animating whatever changed since the last one.
function applyServerState(data) {
  const s = data.state;
  const initial = !online.loaded;
  const roundChanged = !initial && s.round !== online.round;
  const now = performance.now();
  const prev = view.tiles;
  const next = boardFromJSON(s.board);
  let appeared = false;
  for (const [k, t] of next.tiles) {
    const old = prev.get(k);
    if (!initial && !roundChanged && old && old.color === t.color) {
      t.born = old.born; t.hitAt = old.hitAt; t.changeAt = old.changeAt; t.prevHp = old.prevHp;
    } else {
      t.born = initial || roundChanged ? 0 : now; t.hitAt = 0; t.changeAt = 0;
      if (t.born) appeared = true;
    }
  }
  view = next;
  online.v = String(data.v);
  online.you = s.you;
  online.seats = s.seats;
  online.round = s.round;
  online.loaded = true;
  rules = { ...s.rules };

  if (roundChanged) {
    floats.length = 0; ghosts.length = 0; lastResolveAt = 0;
    toast(online.you ? `New game! You're ${NAME[online.you]} this time.` : 'A new game started.');
  }
  if (s.last && s.last.id !== online.lastResId) {
    if (!initial && !roundChanged) animateResolution(s.last, now + (appeared ? RESOLVE_DELAY : 80));
    online.lastResId = s.last.id;
  }
  if (!s.last) online.lastResId = 0;
  logHTML = s.last ? summarize(s.last) : '';
  if (appeared) bump(POP_MS + 50);
  if (initial || roundChanged) fitView();
  rememberGame();
  syncSettingsUI();
  maybeShowJoin();
  refresh();
}

const seatsFull = () => !!(online.seats.blue && online.seats.red);

function canPlaceOnline() {
  return mode === 'online' && online.loaded && !!online.you && seatsFull()
    && colorOf(view.turn) === online.you && view.placed.length < needed(view.turn);
}

function onlinePlace(q, r) {
  const k = key(q, r);
  if (view.tiles.has(k) || !online.loaded) return;
  if (!canPlaceOnline()) {
    if (!online.you) toast("You're watching this game.");
    else if (!seatsFull()) toast('Waiting for an opponent to join. Send them the link!');
    else if (colorOf(view.turn) !== online.you) toast(`It's ${online.seats[colorOf(view.turn)].name}'s turn.`);
    return;
  }
  // show the tile right away; the server confirms (or corrects) a moment later
  view.tiles.set(k, { q, r, color: online.you, hp: 1, born: performance.now(), hitAt: 0, changeAt: 0 });
  view.placed.push(k);
  bump(POP_MS + 50);
  refresh();
  online.pending++;
  online.queue = online.queue.then(async () => {
    try {
      online.latest = await api({ action: 'move', id: online.id, q, r });
    } catch (e) {
      online.failed = true;
      toast(e.message);
    } finally {
      online.pending--;
      if (online.pending === 0) {
        const latest = online.latest;
        online.latest = null;
        if (online.failed) { online.failed = false; await resync(); }
        else if (latest) applyServerState(latest);
      }
    }
  });
}

async function resync() {
  try { applyServerState(await apiGet('')); } catch (e) { toast(e.message); }
}

const canUndoOnline = () => mode === 'online' && online.loaded && !!online.you && online.pending === 0
  && colorOf(view.turn) === online.you && view.placed.length > 0;

async function onlineUndo() {
  if (!canUndoOnline()) return;
  try { applyServerState(await api({ action: 'undo', id: online.id })); }
  catch (e) { toast(e.message); resync(); }
}

async function doRematch() {
  if (!online.you) return;
  if (!confirm('Start a new game on this link? The board will be cleared and you will swap colors.')) return;
  try { applyServerState(await api({ action: 'rematch', id: online.id })); }
  catch (e) { toast(e.message); }
}

function maybeShowJoin() {
  const open = ['blue', 'red'].find(c => !online.seats[c]);
  const show = mode === 'online' && online.loaded && !online.you && !online.watching && !!open;
  $('join').hidden = !show;
  if (!show) {
    if (mode === 'online' && online.loaded && !online.you && !open && !online.toldFull) {
      online.toldFull = true;
      toast("Both seats are taken, so you're watching.");
    }
    return;
  }
  const other = enemy(open);
  $('join-text').textContent = online.seats[other]
    ? `${online.seats[other].name} is playing ${NAME[other]}. The ${NAME[open]} seat is open.`
    : `The ${NAME[open]} seat is open.`;
  const btn = $('btn-join');
  btn.textContent = `Join as ${NAME[open]}`;
  btn.classList.toggle('red', open === 'red');
  if (!$('join-name').value) $('join-name').value = saved.get('rvb:name') || '';
}

async function joinGame() {
  const btn = $('btn-join');
  const name = $('join-name').value.trim();
  saved.set('rvb:name', name);
  btn.disabled = true;
  try {
    const data = await api({ action: 'join', id: online.id, name });
    online.token = data.token;
    saved.set('rvb:tok:' + online.id, data.token);
    $('join').hidden = true;
    applyServerState(data);
    toast(`You're playing ${NAME[data.state.you]}. ${data.state.you === 'blue' ? 'You move first.' : 'Blue moves first.'}`);
  } catch (e) {
    toast(e.message);
    online.watching = true;
    $('join').hidden = true;
    resync();
  } finally {
    btn.disabled = false;
  }
}

// polling: ask for changes every ~1s while waiting on the other player, less often otherwise
function stopPolling() { clearTimeout(online.timer); online.timer = null; }
function schedulePoll(ms) { clearTimeout(online.timer); online.timer = setTimeout(poll, ms); }
function pollDelay() {
  if (document.hidden) return 8000;
  if (online.you && seatsFull() && colorOf(view.turn) === online.you) return 4000;
  return 1200;
}
async function poll() {
  if (mode !== 'online') return;
  const id = online.id;
  if (online.pending === 0) {
    try {
      const data = await apiGet(online.loaded ? online.v : '');
      if (mode !== 'online' || online.id !== id) return;
      if (data.changed !== false && online.pending === 0 && (!online.loaded || Number(data.v) > Number(online.v))) {
        applyServerState(data);
      }
      if (online.failures >= 3) toast('Reconnected.');
      online.failures = 0;
    } catch (e) {
      if (e.status === 404) { stopPolling(); forgetGame(id); return showLobby(e.message); }
      online.failures++;
    }
    $('conn').hidden = online.failures < 3;
  }
  schedulePoll(pollDelay());
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && mode === 'online') schedulePoll(100);
});

const gameLink = () => `${location.origin}${location.pathname}?g=${online.id}`;
async function shareLink() {
  const url = gameLink();
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: 'Red vs Blue', text: 'Play Red vs Blue with me!', url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied. Send it to a friend!');
  } catch {
    const input = $('invite-link');
    if (!$('invite').hidden) { input.focus(); input.select(); toast('Press Ctrl+C (or ⌘C) to copy the link.'); }
    else window.prompt('Copy this link:', url);
  }
}

// recent games on this device, for the main menu
function rememberGame() {
  const label = ['blue', 'red'].map(c => online.seats[c]?.name || '…').join(' vs ');
  let list = [];
  try { list = JSON.parse(saved.get('rvb:recent') || '[]'); } catch { list = []; }
  list = [{ id: online.id, label, at: Date.now() }, ...list.filter(g => g.id !== online.id)].slice(0, 5);
  saved.set('rvb:recent', JSON.stringify(list));
}
function forgetGame(id) {
  try {
    const list = JSON.parse(saved.get('rvb:recent') || '[]').filter(g => g.id !== id);
    saved.set('rvb:recent', JSON.stringify(list));
  } catch { /* ignore */ }
}
function renderRecent() {
  let list = [];
  try { list = JSON.parse(saved.get('rvb:recent') || '[]'); } catch { list = []; }
  $('recent').hidden = !list.length;
  $('recent-list').innerHTML = list.map(g => {
    const days = Math.floor((Date.now() - g.at) / 86400000);
    const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    return `<a href="?g=${encodeURIComponent(g.id)}"><span>${escapeHTML(g.label)}</span><span>${when}</span></a>`;
  }).join('');
}

// ============================== menu ==============================
function hideOverlays() { $('lobby').hidden = true; $('join').hidden = true; $('invite').hidden = true; }

function showLobby(error) {
  stopPolling();
  setMode('lobby');
  window.history.replaceState(null, '', location.pathname);
  $('join').hidden = true;
  $('lobby').hidden = false;
  showLobbyError(error);
  $('in-name').value = saved.get('rvb:name') || '';
  renderRecent();
  view = decorativeBoard();
  floats.length = 0; ghosts.length = 0; logHTML = '';
  cam.x = 0; cam.y = 0; cam.size = defaultSize();
  refresh();
}
function showLobbyError(msg) { $('lobby-error').hidden = !msg; $('lobby-error').textContent = msg || ''; }

// a little game played out behind the main menu
function decorativeBoard() {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const board = boardFromJSON(newBoardJSON());
  const spots = [];
  for (let q = -9; q <= 9; q++) for (let r = -6; r <= 6; r++) if (Math.abs(q + r) <= 11) spots.push([q, r]);
  for (let i = 0; i < 31; i++) {
    let best = null;
    for (let tries = 0; tries < 30 && !best; tries++) {
      const [q, r] = spots[Math.floor(rand() * spots.length)];
      if (!board.tiles.has(key(q, r))) best = [q, r];
    }
    if (best) place(board, best[0], best[1], DEFAULT_RULES);
  }
  return decorate(board, 0);
}

// ============================== HUD ==============================
function refresh() {
  const { changes } = computeChanges(view.tiles, rules);
  preview = new Map();
  for (const c of changes) preview.set(c.k, { nb: c.nb, blob: c.blob, damage: c.damage });

  const stats = { blue: { score: 0, count: 0, next: 0 }, red: { score: 0, count: 0, next: 0 } };
  for (const c of changes) {
    const s = stats[c.t.color];
    s.score += c.before; s.count++; s.next += Math.max(c.after, 0);
  }
  const cur = colorOf(view.turn);
  const started = mode !== 'online' || seatsFull();
  for (const col of ['blue', 'red']) {
    const s = stats[col];
    $('score-' + col).textContent = fmt(s.score);
    $('count-' + col).textContent = `${s.count} tile${s.count === 1 ? '' : 's'}`;
    const d = s.next - s.score;
    const p = $('proj-' + col);
    p.textContent = s.count ? `next ${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}` : '';
    p.classList.toggle('down', d < 0);
    $('card-' + col).classList.toggle('active', started && col === cur);
    const nameEl = $('name-' + col);
    if (mode === 'online') {
      const seat = online.seats[col];
      nameEl.textContent = seat ? seat.name + (online.you === col ? ' (you)' : '') : 'waiting…';
      nameEl.classList.toggle('waiting', !seat);
    } else {
      nameEl.textContent = '';
    }
  }

  const need = needed(view.turn), rem = Math.max(0, need - view.placed.length);
  let msg;
  if (mode === 'online') {
    if (!online.loaded) msg = 'Connecting…';
    else if (!seatsFull()) msg = `Waiting for ${NAME[online.seats.blue ? 'red' : 'blue']} to join`;
    else if (rem === 0) msg = 'Resolving…';
    else if (online.you === cur) msg = view.turn === 0 ? 'Your turn: place the first tile' : `Your turn: place ${rem} more tile${rem === 1 ? '' : 's'}`;
    else msg = online.you ? `Waiting for ${online.seats[cur].name}…` : `${online.seats[cur].name} (${NAME[cur]}) to move`;
  } else {
    msg = view.turn === 0 ? 'Blue places the first tile' : `${NAME[cur]} places ${rem} more tile${rem === 1 ? '' : 's'}`;
  }
  $('turn-label').textContent = `Turn ${view.turn + 1}`;
  $('turn-msg').textContent = msg;
  const pips = $('pips');
  pips.hidden = !started;
  pips.style.color = cur === 'blue' ? 'var(--blue)' : 'var(--red)';
  pips.innerHTML = Array.from({ length: need }, (_, i) => `<span class="pip${i < rem ? ' on' : ''}"></span>`).join('');

  let hint = 'Click any hex to place a tile. Drag to pan; scroll or pinch to zoom.';
  if (mode === 'online' && online.loaded && !online.you) hint = "You're watching. Drag to pan; scroll or pinch to zoom.";
  $('log-text').innerHTML = logHTML || hint;
  $('legend').hidden = !showBadges;

  $('btn-undo').disabled = mode === 'local' ? undoStack.length === 0 : !canUndoOnline();
  $('btn-rematch').disabled = !online.you;
  renderInvite();
  dirty = true;
}

function renderInvite() {
  const panel = $('invite');
  if (mode !== 'online' || !online.loaded) { panel.hidden = true; return; }
  const open = ['blue', 'red'].find(c => !online.seats[c]);
  if (online.you && open) {
    panel.hidden = false;
    $('invite-text').textContent = 'Invite a friend: send them this link to join as ' + NAME[open] + '.';
    $('invite-link').value = gameLink();
    $('invite-link-row').hidden = false;
    $('invite-join-row').hidden = true;
  } else if (!online.you && open && online.watching) {
    panel.hidden = false;
    $('invite-text').textContent = `The ${NAME[open]} seat is open.`;
    $('btn-seat-join').textContent = `Join as ${NAME[open]}`;
    $('invite-link-row').hidden = true;
    $('invite-join-row').hidden = false;
  } else {
    panel.hidden = true;
  }
}

function syncSettingsUI() {
  $('opt-damage').value = rules.damage;
  $('opt-gaps').checked = rules.gapsBlock;
  const locked = mode === 'online';
  $('opt-damage').disabled = locked;
  $('opt-gaps').disabled = locked;
  $('rules-locked').hidden = !locked;
  $('dmg-text').textContent = rules.damage;
  $('dmg-example').textContent = rules.damage * 4;
  $('gap-text').textContent = rules.gapsBlock
    ? 'Empty hexes block attacks: only tiles in the same unbroken run of occupied hexes form pairs.'
    : "Empty hexes in between don't matter: two tiles far apart on a line still form a pair.";
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ============================== canvas, camera, drawing ==============================
const canvas = $('board');
const ctx = canvas.getContext('2d');
const SQRT3 = Math.sqrt(3);
const MIN_SIZE = 6, MAX_SIZE = 150;
const POP_MS = 220, RESOLVE_DELAY = 260, FLOAT_MS = 1300, DIE_MS = 600, HIT_MS = 500;
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const BG = '#0e1117';
const COLORS = {
  blue: { fill: '#3a7bea', edge: '#173f8f', soft: '#9cc0ff' },
  red:  { fill: '#e5484d', edge: '#86171d', soft: '#ffa3a6' },
};
const BADGE_X = 0.36, BADGE_Y = 0.57; // badge offsets from tile center, in hex sizes
const BADGE = {
  nb:   { bg: '#15844d', fg: '#ffffff' },  // + same-color neighbors
  blob: { bg: '#f2b632', fg: '#2a1c00' },  // + blob size
};
const CORNERS = Array.from({ length: 6 }, (_, i) => {
  const a = Math.PI / 180 * (60 * i - 30);
  return [Math.cos(a), Math.sin(a)];
});
const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]; // edge i faces DIRS[i]

let dpr = 1, W = 0, H = 0;
const defaultSize = () => (window.innerWidth < 700 ? 30 : 40);
const cam = { x: 0, y: 0, size: defaultSize() };
let dirty = true, animUntil = 0, wasAnimating = false;
let hover = null;
const floats = [];
const ghosts = [];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function bump(ms) { animUntil = Math.max(animUntil, performance.now() + ms); }
function hexToWorld(q, r) { return [SQRT3 * (q + r / 2), 1.5 * r]; }
function toScreen(q, r) {
  const [wx, wy] = hexToWorld(q, r);
  return [W / 2 + (wx - cam.x) * cam.size, H / 2 + (wy - cam.y) * cam.size];
}
function toHex(sx, sy) {
  const wx = (sx - W / 2) / cam.size + cam.x;
  const wy = (sy - H / 2) / cam.size + cam.y;
  const qf = SQRT3 / 3 * wx - wy / 3, rf = 2 / 3 * wy, sf = -qf - rf;
  let q = Math.round(qf), r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s; else if (dr > ds) r = -q - s;
  return [q + 0, r + 0];
}
function hexPath(x, y, s) {
  ctx.moveTo(x + CORNERS[0][0] * s, y + CORNERS[0][1] * s);
  for (let i = 1; i < 6; i++) ctx.lineTo(x + CORNERS[i][0] * s, y + CORNERS[i][1] * s);
  ctx.closePath();
}
function fmtHp(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(n < 1e5 ? 1 : 0) + 'k';
  return String(n);
}
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  dirty = true;
}
const easeOutBack = p => { const c = 1.6; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };

function drawGrid(s) {
  if (s < 9) return;
  const alpha = 0.02 + 0.05 * Math.min(1, (s - 9) / 14);
  const wx0 = cam.x - W / 2 / s, wx1 = cam.x + W / 2 / s;
  const wy0 = cam.y - H / 2 / s, wy1 = cam.y + H / 2 / s;
  const r0 = Math.floor(wy0 / 1.5) - 1, r1 = Math.ceil(wy1 / 1.5) + 1;
  ctx.beginPath();
  for (let r = r0; r <= r1; r++) {
    const q0 = Math.floor(wx0 / SQRT3 - r / 2) - 1, q1 = Math.ceil(wx1 / SQRT3 - r / 2) + 1;
    for (let q = q0; q <= q1; q++) {
      const [x, y] = toScreen(q, r);
      hexPath(x, y, s);
    }
  }
  ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
  ctx.lineWidth = 1;
  ctx.stroke();
  const [ox, oy] = toScreen(0, 0);
  ctx.beginPath(); ctx.arc(ox, oy, Math.max(1.5, s * 0.06), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fill();
}

function drawTileBody(t, x, y, rad, now) {
  const C = COLORS[t.color];
  const s = cam.size;
  ctx.beginPath(); hexPath(x, y, rad + 0.6);
  ctx.fillStyle = C.fill; ctx.fill();

  ctx.save();
  ctx.beginPath(); hexPath(x, y, rad); ctx.clip();
  const g = ctx.createLinearGradient(0, y - rad, 0, y + rad);
  g.addColorStop(0, 'rgba(255,255,255,.14)'); g.addColorStop(0.55, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,.12)');
  ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  // edges: faint inside a blob, strong on the blob's outline
  const inner = new Path2D(), outer = new Path2D();
  for (let i = 0; i < 6; i++) {
    const [dq, dr] = DIRS[i];
    const n = view.tiles.get(key(t.q + dq, t.r + dr));
    const p = (n && n.color === t.color) ? inner : outer;
    const a = CORNERS[i], b = CORNERS[(i + 1) % 6];
    p.moveTo(x + a[0] * rad, y + a[1] * rad);
    p.lineTo(x + b[0] * rad, y + b[1] * rad);
  }
  ctx.strokeStyle = 'rgba(0,0,0,.22)'; ctx.lineWidth = 1.2; ctx.stroke(inner);
  ctx.strokeStyle = C.edge; ctx.lineWidth = Math.max(2, s * 0.1) * 2; ctx.stroke(outer);
  if (t.hitAt && now >= t.hitAt && now < t.hitAt + HIT_MS) {
    const p = (now - t.hitAt) / HIT_MS;
    ctx.fillStyle = `rgba(255,255,255,${0.65 * (1 - p)})`;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  ctx.restore();
}

function drawLabel(text, x, y, rad) {
  const fs = Math.min(rad * 0.62, (rad * 1.45) / (text.length * 0.62));
  if (fs < 6) return;
  ctx.font = `700 ${fs}px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  ctx.fillText(text, x, y + fs * 0.05 + Math.max(1, fs * 0.05));
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x, y + fs * 0.05);
}

function drawPill(cx, cy, text, bg, fg, fs, s) {
  ctx.font = `800 ${fs}px ${FONT}`;
  const w = ctx.measureText(text).width + fs * 0.75, h = fs * 1.32;
  const bx = cx - w / 2, by = cy - h / 2, rr = h / 2;
  ctx.beginPath();
  ctx.moveTo(bx + rr, by); ctx.arcTo(bx + w, by, bx + w, by + h, rr); ctx.arcTo(bx + w, by + h, bx, by + h, rr);
  ctx.arcTo(bx, by + h, bx, by, rr); ctx.arcTo(bx, by, bx + w, by, rr); ctx.closePath();
  ctx.fillStyle = bg; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = Math.max(1, s * 0.028); ctx.stroke();
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + fs * 0.04);
}

// Three indicators per tile, always in the same spots:
// top-left = gain from same-color neighbors, top-right = gain from blob size, bottom = damage
function drawBadges(x, y, s, p, tileColor, alpha) {
  const fs = Math.max(8.5, s * 0.235);
  ctx.globalAlpha = alpha;
  if (p.nb) drawPill(x - s * BADGE_X, y - s * BADGE_Y, '+' + fmtHp(p.nb), BADGE.nb.bg, BADGE.nb.fg, fs, s);
  drawPill(x + s * BADGE_X, y - s * BADGE_Y, '+' + fmtHp(p.blob), BADGE.blob.bg, BADGE.blob.fg, fs, s);
  if (p.damage) drawPill(x, y + s * BADGE_Y, '−' + fmtHp(p.damage), COLORS[enemy(tileColor)].fill, '#fff', fs, s);
  ctx.globalAlpha = 1;
}

function hoverColor() {
  if (mode === 'local') return colorOf(view.turn);
  if (mode === 'online' && canPlaceOnline()) return online.you;
  return null;
}

function draw(now) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  const s = cam.size;
  drawGrid(s);

  // hover preview
  const hc = hoverColor();
  if (hover && hc && $('modal').hidden && !view.tiles.has(key(hover[0], hover[1]))) {
    const [x, y] = toScreen(hover[0], hover[1]);
    const C = COLORS[hc];
    ctx.beginPath(); hexPath(x, y, s * 0.9);
    ctx.globalAlpha = 0.3; ctx.fillStyle = C.fill; ctx.fill();
    ctx.globalAlpha = 0.9; ctx.strokeStyle = C.soft; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // tile bodies
  const placedSet = new Set(view.placed), lastSet = new Set(view.lastPlaced);
  const visible = [];
  const margin = s * 2;
  for (const [k, t] of view.tiles) {
    const [x, y] = toScreen(t.q, t.r);
    if (x < -margin || x > W + margin || y < -margin || y > H + margin) continue;
    let rad = s;
    if (t.born && now - t.born < POP_MS) rad = s * (0.45 + 0.55 * easeOutBack((now - t.born) / POP_MS));
    drawTileBody(t, x, y, rad, now);
    if (mode !== 'lobby' && (placedSet.has(k) || lastSet.has(k))) {
      ctx.beginPath(); hexPath(x, y, rad * 0.8);
      ctx.strokeStyle = placedSet.has(k) ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.4)';
      ctx.lineWidth = Math.max(1.5, s * 0.055); ctx.stroke();
    }
    visible.push([k, t, x, y, rad]);
  }

  // tiles being destroyed
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i];
    const p = Math.max(0, (now - g.t0) / DIE_MS);
    if (p >= 1) { ghosts.splice(i, 1); continue; }
    const [x, y] = toScreen(g.q, g.r);
    const rad = s * (1 - 0.45 * p * p);
    ctx.globalAlpha = 1 - p;
    ctx.beginPath(); hexPath(x, y, rad);
    ctx.fillStyle = COLORS[g.color].fill; ctx.fill();
    ctx.strokeStyle = COLORS[g.color].edge; ctx.lineWidth = Math.max(2, s * 0.1); ctx.stroke();
    if (p > 0) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, s * 0.08);
      const d = rad * 0.32;
      ctx.beginPath(); ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d); ctx.moveTo(x + d, y - d); ctx.lineTo(x - d, y + d); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (p === 0 && s >= 10) drawLabel(fmtHp(g.hp), x, y, rad);
  }

  // health numbers + preview badges (badges wait until the last resolution's numbers have floated away)
  if (s >= 10) {
    const badgeAlpha = clamp((now - lastResolveAt - FLOAT_MS * 0.6) / 300, 0, 1);
    for (const [k, t, x, y, rad] of visible) {
      const hp = (t.changeAt && now < t.changeAt) ? t.prevHp : t.hp;
      drawLabel(fmtHp(hp), x, y, rad);
      const p = preview.get(k);
      if (mode !== 'lobby' && showBadges && s >= 18 && p && badgeAlpha > 0) drawBadges(x, y, s, p, t.color, badgeAlpha);
    }
  }

  // end-of-turn indicators: the same three badges, enlarged, gains rising and damage sinking
  for (let i = floats.length - 1; i >= 0; i--) {
    const f = floats[i];
    const p = (now - f.t0) / FLOAT_MS;
    if (p >= 1) { floats.splice(i, 1); continue; }
    if (p < 0 || s < 14) continue;
    const alpha = p < 0.1 ? p / 0.1 : 1 - Math.pow((p - 0.1) / 0.9, 2);
    const travel = 0.55 * (1 - Math.pow(1 - p, 2));
    const x = W / 2 + (f.wx - cam.x + f.ox) * s;
    const y = H / 2 + (f.wy - cam.y + f.oy + f.dir * travel) * s;
    const grow = p < 0.1 ? 0.8 + 2 * p : 1;
    ctx.globalAlpha = alpha;
    drawPill(x, y, f.text, f.bg, f.fg, Math.max(10, s * 0.3) * grow, s);
    ctx.globalAlpha = 1;
  }
}

function frame(now) {
  const animating = now < animUntil;
  if (dirty || animating || wasAnimating) { dirty = false; draw(now); }
  wasAnimating = animating;
  requestAnimationFrame(frame);
}

function zoomAt(sx, sy, newSize) {
  newSize = clamp(newSize, MIN_SIZE, MAX_SIZE);
  const wx = (sx - W / 2) / cam.size + cam.x, wy = (sy - H / 2) / cam.size + cam.y;
  cam.size = newSize;
  cam.x = wx - (sx - W / 2) / newSize;
  cam.y = wy - (sy - H / 2) / newSize;
  dirty = true;
}
function resetCamera() { cam.x = 0; cam.y = 0; cam.size = defaultSize(); dirty = true; }
function fitView() {
  if (!view.tiles.size) return resetCamera();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of view.tiles.values()) {
    const [wx, wy] = hexToWorld(t.q, t.r);
    x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); y0 = Math.min(y0, wy); y1 = Math.max(y1, wy);
  }
  const topPad = W < 700 ? 160 : 130, botPad = W < 700 ? 140 : 90;
  const availW = W - 40, availH = Math.max(120, H - topPad - botPad);
  cam.size = clamp(Math.min(availW / (x1 - x0 + 3), availH / (y1 - y0 + 3)), MIN_SIZE, 56);
  cam.x = (x0 + x1) / 2;
  cam.y = (y0 + y1) / 2 - ((topPad - botPad) / 2) / cam.size;
  dirty = true;
}

// ============================== input ==============================
const pointers = new Map();
let drag = null, pinch = null;

function setHover(h) {
  const same = (h && hover && h[0] === hover[0] && h[1] === hover[1]) || (!h && !hover);
  if (!same) { hover = h; dirty = true; }
}
function beginPinch() {
  const [a, b] = [...pointers.values()];
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: cam.size, wx: (mx - W / 2) / cam.size + cam.x, wy: (my - H / 2) / cam.size + cam.y };
}
function updatePinch() {
  const [a, b] = [...pointers.values()];
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  cam.size = clamp(pinch.s0 * d / pinch.d0, MIN_SIZE, MAX_SIZE);
  cam.x = pinch.wx - (mx - W / 2) / cam.size;
  cam.y = pinch.wy - (my - H / 2) / cam.size;
  dirty = true;
}
function handlePlace(q, r) {
  if (mode === 'local') localPlace(q, r);
  else if (mode === 'online') onlinePlace(q, r);
}

canvas.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    drag = { x0: e.clientX, y0: e.clientY, cx: cam.x, cy: cam.y, moved: e.button === 1, button: e.button };
    if (e.pointerType !== 'mouse') setHover(null);
  } else if (pointers.size === 2) {
    if (drag) drag.moved = true;
    beginPinch();
  }
});
canvas.addEventListener('pointermove', e => {
  if (e.pointerType === 'mouse') setHover(toHex(e.clientX, e.clientY));
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) { updatePinch(); return; }
  if (drag) {
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) > 6) drag.moved = true;
    if (drag.moved) {
      canvas.classList.add('dragging');
      cam.x = drag.cx - dx / cam.size;
      cam.y = drag.cy - dy / cam.size;
      dirty = true;
    }
  }
});
function endPointer(e, cancelled) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (!cancelled && drag && !drag.moved && pointers.size === 0 && drag.button === 0) {
    const [q, r] = toHex(e.clientX, e.clientY);
    handlePlace(q, r);
  }
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 1) {
    const p = [...pointers.values()][0];
    drag = { x0: p.x, y0: p.y, cx: cam.x, cy: cam.y, moved: true, button: 0 };
  }
  if (pointers.size === 0) { drag = null; canvas.classList.remove('dragging'); }
}
canvas.addEventListener('pointerup', e => endPointer(e, false));
canvas.addEventListener('pointercancel', e => endPointer(e, true));
canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !pointers.size) setHover(null); });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0016;
  zoomAt(e.clientX, e.clientY, cam.size * Math.exp(-e.deltaY * k));
}, { passive: false });
window.addEventListener('resize', resize);

function openRules() { $('modal').hidden = false; setHover(null); }
function closeRules() { $('modal').hidden = true; dirty = true; }

function undo() { if (mode === 'local') localUndo(); else if (mode === 'online') onlineUndo(); }

window.addEventListener('keydown', e => {
  if (!$('modal').hidden) { if (e.key === 'Escape') closeRules(); return; }
  if (e.target instanceof HTMLInputElement) return;
  if (mode === 'lobby' || !$('join').hidden) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'h' || e.key === 'H') fitView();
  else if (e.key === '+' || e.key === '=') zoomAt(W / 2, H / 2, cam.size * 1.2);
  else if (e.key === '-' || e.key === '_') zoomAt(W / 2, H / 2, cam.size / 1.2);
  else if (e.key === '?') openRules();
});

// buttons
$('btn-undo').addEventListener('click', undo);
$('btn-center').addEventListener('click', fitView);
$('btn-zoom-in').addEventListener('click', () => zoomAt(W / 2, H / 2, cam.size * 1.25));
$('btn-zoom-out').addEventListener('click', () => zoomAt(W / 2, H / 2, cam.size / 1.25));
$('btn-rules').addEventListener('click', openRules);
$('btn-close').addEventListener('click', closeRules);
$('modal').addEventListener('pointerdown', e => { if (e.target === $('modal')) closeRules(); });
$('btn-new').addEventListener('click', localNewGame);
$('btn-invite').addEventListener('click', shareLink);
$('btn-copy').addEventListener('click', shareLink);
$('btn-rematch').addEventListener('click', doRematch);
$('btn-menu').addEventListener('click', () => {
  if (mode === 'local' && view.tiles.size && !confirm('Leave this game? The board will be lost.')) return;
  showLobby();
});
$('btn-create').addEventListener('click', createOnline);
$('btn-local').addEventListener('click', startLocal);
$('btn-howto').addEventListener('click', openRules);
$('btn-join-rules').addEventListener('click', openRules);
$('btn-join').addEventListener('click', joinGame);
$('join-name').addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); });
$('in-name').addEventListener('keydown', e => { if (e.key === 'Enter') createOnline(); });
$('btn-watch').addEventListener('click', () => { online.watching = true; $('join').hidden = true; refresh(); });
$('btn-seat-join').addEventListener('click', () => { online.watching = false; maybeShowJoin(); });
for (const b of $('seg-color').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    lobbyColor = b.dataset.v;
    for (const o of $('seg-color').querySelectorAll('button')) {
      o.classList.toggle('on', o === b);
      o.setAttribute('aria-checked', String(o === b));
    }
  });
}

// settings (damage + gaps are editable in local play only)
$('opt-damage').addEventListener('input', e => {
  const v = Math.floor(Number(e.target.value));
  if (mode === 'local' && Number.isFinite(v) && v >= 0) { rules.damage = localRules.damage = v; syncSettingsUI(); refresh(); }
});
$('opt-gaps').addEventListener('change', e => {
  if (mode === 'local') { rules.gapsBlock = localRules.gapsBlock = e.target.checked; syncSettingsUI(); refresh(); }
});
$('opt-show').addEventListener('change', e => { showBadges = e.target.checked; refresh(); });

// ============================== start ==============================
resize();
requestAnimationFrame(frame);
{
  const params = new URLSearchParams(location.search);
  const gameId = params.get('g');
  if (gameId) enterOnline(gameId.trim().toLowerCase());
  else if (params.has('local')) startLocal();
  else showLobby();
}
