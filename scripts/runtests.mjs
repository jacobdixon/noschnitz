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

   MEASURED: 313s sequential -> 36.5s here, on 4 cores, with the null-control
   sample sizes cut in the same change (see package.json).

   That 36.5s is now at the packing limit and it is worth knowing why, because
   the next person to try to speed this up should not start by guessing. Total
   work is 133s across 4 workers, so 33s is the arithmetic floor, and the
   longest single suite (`undertest`, 28s) sits just under it. The run is
   therefore within ~10% of what this machine can do with these suites; nothing
   is being wasted on scheduling any more. Getting meaningfully faster from here
   means doing LESS WORK, not packing it better — and the remaining work is real:
   profiled, the top suites are all dominated by `endgameValue`, i.e. by playing
   out the hands they exist to play out. Cutting their sample sizes trades
   coverage for seconds, and CI is currently spending ~30s on this in a job that
   takes over a minute to check out and install. Don't.

   ---------------------------------------------------------------------------
   A STALE WEIGHT IS NOT FREE, and this file used to say it was.

   The note on `weight` below claimed a stale one "costs a little packing
   efficiency and nothing else". That was wrong in a way worth recording,
   because the sentence is what stopped anyone checking. `rendertest` was
   declared at 7 and measured at 33 — off by 4.7x — so longest-first scheduled
   the LONGEST suite tenth. It started once the pool had drained and then ran
   for 33 seconds with three cores idle. Wall clock was 71s against a 48s
   critical path: a comment, not a bug, cost 40% of the run.

   Two things now guard that. The weights below were re-measured rather than
   guessed, and the runner PRINTS a warning for any suite that overruns its
   declared weight by more than 2x. It warns rather than fails on purpose —
   timing on a loaded CI box is exactly the marginal signal CLAUDE.md says not
   to gate a deploy on — but it means the next 4.7x error announces itself
   instead of waiting to be profiled.

   ---------------------------------------------------------------------------
   A HUNG SUITE USED TO BE A FIFTEEN-MINUTE MYSTERY.

   Nothing bounded a suite's runtime, so a suite that wedged took `npm test`
   down with it, silently, until the CI job timeout killed the whole thing —
   and a killed job reports no per-suite output at all, so the log said only
   that something took too long. Each suite now runs under a watchdog and a
   suite that trips it is reported BY NAME, with its partial output, exactly
   like a failure. The bound is deliberately loose (see SUITE_TIMEOUT_MS): it
   is there to name a hang, not to police a slow box.

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

   `weight` is a measured cost in seconds, used to schedule the expensive
   suites first (longest-processing-time). Keep it honest — the header explains
   what the last stale one cost — and note the runner will warn if you don't.
   The numbers below are wall-clock for `npm run <suite>` alone on a 4-core box,
   re-measured 2026-08-06.
   ------------------------------------------------------------------------ */
const SUITES = [
  { name: "gradetest", weight: 5, exclusive: true }, // see header
  { name: "undertest", weight: 27 },
  { name: "firingtest", weight: 17 },
  { name: "coalitiontest", weight: 16 },
  { name: "aitest", weight: 13 },
  // 6s alone but ~15s in the pool — the worst contention ratio in the suite,
  // because it shells out to two full `vite build`s and each of those wants
  // every core for its esbuild workers. Weighted for what it actually occupies
  // a worker for, not for its idle-box number.
  { name: "voicebuildtest", weight: 12 },
  { name: "belieftest", weight: 10 },
  { name: "clairvoyancetest", weight: 7 }, // 400 probes since 0.59.0, was 250
  // Runs a Vite SSR server to load JSX. The server is not what this costs —
  // profiled at 650ms for startup and all eight ssrLoadModule calls together.
  // It was 33s until 0.59.2, and 32 of those seconds were one exact
  // double-dummy grade of the fixture hand; see the long note on the seed in
  // rendertest.mjs. If it balloons again, check the grade cost first and the
  // Vite server second (a coverage run in the project root once took it from
  // 8s to 21s by giving the file watcher something to crawl).
  { name: "rendertest", weight: 3 },
  { name: "leaktest", weight: 3 },
  { name: "tablestreamtest", weight: 1 },
  { name: "lint", weight: 3 },
  { name: "soaktest", weight: 3 },
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
  { name: "voiceaudiotest", weight: 1 },
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

/* ---------------------------------------------------------------------------
   HAND ANALYSIS IS NOT A TEST, AND MUST NOT BECOME ONE.

   `pimc.mjs`, `pimcsolve.mjs`, `pimcmine.mjs`, `gradedecision.mjs` and the
   hands under `scripts/scenarios/` and `scripts/hands/` are the tooling for
   "was that play right" (see the skill, and CLAUDE.md's "Analyzing a reported
   hand"). None of them belongs in `npm test`, for three reasons that are worth
   stating because each is a different kind of wrong:

     1. PIMC IS AN ESTIMATE. It reports a mean and a standard error and it
        samples worlds; two runs of a close decision can rank the candidates
        differently and both be right. Asserting on it is precisely the
        marginal test this repo has twice been burnt by — and per CLAUDE.md a
        marginal test on master does not go red, it silently withholds the
        beta deploy.
     2. SCENARIOS ARE AD-HOC DATA, not fixtures. A file under scripts/scenarios/
        is one person's transcription of one screenshot, added whenever somebody
        argued about a hand. Conscripting them into CI means a misread card in a
        transcription can turn master red and stop a deploy — a defect in an
        argument becoming a defect in the release pipeline.
     3. ITS VERDICTS ARE QUESTIONS. "The engine picked the second-best card
        here" is a finding to look into, not a build failure. Tests answer
        pass/fail; analysis answers how-much-and-how-sure. Wiring one into the
        other destroys both.

   The scripts do not end in `test`, so the completeness check above never
   conscripts them today. This guard is for the day somebody adds `pimctest` —
   at which point that check FAILS the run and the obvious way to make it pass
   is to add it to SUITES, which is the wrong answer. So: refuse it here, with
   the reason attached.

   WHAT THIS DOES NOT CATCH, said plainly rather than implied: it reads the
   suite's command line and its own top-level imports. A suite that reaches
   analysis code transitively — through a lib, or a dynamic import — goes
   through. It is a tripwire for the obvious mistake, not a sandbox.
   ------------------------------------------------------------------------ */
const ANALYSIS_ONLY = [
  "scripts/pimc.mjs", "scripts/pimcsolve.mjs", "scripts/pimcmine.mjs",
  "scripts/minehands.mjs", "scripts/gradedecision.mjs",
  "scripts/scenarios/", "scripts/hands/",
];

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

/* The analysis tripwire. Checks each suite's command, and — since a command
   naming `node scripts/foo.mjs` says nothing about what foo.mjs imports — that
   entry file's own top-level imports too. A comment mentioning a scenario is
   fine and common (aiskilltest and aitest both cite the hands their assertions
   were built from); only real code paths are refused, so the match is against
   import/require statements rather than the file text. */
const analysisRefs = [];
for (const suite of SUITES) {
  const cmd = pkg.scripts[suite.name];
  for (const path of ANALYSIS_ONLY) {
    if (cmd.includes(path)) analysisRefs.push(`${suite.name}: its command runs ${path}`);
  }
  const entry = cmd.match(/\bscripts\/[\w.-]+\.mjs\b/)?.[0];
  if (!entry) continue;
  let src;
  try { src = readFileSync(new URL(`../${entry}`, import.meta.url), "utf8"); } catch { continue; }
  for (const line of src.split("\n")) {
    if (!/^\s*(import\b|.*\brequire\s*\()/.test(line)) continue;
    for (const path of ANALYSIS_ONLY) {
      if (line.includes(path.replace(/^scripts\//, "./")) || line.includes(path)) {
        analysisRefs.push(`${suite.name}: ${entry} imports ${path}`);
      }
    }
  }
}
if (analysisRefs.length) {
  console.error(`FAIL — hand-analysis tooling is wired into the test suite. It must not be:`);
  for (const r of analysisRefs) console.error(`  ${r}`);
  console.error(`\nSee the note on ANALYSIS_ONLY in this file. PIMC reports an estimate with a`);
  console.error(`standard error, scenarios are one person's transcription of one screenshot, and`);
  console.error(`"the engine picked the second-best card" is a question, not a build failure.`);
  console.error(`Run the analysis by hand (\`npm run pimcsolve\`, the analyze-sheepshead-hand`);
  console.error(`skill) and file what it finds; do not make a deploy depend on it.`);
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

/* The watchdog bound, per suite. Deliberately loose: 8x the declared weight,
   floor 180s. This exists to give a HANG a name, not to police a slow box —
   the slowest suite here is 27s, so even a runner three times slower than this
   one stays comfortably inside it, and per CLAUDE.md a timing assertion that
   can fire on an unlucky box is a withheld deploy rather than a red check.

   A tripped watchdog is reported as a failure named `<suite> TIMED OUT`, with
   whatever the suite had printed before it wedged — which is the thing the CI
   log could not tell you before, because a job killed from outside prints no
   per-suite output at all. */
const SUITE_TIMEOUT_MS = (suite) => Math.max(180_000, suite.weight * 8_000);

/* Every child that is currently alive, so an interrupt can reap them.
   `detached` is what makes the watchdog able to kill a suite's grandchildren,
   and it also takes the children OUT of this process's group — which means a
   Ctrl-C at the terminal no longer reaches them, and four suites would go on
   burning a core each after the runner exited. So the runner forwards it. */
const live = new Set();
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const pid of live) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
    process.exit(130);
  });
}

function run(suite) {
  const started = Date.now();
  return new Promise((resolve) => {
    // The package.json command directly, not `npm run <name>` — npm's wrapper
    // costs ~200ms a suite, which across 26 of them is most of a second for
    // nothing.
    //
    // `detached` so the child gets its own process group. Several suites spawn
    // their own children (voicebuildtest shells out to two `vite build`s), and
    // killing only the shell would leave those orphaned and still holding a
    // core — so the watchdog signals the whole group.
    const child = spawn(pkg.scripts[suite.name], {
      shell: true, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    live.add(child.pid);
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });

    const killGroup = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    const watchdog = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      // A suite wedged in a tight loop will not service SIGTERM. Give it a
      // moment to exit cleanly, then stop asking.
      setTimeout(() => killGroup("SIGKILL"), 5_000).unref();
    }, SUITE_TIMEOUT_MS(suite));

    child.on("close", (code) => {
      clearTimeout(watchdog);
      live.delete(child.pid);
      const ms = Date.now() - started;
      // A killed process exits with a null code; normalise so the caller's
      // `code !== 0` test cannot read it as a pass.
      results.push({ name: suite.name, code: timedOut ? "timeout" : (code ?? 1), ms, out, timedOut });
      const tag = timedOut ? "TIME  " : code === 0 ? "  ok  " : "FAIL  ";
      process.stdout.write(`${tag}${String(ms).padStart(6)}ms  ${suite.name}\n`);
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
  const banner = f.timedOut
    ? `TIMED OUT: ${f.name}  (killed after ${(f.ms / 1000).toFixed(0)}s — it hung, it did not fail)`
    : `FAILED: ${f.name}  (exit ${f.code})`;
  console.log(`\n${"=".repeat(70)}\n${banner}\n${"=".repeat(70)}`);
  console.log(f.out.trim() ? f.out.trimEnd() : "(no output before it was killed)");
}

console.log(
  `\n${results.length - failed.length}/${results.length} suites passed in ${wall.toFixed(1)}s` +
  ` (${work.toFixed(1)}s of work, ${(work / wall).toFixed(1)}x parallel)`
);

/* Stale weights, reported rather than left to be profiled. See the header for
   what the last one cost. Only suites that ran are checked, and only ones
   overrunning by both 2x AND 5s — the sub-second suites are all declared at 1
   and a 300ms wobble in one of them is not news.

   This never changes the exit code. A CI box under load legitimately overruns,
   and a deploy that hangs on a timing ratio is the failure mode this repo has
   already paid for twice. */
const stale = results
  .filter((r) => !r.timedOut)
  .map((r) => ({ r, weight: SUITES.find((s) => s.name === r.name).weight }))
  .filter(({ r, weight }) => r.ms > weight * 2000 && r.ms - weight * 1000 > 5000)
  .sort((a, b) => b.r.ms - a.r.ms);
if (stale.length) {
  console.log(`\nnote — declared weight is well under measured time, so longest-first is mis-ordering these:`);
  for (const { r, weight } of stale) {
    console.log(`  ${r.name}: weight ${weight}, took ${(r.ms / 1000).toFixed(1)}s`);
  }
  console.log(`  (harmless if the box was loaded; if it reproduces on an idle box, fix the weight in scripts/runtests.mjs)`);
}

if (failed.length) {
  console.log(`\nFAIL — ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
console.log("PASS");
