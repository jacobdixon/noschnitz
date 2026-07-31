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

   Where the flag stands (2026-07-31 — multiplayer was promoted to production):

     production  (www.noschnitz.com, master)  VITE_MULTIPLAYER=1
     beta        (beta.noschnitz.com, beta)   VITE_MULTIPLAYER=1

   Those are still separate Vercel environments — Production and Preview — each
   with its OWN Upstash database. That split no longer gates the feature; it
   keeps beta's tables out of the live keyspace, which is the part that still
   matters and is invisible until two groups play at once.

   Note that the table above describes VERCEL, not this file. Being flag-off was
   only ever the absence of a variable on an environment, so nothing here changed
   when it was promoted — the variable arrived and the next build inlined `true`.
   Which means this file is also the rollback: unset it on Production, redeploy,
   and every branch behind it is eliminated again. See "Promoting multiplayer to
   production" in CLAUDE.md for the four variables that move together, why
   `VITE_MULTIPLAYER` in particular must not be marked "sensitive" (build-time
   variables are withheld from sensitive), and why the bundle is the only honest
   place to check which build actually landed.

   The server has its own flag (MULTIPLAYER, no VITE_ prefix, read at runtime by
   the API routes) because this one never reaches it: VITE_* vars exist only in
   the browser bundle. See api/_lib/flags.js — a client that can't see the
   feature is not a control, only a courtesy.
   ========================================================================= */

export const MULTIPLAYER_ENABLED = import.meta.env.VITE_MULTIPLAYER === "1";
