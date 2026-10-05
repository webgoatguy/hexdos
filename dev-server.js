// Local test server: `npm run dev`, then open http://localhost:3000
// Serves public/ and runs api/game.js the same way Vercel does.
// Without Redis environment variables, games are kept in memory (lost when you stop the server).
// To use a real Redis locally:  REDIS_URL=redis://localhost:6379 npm run dev

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './api/game.js';
import { backend } from './lib/store.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const port = Number(process.env.PORT) || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/game') return handler(req, res);
  const file = path.join(root, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
  if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
});

server.listen(port, async () => {
  const store = await backend().catch(err => ({ name: `error: ${err.message}` }));
  console.log(`Red vs Blue running at http://localhost:${port}  (storage: ${store.name})`);
});
