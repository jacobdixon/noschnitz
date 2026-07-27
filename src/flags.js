/* ============================================================================
   Feature flags.

   One flag today: whether the multiplayer half of the app is reachable.

   Build-time, not runtime, and that distinction is the whole point. Vite
   inlines `import.meta.env.VITE_*` when it builds, so a production build with
   the flag off has `false` written into it literally — and every branch behind
   it is dead code the bundler removes. The multiplayer client isn't hidden in
   production, it isn't there. Nothing to find in devtools, nothing to reach by
   guessing a URL, and no half-working table for someone who stumbles in.

   The cost is that flipping it needs a redeploy, which is the right trade for
   something that gates an unfinished feature rather than an experiment.

   How the two environments differ:

     production  (www.noschnitz.com, master)  flag unset -> solo only
     beta        (beta.noschnitz.com, beta)   VITE_MULTIPLAYER=1

   Those are separate Vercel environments — Production and Preview — which is
   also why beta has an Upstash store and production doesn't. The same split
   that keeps test tables out of the live keyspace keeps unfinished multiplayer
   out of the live site.

   The server has its own flag (MULTIPLAYER, no VITE_ prefix, read at runtime by
   the API routes) because this one never reaches it: VITE_* vars exist only in
   the browser bundle. See api/_lib/flags.js — a client that can't see the
   feature is not a control, only a courtesy.
   ========================================================================= */

export const MULTIPLAYER_ENABLED = import.meta.env.VITE_MULTIPLAYER === "1";
