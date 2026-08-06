# Sheepshead (noschnitz.com) — project memory

Handoff doc for picking this project back up in Claude Code (or any fresh session)
after a Cowork session that took it from "zip file" through a working solo game,
a real AI, and a full multiplayer/growth roadmap. Read this first, then `ROADMAP.md`
for what's next.

## What this is
Sheepshead (5-handed, call-an-ace variant) card game, React + Vite SPA, deployed to
**noschnitz.com** via Vercel. Solo play against 4 AI opponents today (Gus, Bunny,
Duane, Patty — Wisconsin-themed, 4-5 chars each). Source at
`https://github.com/jacobdixon/noschnitz.git`. **Current version: see `package.json`** —
it is deliberately not repeated here, because a hardcoded version in a handoff doc
drifts silently (this line said v0.7.2 while the app shipped v0.22.0).

## Where things live
- `src/engine.js` — pure game logic, zero React/UI. All rules, AI, and the endgame
  minimax solver live here. Kept pure deliberately so it's reusable headlessly (see
  `scripts/simulate.mjs`) and so future modes (multiplayer, tutorial) can wrap it
  without duplicating logic.
- `src/Sheepshead.jsx` — the UI/React layer. Inline styles, felt/brass table theme,
  no CSS framework.
- `scripts/simulate.mjs` (`npm run simulate`) — headless AI-vs-AI simulator, the
  regression check used before/after every AI or data-model change. No browser needed.
- `CHANGELOG.md` — one entry per version bump, newest first, each with the commit hash.
- `ROADMAP.md` — the feature roadmap (Feature → Epic → User Story) for what's next.
  **Read this next.**
- GitHub Issues on the repo — 6 epics + 24 stories from `ROADMAP.md`'s "Now" bucket
  are already filed and labeled (`feature: multiplayer` / `feature: community`,
  `epic`/`story`, `now`). That's the working board; `ROADMAP.md` is the narrative.

## Multiplayer architecture — the decisions and why
Read this before touching anything under `api/` or `src/store/`.

**Vercel-only: serverless functions + Upstash Redis.** Chosen over Durable Objects.
Serverless makes server-authoritative state race-prone, which is survivable only
because of the CAS rule below — that rule is load-bearing, not a nicety.

- **`src/engine.js` stays pure and is the single source of game rules.** The server
  calls it; the client may call it to predict. Never fork the rules.
- **`viewFor(g, seat)` is the only thing that may cross the wire.** Raw `g` holds all
  five hands — shipping it lets any player read the table in devtools. It also hides
  the blind, the partner's identity before the reveal, and conflates-away the secret
  "alone" case. `npm run leaktest` guards it; never route around it.
- **Every write goes through `mutate()` in `src/store/mutate.js`.** Read with a
  version, compute purely, write only if the version hasn't moved, retry against the
  winner if it has. A route that calls `store.put()` directly reintroduces the exact
  race this exists to prevent. Purity is what makes the retry safe.
- **CAS is a Lua `EVAL` script** (`src/store/upstash.js`). Upstash is HTTP-based, so
  there's no connection to hold a `WATCH` across; the check and the write must happen
  in one round trip. Tables are Redis HASHes (`version` + `state`) so the version is
  comparable with a plain `HGET` instead of decoding the blob with `cjson`.
- **`src/store/memory.js` is the reference implementation of the store contract.**
  `npm run storetest` runs one suite against both it and Upstash — the adapter has to
  match, and that's enforced rather than assumed.
- **AI seats advance inside the same request as the human play** (`src/ai-runner.js`),
  looping until it's a human's turn or the hand ends. Serverless has no background
  loop to tick them. Each AI play carries a sequence number so the client can pace the
  reveal instead of flashing four cards at once.
- **The stream endpoint polls; it does not subscribe.** Upstash's HTTP API can't hold
  a long-lived `SUBSCRIBE` from a function. `api/tables/[id]/events.js` polls the
  version and pushes only on change, then closes at a bounded lifetime because Vercel
  kills long connections — the client reconnects with `since=<version>` and resumes.
- **Preview and Production have separate stores.** Both have Upstash connected since
  the 2026-07-31 promotion, and they are two different databases on purpose. Never
  let test tables and live tables share a keyspace. This is also why the Production
  credentials arrived prefixed — the marketplace integration would not reuse a name
  Preview already held; see the promotion runbook.
- **`playerId` is a bearer token.** It's how a player proves which seat is theirs, so
  it must be stripped from other players' entries in every payload.

## Branch + deploy discipline — READ BEFORE DEPLOYING ANYTHING

**The v2 rewrite is done and merged.** There is no `v2` workflow any more. If you find
notes elsewhere telling you to work on `v2`, or describing a future "cutover", they are
historical — this section is current.

The two branches, and the thing that surprises everyone:

- **`master` = production = www.noschnitz.com.** Built **flag-on since 2026-07-31**
  (`VITE_MULTIPLAYER=1` on the Production environment), with `MULTIPLAYER=1` and its
  own Upstash database behind the API. Multiplayer is live to every visitor, and
  "Play with friends" is a public button rather than something only link-holders find.
  Anything elsewhere that describes production as the solo game is historical.
- **`beta` = a BRANCH** (not an environment name), built flag-on →
  beta.noschnitz.com. It used to be *the only place multiplayer exists*; since the
  promotion it is the same build as production, still worth keeping because it is a
  ref that can be moved independently when you want to try something on a real
  domain without shipping it to www.
- **`beta` is fast-forwarded automatically — do NOT do it by hand.**
  `.github/workflows/release.yml` moves beta to master and requests its build on every
  green CI run on master. This section used to tell you to push the refspec yourself;
  that instruction is historical, and following it today is at best a no-op. If beta
  really is behind, the question is never "did somebody forget to push" — it is
  **"why did the Release job not run"**, and the answer is almost always that CI on
  master went red.

**The failure mode that follows from that, and it has bitten:** `Release` is gated on
CI *succeeding*. A test that is marginal rather than deterministic can pass on a pull
request and fail on `master` for the identical commit — and when it does, it does not
merely fail a check. It **silently withholds the deploy**: beta stays where it was and
production is never content-verified. A flaky assertion in this repo is a deploy
outage with extra steps. Fix marginal tests, do not re-run them.

Consequences that look like bugs and are not:

- **Verify a deploy by *string content*, never by bundle hash.** Vercel's minifier is
  non-deterministic, so identical content can produce different hashes.
  Until the promotion there was a second, sharper reason: a multiplayer-only change
  left the production bundle *byte-identical*, because the code was eliminated from
  that build and there was genuinely nothing to deploy. That no longer holds — www is
  flag-on, so multiplayer changes do reach it — but the rule it produced was right for
  the other reason anyway, and every verifier in `.github/workflows` is built on it.
- **Vercel appears to deduplicate builds of the same commit SHA.** Pushing `beta` to
  the same SHA `master` just merged, while that commit's Production build is still in
  flight, can silently skip the beta build. `release.yml` handles both halves of this
  already: it triggers on CI *completing* rather than on the push, which is the gap,
  and it then requests the build through the **Deploy Hook** by name instead of relying
  on the push webhook. That hook URL is a credential: it lives in the dashboard and in
  Actions secrets, never in the repo, and never in a chat transcript.
- **A green commit status on `master` does not mean production shipped.** Vercel
  attributes the *beta* build to the same commit, because beta points at it. The only
  trustworthy check is the one `release.yml` does: fetch what www.noschnitz.com is
  actually serving and grep the bundle for this commit's version string. Do that before
  telling anyone a version is live.
- **That check is also a repair, which changes what a red Release job means.** If
  production is still stale two minutes after the merge, `release.yml` POSTs
  `VERCEL_PROD_DEPLOY_HOOK` and waits again — so the rate-limited-deploy failure that
  left www on v0.23.0 while master was on v0.24.0 now heals itself, and the normal case
  still costs one deployment rather than two. The corollary is easy to get backwards:
  a failing Release job does **not** necessarily mean beta broke. It may mean beta moved
  and built fine and *production* never shipped. Read which step failed before
  concluding anything about either environment.

## Promoting multiplayer to production — DONE 2026-07-31

**Multiplayer went live on www.noschnitz.com on 2026-07-31**, the day after the
first real five-seat session. Kept as a runbook rather than deleted, because it is
also the rollback procedure and because what it cost is worth knowing.

**The flip cannot be done from a session** — the agent proxy refuses vercel.com and
api.vercel.com, `vercel --prod` is banned here anyway, and one of the variables is a
credential. Code and verification land in the repo; the dashboard work is a human
action. That split held exactly as written.

What "promote" means concretely: it is not a state of the code, it is variables on
Vercel's **Production** environment. Four of them, and they have to arrive together:

| variable | why | where it is read |
|---|---|---|
| `VITE_MULTIPLAYER=1` | build-time; without it Vite dead-code-eliminates every multiplayer call site and www keeps serving the solo game | `src/flags.js` |
| `MULTIPLAYER=1` | runtime; the API routes gate on their own copy, because `VITE_*` never reaches a function | `api/_lib/flags.js` |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | a real store. Without it `getStore()` falls back to in-memory, and on serverless a table is created and then vanishes — which reads as data loss, not as an unfinished feature | `api/_lib/store.js` |

**The Upstash database must be a NEW one, scoped to Production only.** Not the
Preview database. Beta tables and live tables sharing a keyspace is the thing the
Preview/Production split exists to prevent, and it is invisible until two groups
are playing at once. `api/_lib/flags.js` already refuses with a distinct
`no-store` code if the flag is on and the credentials are missing, so a half-done
flip fails loudly rather than silently losing tables — but it cannot tell a
Production database from a Preview one.

Order matters, and the middle step is the one that is easy to skip:

1. Merge the work to `master`; `release.yml` carries it to `beta` and verifies
   production is serving the version.
2. Set the four variables on **Production** scope in Vercel. Nothing changes yet
   — a variable is only read at build time.
3. Redeploy production. A merge does it; so does the Vercel dashboard. Do **not**
   run `vercel --prod`.
4. **Verify by content**: Actions → *Verify production* → Run workflow, with
   `expect: multiplayer`. It answers the two questions that look identical from
   outside — stale, versus right version wrong build — and it is the only check
   worth trusting, for all the reasons in the deploy section above. A session
   cannot do this by curl; read it out of the workflow.
5. Sanity-check the API separately from the bundle: a flag-on client against an
   unconfigured Production API looks like a working feature until you tap
   something, then 503s on every table action. `Verify production` checks the
   bundle only — it cannot see the server flag or the store.

Rolling back is the same variables in reverse plus a redeploy, and
`Verify production` with `expect: solo` confirms it. Instant Rollback is still
the move if production is actively broken.

### What it actually cost, and what to do differently

Every one of the four variables was set correctly on the first try except one, and
finding that one took **three deploy cycles** — because the failure is a single 503
that says a thing is missing without saying which thing. Recorded so nobody pays it
again:

- **The real bug was `KV_REST_API_TOKE`** — a missing trailing `N`. That is why
  0.45.1 exists: `no-store` now returns a `details` object naming which accepted
  keys are present and which near-miss names are set. **Read that first.** It
  distinguishes a typo from a prefix from a wrong scope from a stale deployment,
  all of which were previously the same response.
- **Expect a prefix, and do not fight it.** Vercel's marketplace integration
  auto-prefixes when the bare name is already taken on the *project* — which it is
  here, because the Preview database owns `KV_REST_API_URL`. Trying to clear the
  prefix fails with "no environment variables created", which is a name collision
  reported obliquely. Add plain, Production-scoped variables by hand instead;
  Vercel keys on name *plus* environment, so they coexist with Preview's.
- **`VITE_MULTIPLAYER` must NOT be marked "sensitive".** Sensitive variables reach
  functions at runtime but are withheld from the *build step*, and this is the only
  build-time one of the four. Marked sensitive, it produces a solo-game bundle
  sitting in front of a fully live API — every signal green, feature absent. The
  other three are runtime-only and sensitive is fine. Sensitive also means you
  cannot read the value back to copy it: **get the token from the Upstash console's
  REST API panel**, not from Vercel.
- **Never use `KV_REST_API_READ_ONLY_TOKEN`.** The integration provisions it, the
  name is plausible, and `hasRealStore()` deliberately does not accept it. The store
  writes on every table action (`HSET`/`PEXPIRE` inside each `EVAL`), so a read-only
  token would pass the gate and fail at the first write — much worse than failing up
  front. `REDIS_URL` is likewise the non-REST connection string and unusable by
  `@upstash/redis`.

### Verifying it, layer by layer

Four independent checks, because each is blind to what the others see. This is the
sequence that confirmed the live promotion:

| layer | check | pass |
|---|---|---|
| build flag | Actions → *Verify production*, `expect: multiplayer` | `8 references to the tables API` |
| server flag | `GET /api/tables/zzzzzzzz/state?playerId=test` | not `multiplayer-disabled` |
| store credentials | same request | `404 no-such-table` |
| store *persistence* | create a table on www, reload `/t/<code>` in a new tab | the table is still there |

The last row is the one only a human can do, and it is the one that matters most.
A clean 404 proves the credentials are **valid** — nothing in the read path catches,
so a bad token throws out of `mutate` and surfaces as a 500 rather than a tidy JSON
404 — but only a table surviving a second request proves a warm isolate is not
quietly on the in-memory fallback. That failure reads as data loss, not as
misconfiguration, which is why it gets its own step.

### Consequences, now true

- **"Play with friends" is public to every visitor**, not just people holding a
  link. Both entry points read the same flag (`src/App.jsx`), by design: a shared
  link that opened on production while the API had no store behind it would fail
  worse than not existing.
- **`beta` is no longer a different build from production.** It keeps its value as a
  ref that can be moved independently, but anything elsewhere calling it "the only
  place multiplayer exists" is historical. `verify-beta.yml` still works unchanged.

Unchanged rules:

- **Never run `vercel --prod`.** Not from a terminal, not from an agent session.
  Production deploys happen exactly one way: merging a PR into `master`.
- **A stale local `master` is a real hazard here.** `git checkout master` can land you
  dozens of commits behind without complaint, and the working tree then looks like a
  much older engine. Prefer `git fetch origin master && git checkout -B <branch>
  origin/master`, and check `git log --oneline -1` before believing anything you read.
- **`master` is protected by a ruleset**: no direct pushes, PR required at 0 approvals
  (a non-zero requirement locks a solo developer out of merging their own PRs).
- **If prod ever breaks**, don't debug forward — use Vercel's Instant Rollback to the
  last good production deployment, then fix on a branch. `v0.7.3` is always a valid
  rollback target.
- **Env vars are scoped Preview vs. Production separately.** Beta tables and any live
  tables must never share a state store.
- **`gh pr merge --delete-branch` silently fails in this repo** (a worktree error
  swallows it), so merged branches accumulate. Do NOT audit them with
  `git branch -r --merged origin/master` — it under-reports badly, for the reason
  given under "Things a session will try and cannot do" below.
  `v2` is kept deliberately as a landmark; do not delete it in a tidy-up.
- **`beta` has its own verifier now: Actions → "Verify beta" → Run workflow**
  (`.github/workflows/verify-beta.yml`, `workflow_dispatch`). `release.yml` requests
  the beta build but cannot wait for it — Vercel builds beta asynchronously while that
  job is already blocked on production — so "requested" was the last honest thing it
  could say, and its summary printed a curl nobody ran. The workflow checks two
  failures that look identical from outside: **stale** (hook fired, build never
  landed) and **flag-off** (build succeeded without `VITE_MULTIPLAYER=1`, so beta is
  serving the solo game while the commit status, the version and the deployment all
  report green). It tells you which. The flag-off discriminator is `/api/tables/` —
  the multiplayer API surface, whose call sites are all eliminated from the flag-off
  build; measured at v0.44.0 it is 0 occurrences flag-off against 8 flag-on. If you
  ever need a different discriminator, pick a structural string, not a UI label
  somebody can reword without knowing that file depends on it.
- **BOTH verifiers were unable to report a flag-off build until 0.58.6, and the
  reason is a shell gotcha that will bite again.** They count the discriminator
  with `grep -o ... | wc -l`. `grep` exits 1 when it matches **nothing**;
  `set -o pipefail` (already at the top of these scripts) makes that the
  pipeline's status; GitHub runs every `run:` step under `bash -e`. So on a zero
  count the script **aborted at the assignment**, one line before the `if` that
  interprets it — no diagnostic, no summary, just `Process completed with exit
  code 1`.

  Read that again with what a zero means here: **a zero count is not an edge
  case, it is the alarm.** The flag-off build these workflows exist to catch is
  precisely the case in which they died silently. They had never fired only
  because a flag-on bundle always matches `/api/tables/` 8 times, so the bug sat
  in the one branch nobody had exercised.

  The audio check made it visible, because there the healthy answer IS zero:
  *Verify production* failed on **every** dispatch from the day the check was
  added (2026-07-31) until 0.58.6 — three runs, each a bare exit 1 — while
  production was in exactly the intended state the whole time. Fixed with
  `|| true` on all three counting pipelines.

  **The general rule, for any workflow here:** a `grep | wc -l` whose count may
  legitimately be zero needs `|| true`, or `bash -e` + `pipefail` will kill the
  step before it can report the thing you are counting. `release.yml` is safe by
  accident rather than design — its greps sit inside `if` conditions and a
  function called from `if`, where `-e` is suspended. Do not copy a counting
  line out of one of these files without the `|| true`.

  Verified live after the fix: production prints `audio is absent on production
  (0 references to daily)` — a line that had never once appeared — and beta
  prints `multiplayer is present (8 references)`. Note beta's run is a *control*,
  not a demonstration: its count is non-zero, so it proves only that the fix is
  inert on the path that already worked. The zero-count path is verified by
  replaying the step's logic against synthetic bundles, because confirming it
  live would mean deliberately shipping a flag-off build.

## Skills, and what the evaluation of them showed

`.claude/skills/analyze-sheepshead-hand/` is the procedure for "was that play
right", and as of 2026-08-04 it is the only one — see "Analyzing a reported hand"
below for what was deleted and why.

**There is no committed eval set any more.** The four-case set lived at
`.claude/skills/hand-analysis/evals/evals.json` and went with that skill, so
nothing currently checks a change to the surviving skill. That is a real gap:
the cases were each aimed at a way hand analysis goes wrong rather than at the
happy path, and two defects in this repo's own work were caught by them rather
than by review. Recover the file from git history before editing the skill —
`git show eedd846:.claude/skills/hand-analysis/evals/evals.json` —
and note the cases were written against the deleted skill's tool, so they need
re-pointing at `scripts/pimc.mjs` before they will run.

**The result is worth knowing before writing another skill here.** Measured
against a no-skill baseline over nine runs: answer QUALITY was never the
differentiator — every run in both arms got the hand right. This repo's own
documentation (engine.js's comments, the harness headers, this file, the
MEASURED AND NOT SHIPPED notes) already walks a capable reader to the right
procedure, and the baseline beat the skill outright on one case. What varied
wildly was SCOPE: 4 to 30 minutes on comparable questions, depending entirely on
whether the agent stopped once the question was answered.

So a skill here earns its place by carrying (a) the handful of facts written
nowhere else and (b) an explicit instruction to stop. Adding "answer the question
and stop", naming the harnesses not to reach for, took one case from 225 tool
calls to 36. Re-teaching what the codebase already teaches is where the time goes
without buying anything.

**Two defects in this session's own work were caught by the evals rather than by
review**: a summary line that printed a win-rate delta as an absolute value and
so read backwards on exactly the tradeoff it existed to surface, and a first
corpus ranking contaminated by clairvoyant decisions that would have been
reported as engine errors. That is the strongest argument for restoring an eval
set rather than leaving the surviving skill unchecked.

## Conventions established this session (keep following them)
- **Open a pull request whenever there is finished work to check in, without being
  asked, and merge it once the tests pass.** Standing order as of 2026-08-03.
  `master` is protected and takes no direct pushes, so a branch with no PR is not
  "work in review", it is work parked where nothing will ever pick it up. Do not
  wait to be told; the default agent instruction elsewhere ("no PR unless asked")
  is overridden here.

  **Turn on auto-merge as soon as the PR exists — that is the default, not a
  special case.** Standing order as of 2026-08-04. `enable_pr_auto_merge` on the
  PR you just opened; GitHub then merges it the moment the required check goes
  green, with no session sitting on the PR waiting to press a button. This is
  strictly safer than merging by hand against the rule two bullets down: auto-merge
  cannot fire on a red check, so it can never merge over one.

  Two things it does NOT do, and both are still yours:

  - **It does not fire when CI never queues.** Actions genuinely lags here (see
    below), and a PR whose required check never started will sit under auto-merge
    indefinitely — the one case where auto-merge is worse than a hand merge,
    because nothing is failing and nothing is happening. That is what the
    "green local run while CI is missing" escape hatch below is for, and taking
    it means merging manually.
  - **It does not watch `master` afterwards.** Auto-merge gets the PR in; it says
    nothing about whether `Release` went green and the deploy shipped.

  "Once the tests pass" means the repo's own suites, and what counts is
  spelled out because the failure modes differ:

  - `npm test` green locally is the bar for merging — every suite, 0 failures,
    plus `npm run build`. For engine/AI changes add the measurement the change
    is claimed on (`abtest`, `coalitiontest`, `firingtest` — whichever answers
    the question), and check its null control really came back zero.
    - **`npm test` is `scripts/runtests.mjs` since 0.58.4 — a worker pool, not a
      chain.** ~36s on 4 cores against 313s sequential. Read its header before
      changing it: `gradetest` runs alone on purpose, because it asserts a
      timing ratio whose numerator is a single measurement and so inflates under
      contention. Adding a suite to `package.json` without adding it to the
      runner FAILS the run rather than silently skipping it, which is the point.
      - **It is at the packing limit as of 0.59.2, so do not start by trying to
        schedule it better.** 133s of work over 4 workers is a 33s floor and the
        longest suite is 28s, so 36s is within ~10% of what the box can do. The
        remaining time is real: profiled, every heavy suite is dominated by
        `endgameValue`, i.e. by playing out the hands it exists to play out.
        Faster from here means less coverage, and CI spends ~30s on this inside
        a job that costs over a minute to check out and install.
      - **A suite's `weight` is load-bearing and goes stale silently — or it
        did.** `rendertest` was declared at 7 and measured 33, so longest-first
        scheduled the longest suite tenth and it ran alone at the end with three
        cores idle: 71s wall against a 48s critical path. The file's own comment
        ("a stale weight costs a little packing efficiency and nothing else") is
        what stopped anyone checking. The runner now warns when a suite overruns
        its weight by 2x — a warning, never a failure, because a timing gate on
        a loaded CI box is the marginal-test trap this repo has paid for twice.
      - **A wedged suite is killed and named** (watchdog at 8x weight, floor
        180s). Before 0.59.2 a hang took `npm test` down silently until the CI
        job timeout killed the job from outside, which prints no per-suite
        output at all — so a hang and a never-scheduled job looked identical in
        the log. See the next bullet for why that mattered.
    - **The UI is tested now, as of 0.58.5, and it was not before.** Every
      `.jsx` file was at 0% coverage and `useTableStream.js` had nothing at all
      — the file CLAUDE.md itself called the most likely to ruin a games night.
      Two suites, both leaning on `scripts/lib/domharness.mjs` (jsdom, a clock
      you can advance, a fake `EventSource`):
      - `tablestreamtest` — the reconnect loop: `since=` on reopen, stale and
        redelivered frames dropped, handoff vs. error, backoff doubling and cap,
        both watchdogs, the visibility resume, `gone` ending the loop, teardown.
      - `rendertest` — mounts every screen, modal and all five felt rotations
        against real engine states and requires that none throw. It loads JSX
        through Vite's own `ssrLoadModule`, deliberately: a second transform
        could disagree with the real build and then the suite tests something
        nobody ships. `no-undef` catches the two bugs eslint.config.js
        describes; this catches the ones with no free identifier in them.
        **Its fixture seed is chosen, not arbitrary** — the `grades` object comes
        from a real `gradeHandPlays`, an exact double-dummy solve whose cost
        ranges from 275ms to 89 SECONDS depending on the deal (measured over 21
        seeds). The old seed cost 18s, three quarters of the suite. Seed 11 costs
        275ms and still produces both a `best` and a `worst`, so nothing is
        mocked and nothing is skipped. If this suite balloons, check the grade
        cost first and re-scan for a cheap seed; do not stop grading.
      - **Both were mutation-tested when written, and should be again if
        edited.** Each passed on the first run, which is exactly when a suite
        deserves to be distrusted — a smoke test that cannot fail is worse than
        no smoke test, because it reads as coverage. Reintroducing the historic
        `ScoresModal` bug fails `rendertest`; dropping `since` fails
        `tablestreamtest`.
    - **`npm run coverage` runs TWO passes and you must not merge them.**
      `rendertest` loads app modules both natively and through Vite's SSR
      transform, so c8 sees two irreconcilable copies of the same path and the
      merged report UNDER-reports: `engine.js` measured 92.67% from `undertest`
      alone, 57.36% from `rendertest` alone, and **62.43% merged** — impossible
      for a union, and low enough to send somebody off fixing a problem that
      does not exist. The logic pass owns the `.js` answer, the UI pass owns the
      `.jsx` answer, and `scripts/coverage.mjs` keeps them apart on purpose.
      Nothing here gates anything: a coverage number is a good question and a
      bad gate. If the logic pass ever shows `engine.js` near 62%, the split has
      regressed — that is the canary.
    - **The npm-script sample sizes are CI-sized, not measurement-sized.**
      `npm run coalitiontest` and `npm run firingtest` pass 500 hands, which is
      plenty for an exact-zero null control and far too few to measure anything.
      To measure, invoke the script directly with your own counts, exactly as
      each file's usage line describes. The full-width null sweep runs nightly
      in `.github/workflows/harness-nulls.yml`, which also asserts `abtest`'s
      null — `abtest.mjs` itself prints and never exits non-zero, deliberately,
      so that a negative measurement is an answer rather than a failed command.
  - **Prefer CI's verdict when there is one, but a check that never queued is
    not a failing check.** Actions genuinely lags here, sometimes twenty minutes
    and several pushes (see "Things a session will try and cannot do"). Waiting
    for it is right; treating its absence as a red light is not. Merging on a
    green local run while CI is still missing is acceptable — say so in the PR
    when you do it, so the record shows what the merge actually rested on.
  - **A CI job can go red WITHOUT RUNNING, and it looks exactly like a hung test
    suite. Check before you debug.** On 2026-08-06, runs 131/132/134/135 each
    burnt exactly 15.0-15.1 minutes and reported `cancelled` — two of them on
    `master`, so the beta deploy was silently withheld twice. Nothing was slow.
    Every one of those jobs sat in the Actions queue and was cancelled at the
    `timeout-minutes` mark without ever being given a runner; run 133, in the
    middle of them, got one and went green in 2.1 minutes on the same code.
    The tell is in the job, not the log, because a job killed from outside
    prints no per-suite output to read:

    | what you see | means |
    |---|---|
    | no `steps` array, `runner_id: 0`, `runner_name: ""` | never scheduled. Re-run it; nothing is wrong with the repo. |
    | `steps` present, one red | a real failure — read that step. |
    | `steps` present, one hung | `npm test` names the wedged suite itself since 0.59.2. |

  - **`workflow_dispatch` on `ci.yml` runs the tests but does NOT unblock the
    merge.** `ci.yml` carried a comment calling that trigger "two lines to make
    that self-service", and it is only half true. Measured on #138 (2026-08-06):
    an hour and three pushes after the PR opened, no `pull_request` run had
    queued at all, so CI was dispatched by hand. The run got a runner in 5
    seconds, went green in 57, reported a check named exactly
    `lint, tests, build` against the PR head SHA, and listed the PR in its own
    `pull_requests` array. The merge was still refused with
    `405 ... Required status check "lint, tests, build" is expected`.
    So dispatch is worth having — it answers "do the tests pass on this commit"
    when nothing else will — but **only a `pull_request` run satisfies the
    ruleset, and the only way to get one is to push a commit.** Deliberately
    recording the observation and not a mechanism: this file has been wrong
    before by writing down a tidy explanation that fit every observation and was
    not the cause (see the Actions-lag entry below).

    Get it with `actions_get` / `list_workflow_jobs` on the run. 0.59.2 raised
    the job budget to 45 minutes and moved the real bounds to step-level
    `timeout-minutes`, whose clock starts when the step starts — so queue time
    can no longer masquerade as a test failure. **The other workflows still have
    the old shape**: `release.yml`, `verify-beta.yml` and `verify-production.yml`
    are all on a 10-minute job timeout, and a queue-starved `Release` is the
    worst version of this, since it fails in the one place this repo reads as
    "the deploy never shipped". Not changed in 0.59.2 on purpose — a deploy
    workflow does not belong in a test-cleanup change — but it is the same bug
    waiting in a more expensive place.
  - **Do not merge over a red check, ever**, and do not merge to "see if it
    passes on master". Red is the one state that blocks, because of the next
    point. The bullet above is the exception that is not really an exception: a
    job that never ran is not a red check, it is an absent one.
  - **Watch `master` after the merge, not just before it.** `Release` is gated
    on CI *succeeding* on `master`, and a marginal test can pass on a PR and
    fail on `master` for the identical commit — which does not merely fail a
    check, it silently withholds the beta deploy and leaves production
    unverified. The merge is not the end of the job; a green `Release` run is.

  Anything genuinely irreversible or outward-facing beyond this — a production
  variable flip, a rollback, a repo-settings change — is still a human action
  and still gets asked about. This order covers merging ordinary work, not
  deploying by other means.
- **Watch every PR you open, without being asked.** Subscribe to its activity as
  soon as it exists, and stay subscribed until it is merged or closed. A PR here is
  not finished when it is opened: CI going red on `master` is what silently withholds
  the beta deploy (see the deploy section), so a failure nobody is watching for is a
  deploy outage that looks like nothing happening. Webhooks do not reliably deliver
  CI *success*, new pushes, or merge-conflict transitions, so pair the subscription
  with a self check-in about an hour out and re-arm it quietly while the PR is open.
  Drive it to green: a CI-failure wake ends with a pushed fix or a comment saying
  what is broken and why it is not yours to fix — never in silence. The awkward case is CI
  never *starting*: Actions can lag badly here (see "Things a session will try and
  cannot do"), so a missing check is not a failing one. Keep waiting and verify
  locally rather than announcing a blocker.
- **Version + changelog on every shippable change**: bump `package.json` version
  (semver), add a `## [X.Y.Z]` entry to `CHANGELOG.md` describing what changed and
  why, commit, fill in the real commit hash into the changelog in a small follow-up
  commit, push.
- **Verify before shipping**: build (`npm run build`) and, for AI/logic changes, run
  or extend a throwaway simulation script against `engine.js` before committing.
  (The specific "build in a scratch copy outside the synced folder" workaround from
  the Cowork sandbox — its output folder EPERMs on file overwrite — is a sandbox
  quirk, not a real project constraint. Ignore it in a normal local environment.)
- **AI changes are tuned empirically**, not guessed. `npm run simulate` reports pick
  rate, picker win rate, alone rate, schneider rate and avg points, but the harness
  that actually decides things is **`scripts/abtest.mjs`**: it runs a variant in ONE
  seat against four unchanged seats over identical shuffles, across several seeds.
  Read the sign and the seed count, not one number — a change worth keeping is
  consistent across seeds. It null-tests to exactly `+0.0000`, which is what makes a
  small result trustworthy.
  - **The null test proves the PAIRING, not reproducibility, and for a long time
    those deals were not reproducible at all.** Until 0.58.2 `dealWith` seeded-shuffled
    the cards *as `freshHand` left them* — already shuffled by `makeDeck`'s unseeded
    RNG — and a Fisher-Yates composes with the shuffle underneath instead of replacing
    it. So "seed 3" named a fresh population every run. The null test cannot catch
    this in any of these harnesses, because two identical arms play identically
    whatever deal they are handed and still difference to exactly zero. Fixed in all
    four (`abtest`, `coalitiontest`, `undertest`, `firingtest`) by shuffling from
    `ALL_CARDS`.
    **Any seed-level number recorded before 0.58.2 was a fresh draw and will not
    reproduce**, which is exactly how a 4-of-4 sweep result in 0.58.1 evaporated to
    4-of-8 on re-run. The paired comparison between arms was never affected, so the
    conclusions those numbers supported still stand — only their reproducibility was
    ever wrong. `undertest` was the sharper risk: it *asserts*, so it could have
    passed on a PR and failed on master for the same commit, which per the deploy
    section withholds the beta deploy rather than merely going red.
- **`scripts/firingtest.mjs` is the harness for a rule that fires rarely, and
  reaching for `abtest` first will tell you there is no effect when there is one.**
  Same paired A/B, split by whether the option actually changed a card. The probe
  runs against the CONTROL line of play — at each decision it asks whether the
  variant *would* have chosen differently — which counts the decisions the seat
  really faced; once the arms diverge, "would it differ here" has stopped being a
  question about the same hand. It prints the whole-hand `abtest` number beside
  the per-firing one on purpose, so the two get compared instead of confused.
  Read the per-firing figure WITH the firing rate: a big effect on a rule firing
  twice in ten thousand hands is still a rounding error.
  - **It was built twice on the same day, by two people who did not know the
    other was doing it** (0.49.0 for `guardFatTrumpBleed`, 0.58.1 for
    `OVERTAKE_SPEND_SECURITY`), which is the strongest argument that the
    denominator objection is real and not a rationalisation for a weak result.
    Both landed per-firing effects of the same size, +0.252 and +0.210, on rules
    whose whole-hand aggregates were flat or negative noise. **If a change you
    believe in reads as nothing in `abtest`, check the firing rate before
    concluding anything** — 0.58.1 spent an entire measurement pass concluding
    "not established" from a diluted number that was, undiluted, a 4.5 SE effect.
  - Null-test it by passing a variant that cannot fire: 0 firings, exactly
    `+0.0000`. `npm test` asserts that.
- **`scripts/coalitiontest.mjs` is the second harness, and you need it for any rule
  about co-operating with teammates.** A one-seat A/B structurally cannot see those:
  one defender can stand down while the other two still contest the trick, so that seat
  banks the saving and somebody else pays for it. Coalitiontest deals identical hands
  to both arms and applies the variant to EVERY DEFENDER, scoring the side. It also
  null-tests to exactly zero, and `npm test` asserts that.
  In 0.38.0 the two harnesses genuinely disagreed — abtest said +0.0128/seat/hand
  ahead in 8 of 8 while an unpaired `simulate` run said the defence lost 0.6pp — and
  the coalition test settled it. **Do not settle a disagreement like that by preferring
  a harness; build the one that answers the actual question.**
- **One `simulate` run is not evidence.** It is unpaired and uses fresh deals, so at
  3,000 hands the standard error on a win-rate difference is around a point. A 0.6pp
  "result" from it is noise, and it read as the exact opposite of the truth in 0.38.0.
  CLAUDE.md has said "aggregate simulation is the safety net, not the detector" for a
  long time; this is what that costs when ignored.
- **The AI now carries a belief, not just deductions.** `teammateProbability` is a
  calibrated distribution over who the partner is, `scripts/belieftest.mjs` checks it
  against ground truth per reliability bucket, and constants like `TRUMP_LEAD_ODDS` are
  **calibrated by sweeping them in that harness** rather than chosen. If you add a new
  piece of evidence, add it as a weight in `partnerWeight` and sweep it the same way —
  a belief that is not calibrated is a lie the play code will act on.
- **Aggregate simulation is the safety net, not the detector.** Every AI fix that has
  actually landed started from ONE hand a human flagged, was reproduced against the
  engine *before* anything changed, and was then pinned as a constructed assertion
  with a negative control. Several correct-looking diagnoses measured as pure noise;
  measure before believing.
- **"What should the AI do?" and "what should we OFFER a human?" are different
  questions, and the answer here is a PRODUCT call sitting on top of a measurement —
  do not read the two as one number.** `ALONE_HANDSTRENGTH` and
  `ALONE_OFFER_STRENGTH` are both **17** as of 0.46.0, and `aitest` asserts they are
  *equal* rather than ordered, so moving one without considering the other fails
  loudly. That is deliberately not what the measurement alone would say: over 20,239
  pickers who had a partner available, alone is behind by 1.9 points/hand at 17,
  negative in 4 of 4 seeds, and only turns positive at 18 — which is why the offer bar
  sat at 18 from 0.44.0. It moved because a person watching an opponent go alone on a
  hand their own screen refuses to offer reads as the game knowing something it will
  not tell them, and consistency was judged worth ~0.08 points per picked hand of
  bounded exposure. **If the win rate on human picks moves, 18 is the first thing to
  put back**, and if the AI bar is ever re-tuned, re-measure the offer bar in the same
  pass rather than assuming it follows.
  - The harness for that is the general shape to reuse for any "is this option worth
    offering" question: identical deal AND identical bury in both arms, differing only
    in the decision under test, every seat on the unchanged engine, scored on the
    picker's own `handDelta` (which already carries the 4x). It was **not committed** —
    it lives only in this session's transcript. Rebuild it as `scripts/alonetest.mjs`
    if the bar is ever revisited.
- Sandbox-specific network restrictions from this session (blocked `vercel.com`,
  `api.vercel.com`, `api.github.com`) are **Cowork sandbox allowlist limits, not
  real-world limits** — they most likely won't apply in Claude Code on your own
  machine. Don't assume they still apply; just try the direct approach first.

## What's already built (v0.1.0 → v0.7.2)
Mobile-first layout (locked viewport, no scroll-to-see-hand), a from-scratch AI
overhaul (card counting, trump-aware leading, defender ace-hunting, schmear tuning,
exact minimax endgame solve for the last 2 tricks, empirically-tuned "go alone"
aggression), version badge in the UI, a hand-end summary modal with per-hand and
cumulative score columns, a "Last Trick" modal redesigned as a mini table view
(mirrors the live play area layout), and a "Recap" modal — a full 6-trick ×
5-player grid with a leader/winner legend **and best/worst-play grading**: a
rollout-based evaluator (`gradeHandPlays` / `rolloutValue` in `engine.js`) that
replays a finished hand and flags the single best (`!`) and worst (`?`) decision of
the hand, using the AI's own policy as a consistent yardstick across all six tricks
(cheap, deterministic, no separate heuristic-vs-exact blending needed since
`aiChooseCard` already dispatches to the exact solver for the last two tricks).

## Analyzing a reported hand — use the skill

`.claude/skills/analyze-sheepshead-hand/SKILL.md` is the procedure, and it
triggers on its own when somebody asks whether a play was right. It routes to
`scripts/pimc.mjs` — Monte Carlo rollouts on `aiChooseCard`'s own policy, hands
under `scripts/scenarios/`.

**Analysis is READ-ONLY, and it is never part of `npm test`.** Both halves of
that are enforced rather than asked for, as of 0.59.2:

- **It does not change code.** The only file the workflow writes is the scenario
  under `scripts/scenarios/` — the transcription is the input, not a product.
  `src/`, `api/`, the harnesses and the workflows are off limits, *especially*
  when the analysis has just found a real defect. Finding one is the success
  condition; fixing it in the same pass is not, because an engine change here is
  tuned empirically and never guessed (paired A/B, a null control that came back
  exactly zero, consistent across seeds). One hand is where such a change starts
  and nowhere near enough to justify one. The skill states this in its own Scope
  section, which also carries the measured instruction to answer and stop.
- **It cannot be wired into CI.** `scripts/runtests.mjs` refuses any suite whose
  command runs, or whose entry file imports, `pimc.mjs` / `pimcsolve.mjs` /
  `pimcmine.mjs` / `minehands.mjs` / `gradedecision.mjs` / `scripts/scenarios/` /
  `scripts/hands/` — see the `ANALYSIS_ONLY` note there for the three separate
  reasons. The sharpest: a scenario is one person's transcription of one
  screenshot, so conscripting them into CI lets a misread card turn master red,
  and per the deploy section a red master does not merely fail a check — it
  withholds the beta deploy. The guard reads command lines and top-level
  imports; a transitive import would slip through. It is a tripwire, not a
  sandbox.

**There used to be a second skill, `hand-analysis`, and it was deleted on
2026-08-04.** It routed to `scripts/pimcsolve.mjs` (an exact double-dummy solve
per sampled world, hands under `scripts/hands/`) and collided with this one on
every request. Two things about that are worth carrying forward, because the
deletion did not make them untrue:

- **`scripts/pimcsolve.mjs` is still here and still used.** It was the deleted
  skill's tool, but `scripts/pimcmine.mjs` imports `scripts/lib/pimcsolve.js`
  for corpus cost-ranking, and the *Mine hands* workflow runs on it. Deleting
  the skill did not retire the solver, and `npm run pimcsolve` still works.
- **The two disagreed, and not by a little.** Run head-to-head on one decision
  (2026-08-04, Fonzie's 7♦ on trick 3 of the v0.48.0 hand 3; inputs kept at
  `scripts/hands/2026-08-03-fonzie-t3.json` and
  `scripts/scenarios/hand3-fonzie-7d.mjs`) they returned **opposite verdicts**.
  The exact solve priced a queen ~2.8 points ahead of the 7♦; the surviving
  rollout priced it 7.7 points behind. The split sat almost entirely in the 7♦
  line — the two methods disagree about how well the seats behind the picker
  punish a low trump, because the rollout's defenders are `aiChooseCard` and the
  solver's are perfect. So the surviving skill is the one that **inherits engine
  defects on exactly the lines you are usually questioning**, and its own
  SKILL.md warns that a candidate which secures a trick for its own side gets
  scored too harshly. Take a result that turns on that shape to `pimcsolve` by
  hand for a second opinion before acting on it.

The one thing worth repeating
here because it is the easy mistake: **the recap's double-dummy grade and PIMC
answer different questions**, and the grade is the wrong one for "how bad was
that". It solves the deal that happened, with every hand visible, so it forgives
a bad decision that got lucky and convicts a sound one that did not — measured
over 425 decisions it called 15% of decisions clean that cost a point or more,
and 9% mistakes that cost nothing. Report the PIMC number.

**PIMC spreads the called ace uniformly, and on a hand where the table has
already told you where it is, that is its own kind of hindsight-in-reverse.**
`assumePartner: <seat>` (added 0.59.1) conditions the sample on a read. It is
not a nicety: on `hand5-kopps-ah.mjs` the two runs give OPPOSITE verdicts on the
played card — second of four unconditioned, last of four pinned, 3.63 points and
9pp of win rate apart — because two sampled worlds in three had the ruffer on
the defence when a person at the table could see he wasn't. **Run both.** The
unconditioned number is the honest default; a card that only looks good there is
a card whose case rests on the player not having noticed something. Pinning is a
claim about evidence, so say what the evidence was.

That hand is also a live instance of a gap the engine documents about itself.
`PLAIN_TRUMP_LEAD_ODDS` is **MEASURED AND NOT SHIPPED** — a non-picker opening
with a low trump is the partner 60.4% of the time against a 25% base rate, and
the constant still ships at 1 because the only gate consulting the belief is the
schmear, and a low trump lead gets overtrumped nine times in ten so there is no
trick left to schmear into. Its comment reserves "the day something else
consults the belief in a spot a losing lead still matters." This is that day:
Bernie's 8♦ lead lost to a Q♥ and still decided a discard two tricks later, and
`teammateProbability` handed Kopps a flat 66.7% across all three candidates.
**Before concluding a seat was blind to something, ask the engine what it
believed** — `teammateProbability(g, viewer, target)` is cheap and it is
calibrated, and here it is the difference between "Kopps guessed wrong" and "the
engine cannot hear the tell Kopps was being asked to act on."

## The AI used to see your last two cards — FIXED in 0.54.0

Kept because the failure is worth recognising again, not because it is open.

`aiChooseCard` handed tricks 5-6 to `solveEndgameCard`, which recursed over
`g.hands` — all five — so from `tricksDone >= 4` every AI seat solved the REAL
deal rather than what its seat could know. In solo play that meant the four
opponents could see the human's last two cards, and nothing said so. Nobody put
it there on purpose: the endgame was built to be exact, and being exact meant
reading the true layout.

**How it was found is the transferable part.** Not by reading the code — by a
number that could only be true if something was wrong. Ranking corpus decisions
by cost, every trick-5 row had a double-dummy cost of exactly zero, which is
impossible unless the mover already knew the answer. Then demonstrated rather
than argued: move one card between two OTHER seats, leaving the deciding seat's
hand and every public fact identical, and its choice changed.

**Now:** the endgame samples deals from the seat's own information set —
respecting hand sizes, shown voids, and that the called card cannot sit with the
picker — and solves each exactly, averaging over them. Seeded from the position
via `handSeed`, so choices stay reproducible and no hand-playing test goes flaky.

- **Measured cost: +0.0430 stake/seat/hand, ahead in 3 of 3 seeds**
  (`abtest --opt endgameClairvoyant=true`), about 1.6 card points a hand. A real
  strength loss, taken deliberately — an opponent that can see your hand is not a
  difficulty setting, and a player who suspects it will never un-suspect it.
- `endgameClairvoyant` restores the old path. It is the measurement control and
  the rollback, not a supported mode.
- **`npm run clairvoyancetest` is now a LEAK DETECTOR** — it asserts the choice
  does not move when cards are shuffled between seats the deciding seat cannot
  see (0 of 251 probes, against 22 before). It is the only test that can catch
  this class of regression, because a hand reference quietly reintroducing the
  real layout would fail nothing else: playing better with more information looks
  exactly like playing better.
- Consequence still live: `pimcmine` excludes tricks 5-6 from its ranking. That
  was correct while the endgame was clairvoyant and is now over-cautious — those
  decisions became honest data in 0.54.0 and the exclusion should come out.

## The strategic pivot (why the roadmap looks the way it does)
Explored "chess.com for Sheepshead" as a real ambition, not a bit — see the
brainstorm/interview notes at the bottom of `ROADMAP.md` for the full reasoning.
Short version: the group used to run a biweekly Thursday Sheepshead night during the
pandemic on get61.com + a separate Google Meet, coordinated over text. It failed more
often than not — not from lack of interest, but because a *scheduled* commitment
kept losing to spontaneous life events, and getting 5 people to commit in advance was
the real bottleneck. On the best nights 6-7 people wanted in and the tool couldn't
gracefully rotate people through 5 seats. Critically: **the Google Meet was doing
more emotional work than the card game** — "the game is an excuse to fill the quiet
spaces." That reframed the whole roadmap: the near-term goal isn't "worldwide
matchmaking," it's "will the friend group actually play together tonight, on a whim,
no schedule." Voice/video is launch-critical, not a later add-on. AI-filled seats
mean there's no minimum headcount to hit before starting is "worth it."

The **learn-to-play tutorial** (important for the long-term worldwide-growth goal) is
deliberately sequenced *after* the multiplayer core — not because it's low priority,
but because it only pays off once there's somewhere to send a new player (public
tables, which are `Later`). It's protected architecturally: multiplayer must be built
as an *additional* mode alongside the existing local solo-vs-AI mode, reusing the pure
`engine.js` for both, not a rewrite that entangles local and networked state — so
tutorial mode can slot in later the same way solo mode works today (no backend, no
network dependency, instant to try).

## Where to pick up next

**Status: multiplayer is built and playable.** Shareable `/t/<code>` table links, seat
join/leave/away, server-driven AI seats, an SSE stream, and the full rules including
calling under and calling a ten. The backend question below was answered long ago —
**Vercel serverless + Upstash Redis**, with every write going through the
compare-and-swap loop in `src/store/mutate.js`.

**Multiplayer is LIVE on www.noschnitz.com as of 2026-07-31**, verified by bundle
content and by a table surviving a reload. See the promotion runbook above — both
for how it was checked and for the rollback.

Genuinely open:

0. **The skill collision is RESOLVED — `hand-analysis` was deleted 2026-08-04**,
   leaving `analyze-sheepshead-hand` as the only one. See "Analyzing a reported
   hand" above for what that costs: the exact-solve second opinion is no longer
   a skill (though `scripts/pimcsolve.mjs` is still there and still driving
   `pimcmine`), and the repo's only committed eval set went with the deleted
   skill. Restoring an eval set for the survivor is the open piece.

0. **The first games night on production is the real test, and nothing else is.**
   Every multiplayer bug worth fixing so far came from a person on a phone, not
   from a harness. Two things are newest and least exercised: the arrival flow
   rewritten in 0.45.0 (watching while queued, a full table queueing instead of
   refusing) and the Production Upstash database, which has never held a real
   table. Watch specifically for somebody joining mid-hand and somebody arriving
   when all five chairs are taken.
1. **COM-1 voice/video (#4, #19-22) and COM-2 presence (#5, #23-24)** are the only
   open epics. On voice/video, the standing lean is to embed something existing (a
   Jitsi room per table, or an auto-generated link) rather than own WebRTC — the goal
   is testing the core hypothesis fast.
2. **Multiplayer has thin real-device coverage.** `scripts/soaktest.mjs` drives
   five-human tables through the real handlers and is a good net for server bugs, but
   every bug worth fixing so far came from real people playing on real phones. Mid-hand
   join (MP-2.3) in particular has synthetic coverage only — and 0.45.0 just
   changed what that path DOES (an arrival now watches the table instead of
   waiting on a card, and a full table queues instead of refusing), so the thing
   with the least real-device coverage is also the thing most recently rewritten.
   Watch it on the next games night specifically: somebody joining mid-hand, and
   somebody arriving when all five chairs are taken.
   - **First real multiplayer session: 2026-07-30. Two humans, three AI seats, ~20
     hands, no stalls.** The headline is not that it worked, it is *what shape it
     worked in*: the table filled to five with only two people in the room. AI-filled
     seats were bet on specifically to remove the "we need five before it's worth
     starting" barrier that killed the get61 era, and on the first real outing that
     bet paid. Do not read it as coverage — two humans is not five, nobody joined
     mid-hand, and nobody backgrounded a phone for long. The next session is the one
     that tests those.
3. **Nothing from a multiplayer table is recorded.** `recordHand()` is called in
   exactly one place — `src/Sheepshead.jsx`, the solo screen. `TableScreen.jsx` never
   calls it, so `/api/hands` collects nothing from real tables. That is the corpus
   built *because* "both AI fixes that shipped this week were found by reading one
   reported hand at a time," and the richest possible source of hands does not feed it.
   Not a one-liner to fix: all five clients would record the same hand from different
   seats, so it needs dedup, and `handLog.js` says in its own header that collecting
   other people's play needs their consent. Worth doing properly, not hastily, and
   never in the hours before a games night.
   - **Rank it by what mistakes COST with the same workflow, `analysis: cost-ranking`**
    (`scripts/pimcmine.mjs`). The default `outplays` pass ranks by exact
    double-dummy cost, and that ruler is mis-calibrated in both directions —
    measured inside one trick of the 2026-08-02 hand, it scored a 4.3-point error
    at zero and a 0.9-point error at six. It is the right tool for "did this seat
    find the best card" and the wrong one for "which mistakes are worth fixing",
    so any worklist sorted by it has the wrong things at the top. The cost pass
    re-prices every decision under uncertainty and ranks decision SHAPES by total
    cost. Its control is paired and nulls to exactly 0.0000; the unpaired
    seat-vs-seat version measured +0.06 and was measuring role, not skill.
    A session can also run it without the corpus at all — `--selfplay N` deals
    clean engine-vs-engine hands, which is a fine source for the engine's own
    error classes and no source at all for a human's.
  - **Read the corpus with Actions → "Mine hands"** (`.github/workflows/mine-hands.yml`,
     `workflow_dispatch`). A session cannot fetch it — `beta.noschnitz.com` is a 403
     CONNECT policy denial, the same wall as the deploy checks — so this exists for the
     same reason `verify-beta.yml` does. It needs `HANDS_READ_TOKEN` as an **Actions
     secret**, which is a separate thing from the Vercel environment variable of the
     same name; copy the value across. `GET /api/hands` answers 404 both when the
     server's token is unset and when the one given is wrong, deliberately, so a 404
     tells you nothing about which.
   - **Mining is bounded by `--budget-min`, not by how many hands you ask for.** An
     exact grade of every decision costs seconds a hand — ~24s on a slow box, and
     **measured at ~16s/hand on a GitHub runner (131 hands in 35 minutes)** — so a
     thousand hands is hours, not minutes. It takes the newest first when the clock is
     bounded and reports what it did not reach. The `--selftest 30` preamble is a
     further ~7 minutes on a runner; that is the price of checking the instrument
     before believing it, and it is why the self-test is not in `npm test`.
   - **Next session's cleanup list, in the order that pays.** The collection and
     analysis path works end to end now, so what is left is coverage and rigor:
     1. **Point mining at www** and re-census. Beta is historical; www is where play is.
     2. **Record multiplayer hands** (the parent item above). 131 solo hands over four
        days is the ceiling on what solo collection produces; a five-seat table produces
        five perspectives on every hand. Needs dedup and consent, per `handLog.js`.
     3. **Give `minehands` a significance story.** It reports a signed total and nothing
        about spread, so a net built from two heavy tails reads the same as a real edge.
        It should report the per-decision distribution, or bootstrap a CI, so that "+72"
        cannot be quoted as a finding. This is the gap that made the 2026-08-02 run
        need a human to say "that is noise."
     4. **Make the feature table honest about double-counting** — either report
        decisions-per-cluster distinctly from features-per-cluster, or drop features
        that only co-occur with a stronger one.
     5. **Consider grading from trick 2** for cluster-hunting. Trick 1 dominates the
        current table and is the position where DD bias is largest; excluding it would
        tell you whether anything survives without it.
   - **What the corpus can answer is narrower than it looks.** Every record is one
     human against four AI seats, so a cluster is evidence about the engine and never
     about a table. And per the census, a corpus whose newest `version` is several
     releases old means collection broke — not that nobody played.
   - **There are TWO corpora since the promotion, and reading the wrong one looks
     exactly like nobody playing.** Preview and Production hold separate Upstash
     databases by design, so beta has everything up to 2026-07-31 and www has real
     play from then on. The workflow takes the host as an input and stamps it on the
     census; the default is beta because that is where the history is, and it should
     move to www once www has more. Do not merge the two without reading the version
     field — they are hands against different builds, which is what that field is for.
   - **THE CORPUS HAS BEEN MINED ONCE, 2026-08-02, and the answer was "no signal".**
     131 hands off beta, 126 gradeable, 445 real decisions, 142 disagreements with the
     engine. Net **+72 points to the human over 142 disagreements** — which is noise,
     and the shape of it is the point: **87 of the 142 (61%) cost exactly the same
     either way.** Of the 55 that mattered, the human was better 31 times at +9.2 avg
     and the engine 24 times at −8.9. 31-vs-24 is within one SD of a coin flip
     (expected 27.5, SD 3.7). Both sides make real mistakes at the same rate and size.
     - **Read that as a genuine result, not a failed experiment.** "No large systematic
       gap against a competent human" is worth knowing, and it is the strongest claim
       55 decisions can support. Finding subtler stuff needs an order of magnitude more
       hands, which is why the multiplayer-recording item above is the real unlock.
     - **The one lead, and why it is probably a mirage.** `trick=1` had the highest win
       share of any feature (38%, 13 of 34) and the three biggest single-decision gaps
       in the corpus were all trick 1, all second-or-third to act with an opponent
       holding, all the engine picking the wrong trump weight — twice under-committing
       (a beatable queen or a jack where the boss card was right), once over-committing
       (burning a queen where a discard was right). Opposite errors, so not one rule.
       **Trick 1 is exactly where double-dummy flatters the human**, since nothing is
       known yet and DD judges with all five hands visible. Trick 1 topping the table is
       what the bias alone would produce. Cheap to check, do not assume it survives.
     - **The feature table double-counts and will fool you.** Every decision emits seven
       features, so one big-delta decision lights up seven rows. Most of that table is
       the same handful of decisions viewed from different angles. Read the examples
       under it, not the row totals.
   - **Beta stopped collecting on 2026-08-01** — 41/45/40 hands on Jul 29/30/31, then 5,
     then nothing. Not a bug: the promotion moved players to www, whose hands go to a
     different database. **Point the next run at `source: www.noschnitz.com`.** Beta's
     corpus is now a fixed historical artifact spanning nine engine versions
     (0.31.0 → 0.45.2), which is itself a limit on what it can say.
   - **Whatever `total` says is an undercount.** The tail-drop bug (fixed in the same PR
     that added this workflow) was live for the entire beta collection window, so every
     device that stopped mid-batch silently kept up to four hands.

   - **Two independent passes now agree that double-dummy flatters the human, and
     that is the same fact from two directions.** The mining run above reasoned it
     out — trick 1 tops its table because nothing is known yet and DD judges with
     all five hands visible — and the cost ranking below measured it: DD
     overstates cost about 2.3x on average and errs in BOTH directions. So the
     "no signal" result is if anything understated; some of the human's 31 wins
     are the bias, not the human.

3b. **The engine's own error classes are now measurable without the corpus.**
   `npm run pimcmine -- --selfplay N` deals clean engine-vs-engine hands and
   ranks decision shapes by cost under uncertainty. First run, 425 decisions:
   the exact double-dummy grade OVERSTATES cost roughly 2.3x on average (2.09
   against 0.89) and is wrong in both directions — it called 13.6% of decisions
   clean that cost a point or more, and 11.5% mistakes that cost under half a
   point. Leading is the most expensive decision shape (1.36/decision against
   0.46 when an opponent holds the trick). Treat that as a hypothesis: the
   feature buckets are not mutually exclusive and there are no error bars on
   them yet.

4. **`src/useTableStream.js` is covered as of 0.58.5** (`npm run tablestreamtest`, 53
   assertions, 100% of statements) — this entry used to say it had no automated coverage
   at all, and that is no longer true. It is still the file most likely to ruin a games
   night, because a backgrounded phone loses its connection and its timers at the same
   time, and a test can only cover the failures somebody thought to write down.
   **A suite is not a substitute for the flight recorder** (`src/streamLog.js`, readable
   from the in-app menu), which exists because this class of bug is found in the wild
   rather than at a desk. If someone reports a frozen table, still get that log — and if
   it shows a failure mode the suite does not model, that is a case to add.
5. **PAT rotation is still open.** A GitHub PAT was used inline in shell commands in an
   early session and flagged for rotation. Assume it may no longer be valid, and note
   that making the repo private would NOT be the remediation — private does not undo
   public. Rotating the token is the fix.
   - **The secret-scanning pass over history has never been run**, and it is the first
     thing to do if this is picked up again: it answers the question rotation doesn't,
     namely whether the token ever landed *in a commit* rather than only in a shell
     invocation. It was offered twice in earlier sessions and declined both times, so
     nobody should assume from the silence that it came back clean.

## Things a session will try and cannot do

All of these were established the expensive way. They are recorded so the next session
doesn't spend a turn rediscovering them.

- **A session may not be able to fetch noschnitz.com at all.** In the Claude Code
  remote environment (2026-07-30) the egress proxy answered `403` to CONNECT for both
  `www.noschnitz.com:443` and `beta.noschnitz.com:443` — an organization policy denial,
  logged as `connect_rejected` in `curl -sS "$HTTPS_PROXY/__agentproxy/status"`. So a
  session **cannot** do the one check this project insists on, verifying a deploy by
  bundle content. Do not route around it to the same host by another tool. Read the
  answer out of CI instead, which can reach it: `release.yml`'s "Make sure production
  actually deployed" step logs what www is serving, and the "Verify beta" workflow does
  the same for beta. That is *why* the beta verifier exists as a workflow rather than a
  shell one-liner in a transcript. Note this is a different limit from the Cowork
  sandbox one noted above — check the proxy status before assuming either applies.

- **Repo visibility cannot be changed from an agent session.** The agent proxy refuses
  repository-settings writes outright, independent of token scope:
  `PATCH /repos/jacobdixon/noschnitz {"private": true}` →
  `403 {"message":"Repository settings writes are not permitted through this proxy."}`.
  The GitHub MCP server exposes no repo-settings tool either. Doing it by hand is
  Settings → Danger Zone → Change repository visibility. **Add anyone in the group who
  reads the issue board as a collaborator BEFORE flipping** — `ROADMAP.md`'s "Now" bucket
  lives in GitHub Issues, and those go private with the repo, along with tags and
  releases. Staying public was an explicit decision (2026-07-28), not an oversight.
- **Remote branches cannot be deleted from a session either** — the git proxy accepts the
  push and drops it, reporting `send-pack: unexpected disconnect` followed by
  `Everything up-to-date`, which reads like success. There is no delete-branch tool in the
  GitHub MCP set. Combined with `gh pr merge --delete-branch` silently failing (above),
  that is two of the three cleanup routes quietly not working, which is why merged
  branches accumulate here. Deleting them is a human action.
  `git branch -r --merged origin/master` **under-reports badly** — it listed 2 of 14
  genuinely-merged branches, because squash-merged tips are never ancestors of master.
  Compare each branch tip against the head SHA its PR merged instead. On that API note:
  every PR in this repo reports `merged: false`; `merged_at` is the field that tells the
  truth.

- **GitHub Actions can take many minutes and several pushes to start on a session's PR.
  Do not conclude that it never will.** On #120 (2026-08-02) the PR opened at 23:09 and
  `ci.yml` — `on: pull_request`, and the check the merge rules require — had still not
  queued a run after pushes at 23:15 and 23:23. Vercel built and reported success on
  every one of them, so events were plainly reaching GitHub; `mergeable_state` sat at
  `blocked` on a required check that did not exist. It finally queued at 23:29, on the
  fourth push, twenty minutes after the PR opened.

  Recorded mainly for the wrong conclusion drawn in between, which was written into this
  file and had to be taken back out an hour later. Every CI run in this repo's history
  shows `actor: jacobdixon (User)`, while a session's commits arrive through the agent
  git proxy and its PR is opened by the GitHub App — and GitHub genuinely does suppress
  workflow triggers for app-authored events. That is a tidy, checkable-looking story
  which fits every observation available at the time, and it is **wrong**: the run that
  eventually started came through the same proxy under the same identity as the ones
  that did not. An explanation that accounts for the evidence is not the same as a
  demonstrated cause, and this file is the wrong place to put the difference.

  So when the check is missing rather than red: keep waiting, push again if there is
  something real to push, and check by head SHA rather than trusting one poll. Verify
  locally in the meantime and say in the PR that you did. Only after a genuinely long
  silence is it worth telling anyone a human has to push — and if this does turn out to
  recur, adding `workflow_dispatch:` to `ci.yml` would make it self-service, since
  without it `actions_run_trigger` has nothing to call.

- **`node_modules` is empty in a fresh session, and the failures that causes look like
  real ones.** Nothing installs dependencies for you. Until `npm install` is run,
  `npm run build` dies with `vite: not found`, `npm run lint` dies on a missing
  `globals`, and `handstest`/`narrationtest`/`flagtest`/`pacingtest`/`e2etest`/`soaktest`
  all fail with `ERR_MODULE_NOT_FOUND` for `@upstash/redis`. Every one of those reads as
  a broken repo or a broken change. `npm install` works fine through the proxy and takes
  well under a minute, so run it before believing any of it — and if a suite still fails,
  confirm it against a clean tree (`git stash`) before treating it as yours.
