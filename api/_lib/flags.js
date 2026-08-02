/* ============================================================================
   Server-side feature gating for the table API.

   The client flag (src/flags.js) is compiled into the browser bundle and so
   never reaches a serverless function. It also isn't a control: hiding a menu
   entry stops people stumbling in, it doesn't stop a request. These routes are
   public URLs whether or not anything links to them, so the gate has to live
   here too.

   Two conditions, and the second is the one that actually bit:

   1. MULTIPLAYER must be enabled for this environment. Set on Preview (beta)
      and, since the 2026-07-31 promotion, on Production too — mirroring
      VITE_MULTIPLAYER on the client. Still checked rather than assumed: a
      preview branch, a local run, or a future environment may not have it.

   2. A real store must be configured. This is the important one. Each
      environment has its OWN Upstash database, and an environment without one
      falls back to the in-memory store — where, on serverless, every
      invocation can get a fresh isolate. A table would be created, then vanish
      before the next request; joining would 404 against a table you just made.
      That fails worse than not working at all, because it looks like data loss
      rather than an unfinished feature.

   Refusing with 503 and a stable code says the true thing: the feature exists,
   it isn't turned on here, and nothing you did is at fault.
   ========================================================================= */
import { hasRealStore, storeEnvReport } from "./store.js";
import { hasVoiceProvider, voiceEnvReport } from "./voice.js";
import { fail } from "./http.js";

export function multiplayerEnabled(env = process.env) {
  return env.MULTIPLAYER === "1";
}

export function voiceEnabled(env = process.env) {
  return env.VOICE === "1";
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
    //
    // Loud was not enough. This message says a thing is missing without saying
    // WHICH thing, and every way of getting it wrong — a provisioning prefix, a
    // typo, the wrong environment scope, a deployment that predates the
    // variable — produces this identical body. Telling them apart cost a
    // redeploy per hypothesis. `details` names what the deployment can actually
    // see, so the next person reads the answer instead of guessing at it.
    //
    // Names only. See storeEnvReport — this response is public.
    fail(
      res,
      503,
      "no-store",
      "Multiplayer is enabled here but has no store configured.",
      storeEnvReport(env)
    );
    return false;
  }
  return true;
}

/**
 * Guard for the voice route, layered ON TOP of requireMultiplayer rather than
 * replacing it — a voice room belongs to a table, so everything that makes a
 * table reachable has to hold first.
 *
 * Two conditions again, and the same reasoning as the store: a flag can be on
 * in an environment that has no credential behind it, and that combination
 * fails in the most confusing way available. A client whose build flag is on,
 * talking to a server whose flag is on but whose provider key is missing,
 * shows a working "Join audio" button that 503s when tapped — on a games
 * night, in front of five people. Refusing with a distinct code and naming the
 * missing credential is the difference between a five-minute fix and an
 * evening.
 */
export function requireVoice(res, env = process.env) {
  if (!requireMultiplayer(res, env)) return false;
  if (!voiceEnabled(env)) {
    fail(res, 503, "voice-disabled", "Voice isn't available here yet.");
    return false;
  }
  if (!hasVoiceProvider(env)) {
    // Names only — see voiceEnvReport. DAILY_API_KEY is account-wide, so this
    // body must never carry a value.
    fail(
      res,
      503,
      "no-voice-provider",
      "Voice is enabled here but has no provider configured.",
      voiceEnvReport(env)
    );
    return false;
  }
  return true;
}
