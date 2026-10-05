// Server-side game logic. The server is the authority: it checks whose turn it is,
// applies the move with the shared rules, and saves the result.

import crypto from 'node:crypto';
import {
  DEFAULT_RULES, colorOf, newBoardJSON, boardFromJSON, boardToJSON, place, undoPending,
} from '../public/rules.js';
import { backend } from './store.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const COLORS = ['blue', 'red'];
const NAME = { blue: 'Blue', red: 'Red' };
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const MAX_TILES = 5000;
const MAX_COORD = 1_000_000;

const newId = () => Array.from(crypto.randomBytes(7), b => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
const newToken = () => crypto.randomBytes(18).toString('base64url');

export const isValidId = id => typeof id === 'string' && /^[a-z0-9]{4,16}$/.test(id);

function cleanName(name, fallback) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20);
  return s || fallback;
}

function cleanRules(r) {
  const d = Math.floor(Number(r?.damage));
  return {
    damage: Number.isFinite(d) ? Math.min(99, Math.max(0, d)) : DEFAULT_RULES.damage,
    gapsBlock: !!r?.gapsBlock,
  };
}

function seatOf(game, token) {
  if (!token) return null;
  return COLORS.find(c => game.seats[c] && game.seats[c].token === token) || null;
}

// What players see: everything except the seat tokens.
export function publicView(game, token) {
  return {
    id: game.id,
    rules: game.rules,
    round: game.round,
    board: game.board,
    last: game.last,
    seats: {
      blue: game.seats.blue ? { name: game.seats.blue.name } : null,
      red: game.seats.red ? { name: game.seats.red.name } : null,
    },
    you: seatOf(game, token),
  };
}

export async function createGame({ name, color, rules }) {
  const store = await backend();
  const seat = color === 'blue' || color === 'red' ? color : (crypto.randomInt(2) ? 'red' : 'blue');
  const token = newToken();
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = Date.now();
    const game = {
      id: newId(),
      createdAt: now,
      updatedAt: now,
      rules: cleanRules(rules),
      seats: { blue: null, red: null },
      round: 1,
      board: newBoardJSON(),
      last: null,
      resolutions: 0,
    };
    game.seats[seat] = { name: cleanName(name, NAME[seat]), token };
    if (await store.cas(game.id, '', '1', JSON.stringify(game))) {
      return { v: '1', token, state: publicView(game, token) };
    }
  }
  throw new HttpError(500, 'Could not create a game. Please try again.');
}

export async function getGame(id, sinceV, token) {
  const store = await backend();
  if (sinceV) {
    const v = await store.getV(id);
    if (v == null) throw new HttpError(404, 'This game does not exist or has expired.');
    if (v === sinceV) return { changed: false, v };
  }
  const rec = await store.load(id);
  if (!rec) throw new HttpError(404, 'This game does not exist or has expired.');
  return { v: rec.v, state: publicView(JSON.parse(rec.state), token) };
}

// Read, change, and save with compare-and-set; retry if someone else saved in between.
async function mutate(id, change) {
  const store = await backend();
  for (let attempt = 0; attempt < 6; attempt++) {
    const rec = await store.load(id);
    if (!rec) throw new HttpError(404, 'This game does not exist or has expired.');
    const game = JSON.parse(rec.state);
    const result = change(game) || {};
    game.updatedAt = Date.now();
    const next = String(Number(rec.v) + 1);
    if (await store.cas(id, rec.v, next, JSON.stringify(game))) return { v: next, game, ...result };
  }
  throw new HttpError(409, 'The game is busy. Please try again.');
}

export async function joinGame(id, token, name) {
  const myToken = token || newToken();
  const out = await mutate(id, game => {
    if (seatOf(game, myToken)) return;
    const open = COLORS.find(c => !game.seats[c]);
    if (!open) throw new HttpError(409, 'Both seats are taken. You can still watch.');
    game.seats[open] = { name: cleanName(name, NAME[open]), token: myToken };
  });
  return { v: out.v, token: myToken, state: publicView(out.game, myToken) };
}

function requireSeat(game, token) {
  const seat = seatOf(game, token);
  if (!seat) throw new HttpError(403, "You're watching this game, not playing in it.");
  return seat;
}

export async function makeMove(id, token, q, r) {
  if (!Number.isInteger(q) || !Number.isInteger(r) || Math.abs(q) > MAX_COORD || Math.abs(r) > MAX_COORD) {
    throw new HttpError(400, 'That is not a valid hex.');
  }
  const out = await mutate(id, game => {
    const seat = requireSeat(game, token);
    if (!game.seats.blue || !game.seats.red) throw new HttpError(409, 'Waiting for an opponent to join.');
    const board = boardFromJSON(game.board);
    if (colorOf(board.turn) !== seat) throw new HttpError(409, "It's not your turn.");
    if (board.tiles.size >= MAX_TILES) throw new HttpError(409, 'The board is full.');
    const res = place(board, q, r, game.rules);
    if (!res.ok) throw new HttpError(409, res.error);
    if (res.resolution) {
      game.resolutions += 1;
      game.last = { id: game.resolutions, ...res.resolution };
    }
    game.board = boardToJSON(board);
  });
  return { v: out.v, state: publicView(out.game, token) };
}

export async function undoMove(id, token) {
  const out = await mutate(id, game => {
    const seat = requireSeat(game, token);
    const board = boardFromJSON(game.board);
    if (colorOf(board.turn) !== seat || !board.placed.length) {
      throw new HttpError(409, 'Only a tile from your unfinished turn can be taken back.');
    }
    undoPending(board);
    game.board = boardToJSON(board);
  });
  return { v: out.v, state: publicView(out.game, token) };
}

// Start over on the same link, with the players swapping colors.
export async function rematch(id, token) {
  const out = await mutate(id, game => {
    requireSeat(game, token);
    game.seats = { blue: game.seats.red, red: game.seats.blue };
    game.board = newBoardJSON();
    game.round += 1;
    game.last = null;
  });
  return { v: out.v, state: publicView(out.game, token) };
}
