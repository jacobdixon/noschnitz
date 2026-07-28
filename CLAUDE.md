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
- **Merging a PR to `master` does NOT update `beta`.** They are separate deploys off
  the same commit with different flags. Fast-forward beta as its own step:

      git push origin origin/master:beta

  Push refspecs rather than checking out — `master` may be held by another worktree.

Consequences that look like bugs and are not:

- **A multiplayer-only change leaves the production bundle hash IDENTICAL.** The code
  was eliminated from that build, so there is genuinely nothing to deploy. Verify a
  deploy by *string content*, never by bundle hash. (Vercel's minifier is also
  non-deterministic — identical content can produce different hashes.)
- **Vercel appears to deduplicate builds of the same commit SHA.** Pushing `beta` to
  the same SHA `master` just merged, while that commit's Production build is still in
  flight, can silently skip the beta build. Leave a gap between the merge and the beta
  push, or trigger it explicitly with the **Deploy Hook** for branch `beta`
  (Settings → Git → Deploy Hooks). That hook URL is a credential: it lives in the
  dashboard, never in the repo, and never in a chat transcript.

Unchanged rules:

- **Never run `vercel --prod`.** Not from a terminal, not from an agent session.
  Production deploys happen exactly one way: merging a PR into `master`.
- **`master` is protected by a ruleset**: no direct pushes, PR required at 0 approvals
  (a non-zero requirement locks a solo developer out of merging their own PRs).
- **If prod ever breaks**, don't debug forward — use Vercel's Instant Rollback to the
  last good production deployment, then fix on a branch. `v0.7.3` is always a valid
  rollback target.
- **Env vars are scoped Preview vs. Production separately.** Beta tables and any live
  tables must never share a state store.
- **`gh pr merge --delete-branch` silently fails in this repo** (a worktree error
  swallows it), so merged branches accumulate. Check
  `git branch -r --merged origin/master` now and then rather than trusting the flag.
  `v2` is kept deliberately as a landmark; do not delete it in a tidy-up.

## Conventions established this session (keep following them)
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
- **Aggregate simulation is the safety net, not the detector.** Every AI fix that has
  actually landed started from ONE hand a human flagged, was reproduced against the
  engine *before* anything changed, and was then pinned as a constructed assertion
  with a negative control. Several correct-looking diagnoses measured as pure noise;
  measure before believing.
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
   join (MP-2.3) in particular has synthetic coverage only.
3. **`src/useTableStream.js` has no automated coverage at all** — and it is the file
   most likely to ruin a games night, because a backgrounded phone loses its connection
   and its timers at the same time. There is a flight recorder (`src/streamLog.js`,
   readable from the in-app menu) precisely because this class of bug cannot be caught
   by staring at it. If someone reports a frozen table, get that log.
4. **PAT rotation is still open.** A GitHub PAT was used inline in shell commands in an
   early session and flagged for rotation. Assume it may no longer be valid, and note
   that making the repo private would NOT be the remediation — private does not undo
   public. Rotating the token is the fix.
