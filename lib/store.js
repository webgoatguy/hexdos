// Where games are stored. Each game is one Redis hash:  rvb:game:<id>  ->  { v: <version>, state: <JSON> }
//
// Connection is picked from environment variables, so either Redis option in the Vercel
// Marketplace works without code changes:
//   - Upstash for Redis   -> KV_REST_API_URL + KV_REST_API_TOKEN   (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
//   - Redis (Redis Cloud) -> REDIS_URL                              (any redis:// or rediss:// connection string)
// With none of these set, local development (`npm run dev`) keeps games in memory.

const PREFIX = 'rvb:game:';
export const TTL_SECONDS = 60 * 60 * 24 * 30; // a game is deleted 30 days after its last move

// Compare-and-set: only write if the stored version is still the one we read.
// ARGV: expected version ('' = game must not exist yet), new version, state JSON, TTL seconds
const CAS_SCRIPT = `
local cur = redis.call('HGET', KEYS[1], 'v')
if (not cur and ARGV[1] == '') or cur == ARGV[1] then
  redis.call('HSET', KEYS[1], 'v', ARGV[2], 'state', ARGV[3])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
  return 1
end
return 0`;

let backendPromise = null;

export function backend() {
  if (!backendPromise) {
    backendPromise = createBackend().catch(err => { backendPromise = null; throw err; });
  }
  return backendPromise;
}

async function createBackend() {
  const env = process.env;
  const restUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const restToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  const redisUrl = env.REDIS_URL || env.KV_URL;

  if (restUrl && restToken) {
    const { Redis } = await import('@upstash/redis');
    const r = new Redis({ url: restUrl, token: restToken, automaticDeserialization: false });
    return {
      name: 'upstash',
      async getV(id) {
        const v = await r.hget(PREFIX + id, 'v');
        return v == null ? null : String(v);
      },
      async load(id) {
        // raw mode returns [v, state]; accept an object too in case a client version maps it
        const raw = await r.hmget(PREFIX + id, 'v', 'state');
        const [v, state] = Array.isArray(raw) ? raw : [raw?.v, raw?.state];
        return v != null && state != null ? { v: String(v), state: String(state) } : null;
      },
      async cas(id, expected, next, state) {
        const res = await r.eval(CAS_SCRIPT, [PREFIX + id], [expected, next, state, String(TTL_SECONDS)]);
        return Number(res) === 1;
      },
    };
  }

  if (redisUrl) {
    const { createClient } = await import('redis');
    const c = createClient({ url: redisUrl });
    c.on('error', err => console.error('Redis connection error:', err.message));
    await c.connect();
    return {
      name: 'redis',
      async getV(id) {
        const v = await c.hGet(PREFIX + id, 'v');
        return v == null ? null : String(v);
      },
      async load(id) {
        const h = await c.hGetAll(PREFIX + id);
        return h && h.v != null ? { v: String(h.v), state: String(h.state) } : null;
      },
      async cas(id, expected, next, state) {
        const res = await c.eval(CAS_SCRIPT, { keys: [PREFIX + id], arguments: [expected, next, state, String(TTL_SECONDS)] });
        return Number(res) === 1;
      },
    };
  }

  if (env.VERCEL) {
    const err = new Error('No Redis database is connected. In Vercel, open this project → Storage → add a Redis database, connect it to the project, then redeploy.');
    err.status = 500;
    throw err;
  }

  // Local development only: one process, nothing persisted.
  const mem = new Map();
  return {
    name: 'memory',
    async getV(id) { return mem.get(id)?.v ?? null; },
    async load(id) { return mem.get(id) ?? null; },
    async cas(id, expected, next, state) {
      const cur = mem.get(id);
      if ((!cur && expected === '') || (cur && cur.v === expected)) { mem.set(id, { v: next, state }); return true; }
      return false;
    },
  };
}
