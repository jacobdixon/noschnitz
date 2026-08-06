# Changelog

All notable changes to this project are logged here, newest first. Versions
follow [semver](https://semver.org/) loosely: MAJOR for breaking rule/UI
changes, MINOR for new features or AI behavior changes, PATCH for small
fixes/tweaks. The version shown in the app (bottom of the top info strip)
corresponds to the entries below.

## [0.59.3] - 2026-08-06 (`b3700b8`)
**The deploy chain had the same timeout bug 0.59.2 fixed in CI, and `release.yml`
also had a second one nobody had hit.** All three remaining workflows —
`release.yml`, `verify-beta.yml`, `verify-production.yml` — carried a 10-minute
*job* timeout, so a queue-starved run reports as a failure having done nothing.
`Release` is the worst place for that: a cancelled Release is exactly what "the
deploy never shipped" looks like, and it can leave beta moved but unverified.

- **Job timeouts are now queue budgets; the real bounds are on the steps.**
  `release.yml` 45 min (steps 5/5/20/5), the two verifiers 30 min (step 10).
- **`release.yml`'s own worst case exceeded its old budget, independently of any
  queueing.** "Make sure production actually deployed" is a retry ladder — six
  attempts at up to 40s of curl plus a 20s sleep, then the deploy hook, then ten
  more at up to 60s — which is **~16 minutes against a 10-minute job timeout**.
  Never noticed because the fast path exits in seconds, but it means the repair
  path this workflow exists to provide could be cut off after firing the hook
  and before confirming it worked. That step now has 20 minutes of its own.

**Hand analysis is read-only, and it cannot be wired into CI.** Both were true
by accident and are now enforced.

- **`scripts/runtests.mjs` refuses any suite** whose command runs, or whose entry
  file imports, `pimc.mjs` / `pimcsolve.mjs` / `pimcmine.mjs` / `minehands.mjs` /
  `gradedecision.mjs` / `scripts/scenarios/` / `scripts/hands/`. The `ANALYSIS_ONLY`
  note gives three separate reasons; the sharpest is that a scenario is one
  person's transcription of one screenshot, so conscripting them into CI lets a
  misread card turn master red — and a red master withholds the beta deploy. The
  existing completeness check made this worse rather than better: a future
  `pimctest` would fail the run, and the obvious way to make it pass is to add
  it to `SUITES`, which is the wrong answer. Verified with two negative controls
  (command reference, and an innocent command whose file imports `pimc.mjs`);
  both refuse, and the suite is unaffected. Stated plainly in the note: it reads
  command lines and top-level imports, so a transitive import slips through. A
  tripwire, not a sandbox.
- **The skill now has a Scope section**, which it did not. It never said not to
  change code — and its own guidance ("when one candidate scores oddly, check
  what the engine actually plays next") reads as an invitation to go tune one.
  The rule: the scenario file is the only thing the workflow writes; `src/`,
  `api/`, harnesses and workflows are off limits *especially* when the analysis
  has just found a real defect, because an engine change here needs a paired
  A/B, a null control at exactly zero and consistency across seeds, and one hand
  is where that starts rather than what justifies it. Finding a defect is the
  success condition; fixing it in the same pass is not.
- **It also carries the instruction to stop**, which CLAUDE.md had measured and
  never landed here: comparable questions ran 4 to 30 minutes depending only on
  whether the agent stopped once the question was answered, and one case went
  from 225 tool calls to 36 on that instruction alone.

## [0.59.2] - 2026-08-06 (`67f48e7`)
**CI was timing out, and the tests were not the reason.** Four runs on
2026-08-06 — 131, 132, 134 and 135, two of them on `master` — each burnt exactly
15.0-15.1 minutes and reported `cancelled`. That is the shape of a hung test
suite and it was nothing of the kind: every one of those jobs has `runner_id: 0`,
an empty `runner_name`, and no steps array at all. They sat in the Actions queue
waiting for a runner and were cancelled at the `timeout-minutes: 15` mark without
ever being assigned one. Run 133, in the middle of them, got a runner and went
green in 2.1 minutes on the same code. Per CLAUDE.md, two of those reds silently
withheld the beta deploy.

- **The job timeout is now a queue budget (45 min) and the real bounds moved to
  the steps** (`Install`/`Tests`/`Build`, 10 min each). A step's clock starts
  when the step starts, so a busy Actions pool can no longer present itself as a
  test failure. The workflow now also records how to tell the two apart in one
  look: no steps and `runner_id: 0` means never scheduled — re-run it, nothing is
  wrong with the repo.

While in there, the suite itself got measured rather than assumed, and it was
**half waste**: 71.4s wall, now **36.5s**, with total work down from 190.9s to
133.3s and parallelism up from 2.7x to 3.6x.

- **`rendertest` was 33s and 32 of them were one card-game solve.** It builds
  its `grades` fixture by calling the real `gradeHandPlays`, which is an EXACT
  double-dummy solve of every decision in the hand — and what that costs depends
  enormously on the deal. Measured across 21 seeds it ranges from 275ms to 89
  seconds, a 300x spread. The old fixture seed sat near the bad end; a CPU
  profile put `ddFuture` plus its GC pressure at 16 of the file's 22 seconds. A
  UI smoke test that needs a grades object of the right shape, and has no opinion
  about the numbers in it, was spending three quarters of its life solving
  Sheepshead. Seed 11 grades in ~275ms and still yields both a `best` and a
  `worst` over 15 real decisions, so **no fidelity is given up** — same real
  engine grade of a real hand, cheaper deal. 33.0s -> 3.1s, same 40 assertions.
  Mutation-tested both ways per CLAUDE.md: an unguarded `grades.best` fails the
  `no grades at all` case, and breaking the marker legend fails the `graded`
  case, so the real-grade path still has teeth.
- **A stale weight is not free, and `runtests.mjs` used to say it was.** Its own
  comment claimed a stale weight "costs a little packing efficiency and nothing
  else". `rendertest` was declared at 7 and measured 33 — off by 4.7x — so
  longest-first scheduled the longest suite tenth, and it ran for 33s at the end
  with three cores idle. A comment cost 40% of the run. Weights re-measured, and
  the runner now PRINTS a warning for any suite overrunning its declared weight
  by 2x. It warns rather than fails on purpose: timing on a loaded CI box is
  exactly the marginal signal this repo has twice been burnt gating a deploy on.
- **A hung suite is now named instead of taking the job down silently.** Nothing
  bounded a suite's runtime, so a wedged one hung `npm test` until the job
  timeout killed everything — and a job killed from outside prints no per-suite
  output at all, which is why a hang and a queue starvation looked identical in
  the log. Each suite now runs under a watchdog (8x its weight, floor 180s,
  loose on purpose) and a tripped one is reported by name with its partial
  output. Children are spawned detached so the watchdog can reap a suite's
  grandchildren — `voicebuildtest` shells out to two `vite build`s — and the
  runner forwards SIGINT/SIGTERM to them, so Ctrl-C does not leave four
  processes burning a core each.
- **What was deliberately NOT cut.** At 36.5s the run is within ~10% of this
  machine's floor: 133s of work over 4 workers is 33s arithmetic, and the
  longest suite is 28s. Profiling the rest found no second `rendertest` — the
  heavy suites are all dominated by `endgameValue`, i.e. by playing out the hands
  they exist to play out. Going faster from here means less coverage, and CI
  spends ~30s on this inside a job that takes over a minute to check out and
  install. Sample sizes left alone.

## [0.59.1] - 2026-08-06 (`a253a83`)
**PIMC could not be told what the table had already told the player.** The
sampler spreads the called ace uniformly over every seat that could still hold
it, which is right when the deciding seat genuinely has nothing to go on and
wrong the moment it does — and it prices the decision against a table nobody was
sitting at.

- **`assumePartner: <seat>` in a scenario conditions the sample on a read.**
  Validated against the evidence rather than trusted: it refuses a seat that is
  the picker, one the cards have already proved is somebody else, and one that
  is out of cards or has shown void in the called suit. The report prints a
  CONDITIONED banner so a pinned run can never be mistaken for a plain one, and
  only when the pin actually constrained the sample — with the partner already
  settled by the cards it is a consistency check that changed nothing, and
  saying otherwise would overstate what the run assumed.
- **It is not a rounding error.** On the new `hand5-kopps-ah.mjs` the two runs
  give opposite verdicts on the played card: second of four unconditioned, last
  of four pinned, 3.63 points and 9pp of win rate apart. Both numbers are
  correct and they answer different questions, so the guidance added to
  CLAUDE.md is to run both — a card that only looks good unconditioned is a card
  whose case rests on the player not having noticed something.
- **Default unchanged.** With `assumePartner` unset the sampler is the old one;
  verified by re-running the reference `hand1-jh.mjs` and the new hand and
  getting the prior ranking back.
- **New hand: the 2026-08-05 Kopps trick-3 A♥ discard**, off the same Hand 5
  screenshot as `hand5-patty-ac.mjs`. Transcription re-derived independently and
  byte-identical to the committed one. Exact double-dummy calls all four legal
  cards tied at cost 0; the interesting number is the gap between the two PIMC
  runs, not either one alone.
- Also recorded in CLAUDE.md: this hand is a live instance of the case
  `PLAIN_TRUMP_LEAD_ODDS` reserves for itself. A non-picker's low trump lead is
  the partner 60.4% of the time against a 25% base rate and the constant still
  ships at 1, so `teammateProbability` handed Kopps a flat 66.7% across all
  three candidates on a hand where one of them had opened trick 2 with a trump.

## [0.59.0] - 2026-08-04 (`54476e0`)
**Table audio never played a sound, and nothing in the app could tell.** COM-1
shipped in 0.58.0 and was tried for the first time on 2026-08-04, phone to
MacBook. Both ends joined. Neither heard anything.

- **The bug: in call-object mode, daily-js does not play remote audio.** There
  are two modes. `createFrame()` renders Daily's own UI in an iframe and that
  iframe plays audio for you; `createCallObject()` hands you `MediaStreamTrack`s
  and plays nothing. We use the call object because the felt is a locked,
  no-scroll viewport with no room for a second UI on top of it — and the cost of
  that choice, unpaid until now, is that attaching tracks to elements is the
  application's job. Daily's own React library ships an entire `<DailyAudio>`
  component to do this; there is nothing automatic underneath it.

  Confirmed against the installed SDK rather than from memory: `daily-esm.js`
  contains zero occurrences of `srcObject` and creates no media elements — five
  iframes, a canvas, a script and an anchor, and nothing that could play a
  track.

- **Why every signal stayed green, which is the part worth remembering.** The
  room provisioned, both clients joined, microphones were captured with
  permission granted, the mic chip read "connected", the participant count read
  2, and audio was genuinely uploaded to Daily and forwarded to the other
  participant. The only thing that never happened was playback, and playback is
  the one step the app had no way to observe. There was no error, no failed
  request, nothing in the flight recorder. It looked exactly like a working call
  that nobody else had joined — the same trap `ensureRoom` warns about one layer
  up, arrived at from the other direction.

  55 server checks, a bidirectional build test that proved the code was present
  on beta and absent on production, and a lazily-loaded SDK chunk: all correct,
  all passing, and between them unable to notice that the feature did not work.
  **Everything was verified except whether anyone could hear anything.**

- **`src/voiceAudio.js`** is the fix: an `<audio>` element per remote
  participant, keyed by Daily session id, attached on `track-started` and torn
  down on `track-stopped` / `participant-left`. Never the local track — playing
  your own microphone back is a feedback loop, not something you debug calmly on
  a games night. `playsInline` is set, because iOS Safari is half the devices
  this feature exists for. A rejected `play()` — the browser's autoplay policy,
  the one remaining way to be silently silent — is reported to the flight
  recorder rather than swallowed.

- **The wiring lives in the same module as the sink, on purpose.** `bindCallAudio`
  and `sweepExistingAudio` could have stayed inline in the hook, and that is
  exactly how the bug happened: the defect in 0.58.0 was not a broken sink, it
  was the *absence* of three `.on()` calls. A sink tested in isolation would
  have passed perfectly while the room stayed silent, so the wiring had to be
  somewhere a test could reach it.

- **`scripts/voiceaudiotest.mjs`** (35 checks, in `npm test`) drives a fake call
  object through the real Daily event names into a real sink. Its negative
  control is the original bug reproduced exactly — stub out `bindCallAudio` and
  6 checks fail; drop the post-join sweep and 3 fail. Every other assertion was
  mutation-tested too: removing `play()` fails 3, leaking the stream on detach
  fails 2, dropping the idempotence guard or `playsInline` fails 1 each. The
  document is faked rather than jsdom'd — jsdom has no `MediaStream` and its
  `play()` is unimplemented, so a realistic DOM would need both stubbed anyway,
  and a fake can assert the element was actually asked to play.

- **Two paths reach the same track and that is deliberate.** Daily replays
  `track-started` for participants already in the room, so the post-join sweep
  of `call.participants()` is usually redundant — but "usually" is the wrong
  strength for the difference between hearing the table and sitting in silence.
  `attach()` is idempotent on the same track, so running both costs nothing and
  neither interrupts audio already playing.

- **`voicebuildtest` gains `srcObject` as a fifth token**, so the playback path
  is now pinned absent-on-production and present-on-beta like everything else.
  It is a property access on a DOM object, so minifiers leave it alone, and it
  appears nowhere else in `src/`. Verified: production's bundle still contains
  no audio code at all, and the new module is eliminated with the rest.

### Also — `clairvoyancetest` was a marginal test, and it withheld this deploy
Caught by this PR's own CI run, which went red on a suite the change does not
touch.

- **It was missed by the 0.58.2 seeding sweep.** That release fixed `abtest`,
  `coalitiontest`, `undertest` and `firingtest`, all of which seeded a shuffle
  over the deck *as `freshHand` left it* — already shuffled by `makeDeck`'s
  unseeded RNG, so the Fisher-Yates composed with it instead of replacing it.
  `clairvoyancetest` has the identical bug and was not in the list. Its own
  output gave it away once looked at: 250, 253, 251, 253, 252 probes across five
  consecutive local runs. "250 probes" named a different 250 every time.

- **This is the exact failure CLAUDE.md warns about, arriving on schedule.** The
  suite *asserts*, so it passed locally and on the PR and failed on CI for the
  identical commit — 1 flip in 250. A red run on `master` does not merely go
  red; it silently withholds the beta deploy. `undertest`'s own header calls
  this out as the sharper risk of the two; `clairvoyancetest` is the same shape
  and nobody had noticed.

- **Fixed the same way**: shuffle from `ALL_CARDS`, a fixed canonical order.
  Now exactly 403 probes every run.

- **Sample raised from 250 to 400** (`CLAIRVOYANCE_PROBES` to override).
  Seeding freezes one population, so more of it is worth 1s: 5.5s alone, 11s
  under pool contention, weight updated in `runtests.mjs`.

- **The detector is still a detector, and this was checked rather than assumed.**
  Running the seeded population against the clairvoyant path
  (`opts.endgameClairvoyant`) flips **30 of 403**. A leak detector that has
  quietly lost the ability to fail is precisely what this file exists to prevent,
  and seeding it is exactly the kind of change that could cause that.

- **What is NOT resolved, stated plainly.** The 1-in-250 flip CI saw could not
  be reproduced in **14,071 probes** locally on the same Node version (22 in both
  places), so the rate is under ~2e-4 per probe. Everything the endgame choice is
  supposed to depend on was checked and is invariant under this swap: the seed is
  `handSeed(own hand + seen cards)`, the unseen pool is an `ALL_CARDS` filter so
  content *and* order are fixed, `sampleEndgameWorld` reads only other seats'
  hand *lengths*, and the heuristic tiebreak touches only `g.hands[idx]`. So
  either something subtler is reachable or CI found a ~1-in-14k case. Seeding
  makes CI trustworthy; it does not answer that, and the file says so where
  somebody will read it.

### And `gradetest` was reporting a solver bug the engine does not have
The second red CI run on this PR, on a different suite, also untouched by the
change. Worth reading as a pair with the one above: two suites, same underlying
habit, opposite conclusions about whose fault it was.

- **`gradetest` shared ONE transposition table across sixty different deals.**
  Its own comment said "exactly as a grading pass shares it" — but a grading
  pass is a single hand. No caller in the project shares across hands:
  `gradeAllPlays` allocates a `Map` per hand, `pimcsolve` one per world within a
  hand. The test was exercising a usage that does not exist.

- **Why that breaks.** `ddKey` deliberately omits picker and partner, and it is
  right to: they are constant within a hand and the key is built at every node,
  where string construction was most of the solve cost. But the stored value is
  *points to the picker team from here*, so two deals reaching the same small
  late-trick layout with the picker on opposite sides collide on the key and
  disagree about the answer.

- **Reproduced deterministically rather than argued.** Seed 1270, trick 5:
  `shared=62` against a true 97, a 35-point error. Switching to a per-hand table
  and re-running the same seeds gives **0 mismatches over 33,704 positions**,
  that seed included. CI's own failure was the same shape
  (`shared=39 fresh=43 capped=43 reference=43`) — `shared` alone, always low.

- **So the engine was right and the test was wrong**, which is the more
  dangerous way round: it reported a solver defect that does not exist,
  intermittently, on a suite whose red run silently withholds the beta deploy.
  Three of us would have gone looking at alpha-beta.

- **The arm keeps its teeth, and that was checked, not assumed.** The `shared`
  comparison exists to catch a bound from a narrowed window being filed as
  exact. Mutating `ddFuture` to do exactly that (`flag: 0` unconditionally)
  still fails the per-hand version — 39 mismatches over 1435 positions. Scoping
  the table did not defang the test.

- **Its deals are seeded now too**, same defect as `clairvoyancetest`: `seed`
  only ever chose the dealer, and `freshHand` dealt off the unseeded RNG. The
  position counts were the tell — 1493, 1415, 1421 locally against CI's 1443.
  Now exactly 1435 every run.

- **The precondition is written down in `engine.js` where it belongs**, on
  `ddKey`: a memo is valid for one hand only, and if a cross-hand table is ever
  wanted, put the picker team in the key rather than assuming it away.

## [0.58.6] - 2026-08-04 (`3133331`)
**Both deploy verifiers aborted instead of reporting a flag-off build** — the
one failure they were written to catch. Workflow-only; no application code.

- **The bug.** `verify-production.yml` and `verify-beta.yml` count discriminator
  strings in the served bundle with `grep -o … | wc -l`. `grep` exits 1 when it
  matches **nothing**, `set -o pipefail` (already in these scripts) turns that
  into the pipeline's status, and GitHub runs the step under `bash -e`. So on a
  zero count the script died *at the assignment*, one line before the `if` that
  interprets it. Fixed with `|| true` at all three sites.

- **Why that matters more than it sounds.** A zero count is not an edge case
  here, it is the alarm. `verify-beta.yml`'s own header explains that a
  flag-off build is the nastier of the two failures "because every signal says
  green" — and in exactly that case the workflow would have exited 1 with no
  message at all, rather than printing the error explaining which environment
  variable to set. The `mp` checks have never fired only because a flag-on
  bundle always matches `/api/tables/`.

- **The audio check had been failing on every correct run.** Audio is meant to
  be absent from production, so the healthy answer is zero, so
  `Verify production` aborted every time it was dispatched. Run #1 (2026-07-31)
  passed because it predates the audio check; runs #2 (2026-08-03) and #3
  (2026-08-04) both failed this way. No dispatch has succeeded since the check
  was added, and the failure said nothing about why.

- **Production was never actually wrong.** Reaching that line and dying there
  requires grep matching zero, so the crash itself proved audio was absent.
  At v0.58.5 www.noschnitz.com was verified serving the right version and the
  multiplayer build, with no audio — the tooling was broken, not the deploy.

- Verified by replaying the step's own logic against three synthetic bundles:
  healthy (mp=8, voice=0) now exits 0 where it previously exited 1 silently;
  a flag-off bundle (mp=0) exits 1 **with** its diagnostic; a leaked-audio
  bundle (voice=2) is unchanged. Non-zero counts behave identically before and
  after, so the fix cannot mask a real failure.

## [0.58.5] - 2026-08-04 (`9d4c0d7`)
The other half of the CI review: **the UI is tested now, and it was not before.**
0.58.4 made the suite fast; this makes it cover something. No game behaviour
changes. Suite goes 26 → 28 suites and 31s → 33s.

- **Every `.jsx` file was at 0% coverage**, including `TableScreen.jsx` at 1331
  lines, and `src/useTableStream.js` had nothing at all — the file CLAUDE.md
  itself calls the most likely to ruin a games night. The only thing standing
  behind the UI was `npm run build`, and a build resolves modules; it has no
  opinion about whether a component throws when React calls it.

- **`scripts/tablestreamtest.mjs`** (53 assertions) covers the reconnect loop:
  `since=` carried on every reopen, stale and redelivered frames dropped so the
  table cannot rewind mid-trick, the scheduled ~50s handoff distinguished from a
  real failure, backoff doubling and capping, both watchdogs (including the
  three-and-a-half-hour stall from a real flight recorder trace), the
  visibility-resume path, `gone` ending the loop for good, and teardown leaving
  no live stream or timer behind.

- **`scripts/rendertest.mjs`** (40 assertions) mounts every screen, modal and all
  five felt seat rotations against real engine-produced states and requires that
  none throw. It loads JSX through Vite's own `ssrLoadModule` — deliberately the
  same transform the app is built with, because a second toolchain could
  disagree about JSX or `import.meta.env` and then the suite would be testing
  something nobody ships. `no-undef` already catches the two bugs
  `eslint.config.js` describes; this catches the ones with no free identifier in
  them, like a dropped `?.` that only crashes when a worker has not answered yet.

- **Both suites were mutation-tested rather than trusted.** Each passed on the
  first run, which is exactly when a suite deserves suspicion. Six mutations to
  `useTableStream` (drop `since`, apply stale frames, kill the visibility
  reconnect, let `gone` retry, remove cleanup, freeze the backoff) and three to
  the UI — including reintroducing the historic `ScoresModal` bug verbatim — were
  each caught by the assertions that should catch them. A smoke test that cannot
  fail is worse than none, because it reads as coverage.

- **`npm run coverage` runs two passes that must never be merged**, and this is
  the part most likely to be "simplified" into a wrong number later.
  `rendertest` loads app modules both natively and through Vite's SSR transform,
  so c8 sees two irreconcilable copies of one path and the merged report
  *under*-reports: `engine.js` measures 92.67% from `undertest` alone, 57.36%
  from `rendertest` alone, and **62.43% merged** — impossible for a union, and
  low enough to send somebody fixing a problem that does not exist. The logic
  pass owns `.js`, the UI pass owns `.jsx`. Non-gating by design: no thresholds,
  nothing fails on a percentage, and it is out of `npm test` because
  instrumentation roughly doubles the runtime. `Coverage` workflow is dispatchable
  and runs monthly.

- Coverage moved from 0% to: `ui.jsx` 99.5, `modals.jsx` 97.8, `decisions.jsx`
  92.1, `felt.jsx` 85.5, `header.jsx` 73.7, `App.jsx` 72.9, `Sheepshead.jsx`
  60.7, `TableScreen.jsx` 28.5, and `useTableStream.js` to 100% of statements.
  `engine.js` reads 98.2% as it always did — if the logic pass ever shows it near
  62%, the two passes have been merged and the split has regressed.

- **`rendertest` deals a SEEDED hand**, and the reason is worth keeping. It
  originally rendered whatever `freshHand` dealt, which is an unseeded shuffle —
  so it rendered a different hand every run. That surfaced as coverage wobbling
  between runs (`modals.jsx` 98.03, then 96.45, as different branches were
  reached), which is the harmless symptom; the real problem is that a suite
  rendering a different state each run can fail only sometimes, and per the
  deploy notes a marginal test here silently withholds the beta deploy rather
  than merely going red. Seeded from `ALL_CARDS` in the same way the measurement
  harnesses were fixed in 0.58.2 — shuffling the already-shuffled deck composes
  with the unseeded shuffle instead of replacing it. Now byte-identical across
  runs, verified three times.

- **A trap worth knowing:** `rendertest` ballooned from 8s to 21s the moment a
  `coverage/` directory existed, because Vite's dev server crawls and watches the
  project root on startup. It now starts with the watcher and dependency scan
  off — 2.6s — since a headless SSR transform needs neither. `coverage/` is
  gitignored. If this suite ever gets slow again, suspect startup crawling
  something new before suspecting the tests.

- New dev-only dependencies: `jsdom` and `c8`. Neither reaches the bundle.

## [0.58.4] - 2026-08-04 (`4f0fd75`)
CI review: the test suite went from **313s to 31s** (10.1x) with no assertion
weakened and one flake risk removed. Nothing about the game changed.

- **Two suites were 73% of the runtime, and their sample size was buying
  nothing.** `npm test` runs `coalitiontest` and `firingtest` with no `--opt`,
  which makes them null controls: both arms are the same engine on the same
  seeded shuffles, so the answer must be exactly `0.0000`. That is an exact
  identity assertion, not a statistical one — sample size buys precision that an
  answer of exactly zero has no use for. They cost 127s and 103s. Now 500 hands
  each, 16s and 18s, verified passing identically at 200/500/1000 and at the old
  4000/3000.

  The big sample was buying one real thing, and it is not precision: breadth,
  meaning more chances to trip a rare nondeterministic branch. So the wide sweep
  still happens, nightly, in the new **`.github/workflows/harness-nulls.yml`**
  (also `workflow_dispatch`, with hands/seeds inputs). That job additionally
  asserts `abtest`'s null control, which nothing has ever checked — CLAUDE.md
  calls it "the harness that actually decides things" and it prints without ever
  exiting non-zero. The assertion lives in the workflow rather than in
  `abtest.mjs` on purpose: a measurement harness must not fail on a result it
  dislikes, so only the caller that passed no `--opt` is entitled to check.

- **`npm test` is now `scripts/runtests.mjs`, a worker pool, not a 26-link `&&`
  chain.** Longest-first across `os.cpus()`, failing suites' output held back and
  printed at the end so it is readable rather than interleaved with three other
  suites'. Measured 3.6x on 4 cores. The old chain also ran the cheap suites
  first and the two 100s+ suites near the end, so an 8-second `voicebuildtest`
  failure took over four minutes to surface; longest-first fixes that too.

  It guards itself: a script in `package.json` ending in `test` that is not in
  the runner's list fails the run rather than being silently skipped. A new
  suite that never runs while CI stays green is precisely the failure this repo
  cannot afford, since a green CI on master is what releases beta.

- **`gradetest` runs alone, and that is deliberate.** It asserts a timing ratio
  (grading a hand must cost under 150 reference solves on the same machine). The
  ratio was designed so machine speed divides out — the right fix for the slow
  container that once failed it on master having passed on its PR. Contention
  does *not* divide out, because its numerator is one measurement while the
  denominator is averaged over five. Measured 72-78x idle against 56-102x under
  a 4-way load: nothing failed, but headroom to the bound fell from ~1.9x to
  ~1.5x. Per CLAUDE.md a marginal test here is not a red check, it is a silently
  withheld beta deploy — so it gets the box to itself for ~6s. It is the only
  suite that asserts on wall-clock; `leaktest` prints timing without asserting.

- **`ci.yml`: lint ran twice every build**, once as its own step and again
  inside `npm test`. The separate step existed so a lint error reports as a lint
  error rather than an anonymous failed test run, which was a good reason and
  survives without the duplication — lint is now just a suite the runner
  schedules, named on failure like any other, and it overlaps with the rest
  instead of holding them up.

- **`ci.yml` gained `workflow_dispatch`.** Actions has been observed taking
  twenty minutes and four pushes to queue a run on a session-authored PR, and a
  check that never starts blocks a merge exactly as hard as a red one. Without
  this there was nothing to re-trigger — a missing run cannot be re-run, only
  replaced by another push.

- Fixed the header comment claiming the suite was "18 harnesses and ~10s"; both
  numbers had been wrong for a long time, and that line is what the next person
  budgets against. Also resynced `package-lock.json`'s version field, which had
  been left at 0.58.2 by the previous bump.

## [0.58.3] - 2026-08-03 (`07d965e`)
A card played under rendered **face up** on a multiplayer table (#113). Two
defects, one cause, so they are fixed together.

- **The felt lost the flag that hides it.** Playing under is a secrecy feature:
  the card goes down as the placeholder 6 of the called suit, and `felt.jsx`
  draws it face down off `t.under`. The table cannot render server state
  directly — the server resolves every AI seat inside one request — so
  `buildPlaySequence` in `src/usePacedTrick.js` rebuilds the play sequence for
  the paced reveal, copying a fixed set of fields per play. `under` was not one
  of them, so the placeholder was drawn face up, for every viewer, in both the
  live trick and the `trickHistory` replay. Solo hands raw `g` to `Felt` and
  never rebuilds anything, which is why it was table-only.

  `actual` is deliberately still not carried. The felt draws every under card
  face down for everyone, including the picker who knows perfectly well what it
  is; revealing the face belongs to Last Trick and the recap, which have their
  own entitlement rule. Carrying it would put the real card one careless render
  away from the table for no gain.

- **The picker's own stand-in spoke a different language, and that is the half
  nobody filed.** Tapping a card puts a stand-in on the felt before the server
  answers. For an under play the stand-in held the REAL card while the server
  echoes the PLACEHOLDER, so the two share no id: `displayState`'s dedup missed
  it and the retirement check in `TableScreen` could never fire, because it
  matches against `revealedIds`, which only ever contains the placeholder. The
  stand-in survived until the next hand — so the picker watched their own under
  card sit face up next to the placeholder, six cards in a five-card trick.

  Fixed by standing in with `underFace(g)` when `isUnderCard` says so, flagged
  `under` so it goes down face down immediately. Both the dedup and the
  retirement then work unchanged; no edit was needed at either site.

- **The reason no test caught it: no fixture had ever played a card under.**
  `pacingtest`'s hand builder dropped `callKind` and `underCard` from
  `aiBuryAndCall`, so every hand it dealt called an ace or a ten. The builder now
  carries them, and the suite deals until it finds a hand where the designated
  card was genuinely played — the placeholder under test is the one `applyPlay`
  really produces, not a constructed one. Eight assertions, including a negative
  control that no ordinary play acquires the flag. Confirmed failing on the
  unchanged source first.

## [0.58.2] - 2026-08-03 (`d9fce44`)
> Numbering note: this and 0.58.1 were written as 0.49.0/0.49.1, renumbered to
> 0.49.1/0.49.2 when #124 took 0.49.0, and renumbered again on merge because
> `master` reached 0.58.0 while the PR was open. Their commit subjects carry the
> older numbers; the entries here are authoritative. Worth reading #124 (0.49.0)
> alongside 0.58.1 below — the same insight, found independently on two different
> code paths the same day, which is the most useful thing about either of them.

- **The tuning harnesses were not seeded, and had not been for a long time.**
  `dealWith` in `abtest.mjs`, `coalitiontest.mjs`, `undertest.mjs` **and
  `firingtest.mjs`** (the last arriving from #124 while this was in flight) took
  the 32 cards *as `freshHand` left them* — already shuffled by `makeDeck`'s unseeded
  RNG — and ran its seeded Fisher-Yates over that. A shuffle over an already
  shuffled array composes with the one underneath rather than replacing it: the
  seeded stream chooses positions, and which card sat at each position was
  already random. So "seed 3" named a different population on every run. All
  four now shuffle from `ALL_CARDS`, a fixed canonical order, and re-running any
  of them reproduces byte-identically.

  **The null test could never have caught this**, which is why it survived: two
  identical arms play the same cards whatever deal they are handed, so the
  difference is exactly `+0.0000` either way. That number validates the pairing
  between arms and says nothing about reproducibility — a distinction CLAUDE.md
  now makes explicitly, because it previously cited the exact zero as the reason
  small results were trustworthy.

  What it cost in 0.58.1: a sweep point that read "ahead in 4 of 4 seeds" and
  then came back 4 of 8 when re-run, which looked like the effect evaporating and
  was really a fresh draw. The paired comparison between arms was never affected,
  so conclusions already drawn from these harnesses stand — only their
  reproducibility was ever wrong. `undertest.mjs` was the sharper risk of the
  three, because it *asserts*: an assertion true of most deals but not all could
  pass on a PR and fail on `master` for the identical commit, and a marginal test
  here withholds the beta deploy rather than merely going red.

- **`scripts/firingtest.mjs` was built twice, independently, on the same day.**
  #124 needed it for `guardFatTrumpBleed` (0.37% of hands) and this branch needed
  it for `OVERTAKE_SPEND_SECURITY` (0.83% of decisions); neither knew about the
  other. #124's landed first and is the one kept — its firing probe runs against
  the CONTROL line of play, asking at each decision whether the option *would*
  have chosen differently, which counts the decisions the seat actually faced;
  the version here diffed the two arms' play sequences, which stops being a
  question about the same hand once they diverge. It also prints the whole-hand
  abtest number beside the per-firing one, so the two are compared rather than
  confused. Only the seeding fix above is carried over onto it.

  That two independent attempts at the same problem produced the same harness,
  the same denominator objection and per-firing effects of the same size
  (+0.252 there, +0.210 here) is better evidence that the instrument is right
  than either measurement is on its own.

- **Corrected: the 0.58.1 measurement was understated, and one of the two numbers
  reported for it was confounded.** The throwaway version of that harness gave
  the *variant* seat the rule and left the other four on the shipped default
  — which by then was already `0.5`, so the test arm had the rule live in all
  five seats while the control had it off in all five, and only one seat's
  divergence was being watched. Rebuilt as a true one-seat A/B on the fixed
  sampler, `OVERTAKE_SPEND_SECURITY = 0.5` measures:

      +0.2095 per firing +/- 0.0466 SE   (2,999 firings, 30,000 hands x 22)
      4.49 SE from zero, ahead in 20 of 22 seeds

  against the `+0.0666 +/- 0.0317` recorded under 0.58.1. Implied whole-hand
  effect **+0.00099/seat/hand**, which lands on the `+0.0009` the original 4-seed
  abtest sweep reported — so that first sweep was right, and the 4-of-8 re-run
  that appeared to contradict it was the unlucky draw. The rule is a clearly
  positive change, not the marginal one 0.58.1 claims; that entry is left as
  written rather than edited, because the sequence is the useful part.

  That number was taken against the engine as it stood BEFORE #124. `bleedTrump`
  moves fat trump on the leading path and this rule moves it on the overtake
  path — different code, same two cards — so the two could in principle interact.
  Re-run on the merged engine, with #124's harness:

      +0.210 per firing, ahead in 20 of 22 seeds, fires on 0.47% of hands
      whole-hand aggregate +0.0010/seat/hand   (30,000 hands x 22)

  Unchanged: the same mean and the same 20-of-22 split as the pre-merge run, so
  the two guards do not interact — they touch the same two cards on paths that
  never both apply to one decision. 20 of 22 is a sign test at p ≈ 6e-5 on its
  own, without leaning on the SE. (The per-seed figures were piped through
  `tail` when this ran, so the ± could not be recomputed from the log; the
  pre-merge run of the identical measurement gave ± 0.0466.)

## [0.58.1] - 2026-08-03 (`e85447a`)
- **The cheapest-winner rule now measures "cheapest" in points when rank is
  provably free.** Taking a trick with the weakest card that wins it is right,
  but `power` is the wrong axis for deciding what to *risk*: the trump order
  puts the two point-fat trump below every Jack and Queen —

      Q♣ Q♠ Q♥ Q♦ J♣ J♠ J♥ J♦ A♦ 10♦ K♦ 9♦ 8♦ 7♦
                                ▲   ▲
                               11   10 points

  so whenever A♦ or 10♦ is the low winner, "cheapest by rank" is the most
  expensive card in the pile. J♦ and A♦ are *adjacent* there, which makes the
  pair that triggers it also the pair where rank is worth nothing: with nothing
  outstanding between them the same cards beat both, so they hold the trick with
  identical probability and are equally good to keep. Only the 9 points differ.

  Two guards keep this narrow. Equal `cardEquity` means an equal beater set, so
  reordering inside that group surrenders no winning strength at all — this is
  **not** the strength-for-points trade of the three rules already measured and
  rejected in that branch, all of which reached for *more* strength. And
  spending the fat twin is genuinely right once the trick is safe, because the
  points are then banked rather than donated, so `OVERTAKE_SPEND_SECURITY`
  leaves that case exactly as it was. It is the same trump principle `shedCard`
  applies when the trick is lost; the winners branch simply had no equivalent.

  Reported from hand 4 (2026-08-03): the picker overtook her partner's K♦ lead
  from third seat with A♦ while holding J♦, and a defender took the trick with
  Q♥ for 21. The exact solver scores all three legal cards at **cost 0** — the
  defence had that hand regardless — so double-dummy cannot anchor this one.
  PIMC over 10,000 worlds consistent with what she could actually see says J♦ is
  worth **+2.3 points and +4.7pp of win rate** over A♦ (~11 SE). Pinned in
  `scripts/aiskilltest.mjs` with two negative controls (a secure trick, which
  must still spend the Ace; and unequal-equity winners, which must be
  unchanged), and the position is `scripts/scenarios/hand4-patty-ad.mjs`.

  `OVERTAKE_SPEND_SECURITY = 0.5` is swept, not chosen — 20,000 hands x 4 seeds
  per point, variant in one seat against four with the rule off:

      gate    0.2     0.35    0.5     0.65    0.85    0.95    1.0
      mean  -0.0002 +0.0005 +0.0009 +0.0007 +0.0001 +0.0000 -0.0005

  Unimodal with both ends negative, which is what a gate doing real work looks
  like: at 1.0 — fire whenever the trick is less than certain — the rule is
  worse than never firing at all.

  **The whole-hand aggregate cannot see this, and that is a property of the
  rule, not evidence against it.** It fires on 0.83% of contested decisions
  (~0.08/hand, 77% of them the picker, withholding 7.7 points on average), which
  the per-hand average dilutes about twelvefold: pooled across configurations,
  gate 0.5 is favoured in only 13 of 20 abtest sub-samples, which is nothing.
  Measured instead on the decisions it actually changes — a paired harness over
  the same deals, conditioned on the rule having changed a card, which is an
  event fixed at the decision point rather than by the outcome, and which
  null-tests to zero firings:

      +0.0666 per firing +/- 0.0317 SE   (3,629 firings, 30,000 hands x 22)
      2.10 SE from zero, 95% CI [0.004, 0.129], sign test 14+/6- (p = 0.058)

  Positive, and about 2 SE — real but small, and worth reading next to the first
  pass at this, which said +0.11 ± 0.11 over 568 firings. The estimate fell as
  the sample grew, which is what a noisy first look regresses to and a reminder
  that the honest number here was always the bigger run. Implied whole-hand
  effect +0.00038/seat/hand, consistent with the sweep. As with
  `SCHMEAR_KEEP_EQUITY`, the case rests on the pinned hand and the mechanism as
  much as on this — but unlike that one, the aggregate does now point the same
  way rather than merely failing to object.

- **`scripts/abtest.mjs` deals are not reproducible across runs, and the null
  test cannot detect it.** `dealWith` takes its 32 cards from `freshHand`, which
  has already shuffled them with unseeded `Math.random()`, then applies its
  seeded Fisher-Yates on top; shuffling an already-randomised array composes
  with that randomness instead of replacing it, so the seed does not pin the
  deal. The A/B itself is unaffected — both arms get the same `start`, so the
  pairing that gives the harness its sensitivity is intact — but "ahead in k of
  n seeds" is a **fresh draw every invocation**, not a fixed population. Found
  the expensive way: a 4-of-4 result at gate 0.5 failed to replicate as 4-of-8
  on the identical command. Note the exact-zero null test says nothing about
  this, since identical policies play identically on whatever deal they are
  given. Not fixed here — fixing it changes every historical number in this
  file — but it is why a k-of-n from one run should be re-run before it is
  believed.
## [0.58.0] - 2026-08-03 (`de21287`)
Per-table audio on beta (COM-1.1/1.2), server and client. Shipped as one
change; it was developed as two and the halves are kept separate below.

### Server — the flag, the provider adapter, the route
- **Voice rooms, server half — COM-1.1.** A per-table audio room, provisioned on
  demand and cached on the table. No client yet: this is the flag, the provider
  adapter and `POST /api/tables/[id]/voice`. Nothing is reachable from the UI.

- **Audio only, and not as a first step toward video.** The felt is a locked,
  no-scroll viewport with the seat ring absolutely positioned, so video tiles
  would mean redesigning the table. Hearing each other is also what the
  interview said was doing the work — the game is an excuse to fill the quiet
  spaces. `start_video_off`, no screenshare, no chat.

- **Daily, not Jitsi, and the reason is worth recording.** `meet.jit.si` has
  required an account to CREATE a room since August 2023 (Google/GitHub/
  Facebook). Joining stays anonymous, but somebody has to create it — so the
  first person at every table would hit a login wall, which breaks COM-1.3's
  "no second signup" and the whole no-account premise of guest join. The Jitsi
  paths that remain are JaaS (an 8x8 account, plus a JWT signed per participant
  with an RSA key) or somebody's donated public instance.

  Daily rooms can be **public**, so a participant joins with the room URL and no
  token at all. That is the entire reason `api/_lib/voice.js` is 150 lines
  instead of a key-management service, and it matches the trust model this
  project already has: the table link IS the credential, so "anyone holding the
  URL may join" is the same rule one layer down rather than a weakening. Free
  tier is 10,000 participant-minutes a month — a games night is about 900.

- **`VITE_VOICE` is beta-only, which is no longer a branch difference.** Since
  the promotion, beta and production are built from the same commit —
  `release.yml` fast-forwards beta on every green CI run — so "beta only" has to
  be an ENVIRONMENT difference. `master` builds Vercel's Production; `beta`,
  being a non-production branch, builds Preview. A Preview-scoped `VITE_VOICE`
  therefore reaches beta and not www, which is exactly the arrangement
  `VITE_MULTIPLAYER` had before it was promoted. Preview scope also covers PR
  previews, which is useful rather than accidental.

  Verified by building both ways: the production bundle is byte-identical
  (`index-DdDM1lmD.js`, 204.70 kB) and neither build contains `api.daily.co`.

- **The room name is an HMAC of the table code, not the code.** The code is a
  bearer credential; a room name is a string handed to a third party that lands
  in their URLs, logs and dashboard. `src/App.jsx` already redacts table codes
  out of analytics for precisely this reason, and sending the same code to Daily
  would undo that one file over. Keyed with `DAILY_API_KEY` rather than plainly
  hashed, because an 8-character code from a 31-character alphabet is only
  ~8.5e11 preimages — brute-forceable by anyone who obtained a room list. Keying
  costs no new configuration, since the key is already required for any of this
  to work.

- **Two conditions the gate distinguishes, for the reason 0.45.1 exists.**
  `VOICE=1` on the server and a provider key are checked separately, with
  distinct codes (`voice-disabled` / `no-voice-provider`), and the second names
  which credential it cannot see — names only, never values, asserted against
  the serialized body. Flag on with the key missing is the failure that shows a
  working "Join audio" button which 503s when tapped, in front of five people on
  a games night.

- **First writer wins on the room, as long as theirs is still fresh.** Usually
  moot — the name is deterministic in the table id, so racing clients converge
  by construction, one creating and one reading back. The case it guards is a
  key rotation between two provisioning calls, which mints two genuinely
  different rooms; last-writer-wins there splits a table across two calls, and
  the people in the losing one can hear each other, which is what makes it hard
  to notice. The freshness qualifier keeps renewal working, so a session running
  past the 12h room TTL doesn't silently lose audio.

- **Provisioning happens outside `mutate()`.** The CAS loop can call its
  mutation function several times against different states, so a network call
  inside it would be repeated per attempt. The slow, impure part runs once and
  only its result goes through the loop.

- `scripts/voicetest.mjs` (55 checks, wired into `npm test`) drives every branch
  against an injected fake `fetch` — the create/read race, an expiring room, a
  provider that says no, and a stranger trying to spend our quota. Both of the
  load-bearing assertions were negative-controlled: removing the race guard
  fails exactly one check, removing the at-table gate fails exactly two.

- **`flagtest`'s structural check now accepts `requireVoice` as a gate.** It
  matched the literal `requireMultiplayer(res` call, so a route gated through
  the voice wrapper read as ungated. `requireVoice` calls it first and returns
  false if it fails — and that implication is asserted in `voicetest` rather
  than assumed, which is the only thing that makes accepting the wrapper safe.

### Client — opt-in join, mute, and the guard that keeps it off www
- **Table audio, client half — COM-1.1/1.2.** "Join audio" in the table menu, a
  mic chip in the header that mutes and shows how many people are on the call.
  Beta only. Opt-in by tap, never automatic: mobile Safari only grants a
  microphone from a user gesture, and a link somebody texted you should not
  demand one before you have decided to be in the conversation.

- **Production carries no audio code, and that is now enforced rather than
  asserted.** `scripts/voicebuildtest.mjs` builds both ways and greps the actual
  bundles, wired into `npm test`. It is **bidirectional** on purpose: every
  token must be absent flag-off AND present flag-on, because grepping for a
  token and finding zero passes just as convincingly when the token is
  misspelled, when the build silently failed, or when the feature was deleted.
  Measured at v0.48.0: 0 flag-off against 95 flag-on for `daily`.

  `Verify production` gains the deployed half of the same check — a new
  `voice: absent|present` input, defaulting to absent. The build test stops a
  regression being merged; the workflow catches a variable set on the wrong
  Vercel scope, which no test can see.

- **That guard immediately caught a real leak, which is the reason it exists.**
  The first draft gated the UI on `voice.available`, a runtime property of the
  hook's return — and Rollup cannot fold a property access, so the menu entry
  and the mic chip survived into the production bundle. Worse, the first
  verification MISSED it: building without `VITE_MULTIPLAYER` eliminates all of
  `TableScreen`, so the audio inside it looked absent for the wrong reason.
  Production is flag-on for multiplayer, so that was never the right baseline.
  The test now builds production's real shape.

  Fixes: the UI branches on the `VOICE_ENABLED` module constant, and `useVoice`
  returns its inert shape **before** its hooks rather than after. Returning late
  is the obvious shape and leaves every callback in the bundle — it is how
  `toggleMute` shipped to production in the first draft. The early return reads
  like a rules-of-hooks violation and is not one: the rule is that hook order be
  consistent across renders, and `VOICE_ENABLED` is compile-time, so within any
  build this hook either always runs its hooks or never does.

- **The Daily SDK is its own lazy chunk** — 261kB, `import()`ed inside the join
  handler, so even on beta nobody downloads it until they tap the button. Pinned
  separately in the build test, because a refactor to a static import would keep
  every token check passing while making all five people at a table fetch it.

- **A stale join is cancellable.** `join()` awaits twice — the server, then the
  SDK — and either gap is long enough to unmount or to leave. A continuation
  past that point constructs a call object into a dead component, which leaves a
  **live microphone** with nothing on screen to stop it. A generation counter,
  bumped by every teardown, invalidates whatever join is in flight.

- No camera is ever requested: `videoSource: false` at join on top of the room's
  `start_video_off`. Both, because they fail differently — the room property is
  what a second client would honour, the join option is what stops this browser
  lighting a camera indicator even for an instant.

- `userName` is set to the seat index, never the playerId — that is a bearer
  token and the string is visible to every other participant. Nothing reads it
  yet; it is there so a future speaking indicator (COM-2.1) has a seat to point
  at. Deliberately no participant-to-seat mapping in this change: it needs an
  identity join between two systems, and getting it wrong lights up the wrong
  player.

- **Note for whoever adds the next API route:** `api/tables/[id]/voice.js` takes
  the deployment to 11 Serverless Functions against the Hobby plan's cap of 12.
  The seat actions were already folded into one route for this reason. The next
  one has to fold too.

## [0.57.0] - 2026-08-03 (`6b7b254`)
- **Project memory brought in line with the session.** CLAUDE.md's clairvoyance
  section said "Not fixed, deliberately", which stopped being true in 0.56.0 —
  a handoff doc that describes a fixed bug as open is worse than one that omits
  it. Rewritten around how it was FOUND, since that is the transferable part: not
  by reading the code, but by a number that could only be true if something was
  wrong (every trick-5 row grading at exactly zero).
- **New section on skills and what evaluating one showed**, because it changes
  how the next one should be written. Nine runs against a no-skill baseline:
  answer quality was never the differentiator, this repo's documentation already
  walks a capable reader to the right procedure, and the baseline beat the skill
  outright on one case. What varied was scope — 4 to 30 minutes on comparable
  questions. A skill here earns its place by carrying the facts written nowhere
  else and an explicit instruction to stop; adding that took one case from 225
  tool calls to 36.
- Recorded that the evals caught two defects in this session's own work that
  review did not: a summary line printing a win-rate delta as an absolute value,
  and a corpus ranking contaminated by clairvoyant decisions.
- Added the first self-play cost ranking to the "where to pick up next" list —
  double-dummy overstates cost ~2.3x and errs in both directions (13.6% of clean
  calls cost a point or more; 11.5% of flagged mistakes cost under half a point),
  with leading the most expensive shape. Flagged as a hypothesis, not a finding:
  the buckets overlap and have no error bars yet.

## [0.56.1] - 2026-08-03 (`a85a6e7`)
- **`pimc`'s summary line stated the opposite of what happened when the played
  card won more often.** The win-rate delta was wrapped in `Math.abs`, so a card
  that cost points while WINNING more often — trading wins for schneider margin,
  which is the tradeoff this output exists to surface — printed as "and 2.3pp of
  win rate", reading as though it had lost that too. Found by a skill eval run,
  which flagged the line as unusable and told the reader to ignore it.
  - Three cases now, because they are three different pieces of advice: no
    difference, lost win rate, or "but won the hand 1.5pp MORE often — K♣ gains
    margin, not wins". The last is the one that was unsayable before, and it is
    the interesting one.

## [0.56.0] - 2026-08-03 (`2f102cd`)
- **The AI no longer sees your last two cards.** `solveEndgameCard` solved the
  real deal — `endgameValue` recurses over `g.hands`, all five of them — so from
  `tricksDone >= 4` every AI seat played the endgame with perfect information,
  and nothing told the player. It now samples deals from that seat's OWN
  information set and solves each exactly, averaging over them: the determinized
  search of AI_PERFECT_PLAY.md §A, applied where the trees are small enough to
  afford it.
  - Worlds respect what the seat actually knows — hand sizes, suits each seat has
    shown void in, and that the called card cannot sit with the picker. Hardest
    cards are placed first, or a deal paints itself into a corner and the sample
    is wasted. Seeded from the position with `handSeed`, not `Math.random`, so
    card choices stay reproducible and no test that plays a hand becomes flaky.
  - **Cost, measured rather than estimated: +0.0430 stake per seat per hand,
    ahead in 3 of 3 seeds** (`abtest --opt endgameClairvoyant=true`). That is
    what the clairvoyance was worth and what removing it gives up — consistent
    with the ~1.6 card points a hand priced in 0.55.2, and about 24x what
    `BELIEF_FLOOR` gained. A real strength loss, taken deliberately: an opponent
    that can see your hand is not a difficulty setting, it is a different game,
    and a player who suspects it will never un-suspect it.
  - `endgameClairvoyant` restores the old path. It is the measurement control and
    the rollback, not a supported mode.
- **`clairvoyancetest` is inverted and is now a leak detector.** It asserted the
  dependence existed so that removing it would be deliberate; it now asserts the
  choice does NOT move when cards are shuffled between seats the deciding seat
  cannot see (0 of 251 probes, against 22 before). This is the only test that can
  catch the way this silently breaks — a constraint or a hand reference
  reintroducing the real layout would fail nothing else, because playing better
  with more information looks exactly like playing better.

## [0.55.2] - 2026-08-03 (`f6dfa71`)
- **The endgame clairvoyance now has a price: about 1.6 points a hand.** Measured
  over 60 self-play hands — playing the best card under uncertainty instead of
  the clairvoyant one costs 0.42 points per endgame decision on the real deal,
  across the ~3.7 endgame decisions a hand has. It is an UPPER bound, since a
  real uncertainty player would not find the sampled-best card every time either.
  - Against the 120 points in a hand that is ~1.3%: affordable rather than
    load-bearing. The fairness question — the four AI seats can see the human's
    last two cards and nothing says so — was blocked on not knowing what fixing
    it would cost. It is now a decision somebody can make.
  - Recorded next to `solveEndgameCard` and in CLAUDE.md, both of which described
    the behaviour without pricing it. Reproduce with
    `npm run pimcmine -- --selfplay N`.

## [0.55.1] - 2026-08-03 (`5d4c220`)
- **The hand-analysis skill now says to answer the question and stop**, which the
  evaluation says is its most valuable instruction rather than a matter of tone.
  The failure mode is not getting a hand wrong, it is not stopping: a question
  about one card opens onto real work — the engine plays that card too, is that a
  bug, what would a fix measure at — and following the thread produces a research
  report when a reply to a friend was wanted. Measured on an unscoped run: **22
  minutes** on a single trick-1 card, finishing by A/B testing a tuning constant
  over 10,000 hands. Scoped, the same class of question runs about four.
  - Named the harnesses not to reach for (`abtest`, `coalitiontest`, `simulate`,
    `pimcmine`) unless the person asked about the engine rather than the hand,
    since "be brief" without saying what to skip is not actionable.
  - Noticing something about the engine is worth one line and that line is the
    deliverable. The closing pointer now says an engine change is a job started
    deliberately, not drifted into from an answer about a hand.

## [0.55.0] - 2026-08-03 (`7c19df8`)
- **`npm run pimc` leads with the answer somebody actually asked for.** Before
  the diagnostics it now prints every legal card with the DECIDING SEAT's own
  side's average points out of 120 and how often that side wins the hand, then a
  one-line cost against the best card. The table underneath was picker-framed,
  which meant a defender had to invert every number in their head, and no part of
  the output was a thing you could paste to a friend.
  - When the win rate does not move it says so in words rather than leaving two
    identical columns to be noticed — that case is common and it changes the
    verdict from "you threw the hand away" to "you were choosing whether to lose
    double".
- **The hand-analysis skill is cut roughly in half, to the simulation and the
  handful of facts written nowhere else.** Evaluated against a no-skill baseline
  over four cases, and the result was not flattering: the repo's own
  documentation — `engine.js`'s comments, the harness headers, CLAUDE.md, the
  MEASURED AND NOT SHIPPED notes — already gets a capable reader to the right
  procedure. The skill won clearly on one case, tied on one, and **lost** on the
  engine-change case, where the baseline found a code-path distinction (only 301
  of 2,160 apparent schmears came from the schmear branch at all; the rest were
  `shedCard` discarding into a trick already lost) that the skill's own run
  missed.
  - So it no longer re-teaches the engine-change discipline, which CLAUDE.md
    covers better and which was where the time went without buying anything. What
    it keeps is the workflow, and the one thing genuinely undocumented elsewhere:
    a simulated cost at tricks 5-6 is meaningless because the seat is not under
    uncertainty there. That was the case the baseline got wrong — it reported a
    phantom 2.70-point engine bug from a clairvoyant decision.

## [0.54.1] - 2026-08-03 (`5ec31ac`)
- **`pimcmine` was mislabelling what the endgame clairvoyance is worth, and now
  measures it.** It reported the clairvoyant decisions' own PIMC cost as "the
  value of seeing the other hands". That is not what the number is: it is how
  much worse the clairvoyant card LOOKS when scored under uncertainty, which
  answers no question anybody has. The seat is not under uncertainty — that is
  the entire point of excluding those decisions.
  - The quantity that matters is the **double-dummy cost of the uncertainty-best
    card**: what an honest endgame would give up on the real deal. Since the
    clairvoyant card's own DD cost is zero by construction, that difference is
    exactly the price of the information, and it is the input the "should the AI
    stop seeing your last two cards" decision needs. Now computed and reported
    per decision and per hand, flagged as an UPPER bound because a real
    uncertainty player would not find PIMC's best card every time either.
- Correction to the 0.53.1 reading, recorded because it was acted on: on the
  biased estimator `holder=our side` was the one shape where double-dummy
  UNDERstated cost, by +0.19, which made it the obvious place to look next.
  Cross-fitted it is +0.02 — neutral. The hypothesis was an artefact of the
  winner's curse, and the corrected picture is that DD overstates almost
  everywhere (2.09 against 0.89 overall, negative on 17 of 18 shapes) rather
  than having a pocket where it is too kind.

## [0.54.0] - 2026-08-03 (`9173952`)
- **`.claude/skills/hand-analysis/` — the hand-analysis procedure, saved so it
  runs the same way every time somebody asks whether a play was right.** It
  triggers on a recap screenshot, on "was that the right lead", on "what did that
  cost", and on grading or reviewing play generally.
- The thing it exists to prevent is one confusion: **the recap's double-dummy
  grade and PIMC answer different questions**, and the grade is the wrong one for
  "how bad was that". Measured over 425 decisions it called 15% of decisions
  clean that cost a point or more and 9% mistakes that cost under half a point.
  Reporting a DD cost as the size of a mistake is the default failure here, and
  it is confident and wrong rather than obviously wrong.
- It also carries the traps this week produced, each of which cost real time
  before it was understood: tricks 5-6 cannot be analysed as mistakes at all
  because the engine is clairvoyant there; regret is a max over noisy means and
  so is biased upward unless cross-fitted; a defender's information set excludes
  the bury and most sampled worlds with it. And the discipline for acting on a
  hand — reproduce, pin with a negative control, measure on both harnesses,
  calibrate a belief before playing on it — including the outcome nobody expects,
  that a tell can calibrate at 8:1 and still be worth nothing.

## [0.53.1] - 2026-08-03 (`bbcad41`)
- **`pimcmine`'s cost estimate is cross-fitted, because the obvious one is
  biased upward and the bias is not small.** Regret is a MAX over cards of means
  estimated from a finite sample, so whichever card's sampling error ran highest
  gets selected and its inflated mean becomes the yardstick — the winner's
  curse. At 50 worlds that is not a rounding error; it is most of the difference
  between "the engine loses a point a decision" and "the engine is fine", which
  is exactly the kind of number this tool exists to get right.
  - The fix costs nothing: pick the best card on one half of the sampled worlds
    and price it on the other half, so selection noise and measurement noise are
    independent. Both orientations are averaged so no world is wasted. It is
    conservative — the card chosen on half the worlds is sometimes not the best
    — which is the right direction for a number that decides what to work on.
  - The uncorrected figure is still printed, labelled as not to be quoted, since
    the gap between the two is itself worth watching as the world count changes.
  - Every card is priced through the same path, the engine's included. Doing it
    only for the played card left the paired control nulling to something near
    zero instead of exactly zero, which would have quietly cost the one property
    that makes it a control.

## [0.53.0] - 2026-08-03 (`634333c`)
- **The AI plays the last two tricks with perfect information, and now there is
  a test that says so.** `aiChooseCard` dispatches tricks 5-6 to
  `solveEndgameCard`, which recurses over `g.hands` — all five of them — so from
  `tricksDone >= 4` every AI seat is solving the real deal rather than what its
  seat could know. Found by the cost ranking rather than by reading the code:
  every trick-5 decision had a double-dummy cost of exactly 0.00, which is only
  possible if the mover already knew the answer.
- **Demonstrated, not inferred.** `npm run clairvoyancetest` moves one card
  between two OTHER seats — leaving the deciding seat's hand, the played cards
  and every public fact identical — and the card it chooses changes on **4.8%**
  of trick-5 decisions with more than one legal play. One swap is probed per
  decision, so that is a floor on the dependence rather than an estimate of it.
  A characterisation test: it asserts the behaviour that EXISTS, so removing the
  clairvoyance later fails loudly instead of changing quietly.
- **Two consequences, and they are different conversations.** In solo play the
  four AI opponents can see the human's last two cards and nothing says so —
  possibly a fine difficulty knob, but it should be a decision somebody made
  rather than a property nobody noticed. Separately, any double-dummy grade of
  tricks 5-6 reads 0 by construction, so `gradeAllPlays` cannot see an endgame
  mistake and never could, and anything averaging over graded decisions has been
  averaging in a guaranteed zero for the last third of every hand.
- **Not fixed, deliberately.** Removing it means playing the endgame under
  uncertainty — determinized search over the same solver, AI_PERFECT_PLAY.md §A
  — which is a strength change to be measured and a difficulty change to be
  decided, not a one-line deletion.
- `pimcmine` excludes those decisions from its ranking and prices them
  separately. Their PIMC cost is the value of seeing the other hands, not an
  error to fix, and the first run of the ranker reported them as the eight most
  expensive mistakes in the corpus at 10-17 points each. That list was wrong.
  The failure mode is worth naming: an instrument that is correct everywhere
  except one population will report that population's artefacts as its headline,
  because they are the largest numbers it produces.

## [0.52.0] - 2026-08-03 (`f21cf4f`)
- **`scripts/pimcmine.mjs` — rank the corpus by what mistakes actually COST,
  and Actions → "Mine hands" grew an `analysis: cost-ranking` mode to run it
  where the corpus is reachable.** `minehands.mjs` ranks by exact double-dummy
  cost, and 0.50.x established that ruler is mis-calibrated in both directions
  at once: inside a single trick of one hand it scored a 4.3-point error at zero
  and a 0.9-point error at six. That is the right tool for "did this seat find
  the best card" and the wrong one for "which mistakes are worth fixing", so
  every worklist sorted by it has the wrong things at the top. This re-prices
  every decision under uncertainty and ranks decision SHAPES — the same coarse
  feature buckets `minehands` already used — by TOTAL cost, because a shape that
  is slightly wrong very often is worth more than one badly wrong once.
- **Three things it refuses to do, each of which would fake a result:** it does
  not pre-filter to DD-flagged decisions (that would discard exactly the class
  where DD says zero and the real cost is large — the 10♦'s class); it grades
  every seat rather than the human, because the AI's own decisions are what a
  fix would change; and the budget bounds hands rather than decisions, so no
  hand is half-graded and whatever went unreached is printed.
- **The control is paired and nulls to exactly 0.0000.** Every decision is also
  priced for the card `aiChooseCard` would have played there, so the four engine
  seats — who played that card — must come out at exactly zero excess, and the
  noisy seat must come out positive: +2.46 over the decisions it deviated on.
  The first version compared seat 0's mean cost against the other seats' and
  measured +0.06, which is not a control: seat 0 is also the picker more often
  than not, so it was mostly measuring role. That is the same paired-vs-unpaired
  lesson `abtest` and `coalitiontest` already carry, arrived at again.
- **`--selfplay N` deals clean engine-vs-engine hands as a source.** A session
  cannot reach either corpus — the egress proxy still answers 403 to CONNECT for
  both hosts, verified again — and the thing a fix would change is the engine's
  own play, which self-play supplies without limit. What it cannot supply is a
  human's decisions or the real distribution of positions people reach, so a
  self-play ranking is about the engine in the abstract and the corpus stays the
  thing to run against.
- Refactor with no behaviour change: rebuilding a record, the feature buckets and
  the self-test generator moved to `scripts/lib/handlog.js`, and the PIMC core to
  `scripts/lib/pimc.js`, so the two miners cannot drift on what a record means.
  `minehands.mjs --selftest 25` is byte-identical before and after, and both
  published PIMC results reproduce exactly.

## [0.51.0] - 2026-08-02 (`5066c23`)
- **The schmear tell: a new evidence term in the partner belief, calibrated at
  8:1, and shipped OFF because it is almost never actionable.** Every existing
  term in `partnerWeight` is about LEADING a trick; this one is about paying
  into somebody else's, and the two never overlap. It came from a reported hand
  where a defender fed a Ten to the picker — worth 5.9 points by PIMC — because
  `teammateProbability` told him the seat holding the trick was two-thirds
  likely to be a teammate. It was the partner, and the partner had said so in
  trick 1 by throwing an Ace onto a trick the picker had already trumped.
- **The measurement changed the rule twice, which is the part worth keeping.**
  The obvious version — "paid a fat card into a trick the picker was winning" —
  measures at **1.3:1** against a 24.7% base rate, i.e. nothing. Two
  restrictions fix it, and both are about telling a choice from an obligation:
  the payer must be LAST to play (paying into a trick the picker leads *so far*
  is a legitimate bet that a teammate behind you takes it), and it must be
  **tricks 1-3** (late in the hand a seat may have nothing cheap left). That
  lands at **8.3:1** over 6,159 hands, in the same class as the power-trump
  lead. Restricting to Aces makes it *worse*, so the threshold stays at a Ten.
- **Not shipped, and the funnel says why.** Over 92,970 self-play decisions at
  odds 8, the belief moved for the seat winning the trick in 252 (0.27%), 30 of
  those crossed `BELIEF_FLOOR`, and 10 changed a card. The gate is not refusing
  the read — the situation is rare. `abtest` +0.0002/seat/hand ahead in 2 of 4;
  `coalitiontest` -0.00pp with the defenders ahead in 1 of 4; null controls
  exactly +0.0000. When it does fire it is right: all 10 changes were defenders,
  shedding 6.5 fewer points each.
  - Same shape as `PLAIN_TRUMP_LEAD_ODDS`, and worth saying plainly: a tell can
    be strong, honest and worth nothing, because reading a table is not the same
    as being able to do anything about it.
- `aitest` pins the INFERENCE rather than the shipped behaviour, with the
  negative control — at the shipped odds the read does nothing and the defender
  still pays the Ten. If the read ever stops being right, that fails whether or
  not anything is playing on it.
- `belieftest` gained a `SCHMEAR_TELL_ODDS` env override for the sweep, and its
  deduction-only arm now pins the new term off explicitly — the same trap the
  file already documents for `trumpLeadRead`, which silently turned `plain` into
  a comparison of the read against itself.

## [0.50.2] - 2026-08-02 (`f037452`)
- **`pimc.mjs --partner NAME` prices a READ.** It restricts sampling to worlds
  where a named seat holds the called card. The harness has no theory of how
  somebody played and cannot derive this — it is supplied by hand, and that is
  the point: run the same decision with and without, and the gap is what the
  inference is worth in points. The card is dealt to that seat rather than
  sampled and rejected, because rejection on top of the call filter would gut an
  already thin acceptance rate.
- Reported on hand 1: at trick 1 Bunny threw the **A♣** into a trick the picker
  had already trumped and won — playing last, void in the led suit, holding
  cheaper cards. No defender pays eleven points to the picker, so Gus can read
  Bunny as the partner from that alone. Once he has, Bunny's Q♣ at trick 3 means
  the trick is already the picker team's.
  - Throwing the **10♠** goes from **0.9 points** behind the best card to
    **5.9** (±0.12, same sign in 4 of 4 seeds). The read is worth more than six
    times the error it exposes, which is the more useful number: the mistake is
    cheap, *not making the read* is what costs.
  - With the read on, every legal card wins the hand for the picker team in 100%
    of worlds, so the decision is purely the schneider line — 58.7% with the 8♥
    against 76.5% with the 10♠.
- **The engine cannot make this read, and that is a gap in the belief model
  rather than in the play code.** `partnerWeight` has exactly one evidence term,
  `trumpLeadKind`, and a schmear into the picker's trick is not a lead.
  `BELIEF_SCHMEAR` gates a defender *paying* on the belief; nothing feeds the
  belief *from* somebody else's payment. `teammateProbability` is the right
  place for it and `belieftest` is the harness that would calibrate it — this is
  a candidate weight, measurable the same way `TRUMP_LEAD_ODDS` was.

## [0.50.1] - 2026-08-02 (`32621fe`)
- **`pimc.mjs` handles a DEFENDER's viewpoint, which is a different information
  set and was quietly getting it wrong.** A defender cannot see the bury, so the
  two cards nobody ever sees have to be sampled — and two things broke on that:
  - The buried points were being added as a constant taken from the REAL bury.
    For the picker that is correct and the numbers are unchanged (verified
    bit-for-bit against 0.50.0); for anyone else it silently fed the viewer two
    cards' worth of knowledge they do not have, and the bury lands on the
    picker's side of the schneider line, so it moves the answer.
  - Worlds that put the called ace in the picker's hand or in the bury were
    being kept. Nothing about them plays illegally — they simply could not have
    been called that way. The filter asks `callOptions` whether the call that
    was actually made was available in the sampled world, rather than restating
    the rule, so under-calls and called-tens stay right for free. It is doing
    real work: it rejects **74%** of sampled worlds for the defender seat here,
    because it also carries the fact that the picker must still be holding a
    spade, having played nothing but trump.
  - Output is oriented to the deciding seat now — a defender's best card is the
    one that MINIMISES picker-team points, so the sort, the "best" marker and
    the stake column all flip with the side. Stake is the viewer's own delta,
    computed per world, since who the partner is varies between worlds.
- Second result on hand 1, and it points the OPPOSITE way to the first: Gus
  throwing the **10♠** at trick 3 was the worst of his four cards, but by only
  **0.9 points** (±0.10, same sign in 4 of 4 seeds). The exact solve of the real
  deal scores it at **6 points** — so the grader overstates this one by nearly
  7x, having overstated nothing at all about the 10♦. Both errors are real; the
  actual-deal grader is simply not a measure of size.
  - The whole cost is schneider margin, not the hand: win probability is flat
    across all four cards to within a tenth of a point, while the defenders'
    chance of being schneidered goes 31.6% → 34.3%. `aiChooseCard` throws the
    10♠ too.

## [0.50.0] - 2026-08-02 (`924ae24`)
- **`scripts/pimc.mjs` — the determinized search from AI_PERFECT_PLAY.md §A,
  aimed at one decision instead of at the engine.** Sample complete deals of the
  unseen cards consistent with what the deciding seat knew, run the existing
  exact solver on every legal card in every sample, average. It answers the
  question the recap grader structurally cannot: the grader solves the one deal
  that happened, so it scores a play against cards nobody could see, and it will
  happily call a guess correct because the guess came in.
  - **Consistency is enforced by REPLAY, not by a rule list.** A sampled world
    gives each seat its real played cards plus a sampled remainder, the hand is
    replayed from trick 1, and the world is discarded if any card somebody
    actually played would have been illegal in it. Voids, the called-ace
    restrictions and the picker's retain rule all come along for free, and the
    filter cannot drift away from `legalPlays` the way a hand-written one would.
  - Two further filters, kept separate because they are assumptions rather than
    observations: seats that passed are held to `handStrength < 10` (real
    information, and it pushes power trump toward the seats that never got to
    pick), and `--no-passes` turns that off so the sensitivity is visible rather
    than asserted. Error bars are PAIRED — every card is scored on the same
    worlds, so the spread of the difference is what gets reported, not the
    spread of two means.
  - **It cross-checks its own reconstruction against `gradeAllPlays` and refuses
    to print if they disagree.** Analysing a position that is not the position
    that was played produces numbers that are confidently wrong and look fine,
    which is the one failure mode here that nothing else would catch.
  - First result, on the 2026-08-02 hand 1 recap (`scripts/hands/`): leading the
    **10♦** at trick 3 costs **4.3 points against leading the 8♦** (±0.15, same
    sign in 5 of 5 seeds, unchanged with the passer filter off) — the 10 is fat
    and cannot win, with five power trump still out. The exact solver on the real
    deal scores that same lead as **best-available, cost 0**, because in the one
    world that happened the partner's Q♣ took the trick. Both numbers are right;
    they are answers to different questions, and the recap only ever showed the
    second. `aiChooseCard` leads J♠ from that seat — better than the 10♦, still
    2.2 points behind the 8♦, so this is an engine finding and not only a human
    one.

## [0.49.0] - 2026-08-03 (`f708d16`)
- **The AI no longer bleeds with a fat trump when a cheaper one is available.**
  "Lead the weakest trump" has always meant weakest by trick-taking POWER, and
  on the diamonds that reads exactly backwards on price: A-D and 10-D rank below
  every Jack while carrying 11 and 10 points, so the weakest trump in a hand is
  routinely the fattest card in it. Both bleed paths — the picker's and the
  defender's all-trump line — picked that card. New `bleedTrump` skips a fat
  trump when a cheaper one exists and the fat one can still be beaten; a fat
  trump nothing can beat is still a fine lead and stays eligible.

  This is the bleed half of an objection the engine already sustained on the
  press path (`leadDonatesPoints`, 0.44.0). The two have separate switches on
  purpose — `guardFatTrumpBleed` and `guardFatTrumpLead` — because an A/B that
  moves both at once cannot attribute either.

  Found in a real hand, now pinned as `scripts/scenarios/hand8-fonzie-ad.mjs`
  with a constructed assertion and a negative control in `aiskilltest`: a
  defender with every Queen already gone held A-D and three Jacks, so the only
  card left in the deck that could beat anything of theirs was the J-H. The
  engine led A-D — weakest of the four by power, dearest by ten points — into a
  lone picker who, on the evidence visible at the time, held that J-H about 83%
  of the time. PIMC scores J-D ahead by 7.4 points and 30 points of schneider
  rate over 12,000 sampled worlds.

  Measured at **+0.252 per firing on 0.37% of hands, ahead in 5 of 5 seeds**
  (100,000 hands). The whole-hand aggregate is -0.0009/seat/hand, which is
  noise, and that is the point — see the new harness below.
- **New harness `scripts/firingtest.mjs` (`npm run firingtest`).** `abtest`
  measures a variant over every hand, which is the wrong denominator for a rule
  that touches few. A guard firing on half a percent of hands and worth five
  points when it does moves the whole-hand aggregate by about 0.03 — noise at
  any sample size this project runs — so `abtest` reports "no effect" for a
  change that is plainly correct. This splits the population by whether the
  option actually changed a card, and reports firing rate, per-firing delta and
  the `abtest` number side by side so the two are compared rather than confused.

  Two rules in `engine.js` were already tuned this way with throwaway scripts
  rebuilt from scratch each time (see the notes in `aiskilltest`). This is that
  script, kept. It null-tests to exactly zero on both columns with nothing
  firing, and `npm test` asserts it.
- **PIMC reports a schneider rate next to the win rate.** The win rate goes flat
  at exactly the decisions where it is least useful: in a hand already decided,
  every candidate reads 100% and the ranking silently falls back to a mean whose
  units nobody is paid in. Schneider is the boundary still live in those hands,
  and it doubles the stake, so it gets its own column. It uses the same one-point
  asymmetry as the win line (`scoreHand`): the picker's team is schneidered at
  <= 30 and the defenders at <= 29, so schneidering the *other* side needs 90 as
  a defender and 91 as a picker. On the hand above, all four legal leads won 100%
  of sampled worlds while the schneider rate ranged from 49.5% to 89.9% — the
  entire content of the decision was invisible in the old report.
- **New scenario `hand8-fonzie-ad.mjs`**, transcribed from a recap screenshot and
  verified against the printed score before anything was run. Worth keeping as a
  reference case for the exact/PIMC disagreement this workflow exists to surface:
  double-dummy all four leads are *identical* (29 to the picker, schneider either
  way), while PIMC separates them by 8.3 points, because the deciding seat could
  not know where the one outstanding higher trump was.
- **Standing order added to `CLAUDE.md`: open a PR for finished work without
  being asked, and merge it once the tests pass.** `master` is protected and
  takes no direct pushes, so a branch with no PR is work parked where nothing
  picks it up. Spells out that a check which never queued is not a failing check,
  that a red check always blocks, and that `master` gets watched *after* the
  merge too — `Release` is gated on CI succeeding there.

## [0.48.1] - 2026-08-02 (`897fd68`)
- **The collected corpus was mined for the first time, and the answer was "no signal".**
  Docs only, no code change. 131 hands off beta, 126 gradeable, 445 real decisions,
  142 disagreements with the engine, net **+72 points to the human** — noise, and the
  shape says why: **87 of the 142 disagreements (61%) cost exactly the same either
  way.** Of the 55 that mattered the human was better 31 times at +9.2 average and the
  engine 24 times at −8.9, and 31-vs-24 sits inside one standard deviation of a coin
  flip. Both sides make real mistakes at the same rate and the same size.
  - Recorded as a result rather than a dead end. "No large systematic gap against a
    competent human" is the strongest claim 55 decisions support, and it is worth
    knowing before anyone re-tunes anything on a hunch.
  - The one lead — `trick=1`, highest win share at 38%, and the three largest
    single-decision gaps in the corpus — is filed **with the reason to distrust it**:
    trick 1 is precisely where double-dummy flatters the human, because nothing is
    known yet and DD judges with every hand visible. Trick 1 topping that table is what
    the bias alone would produce.
  - Also filed: the feature table double-counts, because every decision emits seven
    features and one big-delta decision lights up seven rows.
- **Beta stopped collecting on 2026-08-01** — 41/45/40 hands on Jul 29/30/31, then 5,
  then nothing. The promotion moved players to www, whose hands go to a different
  database. Next run should read www; beta's corpus is now a fixed historical artifact
  spanning nine engine versions.
- **Mining cost measured on a real runner**: ~16s a hand, 131 hands in 35 minutes, plus
  ~7 minutes for the `--selftest 30` preamble. The old note said ~24s from a slow box.
- Next-session cleanup list written into CLAUDE.md, ordered by what pays: point mining
  at www, record multiplayer hands, **give `minehands` a significance story** (it
  reports a signed total and nothing about spread, so a net built from two heavy tails
  reads exactly like a real edge — that gap is why this run needed a human to say "that
  is noise"), fix the double-counting, and try grading from trick 2 to see whether any
  cluster survives without the position DD is worst at.

## [0.48.0] - 2026-08-02 (`ba00fa9`)
- **`trickSecurity` now prices a beater by whether its holder could legally
  *play* it.** Holding a card that beats the trick is not the same as being
  allowed to play it: a seat holding any card of the led suit must follow with
  one, so an off-suit beater in that hand is a card it never gets to play.
  `forcedPlay` already closed this for the two called-suit pins; ordinary
  follow-suit was still priced as though every unseen card were reachable by
  every seat still to act.

  Found from a real hand. Clubs led, the partner trumped in with J-hearts, one
  opponent left to act. Three unseen cards beat the Jack so the count read
  0.324 — but two fail clubs were also unseen, and that opponent can only trump
  holding neither. The honest number is `0.515 + 0.128 = 0.643`, twice as safe.
  The picker read the trick as 68% lost, overtook his own partner with a Queen
  to rescue it, and was holding two diamonds that could not win a trick all
  night. Double-dummy, every Queen there costs **19** and both diamonds cost 0.

  The overtake gate was never at fault: it correctly demanded 0.60 for an
  unbeatable card and was handed 0.676 by a biased estimate. Beaters are now
  split by whether the led suit is their effective suit, exact for one free
  seat; several free seats need inclusion-exclusion because voidness is
  per-seat, so those keep the old estimate rather than an approximation.

  Measured at 20,000 hands × 5 seeds, and re-measured after merging master so
  the numbers describe the code that actually ships: **+0.0042/seat/hand,
  ahead in 5 of 5** (`abtest`), and **−0.04pp** picker win rate in
  `coalitiontest` with the old behaviour in every defender seat, i.e. no
  defender-side effect either way. Both gates were re-swept with it on and the curve is
  flat — `schmearConfidence` across 0.85/0.88/0.90/0.93/0.95 gives
  +0.0038/+0.0045/+0.0038/+0.0043/+0.0048 and `overtakeMinGain` across
  0.10/0.15/0.20/0.25 gives +0.0029/+0.0038/+0.0037/+0.0040 — so **the gates
  stay where they are**. `SCHMEAR_CONFIDENCE` gains an `opts` override, which
  sweeping it required and which null-tests to exactly +0.0000.

  This was first measured at 4,000 × 3 and **rejected on that basis, wrongly**.
  At that size the harness's run-to-run spread is about ±0.005, larger than the
  effect: the identical variant gave −0.0052 (ahead 1 of 3), +0.0034 (2 of 3)
  and +0.0029 (3 of 3) on three consecutive runs. The tell was that with the
  flag defaulted *on*, turning it *off* also measured "ahead in 3 of 3" — two
  runs that each say the variant wins are one broken measurement, not two
  results. Runs cost eleven seconds; nothing should be decided at that size.

- **New: PIMC decision analysis (`scripts/pimc.mjs`).** Answers "was this a good
  decision given only what the player could see", as against the exact solver's
  "was it a mistake given everything". It forgets what the seat could not know,
  samples worlds consistent with the public evidence, and rolls each forward
  with the engine's own policy. Reports mean, standard error and win rate per
  legal card. `scripts/gradedecision.mjs` gives the full-hindsight grade from
  the same scenario file, and `.claude/skills/analyze-sheepshead-hand` drives
  both from a recap screenshot.

  Four modelling bugs were found and fixed by validating it against a
  forward-simulation baseline that shares no code with it — the habit worth
  keeping. The picker's hand was being split keep-six/bury-two at random,
  discarding 1.3 trump per hand; the pick threshold was applied to all eight
  cards rather than the pre-blind six `aiWantsToPick` actually reads; and with
  the partner unknown the called ace could be dealt to the picker or into the
  bury, making the picker their own partner or secretly alone in 22% of worlds.
  On the reference hand PIMC and the independent baseline now agree (51.3 / 30%
  against 48.8 / 26.9%).

- Repairs two `aiskilltest` fixtures that were pricing probabilities against
  decks that cannot exist: one was 25 cards with the last opponent holding two
  cards of the led suit, so in its own deal that seat had to follow suit and
  could never take the trick the Queen was being spent to rescue; the other had
  two played cards still sitting in hands plus a duplicated K-diamonds. Both are
  now complete 32-card deals, asserted by `dealIsComplete()`.
## [0.47.0] - 2026-08-01 (`a29d0d4`)
- **The collected corpus can be read and mined without a browser, from Actions
  → "Mine hands".** `minehands.mjs` has existed since 0.32.0 and found a real
  bug in its first 41 hands, but reading the corpus meant reaching
  `beta.noschnitz.com/api/hands` — and an agent session cannot: the egress proxy
  answers 403 to CONNECT as a policy denial, exactly as it does for the deploy
  checks. Same answer as `verify-beta.yml`, for the same reason: the check runs
  where it can reach the site, and the answer gets read out of CI.
  - It prints a census before it mines. The first question about a corpus is not
    what it says, it is whether it is still arriving — and since every record is
    stamped with the build that produced it, a corpus whose newest version is
    three releases back means collection broke rather than that nobody played.
  - **There are two corpora as of 0.45.2, and picking the wrong one reads as
    "nobody played".** Preview and Production hold separate Upstash databases on
    purpose, so beta has everything collected up to the promotion and www has
    real play from that day on. The workflow takes the host as an input and
    stamps it on the census; the default stays beta because that is where the
    history is. `HANDS_READ_TOKEN` is scoped per environment too, so reading www
    needs the Production copy of it. Comments in `api/hands.js` and
    `handLog.js` that described production as having no store are corrected —
    that stopped being true the same day this was written.
  - The miner self-tests first, on a seat that plays a random legal card a
    quarter of the time. An instrument that cannot detect a deliberately worse
    player cannot be trusted to detect a better one.
- **A grade could take the whole heap down, and did.** `DD_NODE_BUDGET` bounds
  the search in TIME, and nothing bounded it in MEMORY — the transposition table
  grows one entry per node, so at 50M nodes it wants gigabytes and the heap limit
  arrives long before the budget can fire. `minehands.mjs --selftest 30` died on
  "Ineffective mark-compacts near heap limit" at 8GB after six minutes. The
  budget's whole purpose is to make a pathological hand report no verdict instead
  of hanging; a crash is worse than the thing it was built to prevent, and in the
  browser it takes `grader.worker.js` with it rather than returning nothing.
  - Fixed by capping the table at 750k entries and clearing it when full, which
    is safe because a transposition table is a cache and correctness never
    depended on a hit. Sized on the measurement rather than a guess: the same
    self-test peaks at 5.2GB with a 3M cap and 2.0GB at 750k, grading 30 of 30
    hands either way in the same wall-clock. A CI runner's default old-space is
    around 4GB and a phone's worker heap is far smaller, so the headroom is the
    whole point.
  - `gradetest` proves the clearing is harmless rather than assuming it: every
    one of its 1,479 cross-checked positions is now solved a third time with the
    table capped at five entries, so it clears constantly, and the value has to
    match the unmemoised reference minimax. A table that corrupted results on
    eviction could not pass that.
- **Every device was losing the tail of its log — up to four hands each.**
  `flushHands` only ran after a hand ended and only sent once five were pending,
  so a browser that stopped on four kept them forever: the fifth hand that would
  release them never comes. Since a device stops mid-batch by definition, that is
  not an edge case, and it fell hardest on people who tried the game once. A
  forced flush now runs on mount, so stragglers leave with the next visit.
- **The uploader had no test coverage at all**, which is how that survived. It
  has some now, stubbing `localStorage` and `fetch` and driving the real module:
  four hands stay put, a forced flush sends them, a second forced flush sends
  nothing because the first marked them, an empty queue makes no request, and a
  503 stops the browser asking forever. Checked against the negative control —
  with the fix removed, three of them fail.
- **The miner's self-test advertised a fixed seed and did not have one.** It
  seeded its own shuffle but started from `makeDeck()`, which shuffles with
  `Math.random` first — so the seed was decorative and every run sampled a
  different 30 hands. Three runs on identical code returned nets of -37, -38 and
  -45, which is exactly the size of difference someone would report as an effect.
  It deals from `ALL_CARDS` now, and two consecutive runs are byte-identical.
  - This is why the memo cap above was measured with `gradetest` rather than with
    the self-test: 1,479 positions solved a third time with a 5-entry table, each
    against the unmemoised reference. A control that resamples every run cannot
    settle a question like that, and would have looked like it had.
- `minehands.mjs` takes `--budget-min`, because an exact grade is seconds a hand,
  not milliseconds, so any real corpus outlives any job timeout. It takes the
  newest hands first when the clock is bounded — an old hand is graded against an
  engine that no longer exists — and says how many it did not reach, which is the
  difference between a truncated run and a run that merely looks complete.
- Correcting the comment above the recorder in `Sheepshead.jsx`: it still said
  nothing leaves the browser, which stopped being true in 0.32.0 when uploads
  were added.
- Correcting CLAUDE.md's passage on the two "go alone" bars, which 0.46.0 made
  false the same day it was merged: it still described `ALONE_OFFER_STRENGTH` as
  18 and as a *measured* consequence of the human deciding after the bury is
  spent. Both bars are 17 now, `aitest` asserts them equal rather than ordered,
  and the reason is a product call made against an unchanged measurement rather
  than a new one. Rewritten to say that, including the condition for putting 18
  back — a note that reads as measurement when it is really a judgement is the
  kind that gets cited later as if it settled something.

## [0.46.0] - 2026-08-01 (`6ef0eba`)
- **`ALONE_OFFER_STRENGTH` drops to 17, matching the AI's `ALONE_HANDSTRENGTH`.**
  The "Go alone" button now appears on every hand the AI would consider going
  alone on itself. It sat at 18 since 0.44.0 on the strength of a paired
  measurement, and that measurement has not changed — this is a product call
  made against it, not a new number.

  What it costs, from the same table 0.44.0 was set from (20,239 pickers who had
  a partner available, alone minus calling, points per hand to the picker):

  | strength | alone − calling | alone better on | per seed |
  |---------:|----------------:|----------------:|:---------|
  | 16 | −4.0 | 24.5% | negative in 4 of 4 |
  | 17 | −1.9 | 31.7% | negative in 4 of 4 |
  | 18 | +0.3 | 49.7% | positive in 3 of 4 |

  So the newly-offered band is exactly strength 17, where declining the partner
  loses about two points a hand in every seed. The button is now on **19.1%** of
  picked hands against 15.0% before — 12.5% forced (no callable suit, ungated,
  unchanged) plus **6.6%** where it is a genuine choice, up from 2.5%. The
  marginal band is 4.1% of picked hands, so the exposure is roughly 0.08 points
  per picked hand, and only if the offer is always taken.

  The reason it moved anyway: the AI has been allowed to make this decision at
  17 since `ALONE_HANDSTRENGTH` landed, and a person watching an opponent go
  alone on a hand their own screen refuses to offer reads as the game knowing
  something it will not tell them. Consistency about what the table is permitted
  to do was judged worth two points a hand on 2.5% of picks. The cost is bounded
  and written down; if the win rate on human picks moves, 18 is the first thing
  to put back.

- **The two bars are now asserted equal rather than ordered.** `aitest.mjs`
  checked `ALONE_OFFER_STRENGTH > ALONE_HANDSTRENGTH`, which was the old
  invariant stated as a test. It now checks equality, so moving either bar
  without considering the other fails loudly instead of silently reopening the
  gap. The boundary hands moved with it: strength 17 (`Q♣ Q♠ Q♥ J♦ A♦ A♣`) is
  the new at-the-bar case, and 16 (`Q♣ Q♠ A♦ J♦ J♣ A♣`) the new one-short case.

- No engine, scoring or server behaviour changed. `mayGoAlone` remains a UI
  affordance that the server deliberately does not enforce — alone is legal at
  any strength, and a client that goes alone on a weak hand is only hurting
  itself.

## [0.45.2] - 2026-07-31 (`d5dbb8c`)
- **Multiplayer is live on www.noschnitz.com.** Documentation catching up to a
  deployment, no behaviour change. `VITE_MULTIPLAYER=1`, `MULTIPLAYER=1` and a
  Production-scoped Upstash database are set on Vercel; verified by bundle
  content (8 `/api/tables/` references in what www actually serves) and by a
  table surviving a reload in a fresh tab.

  Every claim that production is the solo game is now false, and this repo has
  been bitten by exactly that drift before — CLAUDE.md's own header notes a line
  that said v0.7.2 while the app shipped v0.22.0. Corrected in `CLAUDE.md`,
  `src/flags.js` and `api/_lib/flags.js`, including the consequence that is easy
  to miss: a multiplayer-only change no longer leaves the production bundle
  byte-identical. Verify-by-content still stands, for the other reason — Vercel's
  minifier is non-deterministic.

- **The promotion runbook now records what it cost.** Four variables, three of
  them right first time, and three deploy cycles spent finding the fourth:
  `KV_REST_API_TOKE`, missing a trailing `N`. Written down so the next person
  doesn't pay it again — expect the marketplace integration to auto-prefix
  (Preview already owns the bare name, and clearing the prefix fails as "no
  environment variables created", which is a name collision reported obliquely);
  never substitute `KV_REST_API_READ_ONLY_TOKEN`, which the store would accept
  and then fail on at the first write; and **`VITE_MULTIPLAYER` must not be
  marked "sensitive"**, because sensitive variables reach functions at runtime
  but are withheld from the build step — which would serve a solo-game bundle in
  front of a fully live API, with every signal green and the feature absent.

  Plus the four-layer verification chain, one row per thing that can be
  independently wrong: build flag, server flag, store credentials, and store
  *persistence* — the last of which only a human can run, and the only one that
  proves a warm isolate isn't quietly on the in-memory fallback.

## [0.45.1] - 2026-07-31 (`49d1001`)
- **`no-store` now says WHICH credential name is missing.** The gate was already
  loud — it refuses with a distinct code rather than silently falling back to an
  in-memory store that loses tables — but it was not specific, and that turned
  out to be most of the cost. Every way of getting the store wrong produces a
  byte-identical 503: a provisioning prefix, a typo, the wrong environment
  scope, or a deployment created before the variable was saved. Told apart only
  by hypothesis, each guess costs a redeploy. Found the expensive way during the
  production promotion, where the real cause was a prefix — Vercel's marketplace
  integration adds one automatically when the bare name is already taken on the
  project, which it is here, because the Preview database owns it. So a
  Production store arrives as `prod_KV_REST_API_URL` and nothing reads it.

  The 503 body now carries `details`:

  ```json
  { "accepted": { "KV_REST_API_URL": false, "...": false },
    "otherNamesPresent": ["prod_KV_REST_API_TOKEN", "prod_KV_REST_API_URL"] }
  ```

  **Names only, never values**, and that rule is asserted rather than commented:
  `flagtest` plants a secret in four differently-named variables and checks it
  appears nowhere in the serialized body. `KV_REST_API_TOKEN` is a bearer
  credential for the whole table store, so a value here would be far worse than
  the misconfiguration it diagnoses. A name is not a secret — that
  `prod_KV_REST_API_URL` exists is not usable by anyone — and the report is
  scoped to store credentials by pattern, so it cannot become an environment
  dump. `STORE_ENV_KEYS` is exported and the report is built from it, so the
  diagnostic cannot drift from the predicate it describes.

## [0.45.0] - 2026-07-31 (`060791f`)
- **Arriving at a table now puts you AT it, watching, instead of on a holding
  page.** Tap a friend's link mid-hand, type a name, and you land on the felt
  with the hand in progress — and the table is told who just showed up and whose
  chair they are taking: *"Dave will take Gus's seat after this hand."* With no
  AI seated there is nothing to name, so it says what is actually true instead:
  *"Dave is watching and will take next available seat."*

  The announcement is derived from the table's live state (`watcherNotices` in
  `src/table.js`), never stored at join time. `applyPendingJoins` hands out
  whatever is open **at the deal**, so a seat pinned when somebody joined would
  be a promise the deal need not keep — the AI seat can be claimed by an earlier
  arrival, or a fifth human can leave and open a different one. Reading it off
  current state means the line always describes the seat that player would
  genuinely take if the hand ended right now.

- **A full table no longer turns people away.** `joinTable` used to answer
  "five humans are already seated" with a 409, which was the wrong answer to
  the question being asked: somebody tapping a texted link has not asked for a
  seat, they have asked to be at the table. Five chairs plus a queue is how a
  games night rotates six or seven people through them — the exact thing the
  get61 era could never do. Joining now always gets you in; what varies is
  whether you are holding cards yet. The 409 survives only past `MAX_WATCHERS`
  (8), which is a ceiling on an array anyone holding the link can write to,
  not a statement about the game.

- **The felt renders for a viewer with no seat.** `rotate()` leaves a watcher's
  view unrotated, so seat 0 landed in the slot `SEAT_POS` deliberately leaves
  empty for the viewer's own hand — and simply wasn't drawn. The table appeared
  to have four players. `SEAT_POS_BOTTOM` gives it somewhere real to be. The
  hand row is dropped rather than rendered empty (`HandFan` holds its height on
  purpose), so the felt takes the space, and the controls a watcher would only
  get a 403 from — deal, boot — are not offered.

- **A refresh no longer re-announces you.** `JoinGate` now recognises its own
  queue entry on the initial state check, so reloading while you wait doesn't
  send you back through the name step and introduce "Dave 2" to the table.
  `uniqueName` also dedupes against the queue, not just the seats, so two
  arrivals with the same name don't produce the same sentence twice.

- **`Verify production`** (Actions → Run workflow), the sibling of
  `Verify beta`. A session working on this repo cannot fetch noschnitz.com, so
  the check this project insists on — verify by bundle **content** — has to be
  readable out of CI. It reports *stale* and *wrong build* separately, in both
  directions: flag-off after the multiplayer promotion means www quietly lost
  it, flag-on before means unfinished multiplayer went live against a Production
  environment with no store behind it.

## [0.44.0] - 2026-07-30 (`3944da3`)
- **The "Go alone" button is gated on the hand now — `ALONE_OFFER_STRENGTH`.**
  0.43.0 offered it on every hand, which made a losing move available on most of
  them. When it is worth offering was measured rather than guessed, with a
  paired harness: both arms get the identical deal AND the identical bury and
  differ in nothing but the call, because by the time the button is on screen
  the bury is already spent. Every seat plays the unchanged engine; the metric
  is the picker's own `handDelta`, which already carries the 4×. Over 20,239
  pickers who had a partner available (6,000 hands × 4 seeds), alone minus
  calling, in points per hand to the picker:

  | strength | alone − calling | alone better on | per seed |
  |---------:|----------------:|----------------:|:---------|
  | 15 | −5.9 | 18.0% | negative in 4 of 4 |
  | 16 | −4.0 | 24.5% | negative in 4 of 4 |
  | 17 | −1.9 | 31.7% | negative in 4 of 4 |
  | 18 | +0.3 | 49.7% | positive in 3 of 4 |
  | 19 | +2.5 | 68.7% | positive in 4 of 4 |
  | 20 | +4.3 | 91.1% | positive in 3 of 3 |

  So the bar is **18**, and it is deliberately NOT the AI's `ALONE_HANDSTRENGTH`
  of 17. Those answer different questions: the AI decides while it still holds
  all eight and buries to match the plan, banking points instead of protecting a
  call; a human decides after the bury is spent. At 17 the human is giving up
  about two points a hand by declining the partner, consistently in every seed —
  offering it there is offering a losing move.
  - Net effect: the button shows on **14.9%** of picked hands — 12.3% where no
    suit is callable at all (forced, ungated, unchanged) and 2.5% where it is a
    genuine choice.
  - `mayGoAlone(hand)` lives in `engine.js` and is read by both the button and
    the status prompt, so the solo screen and the table screen cannot end up
    disagreeing about the bar — the same reason `CallButtons` renders options
    rather than suits.
  - The prompt tracks the gate in both directions: "Call an ace, or go it
    alone." only when the button is there, and the original "Call an ace — your
    partner holds it." when it is not. A line offering a choice the screen does
    not have is as wrong as one hiding a button that is right there.
  - `api/tables/[id]/bury.js` deliberately does **not** enforce the bar. It is an
    affordance, not a rule: alone is legal at any strength, the AI's own bar sits
    a point lower, and a tampered client going alone on a weak hand is only
    hurting itself. Validation there is for things that would corrupt the hand
    for everyone else.
  - On the reported case — "five trump and an ace", the shape that used to be
    forced alone and now gets an under call offered instead — the answer depends
    on *which* five. Five plain trump reads 10 and going alone there measured 11
    points a hand worse than calling, so the button stays off; the same shape in
    three Queens and two Jacks reads 18 and gets it. Both are pinned in
    `aitest.mjs`, with the one-notch-weaker hand as the negative control.

## [0.43.0] - 2026-07-30 (`0276266`)
- **The picker can go alone even when a partner is available.** "Go alone" only
  appeared when `callOptions()` came back empty — i.e. when there was nothing to
  decide — so the human could only ever be alone by accident of the deal. The
  AI has been allowed to make this decision since `ALONE_HANDSTRENGTH` landed:
  `aiBuryAndCall` declines a perfectly good call on a strong enough hand and
  takes the 4×. The engine, `assignPartner`, `viewFor` and the scoring all
  already handled a chosen null call identically to a forced one; what was
  missing was a button and a server that would accept it.
  - `api/tables/[id]/bury.js` used to reject it. A null `calledSuit` with a
    non-empty option list fell past the `no-callable-suit` branch into
    `bad-call` and came back 400 — "You can't call that suit", about a suit the
    picker had deliberately not called. Declining to call is now always legal;
    the remaining checks are only about naming a partner you aren't entitled to
    name.
  - The button is deliberately not gold and sits on its own row under the call
    buttons: calling a partner is the ordinary move and should still look like
    it. When it is a genuine choice it arms on the first tap and commits on the
    second ("Tap again — no partner, 4×"), because nothing in the call step is
    undoable and a stray tap turns a 2×/1× hand across two people into a 4×
    against four. When no suit is callable it stays a single unconfirmed tap —
    there is no partner being given up, so there is nothing to confirm.
  - `status.callPrompt()` names the alternative in both branches that offer a
    call ("Call an ace, or go it alone."). A prompt saying only "Call an ace"
    over a "Go alone" button tells the player the screen is wrong.
  - Covered end to end in `scripts/e2etest.mjs`: the table is rigged into a
    human bury with clubs genuinely callable, and the route is asked to go
    alone anyway. Rigged rather than driven for the same reason the all-pass
    case is — reaching a *human* bury with something callable depends on which
    seat the AI let pick, so driving it would silently skip on most runs. The
    rig deals all five hands from `ALL_CARDS` and clears `aiLog`, since handing
    one seat cards the others already hold makes the leak sweep read the
    picker's own hand as somebody else's.

## [0.42.0] - 2026-07-30 (`ce9fc11`)
- **Every modal's buttons are right-aligned now, primary on the right.** The
  game is played one-handed on a phone, and the buttons were laid out
  left-to-right with the primary first — which put "Deal next hand", the button
  pressed every single hand, at the furthest point on the screen from a right
  thumb. The rule is now one row per modal, pinned to the trailing edge, with
  the primary action last in it and the secondary ones flowing back to the
  left: Recap/**Deal next hand**, Back/**Deal next hand**, Close/**Stop sending
  my hands**, Clear/Close/**Copy**, Close/**Remove <name>**.
  - Lives as `ModalActions` in `src/ui.jsx` rather than a `justifyContent` on
    each row, so the next modal gets it for free — this was seven hand-rolled
    flex rows that had already drifted in three directions (one stacked, one
    full-width, one plain row).
  - Children are written in visual order rather than the row being reversed in
    CSS, so tab order and screen-reader order still agree with the screen.
    Wrapping is on and stays right-aligned: three sentence-length labels do not
    fit across a 390px phone, and the overflow lands bottom-right, which is
    still the closest point to the thumb.
- **The Scores modal's own controls join that row, and "Change my name" is a
  button again.** It was a `btnGhost` — 13px text in 4px of padding, about half
  the height of the "Step away" button stacked directly under it — so the one
  control on that screen that changes something about *you* read as a link that
  had wandered in. It is now `btnPlain`, the same shape and height as the
  controls beside it, which is what it always was in weight.
  - The explanatory notes move above the row rather than sitting under their
    own buttons, since the buttons are no longer stacked. Same text, one place.
  - The one modal where Close is *not* the primary: if you have stepped away,
    "Take my seat back" is what you opened Scores for, so it takes the
    right-hand slot and Close moves left of it.
  - `SeatControls` became `TableScoresModal` and now owns the modal instead of
    being passed into it as children. Its controls belong in the footer row and
    its explanations above it — two slots decided by one piece of state
    (whether the name is being edited), so the component holding that state has
    to be the one filling both. `ScoresModal` takes the whole row as `actions`
    rather than a Close button plus extras, because only the caller knows which
    of its controls is primary, and the primary is the one that has to be on
    the right.
  - Checked by screenshotting all eleven modal states through a real browser at
    390px, including the rename-in-progress and stepped-away variants, rather
    than by reading the flex rules back.

## [0.41.0] - 2026-07-30
- **The AI never takes over the last human's seat.** Reported from a real table:
  a player alone with the four AI put their phone down between tricks, came back
  inside a couple of minutes, and the hand had been picked, called and played
  out without them. The seat was still theirs — cover marks a seat `away`, not
  released — but the game they were in the middle of was gone.
  - `coverIdleSeats` now returns the table untouched when only one seat is
    `human`. Cover exists to stop a table full of people stalling on somebody
    who left; with one human there is nobody to un-stall, so the entire benefit
    is gone while the cost stays the worst one in the system.
  - Presence is why this was not a rare accident. `lastSeen` depends on a client
    ping that a backgrounded tab stops sending — see the note on `active` in
    `api/tables/[id]/state.js` — so "gone quiet for 90 seconds" routinely means
    "locked their screen", not "left". Everywhere else that weakness costs at
    most one covered seat on a table that keeps playing. Alone, it cost the
    session.
  - One deliberate exception: a guest who clicked the link mid-hand is queued
    until the next hand boundary, and that boundary only arrives if the hand is
    played out. So a waiting joiner still counts as company, or the rule would
    freeze a real person out of the table with no way in. A stale queue entry
    can't disable the rule for long — the joiner is seated at the next boundary
    and becomes a seat of their own.
  - Stepping away deliberately is untouched, including when you are the only
    human. Handing your seat to the AI is a choice, and the solo-vs-AI table is
    exactly where you might want it; this only refuses to make that choice for
    you. Booting is untouched too — it takes another person acting.
  - `scripts/tabletest.mjs` pins it with a negative control: the identical table
    with a second human present still covers exactly as it did, so this is a
    rule about being last rather than a blanket disabling of cover. Two existing
    cases assumed a table could be swept empty of humans and were rewritten
    around three players; they were encoding the behavior this replaces.

## [0.40.0] - 2026-07-30
- **The AI stops schmearing a boss fail card over a dead one.** Reported from a
  real hand: a defender void in trump sat behind her partner's winning
  Q-diamonds holding A-clubs, 10-hearts, 9-clubs and 10-spades, with hearts the
  called suit and the called A-hearts therefore known to be in the picker's
  partner's hand. She threw the Ace. The schmear branch sorted candidates by
  card points alone, so eleven beat ten and that was the whole decision — but
  the Ace was boss of clubs with a single trump left in the game, a trick she
  still owned, while the ten of the called suit was a guaranteed donation the
  moment hearts was led. It was led on the very next trick, and the ten fell
  under the called Ace. Four points, double-dummy.
  - The rule now declines to spend a fail card that is still boss of what
    remains when a card within one point of it is already doomed. Deliberately
    narrow: it costs a point of schmear at most, and only fires when the fat
    card genuinely expects to take a trick of its own — in practice the
    Ace-versus-Ten choice with the trump nearly spent, about one hand in 120.
  - The obvious general version is wrong, and was measured to be wrong before
    the narrow one was written. Discounting every candidate's points by its
    exposure and schmearing the largest product costs -0.0005/seat/hand, ahead
    in 1 of 5 seeds at 10,000 hands per split, and loses 0.311 points per
    disagreeing decision against the exact solver. It lets a cheap exposed card
    outrank a fat safe one — it threw a King (4 points) over an Ace (11) — and
    a certain eleven now beats a speculative eleven later by more than any risk
    model gives back. Points-first was right all along; it is only the near-tie
    at the top that it got wrong. Both the rejected rule and the reasoning are
    kept in `engine.js` so nobody has to rebuild them to re-check.
  - Measured at +0.0001/seat/hand, ahead in 7 of 10 seeds over 60,000 hands per
    split, with the mirrored run (old rule in one seat against four new) agreeing
    at -0.0001, behind in 10 of 10. The null test resolves to exactly +0.0000,
    which is what makes a number this small readable at all.
  - Worth recording that this was tuned before 0.36-0.39 and re-measured after.
    On the pre-0.36 engine it was +0.0003, ahead in 7 of 8 — the belief gate
    those versions put in front of the schmear branch halves it. Both directions
    still lean the same way and nothing regressed, but the honest claim is now
    a sign rather than a magnitude, and the case for the change rests as much on
    the pinned hand as on the aggregate. The knobs were re-swept on the current
    engine and this pair is still the best of them, thinly.
  - `npm run simulate` unmoved; full suite green.
  - Pinned in `scripts/aiskilltest.mjs` from the real deal rather than a
    constructed one — every card of that hand is visible in the recap, so the
    position is exactly as it stood — with a negative control that brings the
    Ace back when the rule is switched off, and two cases guarding the failure
    mode above.
## [0.39.2] - 2026-07-30
- **No behaviour change — a measurement written down where it will be found.**
  The largest single error in the collected corpus is a defender playing the
  cheaper of two Queens on trick 1 and losing the trick to the picker's
  Q-spades, worth 43 points double-dummy. The play really is wrong (over 3,000
  deals consistent with what that seat can see, the boss Queen is worth +2.8
  points to the defense and wins 81.3% of hands against 75.4%) — so the hand
  will be reported again, and the next person to look deserves the result of
  having already tried.
- The obvious fix — upgrade to a boss winner when the cheap winner has a live
  beater and `securityAfterPlay` says the trick is not yet certain — measures
  **-7.37 per firing over 2,929 firings, 0 of 3 seeds**, with the acting side's
  win rate falling from 75.1% to 62.5%. It fires on ~12% of hands and is the
  rule 0.19.0 deleted for +0.089/seat/hand coming back in by another door.
- Narrowed to the reported shape exactly, it reads +1.25 per firing in-sample
  and **-0.61 on fresh seeds**. That is noise; the in-sample figure was the best
  of twenty slices. Recorded because "narrow it until it works" is the obvious
  next move and it does not work.
- What the position actually needs is a prior nothing in the engine has yet:
  the card that beats the cheap Queen is likelier to sit with the **picker**,
  because pickers pick on trump. Noted against §B of `AI_PERFECT_PLAY.md` as a
  ready-made test case for the belief layer.

## [0.39.1] - 2026-07-30
- **Renaming yourself at a table works again.** `TableScreen` called
  `api.renameSeat(...)`; `src/api.js` exports that function as `setName`. There
  was never a `renameSeat`, so the Rename button in the seat controls threw
  `TypeError: api.renameSeat is not a function` and the name never changed. Fixed
  at the call site rather than by renaming the export — one caller was wrong, not
  the API. The seat route itself was fine; nothing server-side changes.
- **`npm run exporttest` — a guard for the class, not just this bug.** For every
  `import * as NS from "./local.js"`, it loads the module and asserts every
  `NS.member` the file reads is actually exported.
  - This is the sibling of the gap `no-undef` exists for (see the note in
    `eslint.config.js`): lint catches a free identifier that resolves to nothing,
    this catches a *member* that resolves to nothing. Lint cannot see it — `api`
    is a perfectly well-defined binding, and ESLint does not follow the import to
    check what is on it.
  - The build did notice, and that is the part worth remembering: Vite printed
    `"renameSeat" is not exported by "src/api.js"` on **both** the flag-off and
    the flag-on build, and exited 0 anyway. A warning in a passing build is a
    thing nobody reads. It fails the test run now instead, in milliseconds and
    without a bundler.
  - Verified by negative control: reintroducing `api.renameSeat` makes it exit 1.
- The bug outlived five releases (0.34.0 through 0.39.0) with the warning in
  every build log the whole time, which is the case for the guard more than the
  one-word fix is.


## [0.39.0] - 2026-07-30
- **The picker no longer leads a fat trump into higher trump.** Holding K-D, A-D
  and 10-D with both jacks still out, the engine led the Ace — eleven points to
  whoever held a jack, on a trick it could not win. The defense has to follow
  trump whichever of the three it leads, so the bleed is identical and the only
  variable is the price.
- The branch responsible is "opponents nearly tapped out, press now", which
  leads the *top* trump. Pressing is right, but it is only pressure if the top
  trump can plausibly hold the trick; with higher trump outstanding a fat diamond
  is a donation. It now declines and falls through to the bleed rule below it,
  which sends the weakest trump.
- Deliberately narrow, in three ways. A fat trump that nothing left can beat is
  still a press. A *lone* fat trump is still led, because pulling trump is worth
  more than the points it risks — that is the measured +0.019/seat/hand rule in
  the leading block and this change does not touch it. And the separate
  "which trump to lead" test one line down (`isPowerTrump || cardEquity <= 1`) is
  left exactly as measured.
- Needed no belief model and no inference: `cardEquity` already reported the card
  as beatable. This is the leading counterpart to the "protect your trump power"
  family `aiskilltest` covers when following.
- **Found twice, the second time mechanically.** Once from a recap screenshot,
  then again as hand 9 of the collected corpus — the first bug `minehands.mjs`
  turned up on its own, in the first 41 hands off beta, from a position where the
  human led K-D and the engine led A-D. The pinned assertion uses that real
  position, with a negative control that fails if it ever stops reproducing.
- Measured the way a rule this rare has to be, since it fires on 0.5% of hands
  and a whole-hand aggregate would call that noise: every firing finished twice
  from identical state, engine driving all five seats, 100,000 deals across 5
  seeds. **+5.34 picking-team points per firing, ahead in 5 of 5 seeds**, the
  schneider multiplier moving on 10% of firings (picker win rate 85.7% against
  84.3%). Re-measured on top of 0.37.0-0.38.2 rather than carried over from the
  first run: the belief layer changes how the hand plays out after the lead, so
  the older numbers (+5.66 per firing) no longer describe this engine.

## [0.38.2] - 2026-07-30
- **The grading cost test measured the machine, not the code.** It asserted a flat
  `gradeMs < 1000` under a label claiming grading "renders synchronously" — and that
  stopped being true when the solve moved into `grader.worker.js`, which documents it
  as a median of ~800ms and up to ~8s precisely *because* it is off the render path.
  The test was enforcing a contract the design had deliberately abandoned.
- It is now a RATIO against a reference solve on the same machine and the same hand,
  so machine speed divides out. What is left is the thing worth guarding: grading a
  whole hand must not become dramatically more expensive per solve than solving one
  position. Observed at roughly 50-70x, bounded at 150x, and the ratio is printed on
  every run so drift is visible long before the bound is reached. The reference is
  averaged over five runs because a single ~15ms solve is small enough for timer noise
  to show up in the quotient.
- **`CLAUDE.md`'s deploy section told you to fast-forward `beta` by hand.**
  `.github/workflows/release.yml` has done that automatically for some time, so
  following the doc was at best a no-op. Rewritten: if beta is behind, the question is
  never "did somebody forget to push" but "why did the Release job not run".
- The same section now records the failure mode that cost a deploy today. `Release` is
  gated on CI *succeeding*, so a marginal test can pass on a pull request, fail on
  `master` for the identical commit, and **silently withhold the deploy** — beta stays
  put and production is never content-verified. A flaky assertion in this repo is a
  deploy outage with extra steps.
- Also added there: a green commit status on `master` does not mean production shipped,
  because Vercel attributes the *beta* build to the same commit; and a stale local
  `master` can leave the working tree dozens of commits behind without complaining,
  which is worth a `git log --oneline -1` before believing anything you read.
- **The tuning conventions now describe both harnesses.** `scripts/coalitiontest.mjs`
  is required for any rule about co-operating with teammates, because a one-seat A/B
  structurally cannot see them. 0.38.0 is written up there as the worked example: the
  harnesses disagreed, and the answer was to build the one that asked the real question
  rather than to prefer whichever agreed. Two matching notes: one `simulate` run is not
  evidence at 3,000 unpaired hands, and any new piece of partnership evidence belongs
  in `partnerWeight`, calibrated by sweeping it in `belieftest` rather than chosen.

## [0.38.1] - 2026-07-30
- **Fixes a flaky assertion that turned master red and stranded beta.** The
  belief calibration test asserted a flat 2pp error bar on every bucket. The
  trump-lead read's confident bucket sits at 1.8-2.2pp, so the test passed on
  the pull request and failed on master for the identical commit — and because
  `Release` fires only on CI *succeeding*, beta was never fast-forwarded and
  production was never content-verified.
- The bar is now direction-aware, which is a design decision rather than a
  convenience. `TRUMP_LEAD_ODDS` is deliberately set below its best-calibrated
  value (40 against 64) so the read stays honest against off-book human
  opponents it was never calibrated on, and the price of that choice is exactly
  this: the read predicts 97% where the truth is 99%. **Under-confidence is the
  intended error**; over-confidence is the one that makes the play code act on a
  lie. So the conservative direction gets 5pp and the dangerous one keeps 2pp.
  Verified still strict enough to fail the 8.6pp that odds of 8 produce.
- Worth recording that the failure was NOT sampling noise, which was the first
  guess. With n=4178 in that bucket the standard error is about 0.27pp, so 2.2pp
  is roughly eight sigma — a real, small, deliberate miscalibration. The test was
  wrong about what it should be asserting, not unlucky.

## [0.38.0] - 2026-07-30
- **Defenders stop taking tricks off each other on a hunch.** The overtake brake
  — "taking a trick off our own side has to buy something" — was gated on the
  partnership being *certain*. Everywhere else a seat that could win simply won,
  so defenders routinely spent a card seizing a trick another defender already
  had. It now applies on a strong BELIEF too (`OVERTAKE_BELIEF_FLOOR`, 0.6).
  This is the largest AI gain measured in a long while.
- **It took a second harness to see it honestly, because the two disagreed.**
  `abtest` — the variant in one seat against four unchanged — said
  +0.0128/seat/hand, ahead in 8 of 8 seeds. An all-five-seats `simulate` run
  said the opposite, and matched the 0.6pp defensive LOSS this very branch's
  comment records from a 3x200,000-hand run as the reason the gate was there.
- That could not be settled by preferring a harness, so **`scripts/coalitiontest.mjs`**
  is new: identical deals to both arms, the variant applied to EVERY DEFENDER,
  scoring the defending side. A one-seat test can't see this class of change,
  because one defender can stand down while the other two still contest the
  trick — that seat banks the saving and somebody else pays for it. Paired,
  12,000 hands x 5 seeds, as a change in the picker's win rate on partnered
  hands:

      null control            0.00pp   defenders better in 0 of 5
      floor 0.0 (no belief)  -0.53pp   defenders better in 5 of 5
      floor 0.6              -0.74pp   defenders better in 5 of 5
      floor 0.66             -0.87pp   defenders better in 5 of 5

  Defenders gain, consistently. **The `simulate` reading was noise** — 3,000
  unpaired hands against roughly a point of standard error on the difference.
  Worth remembering the next time one `simulate` run seems to say something.
- The belief earns its place here in a way `abtest` could barely resolve
  (+0.0122 at floor 0.0 against +0.0128 at 0.3, inside each other's spread)
  but the coalition harness shows plainly: consulting it is worth about half
  again as much as the brake alone. Standing down for a seat that is really the
  picker's partner is exactly the mistake, and only the belief knows which
  "teammate" that is.
- `npm test` now runs `coalitiontest` with no variant and asserts the null
  control is **exactly** zero. A harness that cannot prove it is paired cannot
  make a fraction of a point readable.
- **The beta testers' broader rule was measured and did not ship.** They
  described it as "a non-picker leading TRUMP is almost certainly the partner",
  which is broader than the Queens-and-Jacks read 0.37.0 implemented. Over 6,000
  self-play hands, of every trick opened by a non-picker (base rate 25%):

      power trump (Q/J)   2908 leads   the partner 75.2%
      plain trump         1279 leads   the partner 60.4%
      fail               13538 leads   the partner 12.8%

  So they are right — a plain trump lead is real evidence, about 4.6:1. It is
  simply almost never *actionable*: swept at 2 / 3 / 5 / 8 it measures +0.0000
  to +0.0001, ahead in 0 to 1 of 5 seeds. The gate it feeds is the schmear,
  which only exists as a decision while the leader still HOLDS the trick — and a
  plain trump lead gets overtrumped nine times in ten (won its own trick 9.4% of
  the time, against 41.1% for a power trump). Left switchable and off.
- Also corrected: 0.37.0's note described the power-trump read as ~98% accurate.
  That was the accuracy of the belief's confident bucket, which combines the read
  with the deduction. The read alone is 75% — a 3x lift on the base rate, and
  still the strongest single inference in the file, but 98% overstated it.
- `teammateProbability` gained a `partnerWeight` tier for plain trump, and
  `trumpLeadKind` replaces `ledPowerTrump`. Repeat leads from one seat take the
  strongest signal rather than multiplying: it is the same seat with the same
  hand and the same plan, and multiplying would put a three-time leader past any
  odds this can be calibrated to.

## [0.37.0] - 2026-07-30
- **The AI now reads the partnership off how a seat has PLAYED**, not only off
  what the cards have proven. Reported from hand 1, which finished 120-0: a
  defender won trick 1 with Q-clubs and led Q-hearts into trick 2, and both
  remaining defenders read that seat as a teammate and schmeared an Ace onto it.
  22 points to the picker's partner on a single trick.
- Nothing there was deducible. Hearts had not been led, so three seats could
  still hold the called ace and no amount of deduction narrows that — the
  machinery added in 0.36.0 correctly declines to guess. What was available is
  inference: this engine's leading branch has the picker's team lead trump
  whenever it holds any, while defenders lead fail and reach for trump only
  holding nothing else, weakest-first. **A Queen or a Jack on lead is the
  picker's book.**
- `teammateProbability` is no longer uniform over the candidate seats. It
  reweights them by `partnerWeight`, and a seat that has opened a trick with a
  power trump carries `TRUMP_LEAD_ODDS`. In the reported hand that moves a
  defender's read of the trump-leader from "two-in-three my friend" to 0.048.
- **`TRUMP_LEAD_ODDS` was calibrated, not guessed.** `belieftest` buckets every
  judgement by what the belief predicted and checks it against ground truth, so
  the constant was swept until the buckets came out honest: at 8 the read was
  under-confident by 4.4pp and 8.1pp on the two buckets it moves, improving
  monotonically to 0.2pp / 0.5pp at 64. The finding behind that curve is the
  interesting part — **a seat that leads a Queen or a Jack is on the picker's
  team about 98% of the time.** Shipped at 40 rather than the flattest point,
  because the calibration is measured in self-play where every seat runs this
  file's book, and a human defender is off-book and will lead trump more often
  than an AI one.
- The belief is now spent, by a floor the schmear gate must clear
  (`BELIEF_FLOOR`, 0.5). **Worth +0.0018/seat/hand, ahead in 8 of 8 seeds** at
  20,000 hands per split. The control that makes that readable: the identical
  floor with the read turned OFF measures +0.0000, ahead in 0 of 5 — the
  mechanism earns nothing, the entire gain is the inference.
- **Two blunter fixes measured worse and did not ship**, and the reason is the
  same in both. Gating the schmear on the probability directly (`BELIEF_SCHMEAR`)
  is -0.0028, ahead in 1 of 5: with no evidence at all the best a defender can
  believe is 1 - 1/n, which never reaches `SCHMEAR_CONFIDENCE`, so it bans
  speculative schmearing outright and pays the 0.6pp the overtake branch already
  documents. Capping what may be spent by the card's points
  (`SPECULATIVE_SCHMEAR_MAX` at 4) is -0.0022, ahead in 0 of 5 — the card is the
  wrong axis, since it gives up the fat schmears that pay whenever the trick
  really is ours without ever asking which case this is. A floor that bites only
  where there is evidence is the version that works.
- `teammateProbability` now short-circuits on a revealed partnership rather than
  re-deriving it. Same answer in real play by construction, and it keeps the
  result anchored to the state's own account of who the partner is.
- Hand 1 is pinned in `scripts/aiskilltest.mjs`. The load-bearing control is not
  that the bug is fixed but that **speculative schmearing still happens**: a fail
  lead with no power trump played and the partnership unknown must still pay its
  King, which is precisely what the two rejected variants broke.

## [0.36.0] - 2026-07-30
- **A trick that cannot be lost is now priced as one.** Reported from hand 27:
  clubs called, clubs led for the first time, a defender's partner winning it
  with the 9 of diamonds — and the two seats left to play were the picker and
  the partner, both forced to follow clubs, neither able to beat a trump with
  one. The trick was unloseable. `trickSecurity` rated it 0.05.
- The consequence was a card, not a number. Reading the trick as 95% lost, the
  defender skipped the schmear branch entirely and fell through to "if you can
  win it, win it", spending the Jack of hearts to overtake his own side. The
  right card was the King of hearts: four points onto a trick the defense
  already owned, keeping both trump, and the King was his deadest card anyway —
  eleven unseen cards beat it and it takes no later trick.
- `trickSecurity` counts unseen cards that outrank what is down, with no notion
  that a seat yet to act may be pinned to a suit. It now asks first. Two rules
  do the pinning, both live only on the FIRST lead of the called suit: the
  partner must play the called card, and the picker must still be *holding* a
  called-suit card, because `legalPlays` forbids discarding the last one until
  the suit has been led. Both are rules, not reads — no belief model involved.
- Forced is not the same as harmless, and the rule prices both directions: a
  seat pinned to a card that TAKES the trick sends security to zero rather than
  one. That sign error is the one this could most easily have made.
- Worth **+0.0021/seat/hand, ahead in 8 of 8 seeds** at 20,000 hands per split
  (`scripts/abtest.mjs`), with the harness null-testing to exactly +0.0000 on
  the same run. Aggregate self-play moves the way you would expect for a fix
  that helps the defense: picker win rate 68.5% → 66.9%.
- **The other half of the diagnosis measured as a loss and did not ship.** The
  same hand showed the engine ignoring a deduction it had already made: with the
  leader having played a low club instead of the ace, and the next seat trumping
  in and therefore void, only one seat could still hold the called ace.
  `calledCardCandidates` knew this; the play code asked `partnerRevealed`
  instead. Wiring the deduction in (`provenSide`, `knownPartner`, both new and
  both correct — `belieftest` holds them to ground truth) measures at
  **-0.0049/seat/hand, ahead in 0 of 5 seeds**, and either half of it alone
  costs -0.0006.
- That result is worth more than the change would have been. The engine's
  defense is tuned around `knowsTeammate`'s optimistic default, where an
  unrevealed seat is a friend; being *right* about who the opponent is makes a
  defender count more opponents, price tricks lower, and schmear less. Better
  information, played by a policy calibrated for worse information, loses. It is
  left switchable and off (`DEDUCE_PARTNER`, with `deduceOpponents` /
  `deduceOwner` sub-flags) with the numbers recorded at the flag, because acting
  on it wants the schmear and overtake thresholds re-tuned around it — a bigger
  change than the hand that prompted this one. `knownPartner` ships regardless:
  the forcing rule above depends on it.
- Hand 27 is pinned in `scripts/aiskilltest.mjs` with four negative controls —
  the deduction must not fire a trick early, forcing must not fire when the
  called suit was not led, a forced seat that can still win must not read as
  safe, and the old engine must still be shown making the reported mistake.

## [0.35.0] - 2026-07-29
- **You can now remove a teammate who walked away from their computer.** You
  could not before, and the reason was that an open tab counted as a person.
  The presence poll fires every 20s for as long as the tab is mounted — a phone
  asleep in a pocket, a laptop lid shut on a browser that keeps its timers — and
  the idle threshold for freeing a seat is 90s, so the clock was reset four
  times over before it could ever expire. The seat modal sat on "you can free
  this seat once they've been away for a while" forever, and the idle counter
  visibly ran *backwards*.
- **The same clock is what the AI uses to cover a seat the table is waiting on**
  (`coverIdleSeats`), so this was never only about booting: a table stalled on
  somebody who had gone could not un-stick itself either, for exactly as long as
  their tab stayed open. That matters more than the boot button does.
- The poll now says whether it speaks for a person or is merely a keep-alive.
  The test is a real interaction — pointer, key, touch, wheel — within
  `ACTIVITY_WINDOW_MS` (2 minutes). Coming back, by any input or by the page
  becoming visible again, pings immediately rather than up to 20s late, because
  the seat may be seconds from being covered.
- **`document.visibilityState` is deliberately not part of that test**, though it
  looks like the obvious signal for a phone going to sleep. A page can report
  `hidden` while somebody is sitting in front of it — embedded webviews do, and
  it was measured while building this: a fronted tab in the tool browser reports
  `hidden` with the game plainly on screen. Vetoing presence on that would hand
  an attentive player's seat to the AI mid-hand. Visibility is therefore only
  ever used to *add* presence, never to withdraw it, and nothing is lost by that:
  a tab nobody can see receives no input either.
- The window is deliberately generous, several times longer than a turn. Reading
  the hand-end summary can take a minute with no input at all, and the expensive
  mistake is declaring an attentive player absent: their seat gets played by the
  AI or handed to somebody else. Being slow to release a seat only costs
  patience. A locked phone releases it sooner anyway, on the visibility signal.
- A poll that sends no flag still stamps presence, so an older cached bundle
  behaves exactly as it used to rather than having its seat quietly reclaimed.

## [0.34.0] - 2026-07-29
- **Nobody waits on the host between hands any more.** Dealing was host-only,
  which made one person the table's clock and, worse, its single point of
  failure: `hostPlayerId` is set once when the table is created and never
  reassigned, and the auto-cover that rescues an absent player cannot help here
  — it only covers the seat that is *owed a decision*, and at a finished hand
  nobody is owed one. A host whose phone died at the recap left everyone else
  looking at a summary with no way forward and no way to recover. Any seated
  player can now deal; the Host badge stays, but it is a label rather than an
  office.
- **Closing the hand-end summary is what deals the next hand.** The gold button
  reads "Close" instead of "Deal next hand", and the first person to finish
  reading moves the table on. Everyone else keeps their summary — and their
  recap — for as long as they want it, and lands in the hand already under way
  when they close. The table no longer runs at the pace of its slowest reader,
  and nobody has to ask anyone to press anything.
- The summary and recap now render from a snapshot of the finished hand taken
  when it ended, not from live table state. Without that they were torn off the
  screen by somebody else's click the moment the deal landed — which, with the
  change above, is the ordinary case rather than a rare one. The snapshot keeps
  the seat names of the hand it belongs to as well, so a player seated by that
  very deal (MP-2.3) cannot relabel a recap of a hand they were never in.
- Two people closing on the same beat is now routine, so it is covered rather
  than assumed: the second deal of a hand is refused by the compare-and-swap,
  and the client says nothing about it, because there is nothing to say — the
  hand it was asking for is already on the felt.
- Multiplayer only. The solo game keeps its "Deal next hand" button, and the
  flag-off production bundle is unchanged.

## [0.33.2] - 2026-07-29
- **The picker's under card no longer leaks through the AI log.** `advanceAI`
  recorded the *physical* card each AI seat played. For every card but one that
  is the same thing the table shows — the exception is the under card, which
  lands as the 6 of the called suit with its real face hidden. The log ships to
  every client with the rest of the table state and `viewFor` does not redact
  it, so the moment an AI picker played her under card its true face went out to
  the whole table. That is the one thing the under rule exists to hide, and it
  has been live in multiplayer since the log was introduced.
  - Fixed by logging the face the table shows. Nothing is lost: the log exists
    so a client can replay a burst of AI plays at human speed, and what it draws
    is what is on the table. The real card still travels on the trick as
    `actual`, which `viewFor` releases only to the picker, to whoever won that
    trick, and to everyone once the hand ends.
- **The "flaky" `e2etest` was this bug, not a flaky test.** It failed about 4% of
  runs — 5 in 120 on v0.33.1 — with `leaked card 8C at table.aiLog[1].card`, and
  the randomness was only ever `makeDeck`'s: whether a deal produces an under
  call is up to `Math.random()`, so the leak fired on every under hand and no
  other. 0 failures in 200 runs with the fix. **Worth remembering: an
  intermittent failure in this repo's leak harnesses means the under card until
  proven otherwise** — that is now twice, and the first time it was the *test*
  that got adjusted rather than the code.
- The regression test is constructed rather than dealt, so it runs on every
  invocation instead of one in twenty-five: hearts called under with Q♣
  designated and hearts led, leaving the under card as the AI picker's only
  legal play. Three assertions in `aitest` that fail against v0.33.1. Two places
  in that harness that had been taught to expect the discrepancy — a `faceOf`
  helper and an `.actual` fallback in the randomized sweep — are gone with it, so
  the sweep now enforces the invariant rather than excusing it.

## [0.33.1] - 2026-07-29
- **Vercel Speed Insights is now collecting.** The package had been installed
  but never mounted, so the dashboard had nothing to show. `<SpeedInsights />`
  now sits at the root next to `<Analytics />`, where a page load is measured
  once whichever screen someone lands on. Nothing about the game changes; the
  component renders nothing.
- **Table codes stay out of the vitals too.** The route is passed explicitly
  rather than detected, because automatic detection is a framework integration
  and this app routes with pushState and no router — left alone, every table
  would arrive as its own unique path, which puts a live credential in a third
  party's logs and splits one page across thousands of one-visit rows. Both
  `/t/<code>` paths collapse to `/t/[code]`, the same redaction analytics has
  always done, now shared by the two of them.

## [0.33.0] - 2026-07-29
- **Accidental alone hands are gone — 0.45% of picks to zero.** v0.32.0 stopped
  the bury from throwing away the only callable suit, but left a residue, and
  the residue turned out to be a bug in its own exemption rather than a gap in
  its reach. It asked "is this hand strong enough to go alone on purpose?" of
  all eight cards, on the reasoning that the bury only ever discards fail cards
  so the answer would not move. That is false for exactly the hands it mattered
  to: a picker holding a single fail card must spend a trump to keep a call, so
  the six that remain read two below the eight. `9D KD 7D AD JS QH 8D 10S` reads
  17 — precisely the bar — buries the 10♠ for its points under an exemption it
  has not earned, and plays alone on a hand of 15. Now the bury runs greedily
  first and the exemption is judged on the six cards left over, which costs one
  more pass and cannot be wrong about it. That hand buries 7♦ 8♦ and calls
  spades.
- **A partner is worth any diamond, not only a low one.** The other half of the
  residue. Points buried are points *banked* — they still score for the picking
  team — so what a diamond costs when it is spent buying a partner is its rank
  and nothing else, which is why the choice sorts by power rather than by
  points. The cap of "below the King" is gone; the weakest diamond in the hand
  goes, whatever it is. A Queen or a Jack still never does, because those cost
  a trick rather than a rank.
- Measured the same way as v0.32.0 — every firing position finished twice from
  an identical deal, the same engine driving all five seats. Over 3 seeds x
  40,000 deals the picker is **+2.6 stake points per firing**, winning 79% of
  those hands with a partner against 58% alone; ahead in every seed. Smaller
  than v0.32.0's +4.2 and it should be, since these are the hands that sat near
  the alone bar in the first place. Across 74,000 picks the picker now goes
  alone on 19.8% of them, all of it deliberate.
- Both pinned in `aitest` from the hands that exposed them, with negative
  controls that fail against v0.32.0.

## [0.32.0] - 2026-07-29
- **The picker no longer sends a Queen or a Jack under.** Reported from hand 16:
  holding Q♦ Q♠ Q♣ 10♦ A♦ K♥, the picker designated the queen of diamonds as her
  under card — the strongest card left in the hand, spent on a card that by rule
  cannot win a trick, to avoid giving up the four points on the King. The old
  rule scored points ten times heavier than everything else, which reads sensible
  and is wrong exactly at the cards that matter: a Queen is three points, so the
  boss trump kept coming out as the hand's cheapest card. Power is what an under
  card destroys, not points. Now three tiers — fail, then plain trump, then Q/J
  last of all — with points deciding only inside a tier. Changes the designation
  on 17% of under calls; 5.6% of them were a Queen or a Jack.
- **The bury no longer goes alone by accident.** Reported from hand 19: the
  picker was dealt one spade, the ten, and spades was her only callable suit
  (hearts was out — she held its ace). The bury liked the ten points, buried it,
  and left her with nobody to name; she played alone against four on a hand
  whose strength is 12 against an alone bar of 17, and took 39. Ten points
  doubled beat the eight-point penalty for killing the call, as it always would.
  Whether to go alone belongs to the call step, which has a bar for it, so
  keeping a call alive is now a constraint on the bury rather than a term in its
  score: if any candidate preserves one, no candidate that destroys one is
  considered. A hand already strong enough to go alone on purpose is exempt and
  still buries for points. Fires on 1.1% of picks, giving up an average of 9.5
  buried points to keep the partner.
- **A partner is also worth a spare trump.** The larger half of the same bug: a
  picker dealt only two fail cards in its eight buried both, because the bury
  pool never looked at trump while any fail card remained — 4.4% of picks, every
  one an alone hand nobody chose. It now spends the cheapest trump in the deck
  instead, a diamond below the King: no points, and beaten by every other trump.
  Not a Queen, a Jack, or a high diamond, so a hand holding no spare diamond
  still plays alone. Between the two changes the picker goes alone on 20.1% of
  picks rather than 25.6%, and what remains is almost all deliberate — hands at
  or above the alone bar — with the accidental share down from 5.9% of picks to
  0.46%.
- Measured the way a narrow rule has to be: every firing position finished twice
  from an identical deal with the same engine driving all five seats, comparing
  only those hands. Over 3 seeds x 40,000 deals the picker is **+4.2 stake
  points per firing** for the spare-diamond bury and **+4.7** for the fail-card
  one, winning ~69% of those hands with a partner against ~40% alone —
  consistent in every seed. The whole-hand aggregate cannot see either, so it
  was not used.
- All three are pinned as constructed assertions from the reported hands, each
  with a negative control that fails against the previous engine — `undertest`
  for the designation, `aitest` for the bury.

## [0.31.0] - 2026-07-29
- **Solo hands now upload themselves; no console command.** `recordHand`
  already captured every finished hand — what was manual was getting it off the
  device, which matters because solo is played on a phone where nothing can
  reach localStorage. The client now POSTs unsent hands in batches of 5 as you
  play, and `scripts/minehands.mjs` reads the corpus back.
  - Uploads continuously rather than waiting for a round 100: a cleared browser
    would otherwise lose the lot. 100 is when there is enough to analyse, not
    when to start keeping it.
  - Failure is silent and non-destructive. Unsent hands stay unsent and go out
    after the next hand, so playing on a train loses nothing. A 503 or 404 is
    treated as a permanent no and stops further attempts, so a browser on
    production doesn't queue forever.
- **`POST /api/hands`** stores a played hand; **`GET /api/hands`** reads them
  back and requires `HANDS_READ_TOKEN`, refusing with 404 when that is unset so
  a missing config closes the door rather than opening it.
  - Gated by `requireMultiplayer`, deliberately not by a second mechanism of
    its own. That gate's second condition is already "a real store is
    configured", which is exactly what collection needs — and one gate enforced
    by one test (`flagtest` walks `api/` and requires the call) beats two
    mechanisms a reader has to know about. Practically this means **beta, not
    production**, since Upstash is scoped to Preview and Development.
  - The stored record is **rebuilt field by field, never spread**, so nothing a
    client sends outside the known list can reach storage even by accident.
    `handstest` asserts exactly that with a payload carrying a name and an
    email, neither of which survives.
- **What is collected, and the notice for it.** The cards dealt and played,
  which seat was human, the app version, and a random per-browser install id —
  minted for this and deliberately *not* the multiplayer `playerId`, which is
  joined to a name. No name, no account, nothing identifying. Since the site is
  public and this collects from everyone, there is a menu entry, "Helping the
  AI improve", stating the list and offering a one-tap opt-out that takes
  effect immediately.
- `handstest` joins `npm test` (19 harnesses), covering the refusals rather
  than the happy path: malformed tricks, out-of-range seats, oversized batches,
  wrong method, an unset read token, and a store-less environment.

## [0.30.0] - 2026-07-29
- **Fixed the schneider threshold for defenders — closes #52.** Schneider is
  half of what a side needs to win, and the two sides do not need the same
  thing: the picker's team needs 61 and the defenders 60, because a 60-60 tie
  goes to the defenders. Halving each gives 31 for the picker and 30 for the
  defenders, so every defender threshold sits one point below the picker's,
  exactly as 60 sits below 61.
  - The code tested `<= 30` on both sides, and the comment above it asserted
    the symmetry as though it were the rule — so the comment was wrong in the
    same way the code was, which is why it had survived. Defenders finishing on
    exactly 30 were scored as schneidered when they were not.
  - **Measured, paired.** The change is scoring-only, so the same played hand
    can be scored under both rules with no run-to-run noise at all: over 28,828
    played hands it changes **1.09%** of them, and the picker's EV goes from
    0.7312 to 0.7019 a hand — the picker had been collecting **844 unearned
    points** across that sample, every one of them from an undeserved 2x.
  - `handStrength >= 10` still needs no retuning: the move is small, and it is
    in the direction of making picking very slightly less attractive, which is
    the correct direction for a rule that was over-paying the picker.
  - Both sides of both boundaries are now pinned in `scoringtest` — defenders
    on 29/30/31 and the picker on 29/30/31 — plus the no-tricker cases, since
    an off-by-one is invisible anywhere except at the boundary. An unseeded
    `simulate` comparison is NOT sufficient here and was misleading when tried:
    two runs disagreed on "went alone" by 0.8pp, which this fix cannot affect.

## [0.29.0] - 2026-07-28
- **Solo now keeps a local record of finished hands, so human play can be
  compared against the engine's.** Two deliberate constraints: nothing leaves
  the browser — the log lives in localStorage and only moves when exported by
  hand — and it stores the *hand*, not the analysis. Grading takes ~800ms and
  the grader keeps improving, so re-deriving costs offline beats freezing
  today's verdict into the record. `trickHistory` already contains every card
  every seat played, which is enough to rebuild all five starting hands, so a
  record is ~1.1KB and 300 of them sit comfortably inside localStorage.
  - No UI for it on purpose. It is a tool for whoever is tuning the AI, not a
    feature, and a menu entry would have to be designed and maintained. Two
    documented globals do the same job: `noschnitzExportHands()` downloads the
    log, `noschnitzClearHands()` empties it.
- **`gradeAllPlays` exposes what `gradeHandPlays` was already computing and
  throwing away** — an exact double-dummy cost for every decision in the hand,
  plus the cost of every *legal* card at each one, rather than only the best
  and worst play the recap shows. It also reports whether the hand graded at
  all, which the recap can ignore and an analysis cannot: counting a hand that
  blew the node budget as a clean one biases every average toward zero.
- **`scripts/minehands.mjs`** reads an exported log and ranks the position
  shapes where the human's card cost less than the card the engine would have
  played. Both AI fixes shipped today were found this way by hand, from
  screenshots; this does the same reading mechanically.
  - The metric is a **signed cost difference**, not "who found the best card".
    The script's own self-test caught that: a seat playing a random legal card
    25% of the time still *wins* individual disagreements by luck — 3 of 28 in
    the control run — and a win count scores it as an improvement. On signed
    cost the same seat is -69 points, which is the answer. `--selftest` exists
    to keep that honest and is the reason the first metric did not ship.
  - Deliberately not in `npm test`: it grades whole hands, so a meaningful run
    is tens of seconds. Run `node scripts/minehands.mjs --selftest` after
    touching it.
  - A cluster it surfaces is a hypothesis, not a fix. Double-dummy cost is
    biased against play that is correct under uncertainty, so the comparison is
    only survivable because the human and the engine are judged on the same
    hands with the same bias.

## [0.28.0] - 2026-07-28
- **The recap grades every trick, including the first two.** `GRADE_FROM_TRICK`
  moved from 2 to 0. Two separately reported mistakes this week — a picker
  burning boss trump on trick 1, and the same shape on trick 2 — sat in the
  ungraded window, so the recap could not see either of the plays an expert
  was pointing at. The legend now reads "every trick graded" rather than
  "graded from trick 3 on".
- **The threshold could not move on its own; the search had to come off the
  main thread first.** Re-measured over 40 AI-played hands on the current
  solver: grading from trick 3 is a median of 8ms (p90 20ms), from trick 2 a
  median of 100ms (p90 259ms), and from trick 1 a median of **795ms with a p90
  of 3.9s and a worst case of 6.8s**. The old note here recorded 4.2s/14.4s for
  trick 1 — the `handMask` transposition key is most of the ~5x since — but it
  is still nowhere near a render budget, and both call sites were `useMemo`
  running inside a render.
  - `grader.worker.js` now owns the solve and `useHandGrade` delivers it
    asynchronously. Both screens render the recap immediately and fill the
    verdict in. The worker is deliberately thin — every decision worth testing
    stays in `gradeHandPlays`, which the harnesses call directly.
  - The recap distinguishes "still working" from "nothing worth flagging",
    which would otherwise both render as a blank legend. While the solve is out
    it says *grading the hand…*.
  - If a worker cannot be constructed the recap simply shows no verdict.
    Falling back to grading on this thread would reintroduce exactly the freeze
    this avoids, and quietly grading from a later trick would answer a
    different question than the legend claims.
- `DD_NODE_BUDGET` 500k -> 50M. It is a backstop against pathology now, not a
  latency guard — latency is the worker's problem. Sized by measurement:
  grading from trick 1 over 40 hands leaves 20 ungraded at 2M nodes and 3 at
  10M, and none at 40M.
- Verified in a real browser, not just in the harness: the module worker
  constructs, round-trips a finished hand in ~1s, and the recap renders a
  trick-1 verdict with the `!` marker on it.

## [0.27.0] - 2026-07-28
- **The trick sweep now converges on a single point instead of moving all
  five cards by the same offset.** Previously every card shifted by the
  winner's fixed direction vector, which reads as "parallel," not
  "gathering" — five cards starting at five different spots and moving the
  same distance in the same direction land at five different places. Each
  card's `--sweep-dx`/`--sweep-dy` is now that card's own position subtracted
  from one shared target, computed from the felt's actually measured pixel
  size (`felt.jsx`'s new `useElementSize`) rather than the fixed approximate
  offsets `SEAT_DIR` still uses for the entrance animation.
  - The target is the point on the winner's avatar circle nearest the middle
    of the felt, so cards visibly stop at the avatar's edge instead of
    flying into it. The viewer's own seat has no avatar (drawn as the hand
    below in both solo and at a table), so it aims at the bottom-center of
    the felt instead.
  - Verified with a plain Node script reproducing the same math for every
    winner seat and every card-origin seat: all land at the identical target
    point in every case. Getting a live browser to hold still long enough to
    screenshot the 450ms sweep remains unreliable in this environment (timer
    throttling on a backgrounded tab), so the geometry was proven
    computationally rather than by chasing the animation frame — the same
    keyframe mechanism already confirmed working in v0.23.0/v0.25.0 is
    unchanged, only the dx/dy values it's given are now exact.

## [0.26.0] - 2026-07-28
- **The picker no longer burns her boss trump on a thin trick she may already
  own.** Reported from real play: trick 1, the partner led Q-spades, the picker
  sat last holding Q-clubs, J-diamonds and the 7 of diamonds, and took the
  trick with Q-clubs. That spends the one card guaranteed to win a trick later
  — nothing outstanding beats it — to gain three points on the thinnest trick
  of the hand, on a trick her own partner already held.
  - The engine got there because `knowsTeammate` returns **false for every
    seat** while the picker has not seen the called ace ("picker unsure of
    partner"). So the position reads to her exactly like an opponent's trick,
    the teammate branch is skipped entirely, and she falls through to "play the
    cheapest winner" — which here was the boss.
  - `freeDuckForPicker` now intercepts that fall-through under conditions that
    are all decidable from the cards: she is the picker with the partnership
    still unknown, she is **last to act** so the pot is final, a **trump** is
    winning it (a fail-winning trick is worth capturing), the pot is at or
    under `DUCK_MAX_TRICK_POINTS` (12), her cheapest winner is **boss**
    (`cardEquity === 0`), and a **zero-point** legal card exists to throw
    instead. She throws the weakest of those.
  - The point is that the duck is free. The trick's existing points are at risk
    either way; a zero-point card donates nothing on top. That is why this
    needs no read on who the partner is and does not wait for the belief model.
- Measurement, and note the whole-hand aggregate is the wrong instrument here.
  The rule fires on **0.6% of picker-last decisions**, so `abtest` over 9,000
  hands x 3 seeds cannot resolve it — it read +0.0008/seat/hand *against* the
  rule, which is the same order as the largest effect the rule could possibly
  have. Measured instead on the decisions it actually changes — finishing each
  firing position twice from identical state, 139 firings from 24,000 hands —
  ducking is worth **+2.2 picking-team points per firing**, positive in 3 of 3
  seeds, and picker win rate on those positions is **93.5% vs 84.2%**.
  - The asymmetry is the whole argument: **+18 points when the trick really was
    the partner's, -4 when it was not**, and it is the partner's **28%** of the
    time. That implies a break-even of 18%, which independently matches the
    ~13-16% obtained by sampling deals consistent with what the picker knows on
    the reported hand. Chance alone puts it at 25% with four unknown seats, so
    the old play was wrong even with no read at all.
- Deliberately **not** extended to the case reported alongside it, where the
  picker held Q-clubs, Q-hearts and the Ace of diamonds and had no zero-point
  card. Ducking there costs 3 or 11 points on a guess and the break-even
  measured **85%**, not 13% — that one wants the belief layer, and the engine
  still takes the trick. Both halves are pinned in `aiskilltest`, with the
  negative control asserting the position still tempts the old behaviour when
  the rule is switched off via `duckMaxTrickPoints`.

## [0.25.0] - 2026-07-28
- **Solo's opponent roster now rotates.** Picked once per session from an
  8-name pool instead of the same fixed four every game, so an AI blunder
  doesn't get pinned on the same name forever. Beyond the original Gus/Bunny/
  Patty: Bernie (Brewer, the mascot), Miller, Fonzie (Happy Days, set in
  Milwaukee), and Kopp's/Leon's, the city's two rival frozen-custard spots.
  Multiplayer is untouched — `table.js`'s `AI_NAMES` stays fixed per seat
  position, since a seat's name should only change when its occupant does.
- **A human's seat now tints differently from the house AI's**, a subtle red
  vs. the usual green avatar fill. Solo never actually shows it — the viewer's
  own seat renders as the hand below, not an avatar, in solo or at a table —
  but at a table, another real player's seat now reads apart from an AI-filled
  one at a glance.
- **The hand recap now colors by trump, not just red/black.** Every Queen,
  Jack, and diamond — trump, regardless of suit — reads gold, the same fact
  that actually decided the hand. Fail cards keep their own color: hearts red,
  clubs a new blue, spades white. Diamonds never show their own fail color
  since they're always trump. Scoped to the recap grid only; the rules-
  reference trump list elsewhere still uses red/cream, where every card shown
  is already trump and gold would flatten the one distinction that display is
  for.

## [0.24.0] - 2026-07-28
- The exact endgame solver no longer breaks ties by sort order. From trick 5
  on, `aiChooseCard` hands the decision to `solveEndgameCard`, which solves
  double-dummy — it reads every seat's hand. That is fine while one card is
  strictly best and wrong the moment several tie, because "tied if you could
  see the cards" says nothing about which card to play when you can't. The old
  code took `legal[0]`, i.e. sorted-hand order, which puts trump first.
  `solveEndgameCard` now collects every double-dummy-optimal card and, when
  there is more than one, asks the heuristics to choose among them. Search
  decides what wins; judgement decides between things that tie.
  - Reported from expert play (hand 7, v0.22.0). A defender holding Q-hearts
    and 9-hearts, with his own partner already winning the trick and only a
    fellow defender left to act, played the Queen. Double-dummy the two cards
    are identical — that hand finishes 70-50 either way — so the solver took
    the first. Enumerating the 144 deals of the seven cards that seat could
    not place says otherwise: 9-hearts wins the hand in 144 of 144, Q-hearts
    in 59. It spent boss trump and gave up guaranteed control of the last
    trick, and only got away with it because one specific unseen card sat in
    the right hand.
  - The AI already knew better. `cardEquity` had Q-hearts at 0 — boss of
    everything unaccounted for — and the heuristic path plays the 9. The
    short-circuit was discarding that reasoning in exchange for clairvoyance.
  - Ties are not rare: over 4,000 hands, 69% of endgame decisions have more
    than one double-dummy-optimal card, and the old tie-break disagreed with
    the heuristics on 32% of decisions. 182 of those 4,000 hands showed this
    hand's exact signature — spending boss trump when a cheaper tied card was
    equally optimal.
  - `heuristicCard` is split out of `aiChooseCard` so the solver can reach the
    heuristics without recursing through the short-circuit, and takes an
    `opts.restrictTo` used only by the tie-break.
- Measurement note, because the obvious harness says nothing here. A paired
  duplicate-deal A/B over 11,538 hands shows **zero** difference, and that is
  structural rather than reassuring: in self-play every seat runs the same
  clairvoyant endgame solver, so the double-dummy value is always realised and
  cards that tie double-dummy cannot produce different results. The tie-break
  only pays against someone who can't see the cards. Scored the way the
  reported hand was — sampling deals consistent with the acting seat's own
  information — the new card wins 43.1% vs the old card's 41.2% averaged over
  four seeds (+1.3 to +2.0pp per changed decision, ahead in 4 of 4, strictly
  better in ~2 positions for every 1 it is worse). Do not reach for
  `simulate`/`abtest` to validate endgame changes; they are blind to this
  whole class by construction.
- Pinned in `aiskilltest` as the reported position, with the negative control
  asserting the double-dummy tie is real and that legal order puts the Queen
  first — so the case cannot quietly become vacuous if the solver changes.

## [0.23.0] - 2026-07-28
- A played card now arrives from its own seat and fades in (220ms) instead of
  appearing already in place on the felt — the same idea as the existing
  hand-deal animation, a `play-in` keyframe parameterized per-card by
  `--play-dx`/`--play-dy` instead of a flat offset, since a trick can arrive
  from any of the four opponents' seats or the viewer's own hand.
- A finished trick now stands for 900ms — long enough to read the "+points"
  banner — then all five cards sweep toward the winner's seat: fading and
  shrinking via a `sweep-out` keyframe over 450ms. 900+450 stays comfortably
  under both callers' hold windows (1500ms at a table, 2625ms solo), so the
  sweep always finishes before the trick array is cleared.
  - First cut used a JS-toggled inline `transition` rather than a keyframe.
    Not visibly wrong in review, but harder to be sure it always fires than a
    keyframe animation, which just plays once assigned regardless of prior
    style state — same mechanism `play-in` already uses. Switched after a
    report of the sweep not being visible; confirmed via `getAnimations()`
    that the keyframe attaches and runs correctly for the entrance case, and
    the sweep now shares that exact wiring.
  - Both live in `Felt`, shared by solo and the table, so neither caller
    needed a change.
- `prefers-reduced-motion` is respected for both: the entrance and the sweep
  fall back to a plain opacity fade with no movement, matching `deal-in`'s
  existing behavior.

## [0.21.0] - 2026-07-28 (`abb0449`)
- **The recap's best/worst play grading is now exact, and no longer invents
  mistakes.** Grading previously rolled the hand forward with `aiChooseCard`
  driving all five seats and compared the totals, which measures the wrong
  thing: the continuation is only as good as the AI, so any weakness in the
  AI's later play was charged to whoever happened to be moving.
  - **Reported from a real hand** (v0.18.0, hand 1): a defender's J-diamonds was
    flagged as the worst play of the hand, costing 14 points against ducking. It
    cost nothing. With every hand face up, all four of that seat's legal cards —
    and every card at every one of the defenders' eleven decisions in the hand —
    end 120-0. The 14 points were the AI misplaying the *picker's* side after
    the duck. (The picker did have two live decisions in that hand, worth 24 and
    17 points, and got both right, so the hand was cold for the defence
    specifically rather than for everybody.)
  - Grading now solves the position double-dummy. Two properties matter more
    than the precision: a play can never be flagged as a mistake unless a better
    one genuinely existed, and when every legal card leads to the same result
    the hand is reported as having no best or worst play instead of an arbitrary
    one. About 8% of hands now come back with no grade at all, which is the
    correct answer for them.
  - **Grading is limited to trick 3 onward**, and this is a real limitation
    rather than a tuning knob. Exact solve cost falls off a cliff with the
    number of cards still out: measured over 38 AI-played hands, grading from
    trick 1 costs a median of 4.2s and a p90 of 14.4s (exceeding any sane node
    budget on ~10% of hands), from trick 2 a median of 345ms and p90 1.2s, and
    from trick 3 a median of 34ms and p90 88ms. Both call sites run inside a
    render, so seconds are not available. A blunder in the first two tricks is
    not graded; grading the whole hand needs the search off the main thread.
    Measured end to end, the recap now grades in a median of 24ms, p90 97ms.
  - The recap legend no longer advertises markers that aren't present: it shows
    only the ones actually used, and states that grading starts at trick 3.
  - Adds `npm run gradetest`. Its main assertion is that the solver agrees
    *exactly* with a plain unpruned, unmemoised minimax over ~1,400 positions,
    including through a transposition table shared across the whole run. The
    solver uses alpha-beta with a shared table, and the classic way to get that
    wrong is to file a bound returned from a narrowed window as an exact value —
    a bug that does not crash and returns plausible numbers, so a reference
    implementation is the only way to catch it. The table stores bound flags for
    exactly this reason.
  - `rolloutValue` is gone; the grader was its only caller.

## [0.20.0] - 2026-07-28 (`eafab0b`)
- **The picker's side now leads trump whenever it holds any**, instead of only
  with three or more. Worth **+0.019/seat/hand, ahead in 5 of 5 seeds**
  (20,000 hands per split, z 8.5-11.9), measured with `npm run abtest`.
  - The old bar was `trumps.length >= 3` — "real depth" — and depth was the
    wrong quantity. Pulling trump works because the defenders must *follow* it:
    even a trump that cannot win the trick still strips two trump from the
    defense and shortens the suit protecting their fail points. Three low
    diamonds bleed as well as three Queens; they simply don't win while doing
    it. The conventional wisdom — partner leads trump — turns out to hold
    further down into weak holdings than the engine believed.
  - **Every attempt to tighten the gate measured worse, monotonically.**
    Requiring 4+ trump costs 0.019/seat/hand; deleting the rule outright costs
    0.035; gating on the top trump's `cardEquity` costs between 0.008 and 0.034
    depending on threshold. This was originally investigated on the *suspicion*
    that the gate was too loose — that a hand of 9-8-7 of diamonds would lead
    into eleven higher trumps. It does, and it should.
  - **Which trump to lead is a separate question from whether to lead one.**
    Lead the top trump when it can plausibly hold the trick (a Queen or Jack, or
    at most one unaccounted-for card beats it); otherwise the lead is purely a
    bleed and shouldn't also donate points, so the weakest goes instead. Worth
    +0.019 against +0.012 for always leading the top trump and +0.007 for
    always leading the weakest.
  - **Side effect, measured and kept:** the picker's "call for the ace" lead is
    now reachable only with a hand of pure fail. A version that kept it
    available while holding trump measured worse on every seed
    (+0.013/+0.017/+0.015 against +0.016/+0.020/+0.019).
  - Note this branch is picker-side only, so it widens the AI's picker/defender
    asymmetry: in self-play the picker win rate moves 63.4% -> 65.4% and average
    picker-team points 70.6 -> 72.0. Defending against the AI is now harder.

## [0.19.0] - 2026-07-28 (`3bcb4a3`)
- **The AI now always takes a trick with the cheapest card that wins it.** The
  "secure with strength" rule — reach for the strongest winner when the trick is
  fat (10+ points) or late (trick 4+) — is deleted outright rather than refined.
  Worth **+0.089/seat/hand, ahead in 5 of 5 seeds** (20,000 hands per split,
  z ~ 19). For scale, 0.18.0 was +0.013 on the identical harness, so this is
  roughly seven times that gain and the largest single play change to date.
  - The premise of the old rule was wrong. A trick won by one rank scores
    exactly what a trick won by eight scores, and the surplus rank is a later
    trick you no longer win. There is essentially nothing for "reach for
    strength" to buy, so no amount of tuning around it could pay.
  - 0.18.0 softened the same rule with a sufficiency filter instead of removing
    it, which is why it measured as a real but small win at the time. It was
    mitigating a bad heuristic, not fixing one.
  - **Reported from a real hand** (v0.18.0, hand 1): with a fail club led, the
    picker held Q-clubs Q-hearts J-spades J-hearts and took a 13-point trick
    with Q-hearts where J-hearts took the identical 13. The sufficiency filter
    could not certify the Jack, because `trickSecurity` counts beaters the one
    seat left to act could not legally play — that seat was following a fail
    suit and could not trump in — so the code fell through to strength and
    burned a Queen for nothing.
  - **A plausible-sounding fix measured worse and was discarded.** Making the
    sufficiency test legality-aware by pricing the security gain the way the
    overtake branch does lands between -0.005/seat/hand (tight threshold, and
    significantly *negative*) and +0.016 (loose threshold) — the whole curve is
    dominated by simply playing the cheapest winner. Recorded so the idea isn't
    retried: the conservatism in `trickSecurity` is not the problem, the rule
    consuming it was.
  - `lastToPlay` and `trickPts` are gone from `aiChooseCard`; both existed only
    to gate the deleted branch, and the last-to-play case now falls out of the
    general rule for free.

## [0.18.0] - 2026-07-28
- Once the AI is winning a trick, it takes it with the cheapest card that is
  actually sufficient rather than the strongest card it holds. Item 2 of the
  play brief, and its second-largest single error at 24 points: the picker took
  a trick with Q-clubs where Q-hearts took the identical 18 — the one seat left
  held no Queen at all — then, boss gone, led Q-hearts into a live Q-spades and
  lost 15 more. Same shape in a second hand, Q-clubs where J-diamonds sufficed.
  - "Try to secure with strength" was right about *when* (a fat trick, or late
    in the hand) and wrong about *what*. When a provably sufficient winner
    exists, anything stronger buys nothing and spends a card that wins a later
    trick. When none exists, strength really is the best of the options left, so
    that branch stays exactly as it was.
  - **Two wrong versions preceded this one, both caught by measurement, both
    worth recording.** The first applied the filter before the fat-trick test
    and so also hit the branch that already played the *cheapest* winner.
    `sufficient` is `winners` with the weak cards removed, so taking the
    cheapest of it there plays a *stronger* card than before — the rule
    silently inverted. That cost **0.045/seat/hand** and read exactly like the
    brief's idea failing.
  - The second replaced `securityAfterPlay` with a stricter test — nothing
    outstanding beats this card at all, whoever holds it — on the theory that
    `opponentsYetToAct` is too loose because knowsTeammate() calls every
    unrevealed seat a teammate. That reasoning is wrong here, and the
    measurement said so: strict came in at **-0.002/seat/hand, ahead in 2 of 5
    splits**, i.e. indistinguishable from making no change. The exclusion is the
    point. If a seat we take for a teammate overtakes our cheap winner the trick
    stays with our side and nothing was wasted, so refusing to certify those
    cases just burns the boss card for nothing.
  - **Measured head to head, 200,000 hands per split, three replicates.** The
    shipped version is **+0.008 to +0.013 per seat per hand, ahead in 19 of 20
    splits.** Small — it fires only when a provably sufficient winner exists in
    a fat or late trick — but consistent in sign across every replicate.
    Cumulative against 0.16.4, items 1 through 3 together: **+0.033/seat/hand,
    ahead in 5 of 5.**
  - `npm run aiskilltest` grows to 48 assertions. The new position fails against
    0.17.0 and passes here. (`baa9270`)
- The bump-multiplier recalibration flagged in 0.17.0 is still open and this
  moves the same direction, since the change again helps whoever holds it and
  the defenders outnumber the picker. Still deliberately untouched.

## [0.17.0] - 2026-07-28
- The AI stops shedding by card points alone. Six hands were reconstructed
  card-for-card from result screens and every decision solved double dummy;
  nearly every large error traced to one question the engine never asked —
  *which of these cards can still win a later trick, and whose trick am I
  shedding into.* Both halves of that turn out to be the same computation, so
  they land together.
  - **Equity classes.** Legal cards are bucketed by how many unaccounted-for
    cards can still beat them, and points are allocated only *inside* the
    weakest bucket, never across buckets. A bare minimum-points shed gets this
    exactly backwards whenever the cheap card is the valuable one: reported from
    a hand where a defender under an unbeatable Queen held J-spades — with both
    higher Queens just played, provably the highest trump left — and threw it to
    keep a dead A-diamonds. Two tricks later the picker swept 44 on a trick
    J-spades wins outright. Ranking by points saw a 2 and an 11; ranking by
    class sees a boss card and a dead one.
  - **Ownership survives the control flow.** `mateWinning` was already computed
    and already correct — it just didn't reach the code that needed it. A seat
    whose own side held the trick, holding nothing able to overtake, with the
    trick below the schmear-confidence bar, fell out of the teammate branch
    entirely and landed in the generic can't-win shed, which minimises points.
    So it donated its *cheapest* card to a trick its own side was taking. The
    ownership signal is hoisted above the branch and carried into every shed
    path, which is a plumbing fix rather than a new input.
  - **`trickSecurity` read as a direction, not a gate.** The sign of a shed is
    just "is our side more likely than not to still hold this at the end", which
    breaks even at one half. `SCHMEAR_CONFIDENCE` stays at 0.85 and keeps its
    own job: schmearing is *choosing* to spend a valuable card and its error is
    asymmetric, so it wants confidence well above even money. Shedding is
    forced — a card is going regardless — so the honest breakeven is different.
    One number, read two ways, which is what lets both branches share one
    function.
  - **Overtaking your own side's trick is now priced, not gated.** A flat
    threshold is cleared most easily by exactly the card it is most expensive to
    spend: whoever holds the boss trump can always take the trick's security to
    1.0. Reported from a real hand — a defender's Q-hearts already owned trick 1
    and their partner over-trumped with Q-clubs, the boss card of the game, on a
    trick their own side already had, letting a lone picker out for 7-diamonds.
    The old gate permitted it *because* Q-clubs was unbeatable. The bar now
    scales with the card's own equity: unbeatable pays 4x, near-boss 2x. It
    stays a price and not a prohibition, since holding the lead is sometimes the
    whole plan — the existing "still overtakes when it converts the trick to a
    certainty" assertion passes unchanged.
  - **The picker counts their own burial.** Every "what could still beat this"
    question resolves through one `unaccountedFor()` list, and the picker knows
    two cards nobody else does. On its own this is worth nothing measurable
    (+0.0004/seat/hand, ahead in 3 of 5 splits — inside the noise) and it is
    kept because it is information the seat genuinely has and it sharpens the
    "provably boss" judgements the class rule depends on, not because the
    aggregate could see it.
  - **Measured head to head, old policy against new, assigned per seat.** The
    game is zero-sum across five seats, so the new-policy seats' average score
    *is* the effect size — no comparing two separately-run populations. At
    100,000 hands per split across seven different seat splits the new policy is
    ahead in **7 of 7**, by +0.018 to +0.032 points per seat per hand. Layered:
    ownership + equity carries +0.016, the overtake price adds the rest.
    Picking and the last two tricks are identical in both engines (untouched
    `aiBuryAndCall`, same exact endgame solver), so this isolates tricks 1-4.
  - **Both sides get it, and the defenders gain more.** Self-play over 3x100,000
    hands: picker win rate **61.5-61.8% -> 60.8-60.9%**, schneider rate
    23.0% -> 21.9%, no-tricker rate 7.2% -> 5.2%, avg picker-team points
    70.2 -> 69.0. Ranges don't overlap. That direction is expected — two of the
    three reported symptoms are defender plays, and there are four defenders.
  - **This opens a calibration question it does not close.** 0.14.0 set the bump
    multiplier so picking sits near neutral, and at 200,000 hands picker EV has
    moved from **+0.22 alone / +0.03 partnered to -0.11 / -0.06**. Picking is now
    slightly negative rather than slightly positive. That wants the bump
    multiplier re-derived and the `handStrength >= 10` pick threshold re-swept —
    deliberately left alone here so the play change is measured on its own.
  - `npm run aiskilltest` grows to 45 assertions with three positions isolating
    the symptoms above. Four of the new behavioural assertions fail against the
    previous engine and pass against this one. (`8f3a7f7`)
- Strips six committed merge-conflict markers out of `CHANGELOG.md`, left behind
  when the 0.16.2-0.16.4 entries landed. No entry text changed. (`6528232`)

## [0.16.4] - 2026-07-27
- The header moves into `src/header.jsx`: title, build stamp, house-rules line,
  doubler badge and the menu. No visual or behavioural change — the second half
  of the same groundwork as 0.16.3.
  - `rules` arrives as a prop, which is the point of doing this separately from
    the felt. Solo's rules are a module constant so every player necessarily
    agrees; at a table they have to be state, because everyone sitting down has
    to be playing the same game. Threading that through afterwards would mean
    touching this markup twice.
  - Menu entries are passed as data rather than rendered fixed, because that is
    where the two halves genuinely differ — a table adds Invite and later a
    profile. Nothing conditional lives in the header; it never learns what a
    "host" is.
  - Verified behaviour-identical by measurement against the unextracted build:
    same header text, same 61px height, same menu items, no overflow. The
    doubler branch was exercised separately by forcing a stake — badge renders,
    header wraps to 84px as designed. `Sheepshead.jsx` drops to 587 lines,
    from 800 before this pair of extractions. (`de15a0b`)

## [0.16.3] - 2026-07-27
- The felt moves into `src/felt.jsx`: seat ring, played trick, trick-winner
  banner, blind marker and hand fan. No visual or behavioural change — this is
  groundwork so the multiplayer table renders from these components instead of
  a second copy that drifts, which is what happened over the past week.
  - Two props carry everything that differs between the halves: `names` (solo
    passes its fixed cast, a table passes whoever sat down) and `mySeat` (solo
    is always 0; at a table you get whichever seat was free and still expect to
    be at the bottom of your own screen). At `mySeat` 0 the rotation is the
    identity, so solo renders exactly as before.
  - `rules` deliberately stays out: the house-rules line and the doubler chip
    both live in the header, so that prop belongs to the header extraction.
  - Nothing in the felt reads another player's hand — seat lines show score and
    trick count, not cards held — which is what lets a table feed it a view
    where the other four hands are absent.
  - Verified behaviour-identical by measuring the rendered result against
    unmodified master rather than by inspection. `Sheepshead.jsx` drops from
    800 to 676 lines. (`848c7d4`)

## [0.16.2] - 2026-07-27
- "Play with friends" moved into the menu, alongside Trump order and Scores.
  It had been sitting beside Last Trick since the menu didn't exist yet — the
  header couldn't fit a third button without clipping the title. The menu is
  the proper answer to that, so the hand row is back to carrying one control.
  - Only rendered when a host supplies the handler, so the solo game keeps no
    dependency on the networked half and still works with no server at all.
  - Labelled for what it does today: it starts a fresh table, leaving the hand
    in progress behind. Once a table can be seeded with the running score this
    becomes "Invite others" and the game carries over instead. (`cb0130f`)

## [0.16.1] - 2026-07-27
- Shared presentational pieces move into `src/ui.jsx`, matching the multiplayer
  branch. No behaviour change to the solo game beyond the two mobile fixes noted
  below; this is groundwork for bringing the two versions together.
  - The two branches had been fighting over one file. `v2` was +27 commits, but
    almost all of it is additive — 22 new files that can't collide. Measured
    against the merge base, `v2`'s own changes to `Sheepshead.jsx` were
    **+19 / -121**, and the -121 was entirely lifting `felt`, `Card`, `Badge`,
    `Modal` and the button styles into `ui.jsx`. It had made essentially no
    behavioural change to the solo screen. `engine.js` was +57 with zero
    deletions, which is why engine merges have always resolved themselves and
    only `Sheepshead.jsx` ever conflicted.
  - So the whole merge tax came from one structural refactor that master didn't
    have. Master now has it, byte-identical.
  - Measured with a trial merge into `v2` before and after: the conflict in
    `Sheepshead.jsx` goes from **one 85-line hunk to two hunks totalling 12
    lines** — and changes character, from "reconcile a refactor" to "master
    added a constant, keep it". Getting from 25 lines to 12 meant adopting
    `v2`'s exact comment text and blank lines where the two files overlap;
    divergence there is divergence, even when it's only prose.
  - It does not reach zero, and can't while `v2` is four commits behind: master
    keeps adding content next to a region `v2` also edited. Once `v2` takes this
    merge, both sides share the structure and later solo changes land in
    disjoint regions.
  - `Sheepshead.jsx` also gains the optional `onPlayWithFriends` prop and its
    Friends button. Inert here — nothing passes it — but present so the file
    matches its counterpart rather than differing by a feature.
  - Carries across two mobile fixes that only existed on `v2`: `touchAction:
    "manipulation"` on cards, removing the ~300ms double-tap delay browsers add
    to undeclared touch targets, and `WebkitTouchCallout: "none"`, which stops
    the "save image" callout firing when a thumb rests on a card.
  - Bundle 56.48 -> 56.54 kB gzipped, which is the two touch properties and the
    unused button. `npm test` 75/75 unchanged. (`8a9663d`)

## [0.16.0] - 2026-07-27
- The play-area header is gone, and everything it carried moved to the thing it
  describes.
  - The dealer wears a poker-style **D button** beside their avatar; seat 0 has
    no avatar on the table, so it sits in the YOUR HAND row instead. The called
    suit rides on the **picker's badge stack**, where it belongs — they chose
    it. "picked" and "alone" were already duplicated by those same badges, so
    the strip was restating three things and owning one.
  - That hands ~38px back to the table, which is the part of the screen you
    actually look at.
  - The Doubler badge moves up into the header, beside the house rules. It was
    briefly at the table's top centre, and that collides: the seats sit at 4% of
    the table's height, so on a 667px-tall phone they start at y=14 while the
    badge reaches y=19, overlapping two of them. There is no room between the
    two top seats either — that gap is ~50px and the badge is ~95px. In the
    header it is fixed chrome that cannot collide with anything the game draws,
    and it sits next to the rule that explains what doubling means. The row
    wraps rather than squeezing the rules line, since the two together need
    356px against a phone's 339 — and that height change is only safe because a
    doubler is set when the hand is dealt, never mid-hand.
- The recap now stamps **the build number inside the shared screenshot**:
  "Hand 3 · v0.16.0". That image is the format hands actually get reported in,
  and a reported hand is evidence about a specific AI build — without the
  version in the picture, "the AI misplayed this" can't be matched against what
  the AI was at the time. Hand number moved inside the capture region with it;
  only the Share button stays outside.
- Two long-standing wording bugs, both noticed in passing and held for this
  pass:
  - The status line said "You takes the trick" — seat 0 is named "You", and it
    was being interpolated into a third-person sentence.
  - The hand-end and recap headings said "Pickers win" even when the picker went
    alone, which is wrong on exactly the hands where the win is most impressive.
    Now "Picker wins". Both call sites fixed together.
- Verified in the browser at 375px: contract strip gone (the root is down to
  four children), table grew to 507px, exactly one dealer button renders, all
  four seat columns sit inside the table edge with no horizontal overflow, and
  the recap capture region contains the version while the Share button stays
  out of it. (`e21ef8c`)

## [0.15.0] - 2026-07-27
- The header now states the house rules, and the two buttons that lived up
  there have moved into a menu.
  - "Called Ace · No Leasters · Double on the Bump" sits under the title, above
    the rail, and stays there all game. Two of those three were already true and
    unstated; the third arrived in 0.14.0 and changes what a hand is worth, so
    it needed saying somewhere permanent rather than being discovered when a set
    picker paid double.
  - Held as a list rather than one sentence. The planned version of that line
    lets you change the rules, and a rule you can toggle has to be an
    addressable thing rather than a substring. It is deliberately *not* a button
    yet — a control that does nothing when pressed reads as broken, so it stays
    text until it has somewhere to go.
  - Trump and Scores become items under a hamburger. Two buttons was already
    most of the header's width, and the rules line needed room; the menu also
    gives the rules editor and anything after it a place to land that doesn't
    cost width. Menu closes on select and on any click outside, tracks
    `aria-expanded`, and its items carry `role="menuitem"`.
  - Verified in the browser at 375px and desktop: menu opens, selects, closes on
    outside click with no stray backdrop left behind, and sits inside the table
    edge (203-357px within a 375px root). The rules line measures 230px of text
    in 339px of space at phone width — one line, with room for a fourth rule.
    (`1ee2bb4`)

## [0.14.0] - 2026-07-27
- Two house scoring rules, both on by default: **double on the bump** and a
  **doubler after a passed-out hand**.
  - *Double on the bump* — a set picker pays twice. The reason it works out:
    the picking team wins about 61-62% of the hands it takes, which alone would
    argue for something milder, but it also wins them *bigger* than it loses
    them — average multiplier 1.49 winning against 1.17 losing, because it holds
    the blind and the burial. Feed that asymmetry in and the break-even win rate
    for picking lands at roughly 61%, right where the game actually runs.
  - Measured over 200,000 hands: picker EV falls from **+1.27 to +0.10** per
    picked hand overall (alone +2.04 -> +0.24, partnered +0.93 -> +0.04). What
    that buys isn't fairness between seats — the game was always zero-sum, and
    every seat picks about equally often. It's that at +1.27 picking was close
    to free, so loose picking paid about as well as good picking. At +0.10 it's
    a decision again.
  - The current AI pick threshold needs no retuning: swept it, and
    `handStrength >= 10` is the only setting where picking stays near neutral
    under the new rule (>= 11 goes back to +0.39, >= 12 to +0.71).
  - *Doubler* — nobody picks, the hand is thrown in, and the next one pays
    double. Stacks if it happens twice running, shown as `DOUBLER ×4` and so on.
    Carried on the game state rather than recomputed, since the hand that pays
    it isn't the hand that caused it.
  - Both stack with the existing multipliers, so a set no-schneider is 4x and a
    set no-tricker is 6x. Winning big is *not* doubled — the bump is a penalty
    on the picker, not a general multiplier.
  - Adds `npm run scoringtest` (folded into `npm test`): 38 assertions on
    constructed finished hands, kept in their own harness because "what is this
    hand worth" fails for entirely different reasons than "which card should the
    AI play". Every case also asserts the hand is zero-sum, which is the
    invariant most likely to break quietly if a stake is ever applied to one
    side only.
- Fixes a long-standing layout bug the Doubler badge exposed: the contract strip
  carried both `width: 100%` and 12px of horizontal padding under content-box
  sizing, making it 387px wide inside a 363px box. The root clips overflow, so
  the extra 24px was invisible for as long as nothing was right-aligned — the
  badge was the first thing to land in it, and rendered cut in half. (`0de4e84`)

## [0.13.0] - 2026-07-27
- Taking a trick off your own side now has to buy something. Reported from
  expert play: Gus picked, his partner Duane led Q-hearts, Gus overtook with
  Q-spades — and Bunny's Q-clubs took it anyway.
  - The number that settles it: from Gus's seat, Q-hearts and Q-spades were
    beaten by exactly the same one unaccounted-for card, Q-clubs. Q-spades was
    in his own hand, so it threatened nothing. Overtaking moved the trick from
    his partner's Queen onto his own better one without improving its odds by a
    single point — measured at 0.737 either way. Reaching the winners branch
    means "I can win", and the old code read that as "I should win".
  - `securityAfterPlay()` answers what the trick's security becomes if I play a
    given card. When a teammate is holding it, the AI now overtakes only if that
    difference clears `OVERTAKE_MIN_GAIN`; otherwise it lets the trick ride and
    sheds its weakest card. In the reported position Gus keeps both Queens and
    throws J-spades.
  - **The first version of this was a net loss and was scrapped.** Applied
    wherever `knowsTeammate()` was true, it cost defenders 0.6pp in partnered
    hands (picker win rate 62.0-62.2% -> 62.6-62.8%), and got worse the higher
    the threshold went. knowsTeammate() calls every unrevealed seat a teammate,
    so the brake was talking defenders out of taking tricks off the picker's
    hidden partner — the same 2:1 asymmetry that made speculative schmearing
    worth *keeping* in 0.9.0, pointing the other way. Gating it on the
    partnership actually being known reversed the result.
  - Measured over 3x200,000 hands with the gate in place. Picker win rate
    62.0-62.3% -> **61.4-61.5%** overall, and both halves improve on their own:
    alone 61.9-62.5% -> 61.4-61.5%, partnered 62.0-62.2% -> 61.4-61.5%. No
    range overlaps. Most of the partnered gain is post-reveal, where defenders
    stop spending power to overtake each other.
  - `OVERTAKE_MIN_GAIN` swept at 0.05 / 0.15 / 0.30 / 0.50. Set to 0.15: it
    wins on partnered hands, which are roughly 70% of picked hands, and on the
    overall rate. 0.30 is marginally better against loners and worse everywhere
    else.
  - `npm test` grows to 37 assertions, pinning the reported position from Gus's
    real hand (8S QS 7H QD JC JS) including the security-equality that makes the
    overtake pointless, plus a guard that the brake doesn't seize: with the top
    trump in hand and a coin-flip trick, it still takes it. Against the previous
    engine the two behavioural assertions fail. (`e1ca4e4`)

## [0.12.0] - 2026-07-27
- Schmearing is rebuilt around two questions the AI wasn't asking: *is this
  trick actually ours to win*, and *which card can I least afford to keep*.
  Reported from expert play — a loner led a trump, the trick was already
  unbeatable in a defender's hand, and Duane threw Q-diamonds while holding the
  10. "No points/power issue."
  - **Forced trump.** 0.8.0's "a schmear is paid in fail points only" was
    written for the free choice, where keeping trump beats paying with it. When
    trump is led there is no free choice — a trump is going regardless — and the
    old code fell through to "cheapest by card points", which is exactly
    backwards. Trump splits cleanly: Queens and Jacks are 3 and 2 points and all
    the power, while every point that lives in trump lives in the diamonds. So
    with no free choice the AI now spends the fattest diamond, which is better
    on both counts at once — seven more points banked AND the stronger card
    kept. Queens and Jacks are parted with only when they're all that's left,
    weakest first.
  - **Trick security.** The old safety test asked whether the winning card was
    a Jack or better. That's the wrong question: the danger isn't a card, it's a
    seat. `trickSecurity()` now returns the chance our side keeps the trick —
    certain when no opponent is left to act, certain when nothing unaccounted
    for beats the winner, and otherwise hypergeometric over the cards this seat
    can't see. Below `SCHMEAR_CONFIDENCE` the AI declines to pay in, which lets
    the two better options downstream fire on their own: overtake the teammate,
    or sit on the points and wait.
  - Measured over 3x200,000 hands. **Against a loner the picker's win rate falls
    67.4-67.6% -> 61.8-62.4%** — a 5.4pp swing, non-overlapping by a wide
    margin. The whole effect is defenders: a lone picker has no teammate, so the
    schmear branch never fires for them. Partnered hands are unchanged
    (61.9-62.1% -> 61.9-62.1%), which is the intended blast radius and doubles
    as a control. Schneider rate 23.5-23.7% -> 22.6%, as fewer loners run away
    with a hand.
  - `SCHMEAR_CONFIDENCE` is set on principle, not measurement: swept 0.50 to
    0.95 and the aggregate could not tell the values apart, every one landing
    inside the others' spread. Not because it's inert — 41.5% of security
    evaluations come back strictly between 0 and 1 — but because in most of
    those middle cases there's nothing pointy in hand and both branches play the
    same card. Set to 0.85 because the error is asymmetric: a bad schmear hands
    points to the picker, a missed one usually only defers them.
  - `npm test` grows to 31 assertions, including all three AI seats from the
    reported trick. Only Duane's play changes; Gus (holding two power trump,
    correctly shedding the Jack) and Bunny (shedding a worthless diamond over a
    Jack) were already right and are pinned so they stay that way. Against the
    old engine three behaviours fail. (`ea94790`)

## [0.11.2] - 2026-07-27
- The buried pair in the recap is shown as rank-and-suit glyphs rather than two
  card faces — the same shorthand the grid below already uses.
  - 0.11.0 rendered them as full cards, which made the two cards nobody played
    the largest thing on a screen whose subject is the 30 cards that were. The
    whole recap now reads in one visual language.
  - The buried row goes from 132px to 18px, which pulls the trick grid back up
    into view without scrolling on a phone.
  - Verified at 375px on a finished hand: renders "BURIED A♥ 10♣", red suits in
    the same red the grid uses, no card elements left in the row, no page
    overflow. (`13a6ac2`)

## [0.11.1] - 2026-07-27
- The recap grid labels its columns once: "TRICK" now sits in the name column
  as a row header, and each heading is just its number.
  - Repeating the word six times spent width in the one place the grid is
    tightest. At 375px every heading wrapped onto two lines, so the header row
    was twice as tall as it needed to be and the numbers — the part you
    actually read — were the smaller half of each cell.
  - Numbers move to 12px semibold now that they stand alone; "TRICK" keeps the
    11px uppercase treatment the headings had.
  - Measured at 375px with a finished hand: the header row is a single 23px
    line, all seven cells one line each, table 318px inside a 318px scroller —
    no sideways scroll on the grid and no page overflow. (`c9ed246`)

## [0.11.0] - 2026-07-27
- The recap now opens with the hand-end summary — who won, the label, and the
  points both ways — instead of just the word "Recap", and shows the two
  buried cards in place of the old "(N buried)" count.
  - The buried pair is the one part of a hand nobody at the table ever gets to
    see. A count of their points was the least interesting thing about them;
    the recap is the only screen that can actually show them, so it does, as
    real cards rather than text.
  - The summary sits inside the shared-screenshot region, which the trick grid
    alone never did. A recap gets shared to argue about a hand, and the grid on
    its own doesn't say who won or by how much — so the image now carries the
    result with it. The Share button stays outside the capture, confirmed by
    reading the captured element's text.
  - "Hand N" and Share keep the top row; the summary and grid sit below.
  - Verified in the browser at 375px on a finished hand: header, points line,
    both buried cards, the six-trick grid and the legend all render inside the
    capture region with no horizontal overflow. (`4413ec0`)

## [0.10.1] - 2026-07-27
- The 90-point result now reads "No Schneider!" rather than "Schneider!" — the
  losing side failed to get out of schneider, so that's what it should say.
  Applies to both sides of the same event: picker team held to 30 or less, or
  defenders held to 30 or less.
  - The label is produced in `scoreHand`, so this is one string in the engine
    rather than a patch at the render site. `simulate.mjs` compared against the
    old label with exact equality to count its schneider rate, and was updated
    with it — left alone it would have silently reported 0.0% and quietly
    broken one of the three metrics used to judge every AI change.
  - Verified on constructed scoring positions: picker team 95/defenders 25 and
    defenders 95/picker team 25 both label "No Schneider!" at 2x, an ordinary
    70-50 win stays unlabelled at 1x, and a no-tricker still reads
    "No-tricker!" at 3x. Simulated schneider rate holds at 23.6% across 50,000
    hands, unchanged from before the rename.
  - Layout-neutral at 375px. The heading already wrapped to two lines for every
    labelled outcome before this change; measured against the modal's 299px
    inner width, all five strings still render at two lines and 55px with no
    horizontal overflow. (`5c9ac72`)

## [0.10.0] - 2026-07-27
- Each opponent's seat now shows their running score instead of how many cards
  they're holding — green when they're up, red when they're down.
  - The card count was dead weight: everyone still in the hand holds exactly as
    many cards as you do, so it only ever repeated what your own hand already
    told you. Where each player stands in the match is the thing you actually
    glance up for, and it previously meant opening the Scores modal mid-hand.
  - Score colours are a new pair in the theme rather than a reuse of the
    existing `red`/`brass`: `red` is tuned for card pips on a cream card face
    and goes muddy on dark felt. Zero is neutral cream, not green — nobody is
    winning before a hand has been scored.
  - Trick count stays, and now reads "1 trick" rather than "1 tricks". That
    was a pre-existing wart, fixed here because it sits in the same span.
  - Verified in the browser across a scored hand: +4 and +2 render green
    (`#5BBE72`), -2 red (`#E0685C`), 0 neutral cream. At 375px the strip adds
    no horizontal overflow — the widest seat text measures 63px inside the
    84px seat column. (`ad67d4b`)

## [0.9.1] - 2026-07-27
- The table no longer lurches when you play your last card. The hand fan holds
  its height whether or not it has cards in it, so the layout stays exactly as
  it was with cards in front of you.
  - The fan reserved no height of its own, and the table above it is
    `flex: 1 1 auto`. Playing the sixth card emptied the fan and handed the
    table 91px, so every seat and every card of the final trick jumped — right
    at the moment you're watching the last trick resolve, and just before the
    hand-end modal covers it.
  - 91px because a `Card` is content-box: the declared 80px height plus 2x4
    padding and 2x1.5 border. Pulled out as `CARD_ROW_H` next to the component
    that defines those numbers, rather than left as a magic constant.
  - Measured in the browser across a full auto-played hand. Before: the table
    area held 661px for six cards down to one, then jumped to 752px at zero.
    After: 661px at every card count including zero — one distinct value for
    the whole hand.
  - Also settles a smaller 8px shift nobody had reported, between the burying
    fan (8 cards at 0.9 scale, 83px) and normal play (91px). Both now measure
    101px including the row's padding. (`c6460fa`)

## [0.9.0] - 2026-07-27
- Defenders now gang up on a lone picker properly. Against someone who went
  alone, the AI defenders were refusing to schmear on the opening trick, so the
  loner got a free run at the trick that most often sets up the hand.
  - Root cause was the guard added in 0.8.0, which stops a defender paying
    points to a "teammate" who might turn out to be the picker's hidden partner.
    It keyed off `partnerRevealed`, and when the picker goes alone there is no
    called ace, so nothing ever reveals and the flag stays false all hand. The
    guard was written for uncertainty, but an alone hand is the one case with
    none: going alone is declared at pick time and shown all hand
    ("Picker · Alone"), so every defender knows the other three seats are
    teammates from the first card. Certainty now also comes from there being no
    partner to be wrong about, not only from the ace having fallen.
  - Measured over 5x200,000 simulated hands before and after. In alone hands the
    picker's win rate drops 68.2-69.1% -> 67.4-67.8%; ranges don't overlap, so
    it's a real shift rather than run-to-run noise. Partnered hands are
    untouched (61.7-62.0% -> 61.9-62.1%, overlapping), which is the intended
    blast radius and doubles as a control on the measurement.
- Also measured and deliberately *not* changed: the same guard leaves defenders
  free to schmear speculatively in partnered hands from trick 2 onward, where
  they may hand points to the picker's hidden partner. Extending the guard
  across the whole pre-reveal window looks like the same fix, and costs about
  0.8pp: partnered picker win rate goes 61.7-62.0% -> 62.4-62.8%, again
  non-overlapping. With the picker excluded, an unrevealed winner is a fellow
  defender two times in three and the partner only one in three, and an Ace held
  back gets trumped later often enough that pooling it beats hoarding it. The
  rejected variant is asserted in the test suite so it doesn't get "fixed" later.
- `npm test` grows to 21 assertions. Against the old engine exactly one fails —
  the opening-trick loner case — with the other 20 passing, so the new
  behaviour is pinned and the guards are confirmed to be guards. (`162ba87`)

## [0.8.0] - 2026-07-26
- AI now protects its trump power instead of throwing Queens away as schmear.
  Reported from a real hand: with a Jack led and Q-clubs already down and
  unbeatable, both Gus and Bunny threw Queens while holding lower trump.
  - Root cause: the schmear branch sorted every legal card by card points,
    highest first. When trump is led every legal card is trump, and among trump
    the highest-point card is a Queen (3) ahead of a Jack (2) — so the AI was
    giving up the strongest card in the game for one extra point. It wasn't
    valuing the Queen at all; it was counting pips.
  - A schmear is now paid in fail points only. Trump takes later tricks and no
    schmear is worth the trick a trump could win, so trump is never schmear
    material. When nothing is worth paying, the AI gets out of the way with its
    cheapest card by points — which makes a Queen the last trump it will ever
    part with — rather than falling through to the winning logic and overtaking
    its own teammate.
  - Also stops speculative schmearing on the opening trick. Before the called
    ace falls a defender's "teammate" is a guess, and the seat winning may well
    be the picker's partner; paying points to the wrong side is worse than
    holding on. Only fires now when the partnership is actually known.
  - Measured over 3x20,000 simulated hands before and after. Picker win rate
    63.1-63.6% -> 64.0-64.6%, schneider rate 21.8-22.3% -> 24.3-24.4%, avg
    picker-team points 70.8-71.1 -> 71.7-71.9. Ranges don't overlap, so it's a
    real shift rather than run-to-run noise. Pick and alone rates unchanged, as
    expected — nothing here touches the picking decision.
  - Adds `npm run aiskilltest` (also `npm test`): 13 assertions on constructed
    positions, including the reported hand replayed in true play order.
    Aggregate simulation can't catch this class of bug — a wasted Queen costs a
    few points against far larger run-to-run noise — so the behaviours players
    actually notice are asserted directly. Against the old engine 7 of them
    fail. (`aea4269`)

## [0.7.4] - 2026-07-25
- Recap modal now marks who picked and who was the partner, with `Picker` /
  `Partner` badges under the player names in the grid — the same badges the
  hand-end summary already uses, so the two modals speak one language.
  Reviewing a hand without knowing which team each player was on made the
  trick-by-trick grid much harder to read, and it's the piece most missed
  when a recap gets shared out of context.
  - The picker also gets a secondary (non-gold) `Alone` badge when they went
    alone, so an absent partner reads as "there wasn't one" rather than
    looking like the marker failed to render.
  - Badges stack under the name and use a new `compact` variant of `Badge`
    (9px, tighter tracking and padding). At full size the `Partner` badge
    widened the name column enough to push Trick 6 off-screen at 375px —
    measured 7px of overflow; compact brings it to 0.
  - Verified by playing a full hand in the browser at mobile (375px) and
    desktop widths, including temporarily forcing the alone case to check
    that layout. (`ae4b7ff`)

## [0.7.3] - 2026-07-25
- Added a Share button (industry-standard share icon) to the Recap modal so
  testers can send back hands they think the AI misplayed. Captures a
  screenshot of the recap grid (hand number, trick-by-trick grid, and the
  best/worst-play legend) and hands it to the OS share sheet via
  `navigator.share`, so it goes straight into Messages/Mail/etc. as an
  image.
  - Screenshotting uses `html2canvas`, loaded lazily from a CDN only when
    Share is tapped, so it doesn't add to the bundle for everyone else.
  - Falls back to `navigator.share` without the file if file-sharing isn't
    supported, and to a plain image download if `navigator.share` isn't
    available at all (e.g. most desktop browsers) -- the tester still ends
    up with the PNG either way.
  - Verified with a clean production build; bundle size essentially
    unchanged (172.76 kB) since html2canvas isn't bundled. (`3111138`)

## [0.7.2] - 2026-07-24
- Recap grid now flags the single best play (`!`) and single worst play
  (`?`) of the hand, chess-style, no explanation shown — just the glyph
  next to the card.
  - engine.js: added `rolloutValue(g)`, a deterministic single-path
    playout to hand-end using the built-in AI (`aiChooseCard`) for every
    remaining decision on both sides. Since `aiChooseCard` already
    switches to the exact minimax solver for the last two tricks, that
    precision folds automatically into the rollout — one consistent
    yardstick across all six tricks instead of blending two separate
    scoring systems.
  - `gradeHandPlays(g)` replays a finished hand from `trickHistory`
    (reconstructing each player's post-bury starting hand from the cards
    they're recorded as having played), and at every real decision
    (skipping forced single-legal-card plays) compares the actual card's
    rollout value against every legal alternative, from the mover's own
    team's perspective. Worst play = biggest point cost vs. the best
    available option. Best play = a decision that matched the best
    option (cost 0) with the largest gap between the best and worst
    available options, so a genuinely correct, high-stakes read gets
    picked over a trivial no-brainer.
  - Verified across 284 completed simulated hands: no exceptions, every
    flagged card matches what was actually played, best and worst never
    point at the same cell, ~3ms/hand grading cost. (`52d2073`)

## [0.7.1] - 2026-07-24
- Redesigned the "Last Trick" modal from a text list to a mini table view:
  all 5 seats laid out like the live play area (avatar, name, card played),
  with a gold ring on the leader's avatar and a glow on the trick-winner's,
  matching how a trick reads during actual play. (`4cae13b`)

## [0.7.0] - 2026-07-24
- Added a "Recap" button to the hand-end summary modal. Opens a
  replacement modal (summary hides while it's open) with a grid: players
  down the left, one column per trick (1-6), each cell showing the card
  that player played. The leading player's cell gets a gold underline,
  the trick-winner's cell gets a shaded background — a quick way to
  scan the whole hand. Has its own "Deal next hand" button so you can
  skip straight from recap to the next deal.
  - engine.js: added `g.trickHistory`, accumulating every resolved
    trick (not just the last one) for the current hand, reset each
    `freshHand`.
  - Modal component now takes an optional `maxWidth` (recap uses 480
    instead of the default 380 to fit the 7-column grid), with
    horizontal scroll as a fallback on narrow phones.
  - Verified trickHistory across 500 simulated hands: exactly 6 tricks
    per hand, all 5 players present in each, and the flattened card
    list matches the existing card-counting log exactly. (`a532ce1`)

## [0.6.1] - 2026-07-24
- Added "Hand N" to the hand-end summary modal (small label above the
  win/lose headline), so hand count is visible right after each hand, not
  just in the Scores modal. (`1d0a570`)

## [0.6.0] - 2026-07-24
- Added a "Hand" score column to the hand-end summary table, between
  "Pts" (points taken this hand) and "Total" (running score). Shows each
  player's score change for just this hand (e.g. picker +4 on an alone
  schneider). `scoreHand()` in engine.js now returns `result.handDelta`,
  computed from the pre/post score arrays. Added column headers to the
  table since it's now 3 numeric columns wide. Verified across 500
  simulated hands that every hand's deltas sum to zero and match the
  cumulative total on hand 1. (`d75f8a0`)

## [0.5.5] - 2026-07-24
- Shortened "Picker team wins" to "Pickers win" in the hand-end modal
  headline, to leave more horizontal room for the "— Schneider!" /
  "— No-tricker!" suffix on the same line. (`e54a970`)

## [0.5.4] - 2026-07-24
- Switched called-suit text to the classic icon + label pattern: "Called: A
  Clubs" -> "Called: ♣ Clubs" in the contract strip, "Call Ace of Clubs" ->
  "Call ♣ Clubs" on the call-phase buttons. Dropped "Ace of" since it's
  redundant while calling an ace is the only option (revisit if a
  call-a-ten rule gets added later). (`e9d81cd`)

## [0.5.3] - 2026-07-24
- Renamed two AI opponents to lean into the Wisconsin theme: Lorraine ->
  Bunny, Werner -> Duane. Both 5 characters, no avatar-initial collisions
  with You/Gus/Patty. (`ab8c259`)

## [0.5.2] - 2026-07-24
- Called-suit text now spells out the suit name instead of showing the
  symbol — "Called: Ace of Clubs" instead of "Called: A♣" in the contract
  strip, and "Call Ace of Clubs" instead of "Call A♣" on the call-phase
  buttons. Directly addresses the clubs/spades confusion; card faces
  themselves still use symbols. (`cc1361d`)

## [0.5.1] - 2026-07-24
- Fixed the contract strip wrapping onto two lines at the new font size:
  dropped "Hand N" from it (moved into the Scores modal instead) and moved
  the version badge up into the header row, centered between the
  SHEEPSHEAD title and the Trump/Scores buttons. The play-area header is
  now just "Dealer: X · Y picked · Called: A#" (plus "· Alone" when it
  applies), full width, one line. (`8a240a6`)

## [0.5.0] - 2026-07-24
- Added a "Last Trick" feature: the tricks/score text in the bottom-right of
  the hand area is now a button (styled like "Scores") that opens a modal
  listing the previous trick's cards by player, in the order they were
  played (leader first), with "led"/"won" tags and points taken. (`9c442a7`)

## [0.4.2] - 2026-07-24
- Bumped font sizes ~20% across the board (card ranks/suits, seat labels,
  status text, modals, buttons) for readability — feedback flagged clubs
  and spades as hard to tell apart at the old sizes. Card dimensions and
  the overall layout footprint are unchanged; a little padding was trimmed
  in the header/status areas to offset the larger text so the table area
  doesn't get cramped. (`7464f12`)
- Simplified the version badge to just `vX.Y.Z` (dropped the trailing
  commit-hash suffix, which had hex letters in it). Removed the now-unused
  git-hash injection from `vite.config.js`. (`7464f12`)

## [0.4.1] - 2026-07-24
- Fixed the leftmost card getting clipped off-screen during the bury phase
  (8 cards held) on narrower phones — confirmed via a real Pixel 9
  screenshot. The hand fan now shrinks ~10% (card size + overlap) whenever
  more than 6 cards are held; normal 6-card play is unaffected. (`83ac79f`)

## [0.4.0] - 2026-07-24
- Added a discreet version/commit badge to the UI (`v0.4.0·6b7ef41` style) so
  tester screenshots carry an exact build stamp. (`6b7ef41`)

## [0.3.1] - 2026-07-24
- Lengthened the post-trick pause from 1.5s to 2.625s (+75%) so there's more
  time to read the completed trick before it clears. (`5a34fe6`)

## [0.3.0] - 2026-07-24
AI overhaul — six targeted improvements, each tuned and verified against a
new headless simulation harness (`npm run simulate`) before shipping:
- Extracted game logic into `src/engine.js` and added
  `scripts/simulate.mjs`, which plays thousands of all-AI hands and reports
  pick rate, picker win rate, alone rate, schneider/no-tricker rate, and
  average points — the regression check used for everything below.
  (`02325bb`)
- Card-counting: track every played card so the AI can reason about what's
  still unaccounted for. (`3b4710e`)
- Trump-aware leading: run a suit safely when holding all remaining trump,
  press when opponents are nearly out of trump, instead of a fixed
  "3+ trumps or a queen" rule. (`27d1fae`)
- Defenders now lead a short called-suit holding to flush out the picker's
  partner early, instead of only passively avoiding that suit. (`1f72ed1`)
- Loosened schmear conditions so points get fed to a winning teammate more
  often instead of only on the literal last card of a trick. (`d5becab`)
- Exact minimax solve for the last two tricks, where the remaining game
  tree is small enough to brute-force optimal play instead of leaning on
  heuristics right when hands are usually decided. (`f056950`)
- Deliberate "go alone" for exceptional hands (handStrength >= 17), tuned
  empirically: alone rate rose from ~25% to ~30% at equal or better
  win rate/EV per hand (confirmed at n=20,000 simulated hands). (`68d3361`)

## [0.2.0] - 2026-07-24
- Fixed mobile layout: the app now locks to the real viewport height
  (`100dvh`, overflow hidden) instead of `min-height: 100vh`, so the hand no
  longer requires scrolling to see on phones. Added safe-area padding for
  notched devices. (`b79b9ea`)
- Ignored stray Vite temp config files. (`f9c9a4c`)

## [0.1.0] - 2026-07-24
- Initial version: Sheepshead (5-handed, call-an-ace variant) built with
  React + Vite, playable against four AI opponents. (`6d1a60d`)
