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
- **Preview and Production have separate stores.** Only Preview/Development have
  Upstash connected today. Never let test tables and live tables share a keyspace.
- **`playerId` is a bearer token.** It's how a player proves which seat is theirs, so
  it must be stripped from other players' entries in every payload.

## Branch + deploy discipline — READ BEFORE DEPLOYING ANYTHING

**The v2 rewrite is done and merged.** There is no `v2` workflow any more. If you find
notes elsewhere telling you to work on `v2`, or describing a future "cutover", they are
historical — this section is current.

The two branches, and the thing that surprises everyone:

- **`master` = production = www.noschnitz.com.** Built **flag-off** (`VITE_MULTIPLAYER`
  unset), so the multiplayer code is dead-code-eliminated and production is the solo
  game: 1 human + 4 AI, no network calls, works offline.
- **`beta` = a BRANCH** (not an environment name), built **flag-on** →
  beta.noschnitz.com. This is the only place multiplayer exists.
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

- **A multiplayer-only change leaves the production bundle hash IDENTICAL.** The code
  was eliminated from that build, so there is genuinely nothing to deploy. Verify a
  deploy by *string content*, never by bundle hash. (Vercel's minifier is also
  non-deterministic — identical content can produce different hashes.)
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

## Promoting multiplayer to production — the runbook

Requested 2026-07-31, after the first real five-seat session. **The flip itself is
three environment variables in the Vercel dashboard and cannot be done from a
session** — the agent proxy refuses vercel.com and api.vercel.com, `vercel --prod`
is banned here anyway, and one of the three is a credential. So the split is:
code and verification land in the repo, the flip is a human action.

What "promote" means concretely. Production is flag-off today, which is not a
state of the code — it is the *absence* of variables on Vercel's **Production**
environment. Three of them have to arrive together:

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

Rolling back is the same three variables in reverse plus a redeploy, and
`Verify production` with `expect: solo` confirms it. Instant Rollback is still
the move if production is actively broken.

Two consequences worth knowing before deciding:

- **The "Play with friends" button becomes public to every visitor**, not just
  people holding a link. Both entry points read the same flag (`src/App.jsx`),
  by design: a shared link that opened on production while the API had no store
  behind it would fail worse than not existing.
- **`beta` stops being a different build from production.** It keeps its value
  as a branch that can be moved independently, but it is no longer "the only
  place multiplayer exists," and any instruction elsewhere that says so becomes
  historical the moment step 3 completes. `verify-beta.yml` still works
  unchanged.

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

## Conventions established this session (keep following them)
- **Watch every PR you open, without being asked.** Subscribe to its activity as
  soon as it exists, and stay subscribed until it is merged or closed. A PR here is
  not finished when it is opened: CI going red on `master` is what silently withholds
  the beta deploy (see the deploy section), so a failure nobody is watching for is a
  deploy outage that looks like nothing happening. Webhooks do not reliably deliver
  CI *success*, new pushes, or merge-conflict transitions, so pair the subscription
  with a self check-in about an hour out and re-arm it quietly while the PR is open.
  Drive it to green: a CI-failure wake ends with a pushed fix or a comment saying
  what is broken and why it is not yours to fix — never in silence.
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
  questions and get different numbers.** `ALONE_HANDSTRENGTH` (17) is the AI's bar for
  going alone; `ALONE_OFFER_STRENGTH` (18) is when the button is worth showing a
  person. They sit next to each other in `engine.js` and look like a typo — they are
  not. The AI decides while it still holds all eight and buries to match the plan
  (banking points instead of protecting a call); a human decides *after* the bury is
  spent, which is strictly worse, so the human's bar is a point higher. Measured over
  20,239 pickers who had a partner available: alone is behind by 1.9 points/hand at
  17, negative in 4 of 4 seeds, and only turns positive at 18. **If the AI bar is ever
  re-tuned, re-measure the offer bar in the same pass** rather than assuming it
  follows.
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

Genuinely open:

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
4. **`src/useTableStream.js` has no automated coverage at all** — and it is the file
   most likely to ruin a games night, because a backgrounded phone loses its connection
   and its timers at the same time. There is a flight recorder (`src/streamLog.js`,
   readable from the in-app menu) precisely because this class of bug cannot be caught
   by staring at it. If someone reports a frozen table, get that log.
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
