// Rules tests: `npm test`
import {
  key, computeChanges, applyChanges, place, undoPending, boardFromJSON, boardToJSON, newBoardJSON, DEFAULT_RULES,
} from '../public/rules.js';

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`}`);
};
function run(list, rules = DEFAULT_RULES) {
  const b = new Map();
  for (const [q, r, color, hp = 1] of list) b.set(key(q, r), { q, r, color, hp });
  const { changes } = computeChanges(b, rules);
  const byK = Object.fromEntries(changes.map(c => [c.k, c]));
  const dead = applyChanges(b, changes);
  return { b, dead, byK };
}
const hp = (t, q, r) => (t.b.has(key(q, r)) ? t.b.get(key(q, r)).hp : null);
const dmg = (t, q, r) => t.byK[key(q, r)].damage;

// growth
let t = run([[0, 0, 'blue']]);
eq('lone tile grows 1 -> 2', hp(t, 0, 0), 2);
t = run([[0, 0, 'blue'], [1, 0, 'blue'], [2, 0, 'blue']]);
eq('line of 3: neighbors + blob', [hp(t, 0, 0), hp(t, 1, 0), hp(t, 2, 0)], [5, 6, 5]);
t = run([[0, 0, 'red'], [1, 0, 'red'], [0, 1, 'red'], [-1, 1, 'red'], [-1, 0, 'red'], [0, -1, 'red'], [1, -1, 'red']]);
eq('center of a 7-hex flower: +6 neighbors +7 blob', hp(t, 0, 0), 1 + 6 + 7);

// attacks: every pair stacks (blue at 1,2,4,5 and red at 3 -> 4 pairs -> 8), on all 3 axes
t = run([[1, 0, 'blue'], [2, 0, 'blue'], [3, 0, 'red', 50], [4, 0, 'blue'], [5, 0, 'blue']]);
eq('stacking example, axis 1', dmg(t, 3, 0), 8);
t = run([[0, 1, 'blue'], [0, 2, 'blue'], [0, 3, 'red', 50], [0, 4, 'blue'], [0, 5, 'blue']]);
eq('stacking example, axis 2', dmg(t, 0, 3), 8);
t = run([[1, -1, 'blue'], [2, -2, 'blue'], [3, -3, 'red', 50], [4, -4, 'blue'], [5, -5, 'blue']]);
eq('stacking example, axis 3', dmg(t, 3, -3), 8);
t = run([[0, 0, 'blue'], [1, 0, 'red'], [2, 0, 'blue']]);
eq('single pair kills a fresh tile', [dmg(t, 1, 0), hp(t, 1, 0), t.dead.length], [2, null, 1]);
t = run([[0, 0, 'blue'], [1, 0, 'blue'], [2, 0, 'red', 5]]);
eq('one side only: no damage', dmg(t, 2, 0), 0);
t = run([[0, 0, 'blue'], [1, 0, 'red', 9], [2, 0, 'blue', 9], [3, 0, 'red', 9], [4, 0, 'blue']]);
eq('B R B R B: tiles between do not break pairs', [dmg(t, 1, 0), dmg(t, 2, 0), dmg(t, 3, 0)], [4, 2, 4]);
t = run([[0, 0, 'red', 50], [-2, 0, 'blue'], [-1, 0, 'blue'], [1, 0, 'blue'], [0, -1, 'blue'], [0, 1, 'blue']]);
eq('damage adds across axes', dmg(t, 0, 0), (2 + 1) * 2);
t = run([[0, 0, 'blue'], [1, 0, 'red'], [2, 0, 'blue'], [1, 1, 'red']]);
eq('a neighbor keeps a sandwiched tile alive', hp(t, 1, 0), 2);

// empty-hex option
const gap = [[0, 0, 'blue'], [1, 0, 'blue'], [3, 0, 'red', 50], [4, 0, 'blue']];
eq('gaps allowed by default', dmg(run(gap), 3, 0), 4);
eq('gaps block when enabled', dmg(run(gap, { damage: 2, gapsBlock: true }), 3, 0), 0);

// turn flow
const board = boardFromJSON(newBoardJSON());
let res = place(board, 0, 0, DEFAULT_RULES);
eq('blue opening resolves after 1 tile', [res.ok, !!res.resolution, board.turn], [true, true, 1]);
res = place(board, 0, 0, DEFAULT_RULES);
eq('occupied hex rejected', res.ok, false);
place(board, 5, 5, DEFAULT_RULES);
eq('red mid-turn', [board.turn, board.placed.length], [1, 1]);
undoPending(board);
eq('undo pending tile', [board.tiles.size, board.placed.length], [1, 0]);
place(board, 5, 5, DEFAULT_RULES);
res = place(board, 6, 5, DEFAULT_RULES);
eq('red turn resolves after 2 tiles', [board.turn, res.resolution.turn, board.lastPlaced.length], [2, 1, 2]);
eq('JSON round trip', boardToJSON(boardFromJSON(boardToJSON(board))), boardToJSON(board));

console.log(fails ? `${fails} FAILED` : 'All rules tests passed');
process.exit(fails ? 1 : 0);
