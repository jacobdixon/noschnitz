# Sheepshead (noschnitz.com) — project memory

Handoff doc for picking this project back up in Claude Code (or any fresh session)
after a Cowork session that took it from "zip file" through a working solo game,
a real AI, and a full multiplayer/growth roadmap. Read this first, then `ROADMAP.md`
for what's next.

## What this is
Sheepshead (5-handed, call-an-ace variant) card game, React + Vite SPA, deployed to
**noschnitz.com** via Vercel. Solo play against 4 AI opponents today (Gus, Bunny,
Duane, Patty — Wisconsin-themed, 4-5 chars each). Source at
`https://github.com/jacobdixon/noschnitz.git`, currently at **v0.7.2**.

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

## Multiplayer architecture (v2) — the decisions and why
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

## Branch + deploy discipline (v2 phase — read before deploying anything)
The solo game is live at **noschnitz.com** and stays live, untouched, for the whole
multiplayer build. Protecting it is the point of this setup.

- **`master` = production = the solo game.** Frozen at `v0.7.3` (tagged, with a
  GitHub release). It is protected by a ruleset: no direct pushes, PR required.
  Nothing lands there until v2 is something we'd actually put in front of the group.
- **`v2` = the multiplayer + community rewrite.** All work happens here or on
  per-issue branches (`mp-1.1-table-links`, `com-1.2-mute-toggle`, …) merged into
  `v2`. Use the issue ID from `ROADMAP.md` in the branch name and commit message.
- **Never run `vercel --prod`.** Not from a terminal, not from an agent session.
  Production deploys happen exactly one way: merging a PR into `master`. Pushing
  `v2` gets you a Vercel preview automatically — that's the URL to share and test.
- **If prod ever breaks**, don't debug forward — use Vercel's Instant Rollback to
  the last good production deployment, then fix on a branch. `v0.7.3` is always a
  valid rollback target.
- **Env vars must be scoped Preview vs. Production separately** the moment v2 adds
  a real-time backend. Preview tables and live tables must never share a state
  store. Set this up with the first backend commit, before there's data to untangle.
- **Cutover**: when v2 is ready, PR `v2` → `master`, merge, tag `v1.0.0`. Solo play
  survives as the 1-human + 4-AI case (MP-2.4), not as a separate maintained fork.

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
- **AI changes are tuned empirically**, not guessed — use `npm run simulate` (reports
  pick rate, picker win rate, alone rate, schneider rate, avg points) to compare
  before/after when touching `aiChooseCard` / `aiBuryAndCall` / thresholds like
  `ALONE_HANDSTRENGTH`.
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
1. `MP-1` (Shareable Table Links) is the first epic to build — see GitHub issues
   #1, #7-10.
2. **Unresolved technical decision, needs scoping first**: the realtime backend for
   live table/seat state sync. The app currently has zero backend. Candidates
   discussed: Supabase (Postgres + Realtime + Auth, bundled, low setup) vs. a
   dedicated room server built for this exact pattern (e.g. Colyseus). This
   underlies all of the Multiplayer feature.
3. **Voice/video approach**: lean toward embedding an existing solution (a Jitsi
   room per table, or an auto-generated video link) rather than building custom
   WebRTC for v1 — the goal is testing the core hypothesis fast, not owning video
   infrastructure. Revisit only if that turns out to be genuinely limiting.
4. A GitHub PAT was used inline in shell commands throughout this session for git
   pushes and issue creation — it was flagged for rotation; assume it may no longer
   be valid and get a fresh one if git/API auth fails.
