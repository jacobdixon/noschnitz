#!/usr/bin/env node
/* ============================================================================
   The test runner — `npm test`.

   This used to be a 26-link `&&` chain in package.json. That was fine when the
   suite was small and stopped being fine at ~313s, which is long enough that
   people stop running it before pushing. The chain also had two structural
   problems that had nothing to do with total time:

     1. It ran everything on one core while the runner has four.
     2. It ran the cheap suites first and the two 100s+ suites near the end, so
        a `voicebuildtest` failure — 8 seconds of work — took over four minutes
        to surface.

   So: a worker pool sized to the box, longest-first, with the output of a
   failing suite printed at the end rather than interleaved with three other
   suites' output.

   MEASURED: 313s sequential -> ~33s here, on 4 cores, with the null-control
   sample sizes cut in the same change (see package.json). The floor is now
   `undertest` at ~31s, so that is the suite to look at if this needs to get
   faster again — everything else fits inside its shadow, which is why adding
   the two UI suites in 0.58.5 cost about two seconds rather than ten.

   ---------------------------------------------------------------------------
   THE ONE THING THAT IS NOT SAFE TO PARALLELISE, and why it is called out
   rather than left to be rediscovered:

   `gradetest` asserts a TIMING RATIO — grading a hand must cost under 150
   reference solves on the same machine. Its own header explains that the ratio
   exists so machine speed divides out, which is the right fix for a slow
   container. It does not divide out CPU CONTENTION, because the numerator is a
   single measurement and the denominator is averaged over five: one unlucky
   scheduling stall inflates the ratio without touching the reference.

   Measured on this box: 72-78x idle, 56-102x under a 4-way load. The bound is
   150, so nothing failed — but the headroom went from ~1.9x to ~1.5x, and per
   CLAUDE.md a marginal test here is not a red check, it is a silently withheld
   beta deploy. So gradetest runs ALONE, before the pool starts. It costs ~6s of
   wall clock and buys back the variance. Do not "optimise" it into the pool
   without re-tuning that bound against a loaded box first.
   ========================================================================= */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/* ---------------------------------------------------------------------------
   The suites, resolved out of package.json rather than spelled out here.

   That matters: `belieftest`, `coalitiontest` and `firingtest` carry sample
   sizes as arguments, and those are the numbers a person tunes. Duplicating
   them here would mean a change to package.json silently not reaching CI.

   `weight` is a rough measured cost in seconds, used only to schedule the
   expensive suites first (longest-processing-time). A stale weight costs a
   little packing efficiency and nothing else, so it does not need maintaining
   precisely — but if a suite grows a lot, bump it or it will start straggling.
   ------------------------------------------------------------------------ */
const SUITES = [
  { name: "gradetest", weight: 6, exclusive: true }, // see header
  { name: "undertest", weight: 31 },
  { name: "firingtest", weight: 18 },
  { name: "coalitiontest", weight: 16 },
  { name: "aitest", weight: 14 },
  { name: "belieftest", weight: 10 },
  { name: "voicebuildtest", weight: 9 },
  { name: "clairvoyancetest", weight: 5 },
  // Runs a Vite SSR server to load JSX; 2.6s alone, ~7s in the pool.
  //
  // It was 21s until the server was told not to watch or pre-scan (see the
  // comment on createServer in rendertest.mjs). If this suite ever balloons
  // again, suspect startup crawling something new in the project root before
  // suspecting the tests — a coverage run alone put it from 8s to 21s.
  { name: "rendertest", weight: 7 },
  { name: "leaktest", weight: 4 },
  { name: "tablestreamtest", weight: 1 },
  { name: "lint", weight: 4 },
  { name: "soaktest", weight: 4 },
  { name: "pacingtest", weight: 1 },
  { name: "aiskilltest", weight: 1 },
  { name: "tabletest", weight: 1 },
  { name: "exporttest", weight: 1 },
  { name: "storetest", weight: 1 },
  { name: "streamtest", weight: 1 },
  { name: "e2etest", weight: 1 },
  { name: "fantest", weight: 1 },
  { name: "scoringtest", weight: 1 },
  { name: "flagtest", weight: 1 },
  { name: "voicetest", weight: 1 },
  { name: "statustest", weight: 1 },
  { name: "narrationtest", weight: 1 },
  { name: "calltest", weight: 1 },
  { name: "handstest", weight: 1 },
];

/* Scripts that end in `test` but deliberately do NOT run here.
   - `test` is this runner itself.
   - `abtest` is a measurement harness: it needs `--opt` to say anything, and
     the pairing contract it shares with the other two IS asserted in CI, by
     coalitiontest and firingtest. */
const NOT_IN_CI = new Set(["test", "abtest"]);

/* A new suite added to package.json and forgotten here would simply never run,
   and `npm test` would still go green — the exact shape of failure this repo
   cannot afford, since a green CI on master is what releases beta. So the list
   above is checked against package.json rather than trusted. */
const declared = new Set(SUITES.map((s) => s.name));
const missing = Object.keys(pkg.scripts)
  .filter((s) => s.endsWith("test") && !NOT_IN_CI.has(s) && !declared.has(s));
if (missing.length) {
  console.error(`FAIL — these package.json scripts are not in scripts/runtests.mjs, so \`npm test\` would skip them:`);
  for (const m of missing) console.error(`  ${m}`);
  console.error(`Add them to SUITES, or to NOT_IN_CI with a reason.`);
  process.exit(1);
}
const unknown = SUITES.filter((s) => !pkg.scripts[s.name]);
if (unknown.length) {
  console.error(`FAIL — no such package.json script: ${unknown.map((s) => s.name).join(", ")}`);
  process.exit(1);
}

/* ---------------------------------------------------------------------------
   --only / --skip, which exist for exactly one caller: scripts/coverage.mjs.

   Coverage has to be measured in two passes that must never be merged (that
   file's header explains why at length), and the only way to do that is to be
   able to run the suite with rendertest and without it.
   ------------------------------------------------------------------------ */
const argv = process.argv.slice(2);
const listArg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(",").map((s) => s.trim()) : null;
};
const only = listArg("--only");
const skip = listArg("--skip");
for (const name of [...(only ?? []), ...(skip ?? [])]) {
  if (!declared.has(name)) {
    console.error(`FAIL — --only/--skip names a suite that does not exist: ${name}`);
    process.exit(1);
  }
}
const SELECTED = SUITES
  .filter((s) => (only ? only.includes(s.name) : true))
  .filter((s) => (skip ? !skip.includes(s.name) : true));

/* ------------------------------- running -------------------------------- */
const CONCURRENCY = Math.max(1, os.cpus().length);
const results = [];

function run(suite) {
  const started = Date.now();
  return new Promise((resolve) => {
    // The package.json command directly, not `npm run <name>` — npm's wrapper
    // costs ~200ms a suite, which across 26 of them is most of a second for
    // nothing.
    const child = spawn(pkg.scripts[suite.name], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => {
      const ms = Date.now() - started;
      results.push({ name: suite.name, code, ms, out });
      process.stdout.write(`${code === 0 ? "  ok  " : "FAIL  "}${String(ms).padStart(6)}ms  ${suite.name}\n`);
      resolve();
    });
  });
}

const t0 = Date.now();
console.log(`running ${SELECTED.length} suites across ${CONCURRENCY} workers\n`);

// Exclusive suites first, alone, before anything else is competing for CPU.
for (const suite of SELECTED.filter((s) => s.exclusive)) await run(suite);

const queue = SELECTED.filter((s) => !s.exclusive).sort((a, b) => b.weight - a.weight);
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < queue.length) await run(queue[next++]);
}));

/* ------------------------------- reporting ------------------------------ */
const wall = (Date.now() - t0) / 1000;
const failed = results.filter((r) => r.code !== 0);
const work = results.reduce((s, r) => s + r.ms, 0) / 1000;

// A failing suite's output, held back until now. Interleaving four suites'
// stdout live makes the one that matters unreadable.
for (const f of failed) {
  console.log(`\n${"=".repeat(70)}\nFAILED: ${f.name}  (exit ${f.code})\n${"=".repeat(70)}`);
  console.log(f.out.trimEnd());
}

console.log(
  `\n${results.length - failed.length}/${results.length} suites passed in ${wall.toFixed(1)}s` +
  ` (${work.toFixed(1)}s of work, ${(work / wall).toFixed(1)}x parallel)`
);

if (failed.length) {
  console.log(`\nFAIL — ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
console.log("PASS");
