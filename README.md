# Red vs Blue

A two-player territory game on an endless hex grid. Create a game, send the link to a friend, and play in your browsers. A pass-and-play mode for one device is included.

## Deploy to Vercel

1. **Put the project on GitHub.** Create a new repository and upload the contents of this folder. (Or skip GitHub: run `npx vercel` inside this folder and follow the prompts.)
2. **Import it in Vercel.** Go to vercel.com → Add New → Project → pick the repository. Leave every build setting at its default. `vercel.json` already tells Vercel to serve the `public` folder and run the API in `api/`. Click Deploy.
3. **Add Redis.** Open the project in Vercel → **Storage** → **Create Database** → choose a Redis provider from the Marketplace:
   - **Upstash for Redis**, which provides `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or
   - **Redis** (Redis Cloud), which provides `REDIS_URL`.

   Either one works. The code detects which variables exist. Connect the database to the project for all environments.
4. **Redeploy.** Environment variables only reach new deployments: Deployments → ⋯ on the latest one → Redeploy.
5. **Play.** Open your site, enter a name, click **Create online game**, and send the link to your friend. Anyone else who opens the link can watch.

If the site says "No Redis database is connected", step 3 or 4 hasn't taken effect yet.

## Run it on your computer

```bash
npm install
npm run dev            # http://localhost:3000, games kept in memory
```

To use your real Vercel database locally, pull its variables with the Vercel CLI and pass them in:

```bash
npx vercel link
npx vercel env pull .env.development.local
node --env-file=.env.development.local dev-server.js
```

`npm test` runs the rules tests.

## How it works

| File | What it does |
| --- | --- |
| `public/rules.js` | The game rules. Both the browser and the server import this same file, so they always agree. |
| `public/index.html`, `public/app.js` | The page: main menu, board rendering, local play, online play. |
| `api/game.js` | The one API route (`/api/game`): create, join, move, undo, rematch, and read a game. |
| `lib/games.js` | Server-side checks: who holds which seat, whose turn it is, and applying moves with the rules. |
| `lib/store.js` | Redis storage. Each game is one hash (`rvb:game:<id>`). Saves are compare-and-set, so simultaneous moves can't overwrite each other. Games expire 30 days after their last move. |
| `dev-server.js` | A small local server that behaves like Vercel. |

- **Players.** Creating or joining a game gives your browser a private token (saved in localStorage) that holds your seat. Opening the link again on the same browser puts you back in your seat. Your recent games also appear on the main menu.
- **Updates.** Browsers ask the server for changes about once every 1.2 seconds while waiting on the other player, and less often when it's their own turn or the tab is hidden. When nothing has changed, a check costs one small Redis read. Expect roughly a few thousand Redis commands and function calls per hour of play; check your Redis provider's and Vercel plan's free limits. Poll timing is set in `pollDelay()` in `public/app.js`.
- **Rules options** (damage per attack, empty hexes blocking attacks) are chosen when a game is created and stay fixed for that game.
- **Rematch** clears the board on the same link and swaps colors. **Undo** online takes back a tile only while your turn is unfinished.
