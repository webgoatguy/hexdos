// The game API (one Vercel Function).
//   GET  /api/game?id=<id>[&v=<version>]   -> current game, or { changed: false } if still at <version>
//   POST /api/game  { action: 'create' | 'join' | 'move' | 'undo' | 'rematch', ... }
// Players identify themselves with the token they got on create/join, sent as the x-player-token header.

import {
  HttpError, isValidId, createGame, getGame, joinGame, makeMove, undoMove, rematch,
} from '../lib/games.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://localhost');
    const token = String(req.headers['x-player-token'] || '');

    if (req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!isValidId(id)) throw new HttpError(400, 'Missing or invalid game id.');
      return send(res, 200, await getGame(id, url.searchParams.get('v') || '', token));
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

    const body = await readJSON(req);
    if (body.action === 'create') {
      return send(res, 200, await createGame({ name: body.name, color: body.color, rules: body.rules }));
    }
    if (!isValidId(body.id)) throw new HttpError(400, 'Missing or invalid game id.');
    switch (body.action) {
      case 'join':    return send(res, 200, await joinGame(body.id, token, body.name));
      case 'move':    return send(res, 200, await makeMove(body.id, token, body.q, body.r));
      case 'undo':    return send(res, 200, await undoMove(body.id, token));
      case 'rematch': return send(res, 200, await rematch(body.id, token));
      default:        throw new HttpError(400, 'Unknown action.');
    }
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    return send(res, status, { error: status >= 500 && !err.status ? 'Server error.' : err.message });
  }
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

async function readJSON(req) {
  try {
    // Vercel already parses JSON bodies into req.body; a plain Node server leaves the stream to read.
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}
