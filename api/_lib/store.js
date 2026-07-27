/* ============================================================================
   Store selection for the API routes.

   Upstash when credentials are present, in-memory otherwise.

   The in-memory fallback is for local dev and tests ONLY. On Vercel each
   invocation can run in a fresh isolate, so an in-memory store would lose the
   table between two requests from the same player — the failure looks like
   "my table vanished" rather than a clear error. Deployed environments must
   have KV_REST_API_URL set; the warning below is the tripwire if one doesn't.

   The store is cached per-process so warm invocations reuse the client instead
   of rebuilding it (and, for the memory store, so state survives across
   requests handled by the same isolate).
   ========================================================================= */
import { createUpstashStore } from "../../src/store/upstash.js";
import { createMemoryStore } from "../../src/store/memory.js";

let cached = null;

// Whether a real, persistent store is configured. Separate from getStore so the
// feature gate can ask without instantiating anything — and so the answer is
// the same one getStore uses to decide, rather than a second guess at it.
export function hasRealStore(env = process.env) {
  return Boolean(
    (env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL) &&
    (env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN)
  );
}

export function getStore(env = process.env) {
  if (cached) return cached;

  if (hasRealStore(env)) {
    cached = createUpstashStore({ env });
  } else {
    if (env.VERCEL) {
      console.warn(
        "[store] No Redis credentials in a Vercel environment — falling back to " +
        "in-memory, which does NOT persist across invocations. Tables will appear " +
        "to vanish. Connect the Upstash integration to this environment."
      );
    }
    cached = createMemoryStore();
  }
  return cached;
}

// Tests need to swap the store or clear the cache between cases.
export function _resetStore(next = null) {
  cached = next;
}
