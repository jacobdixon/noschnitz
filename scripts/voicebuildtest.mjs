#!/usr/bin/env node
/* ============================================================================
   Does the production build contain any audio code?

   This is the guard behind "voice is beta-only". Everything else about that
   claim is a promise: a variable set in a dashboard, a comment in flags.js, a
   button that renders conditionally. This is the only thing that checks it, and
   it checks the artefact rather than the intent — the bundle Vercel would serve
   from www.noschnitz.com, built exactly the way Production builds it.

   Why it has to exist at all: `VOICE_ENABLED` only eliminates code if Rollup
   can fold it across module boundaries. It does today, and the same pattern has
   held for VITE_MULTIPLAYER for months — but that is an optimisation, not a
   language guarantee. Restructuring useVoice.js, hoisting the import, or a
   Vite upgrade could each quietly turn elimination into "renders nothing while
   shipping the whole Daily SDK." Nobody would notice, because the feature would
   still be correctly invisible on screen. That is the failure this catches.

   BIDIRECTIONAL, and that is the important part. Grepping the flag-off bundle
   for a token and finding zero passes just as convincingly when the token is
   misspelled, when the build silently failed, or when the whole feature was
   deleted. So every token must be ABSENT flag-off and PRESENT flag-on. The
   flag-on half is the negative control that makes the flag-off half mean
   something — the same reasoning as the /api/tables/ discriminator in
   verify-beta.yml, which measures 0 against 8 rather than just checking 0.

   Usage: node scripts/voicebuildtest.mjs
   ========================================================================= */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

// Structural strings, not UI labels — with one deliberate exception.
//
// The rule this repo learned the hard way (see verify-beta.yml) is to pick
// discriminators somebody cannot reword without knowing a test depends on
// them. "Join audio" breaks that rule and is here anyway, because it is the
// single string a person would actually look for in a bundle to answer "did
// audio ship to production", and its being rewordable is survivable: this test
// fails loudly and points at this comment, rather than silently passing.
const TOKENS = [
  "daily",        // the SDK, the chunk name, and every URL it uses
  "/voice",       // the API route the client calls
  "toggleMute",   // the hook's surface
  "Join audio",   // the menu entry — see the caveat above
];

const build = (label, env) => {
  const out = mkdtempSync(join(tmpdir(), `nsbuild-${label}-`));
  execFileSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir"], {
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  const dir = join(out, "assets");
  const text = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
  return { out, text, files: readdirSync(dir) };
};

// Production's shape: multiplayer on (since the 2026-07-31 promotion), voice
// unset. Deliberately NOT a bare build — the thing being tested is that voice
// is absent from a build that has everything else turned on, which is the
// build www actually serves.
const off = build("off", { VITE_MULTIPLAYER: "1", VITE_VOICE: "" });
const on = build("on", { VITE_MULTIPLAYER: "1", VITE_VOICE: "1" });

try {
  for (const tok of TOKENS) {
    const nOff = (off.text.match(new RegExp(tok.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&"), "gi")) || []).length;
    const nOn = (on.text.match(new RegExp(tok.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&"), "gi")) || []).length;

    check(`production carries no "${tok}"`, nOff === 0, `found ${nOff}`);
    // The control. Without this the check above is satisfied by a typo.
    check(`...and beta does (so the check is real)`, nOn > 0, `found ${nOn} — the token may be stale`);
  }

  // The SDK is its own chunk, so it is not merely absent from production — it
  // is not fetched on beta either until somebody taps the button. Worth pinning
  // separately: a refactor that turns the dynamic import into a static one
  // would keep every token check above passing while making all five people at
  // a table download 261kB they may never use.
  const offChunks = off.files.filter((f) => /daily/i.test(f));
  const onChunks = on.files.filter((f) => /daily/i.test(f));
  check("production emits no Daily chunk", offChunks.length === 0, offChunks.join(", "));
  check("beta emits Daily as a SEPARATE, lazy chunk", onChunks.length === 1, onChunks.join(", "));

  // And the multiplayer discriminator still reads the way verify-production.yml
  // expects, so this build is the one that workflow describes.
  check("the production build is still the multiplayer build",
    (off.text.match(/\/api\/tables\//g) || []).length > 0);
} finally {
  rmSync(off.out, { recursive: true, force: true });
  rmSync(on.out, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  console.error("\nAudio code may be reaching www.noschnitz.com. Do not merge.");
  process.exit(1);
}
console.log("PASS — the production build contains no audio code, and beta's is lazy.");
