#!/usr/bin/env node
/* ============================================================================
   Feature gate tests.

   A flag that quietly stops gating is worse than no flag, because everything
   downstream is built on the assumption that it holds. These assert the two
   properties production depends on:

     1. Every table route refuses when multiplayer isn't enabled here.
     2. It also refuses when it IS enabled but no real store is configured —
        the deployment mistake that fails worst, because an in-memory store on
        serverless creates a table and then loses it, which reads as data loss
        rather than an unfinished feature.

   The client half of the flag is compile-time and can't be tested here; it's
   verified by building both ways and grepping the bundle (see the commit).

   Usage: node scripts/flagtest.mjs
   ========================================================================= */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { multiplayerEnabled, requireMultiplayer } from "../api/_lib/flags.js";
import { hasRealStore, storeEnvReport, STORE_ENV_KEYS } from "../api/_lib/store.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

const mockRes = () => ({
  statusCode: 200, headers: {}, body: "",
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  end(c) { this.body = c || ""; },
});
const codeOf = (res) => { try { return JSON.parse(res.body).error.code; } catch { return null; } };

/* ---------------------------- the two predicates -------------------------- */
{
  check("disabled when MULTIPLAYER is unset", !multiplayerEnabled({}));
  check("disabled when MULTIPLAYER is anything but 1", !multiplayerEnabled({ MULTIPLAYER: "true" }));
  check("enabled when MULTIPLAYER is 1", multiplayerEnabled({ MULTIPLAYER: "1" }));

  check("no store when nothing is configured", !hasRealStore({}));
  check("no store on a URL alone", !hasRealStore({ KV_REST_API_URL: "u" }));
  check("store when url and token are both present",
    hasRealStore({ KV_REST_API_URL: "u", KV_REST_API_TOKEN: "t" }));
  check("the Upstash-native spelling also counts",
    hasRealStore({ UPSTASH_REDIS_REST_URL: "u", UPSTASH_REDIS_REST_TOKEN: "t" }));
}

/* ------------------------------- the guard -------------------------------- */
{
  // Production's shape: flag off, no store.
  let res = mockRes();
  check("production is refused", requireMultiplayer(res, {}) === false);
  check("...with 503", res.statusCode === 503, `got ${res.statusCode}`);
  check("...and a stable code", codeOf(res) === "multiplayer-disabled", `got ${codeOf(res)}`);

  // The deployment mistake: enabled, but nothing to store tables in.
  res = mockRes();
  check("enabled without a store is refused",
    requireMultiplayer(res, { MULTIPLAYER: "1" }) === false);
  check("...distinguishably", codeOf(res) === "no-store", `got ${codeOf(res)}`);

  // The 503 has to say WHICH name is missing, or it is the same message for a
  // prefix, a typo, the wrong environment scope and a stale deployment — which
  // is what made a real promotion cost a redeploy per hypothesis.
  res = mockRes();
  requireMultiplayer(res, { MULTIPLAYER: "1", prod_KV_REST_API_URL: "u", prod_KV_REST_API_TOKEN: "t" });
  const details = JSON.parse(res.body).error.details;
  check("the no-store body reports which accepted names are present",
    details.accepted.KV_REST_API_URL === false && details.accepted.UPSTASH_REDIS_REST_TOKEN === false);
  check("...and names the near-misses that were actually set",
    details.otherNamesPresent.includes("prod_KV_REST_API_URL") &&
    details.otherNamesPresent.includes("prod_KV_REST_API_TOKEN"),
    JSON.stringify(details.otherNamesPresent));

  // Beta's shape.
  res = mockRes();
  check("enabled with a store is allowed",
    requireMultiplayer(res, {
      MULTIPLAYER: "1", KV_REST_API_URL: "u", KV_REST_API_TOKEN: "t",
    }) === true);
  check("...and says nothing", res.body === "" && res.statusCode === 200);
}

/* ------------------- the diagnostic never leaks a value ------------------- */
{
  // The one property that makes storeEnvReport safe to return over the wire.
  // A token in a public 503 body would be far worse than the misconfiguration
  // it diagnoses, so this is asserted rather than left to a code comment — and
  // asserted against the SERIALIZED body, because that is what actually ships.
  const SECRET = "s3cret-token-do-not-ship";
  const env = {
    MULTIPLAYER: "1",
    prod_KV_REST_API_URL: `https://example.upstash.io/${SECRET}`,
    prod_KV_REST_API_TOKEN: SECRET,
    UPSTASH_REDIS_REST_TOKEN_OLD: SECRET,
    SOME_UNRELATED_SECRET: SECRET,
  };
  const res = mockRes();
  requireMultiplayer(res, env);
  check("no value from the environment reaches the response body",
    !res.body.includes(SECRET), res.body);
  check("...and the whole report is names and booleans only",
    !JSON.stringify(storeEnvReport(env)).includes(SECRET));

  // Scoped to store credentials — it is a diagnostic, not an environment dump.
  check("unrelated variables are not named",
    !res.body.includes("SOME_UNRELATED_SECRET"), res.body);

  // The report describes the predicate, so the two cannot drift apart.
  check("every accepted name is reported on",
    STORE_ENV_KEYS.every((k) => k in storeEnvReport({}).accepted));
  const good = storeEnvReport({ KV_REST_API_URL: "u", KV_REST_API_TOKEN: "t" });
  check("a correct environment reports both halves present",
    good.accepted.KV_REST_API_URL && good.accepted.KV_REST_API_TOKEN);
  check("...and has no near-misses to report", good.otherNamesPresent.length === 0);
}

/* ----------------------- every route carries the guard -------------------- */
{
  // Structural rather than behavioural: a new route added without the guard is
  // a hole that no functional test would notice, because it would be reachable
  // only in the environment nobody tests.
  const routes = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "_lib") walk(p); }
      else if (p.endsWith(".js")) routes.push(p);
    }
  };
  walk("api");

  check("found the table routes", routes.length >= 9, `found ${routes.length}`);

  const { readFileSync } = await import("node:fs");
  // Matches the CALL, not the identifier. Checking for "requireMultiplayer"
  // anywhere also matches the import line, so deleting the guard while leaving
  // the import — the exact shape of an accidental removal — passed silently.
  //
  // Deliberately open on the arguments. Pinning it to "requireMultiplayer(res)"
  // failed events.js, which is a factory and so has to pass its env explicitly
  // rather than reading the ambient one. That route was correctly gated the
  // whole time; the test was wrong, which costs more than no test — a suite
  // that cries wolf gets read as broken rather than as a finding.
  //
  // `requireVoice` counts as a gate because it CALLS requireMultiplayer first
  // and returns false if it fails — a voice room belongs to a table, so
  // everything that makes a table reachable has to hold before it. That is a
  // real dependency and not an assumption: scripts/voicetest.mjs asserts it
  // directly ("voice on but multiplayer off is still refused", and that the
  // code comes back as multiplayer-disabled rather than a voice one). If that
  // implication is ever weakened, voicetest fails — which is the only reason
  // it is safe for this regex to accept the wrapper.
  const CALL = /require(?:Multiplayer|Voice)\(\s*res\b/;
  const missing = routes.filter((p) => !CALL.test(readFileSync(p, "utf8")));
  check("every route is gated", missing.length === 0, missing.join(", "));

  // And gated BEFORE it does any work — a guard after the store call has
  // already paid the cost it exists to avoid.
  const late = routes.filter((p) => {
    const s = readFileSync(p, "utf8");
    const guard = s.search(CALL);
    const store = s.indexOf("getStore(");
    return guard >= 0 && store >= 0 && guard > store;
  });
  check("the guard runs before the store is touched", late.length === 0, late.join(", "));
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — multiplayer is gated everywhere, in both directions.");
