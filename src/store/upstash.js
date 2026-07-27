/* ============================================================================
   Upstash Redis table store.

   Implements the same contract as src/store/memory.js — see that file for the
   contract itself. memory.js is the reference implementation; this one has to
   match it, and scripts/storetest.mjs runs one suite against both to prove it.

   SERVER ONLY. This module reads KV_REST_API_* out of the environment and must
   never be imported from anything under src/ that the browser loads — only
   from serverless functions in api/. Nothing bundles it today because nothing
   in the client import graph reaches it; keep it that way.

   Two design notes:

   1. Compare-and-swap needs to be atomic, and Upstash speaks HTTP — there is
      no connection to hold a WATCH across, so the usual WATCH/MULTI/EXEC
      optimistic-locking dance isn't available. The check and the write have to
      happen inside a single round trip, which means a Lua script (EVAL), where
      Redis runs the whole thing atomically.

   2. Each table is a HASH with `version` and `state` fields rather than one
      JSON string. That keeps the version comparable in Lua with a plain HGET,
      instead of decoding the whole blob with cjson — one less thing to depend
      on from the Lua sandbox, and it doesn't parse a few KB of JSON on every
      write just to read one integer.
   ========================================================================= */
import { Redis } from "@upstash/redis";
import { DEFAULT_TTL_MS } from "./memory.js";

// Redis.fromEnv() looks for UPSTASH_REDIS_REST_URL / _TOKEN. The Vercel
// marketplace integration provisions the same values under KV_REST_API_URL /
// KV_REST_API_TOKEN, so the client is constructed explicitly. Accepts either
// spelling so this still works if the env is ever renamed.
export function redisFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Missing Redis credentials: expected KV_REST_API_URL and KV_REST_API_TOKEN. " +
      "Run `vercel env pull .env.development.local` for local dev."
    );
  }
  return new Redis({ url, token });
}

const keyFor = (id) => `table:${id}`;

// Create only if absent, and set the TTL in the same atomic step so a crash
// between the two can't leave an immortal table behind.
const CREATE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'version', ARGV[1], 'state', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

// The CAS write. Returns -1 when the table is gone (expired mid-flight, which
// the caller must not treat as a conflict — retrying would never succeed), 0
// on a version mismatch, 1 on success.
const CAS = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('HGET', KEYS[1], 'version') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'version', ARGV[2], 'state', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`;

export function createUpstashStore({ redis, ttlMs = DEFAULT_TTL_MS, env } = {}) {
  const r = redis || redisFromEnv(env);

  // The SDK deserializes JSON automatically on the way out but stores whatever
  // it's given; both directions are pinned explicitly here so the wire format
  // doesn't depend on SDK defaults changing.
  const encode = (table) => JSON.stringify(table);
  const decode = (raw) => {
    if (raw == null) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  };

  return {
    async create(table) {
      const ok = await r.eval(CREATE, [keyFor(table.id)], [
        String(table.version),
        encode(table),
        String(ttlMs),
      ]);
      return Number(ok) === 1 ? { ok: true, table } : { ok: false, error: "exists" };
    },

    async get(id) {
      // Redis drops the key wholesale at expiry, so an absent hash and an
      // expired table are the same observable thing — matching memory.js,
      // which deletes on read rather than returning a stale row.
      return decode(await r.hget(keyFor(id), "state"));
    },

    async put(table, expectedVersion) {
      const res = Number(await r.eval(CAS, [keyFor(table.id)], [
        String(expectedVersion),
        String(table.version),
        encode(table),
        String(ttlMs),
      ]));

      if (res === 1) return { ok: true, table };
      if (res === -1) return { ok: false, error: "no-such-table" };

      // Hand back what's actually stored so the caller's retry recomputes
      // against the winner rather than re-reading in a separate round trip.
      return { ok: false, conflict: true, table: await this.get(table.id) };
    },

    async touch(id) {
      const ok = await r.pexpire(keyFor(id), ttlMs);
      return Number(ok) === 1 ? { ok: true } : { ok: false, error: "no-such-table" };
    },

    async del(id) {
      await r.del(keyFor(id));
    },
  };
}
