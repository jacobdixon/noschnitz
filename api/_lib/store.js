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

// The only names hasRealStore() accepts, in the order it checks them. Exported
// so the diagnostic below and the error message it feeds cannot drift from the
// predicate they describe.
export const STORE_ENV_KEYS = Object.freeze([
  "KV_REST_API_URL",
  "UPSTASH_REDIS_REST_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_TOKEN",
]);

// Anything that looks like it was MEANT to be one of those.
//
// This exists because "no-store" was loud but not specific, and the two ways to
// get it wrong are invisible from outside while producing an identical symptom:
//
//   a prefix — the Vercel marketplace integration adds one automatically when
//              the bare name is already taken on the project, which it is here
//              (the Preview database owns it), so a Production store arrives as
//              prod_KV_REST_API_URL and nothing reads it
//   a typo   — same 503, same message, completely different fix
//
// Diagnosing either one cost a deploy cycle per guess. Naming what is actually
// in the environment turns that into one request.
const STOREISH = /(KV_REST|UPSTASH|REDIS)/i;

// How many near-miss names to report. A ceiling rather than a filter — the
// pattern above already scopes this to store credentials, and this only stops a
// pathological environment from producing an unbounded error body.
const MAX_REPORTED = 12;

/**
 * What the running deployment can see, for the 503 that says it can't see it.
 *
 * NAMES ONLY, NEVER VALUES. That rule is absolute and is the whole reason this
 * is safe to return over the wire: KV_REST_API_TOKEN is a bearer credential for
 * the entire table store, and putting one in a public error body would be far
 * worse than the misconfiguration being diagnosed. A name is not a secret — that
 * `prod_KV_REST_API_URL` exists tells an attacker nothing they can use — so the
 * disclosure is a list of strings that were already chosen from a fixed
 * vocabulary. scripts/flagtest.mjs asserts the no-value rule directly rather
 * than trusting this comment.
 */
export function storeEnvReport(env = process.env) {
  const accepted = {};
  for (const key of STORE_ENV_KEYS) accepted[key] = Boolean(env[key]);

  const otherNamesPresent = Object.keys(env)
    .filter((k) => STOREISH.test(k) && !STORE_ENV_KEYS.includes(k))
    .sort()
    .slice(0, MAX_REPORTED);

  return { accepted, otherNamesPresent };
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
