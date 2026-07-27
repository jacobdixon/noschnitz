/* ============================================================================
   Server-side feature gating for the table API.

   The client flag (src/flags.js) is compiled into the browser bundle and so
   never reaches a serverless function. It also isn't a control: hiding a menu
   entry stops people stumbling in, it doesn't stop a request. These routes are
   public URLs whether or not anything links to them, so the gate has to live
   here too.

   Two conditions, and the second is the one that actually bit:

   1. MULTIPLAYER must be enabled for this environment. Set on Preview (beta),
      unset on Production, mirroring VITE_MULTIPLAYER on the client.

   2. A real store must be configured. This is the important one. Upstash is
      scoped to Preview and Development only, so on Production getStore() falls
      back to the in-memory store — and on serverless every invocation can get
      a fresh isolate. A table would be created, then vanish before the next
      request; joining would 404 against a table you just made. That fails
      worse than not working at all, because it looks like data loss rather
      than an unfinished feature.

   Refusing with 503 and a stable code says the true thing: the feature exists,
   it isn't turned on here, and nothing you did is at fault.
   ========================================================================= */
import { hasRealStore } from "./store.js";
import { fail } from "./http.js";

export function multiplayerEnabled(env = process.env) {
  return env.MULTIPLAYER === "1";
}

/**
 * Guard for every table route. Returns false and responds when multiplayer
 * isn't available, so callers can `if (!requireMultiplayer(res)) return;`
 * exactly like methodGuard.
 */
export function requireMultiplayer(res, env = process.env) {
  if (!multiplayerEnabled(env)) {
    fail(res, 503, "multiplayer-disabled", "Multiplayer isn't available here yet.");
    return false;
  }
  if (!hasRealStore(env)) {
    // Enabled but unconfigured. Distinct code because it is a deployment
    // mistake rather than a deliberate state, and it should be loud.
    fail(res, 503, "no-store", "Multiplayer is enabled here but has no store configured.");
    return false;
  }
  return true;
}
