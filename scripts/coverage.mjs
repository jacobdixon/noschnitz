#!/usr/bin/env node
/* ============================================================================
   Coverage — in TWO passes, which must never be merged.

   Non-gating on purpose. There is no threshold here and no exit code tied to a
   percentage: this answers "what does the suite actually reach", which is a
   question worth asking periodically and a terrible thing to fail a build on.
   It also roughly doubles the suite's runtime (70s against 31s), which is the
   other reason it is not in `npm test`.

   ---------------------------------------------------------------------------
   WHY TWO PASSES. This is the part that will look like over-engineering until
   it bites, so it is written down.

   `rendertest` loads the UI through Vite's SSR module runner, because Node
   cannot import .jsx. That means a module like src/engine.js gets loaded TWICE
   in that process: once natively (rendertest imports it directly to build real
   game states) and once more as Vite's transformed copy, because the components
   import it too. Both report coverage against the same file path with different
   content and different offsets, and c8 cannot reconcile them.

   The result is not noise, it is WRONG, and wrong in the direction that causes
   damage — it under-reports. Measured at the time this was written:

     engine.js, undertest alone ................. 92.67%
     engine.js, rendertest alone ................ 57.36%
     engine.js, both merged ..................... 62.43%   <-- impossible

   A union cannot be smaller than one of its members. Anybody reading that
   merged number would conclude the engine is half-tested and go looking for a
   problem that does not exist — or worse, "fix" it by writing tests for code
   that already has them.

   So: the logic pass owns the .js answer, the UI pass owns the .jsx answer, and
   they are printed separately with no merge step anywhere. If you ever add a
   second suite that loads app modules through Vite, it belongs in the UI pass.

   Usage: node scripts/coverage.mjs [--html]
   ========================================================================= */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const wantHtml = process.argv.includes("--html");

const run = (label, { skip, only, include, outDir }) => {
  rmSync(outDir, { recursive: true, force: true });
  const reporters = ["--reporter=text", ...(wantHtml ? ["--reporter=html"] : [])];
  const args = [
    "c8",
    ...reporters,
    "--report-dir", outDir,
    "--temp-directory", `${outDir}/tmp`,
    "--all",
    ...include.flatMap((i) => ["--include", i]),
    "node", "scripts/runtests.mjs",
    ...(skip ? ["--skip", skip] : []),
    ...(only ? ["--only", only] : []),
  ];
  console.log(`\n${"=".repeat(72)}\n${label}\n${"=".repeat(72)}`);
  const r = spawnSync("npx", args, { stdio: "inherit" });
  return r.status ?? 1;
};

/* Pass 1 — the logic. Everything except rendertest, so no module is ever seen
   through Vite's transform. This is the authoritative number for src/*.js,
   src/store/ and api/. */
const logic = run(
  "PASS 1 of 2 — logic (src/*.js, api/). Everything except rendertest.",
  {
    skip: "rendertest",
    include: ["src/**/*.js", "api/**/*.js"],
    outDir: "coverage/logic",
  }
);

/* Pass 2 — the UI. rendertest only, reporting only on .jsx, which is loaded
   exactly one way (through Vite) and so has exactly one representation. */
const ui = run(
  "PASS 2 of 2 — UI (src/**/*.jsx). rendertest only.",
  {
    only: "rendertest",
    include: ["src/**/*.jsx"],
    outDir: "coverage/ui",
  }
);

console.log(`
${"=".repeat(72)}
Two numbers, deliberately not one.

  coverage/logic   src/*.js and api/  — from every suite except rendertest
  coverage/ui      src/*.jsx          — from rendertest

Do NOT merge these or quote a combined figure. rendertest loads app modules
through Vite's SSR transform as well as natively, so a merged report
under-reports .js files badly (engine.js measured 92.67% alone, 62.43% merged).
The two passes exist precisely so that neither number is contaminated.

Neither pass gates anything. A drop here is a question, not a failure.
${"=".repeat(72)}`);

// The exit code reflects whether the SUITES passed, not what they covered.
process.exit(logic || ui);
