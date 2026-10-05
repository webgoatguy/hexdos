// Red vs Blue — game rules.
// This one file is used by the browser (local play, previews, animations) and by the
// server (the authority for online games), so both always agree on the rules.

// Axial hex coordinates (q, r), pointy-top. Edge i of a hex faces DIRS[i].
export const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
export const key = (q, r) => q + ',' + r;
export const enemy = c => (c === 'blue' ? 'red' : 'blue');
export const colorOf = turn => (turn % 2 === 0 ? 'blue' : 'red'); // turn 0 is Blue's opening
export const needed = turn => (turn === 0 ? 1 : 2);                // tiles to place this turn
export const DEFAULT_RULES = Object.freeze({ damage: 2, gapsBlock: false });

export function sameColorNeighbors(tiles, t) {
  let n = 0;
  for (const [dq, dr] of DIRS) {
    const o = tiles.get(key(t.q + dq, t.r + dr));
    if (o && o.color === t.color) n++;
  }
  return n;
}

// Map tileKey -> size of the connected same-color region containing it
export function blobSizes(tiles) {
  const size = new Map();
  for (const [k, t] of tiles) {
    if (size.has(k)) continue;
    const comp = [k];
    const seen = new Set(comp);
    for (let i = 0; i < comp.length; i++) {
      const c = tiles.get(comp[i]);
      for (const [dq, dr] of DIRS) {
        const nk = key(c.q + dq, c.r + dr);
        if (seen.has(nk)) continue;
        const n = tiles.get(nk);
        if (n && n.color === t.color) { seen.add(nk); comp.push(nk); }
      }
    }
    for (const ck of comp) size.set(ck, comp.length);
  }
  return size;
}

// For every tile, the number of enemy pairs that have it between them, summed over the 3 axes.
// Every pair counts, and tiles in between (of either color) don't break a pair:
// on one line, a tile with L enemy tiles on one side and R on the other is inside L * R pairs.
// Returns Map tileKey -> pair count
export function attackPairs(tiles, gapsBlock) {
  const pairs = new Map();
  for (let axis = 0; axis < 3; axis++) {
    // axis 0: direction (1,0)  -> line id r,   position q
    // axis 1: direction (0,1)  -> line id q,   position r
    // axis 2: direction (1,-1) -> line id q+r, position q
    const lines = new Map();
    for (const t of tiles.values()) {
      const id = axis === 0 ? t.r : axis === 1 ? t.q : t.q + t.r;
      const pos = axis === 1 ? t.r : t.q;
      let arr = lines.get(id);
      if (!arr) lines.set(id, arr = []);
      arr.push({ pos, t });
    }
    for (const arr of lines.values()) {
      if (arr.length < 3) continue;
      arr.sort((a, b) => a.pos - b.pos);
      const segments = [];
      if (gapsBlock) {
        let cur = [arr[0]];
        for (let i = 1; i < arr.length; i++) {
          if (arr[i].pos === arr[i - 1].pos + 1) cur.push(arr[i]);
          else { segments.push(cur); cur = [arr[i]]; }
        }
        segments.push(cur);
      } else {
        segments.push(arr);
      }
      for (const seg of segments) {
        if (seg.length < 3) continue;
        const total = { blue: 0, red: 0 };
        for (const x of seg) total[x.t.color]++;
        const left = { blue: 0, red: 0 };
        for (const x of seg) {
          const e = enemy(x.t.color);
          const n = left[e] * (total[e] - left[e]);
          if (n) {
            const k = key(x.t.q, x.t.r);
            pairs.set(k, (pairs.get(k) || 0) + n);
          }
          left[x.t.color]++;
        }
      }
    }
  }
  return pairs;
}

// What the end of turn would do to every tile, computed from the current board (nothing is changed)
export function computeChanges(tiles, rules) {
  const blobs = blobSizes(tiles);
  const pairs = attackPairs(tiles, rules.gapsBlock);
  const changes = [];
  for (const [k, t] of tiles) {
    const nb = sameColorNeighbors(tiles, t);
    const blob = blobs.get(k);
    const p = pairs.get(k) || 0;
    const growth = nb + blob;
    const damage = p * rules.damage;
    changes.push({ k, t, nb, blob, pairs: p, growth, damage, before: t.hp, after: t.hp + growth - damage });
  }
  return { changes };
}

// Apply all changes at once, then remove tiles at 0 or below. Returns the dead.
export function applyChanges(tiles, changes) {
  const dead = [];
  for (const c of changes) {
    c.t.hp = c.after;
    if (c.after <= 0) dead.push(c);
  }
  for (const c of dead) tiles.delete(c.k);
  return dead;
}

// ---------------------------------------------------------------------------
// Board: { tiles: Map key -> {q, r, color, hp}, turn, placed: [keys], lastPlaced: [keys] }

export const newBoardJSON = () => ({ tiles: [], turn: 0, placed: [], lastPlaced: [] });

export function boardToJSON(board) {
  return {
    tiles: [...board.tiles.values()].map(t => [t.q, t.r, t.color === 'blue' ? 0 : 1, t.hp]),
    turn: board.turn,
    placed: [...board.placed],
    lastPlaced: [...board.lastPlaced],
  };
}

export function boardFromJSON(j) {
  const tiles = new Map();
  for (const [q, r, c, hp] of j.tiles) tiles.set(key(q, r), { q, r, color: c ? 'red' : 'blue', hp });
  return { tiles, turn: j.turn, placed: [...j.placed], lastPlaced: [...j.lastPlaced] };
}

// Place a tile for whoever's turn it is. When the turn's last tile goes down, the turn resolves.
// Returns { ok: true, resolution } (resolution is null mid-turn) or { ok: false, error }.
export function place(board, q, r, rules) {
  if (!Number.isInteger(q) || !Number.isInteger(r)) return { ok: false, error: 'That is not a valid hex.' };
  const k = key(q, r);
  if (board.tiles.has(k)) return { ok: false, error: 'That hex is already taken.' };
  board.tiles.set(k, { q, r, color: colorOf(board.turn), hp: 1 });
  board.placed.push(k);
  const resolution = board.placed.length >= needed(board.turn) ? resolveTurn(board, rules) : null;
  return { ok: true, resolution };
}

// End of turn: growth and damage worked out together, then applied; tiles at 0 or below die.
// The returned record is what clients use to animate and summarize the turn:
//   changes: [[q, r, colorIndex(0 blue / 1 red), +neighbors, +blob, damage, hpBefore, hpAfter], ...]
export function resolveTurn(board, rules) {
  const { changes } = computeChanges(board.tiles, rules);
  const summary = {
    blue: { before: 0, after: 0, damage: 0, dead: 0 },
    red:  { before: 0, after: 0, damage: 0, dead: 0 },
  };
  for (const c of changes) {
    summary[c.t.color].before += c.before;
    summary[c.t.color].damage += c.damage;
  }
  const record = changes.map(c => [c.t.q, c.t.r, c.t.color === 'blue' ? 0 : 1, c.nb, c.blob, c.damage, c.before, c.after]);
  const dead = applyChanges(board.tiles, changes);
  for (const c of dead) summary[c.t.color].dead++;
  for (const t of board.tiles.values()) summary[t.color].after += t.hp;
  const resolved = board.turn;
  board.lastPlaced = board.placed.filter(k => board.tiles.has(k));
  board.placed = [];
  board.turn++;
  return { turn: resolved, changes: record, summary };
}

// Take back the most recent placement of the current (unfinished) turn.
export function undoPending(board) {
  if (!board.placed.length) return false;
  board.tiles.delete(board.placed.pop());
  return true;
}
