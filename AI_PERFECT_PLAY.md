# Toward Perfect Play — ideas to explore

Brainstorm, 2026-07-28. Nothing here is committed work; it's a menu. Ordered
notes on (1) what "perfect" even means for Sheepshead, (2) strategies to get
there, (3) how to measure whether we're getting there. Grounded in what the
engine already has: heuristic `aiChooseCard`, an exact double-dummy solver
(`solveHandValue` / `ddFuture`), endgame solving (`solveEndgameCard`), and the
post-hand grader (`gradeHandPlays`).

## 1. What "perfect" means here

Sheepshead is an imperfect-information game, so there are three different
targets, and they are genuinely different:

- **Double-dummy perfect** — best play *if you could see all hands*. We can
  already compute this (it's what the recap grader does). It is the wrong
  target for play: a DD-"mistake" can be the correct play under uncertainty
  (e.g. not finessing into a card you can't know about).
- **Game-theoretic optimal** — unexploitable play over information sets, the
  poker/CFR notion. The true "perfect", and mostly of academic interest here:
  5-handed with partnerships makes it enormous, and nobody at the table is
  exploiting us.
- **Maximum-EV vs. realistic opponents** — best play against how humans (and
  our own AI) actually play, in **stake points under the house rules**, not
  card points. This is the target that matters for the product, and note the
  house doubling rules already moved it once: pick EV went from +1.27 to
  +0.10, so "when to pick" perfection is a scoring-rule question, not just a
  card question.

Practical definition of done: **an AI whose blunder rate is indistinguishable
from zero under measurement, and that expert humans stop catching mistakes
from.** The feedback loop (versioned recap images) is already built for the
second half.

## 2. Strategies for stronger play

### A. Determinized search on the existing DD solver (biggest lever)

The GIB approach from computer bridge, and we own every ingredient already:
at each decision, sample N complete deals of the unseen cards consistent with
what this seat knows, run `solveHandValue` on each legal card in each sample,
play the card with the best average. This replaces the entire heuristic stack
with search, and it converges toward correct imperfect-information play as
the sampling gets smarter.

- Start where heuristics are weakest and trees are smallest: tricks 3–6.
  `solveEndgameCard` already does the "one deal, exact" version; this is the
  same idea with sampling instead of omniscience.
- Budget mechanics already exist (`ddFuture`'s node budget, shared memo).
  Needs a per-decision time budget tuned for the browser (see §4 perf).
- Known failure modes to design around: **strategy fusion** (the sampled
  worlds each assume you'll play clairvoyantly later) and non-locality.
  ISMCTS (§D) is the fix if these bite; measure first.

### B. An explicit belief layer (makes A honest, helps heuristics today)

A per-seat probability model over where the unseen cards are, updated from
public evidence: who picked and who passed (passing bounds `handStrength`),
voids shown by failing to follow, the called suit (partner holds that ace,
picker has at least one of the suit... minus the under wrinkle), schmear /
no-schmear tells, bury tendencies. Uses:

- Weight the determinization sampling in §A — uniform sampling is the classic
  GIB weakness; even crude constraints (voids, pick-strength bounds) remove
  most of the impossible worlds.
- Immediately upgrade existing heuristics: `knowsTeammate`'s
  everyone-unrevealed-is-a-teammate asymmetry (which has now produced three
  separate bugs) becomes a probability instead of a boolean, and
  `unaccountedFor` / `cardEquity` get distributions instead of counts.
- Testable in isolation: deal hands, replay, score the belief model's
  calibration against the true layout (Brier score per card-location claim).

### C. Push the exact-solve boundary earlier

Cheapest incremental win: `solveEndgameCard` presumably kicks in when the
remaining tree fits the budget. Profile how early `ddFuture` can afford to
run mid-hand (better move ordering, tighter alpha-beta windows, suit-symmetry
in `ddKey`, endgame tablebase for the last 2 tricks) and slide the switchover
earlier. Every trick claimed from the heuristics by exact search is a trick
that can no longer be misplayed — modulo the DD-vs-hidden-info caveat, which
§A resolves properly.

### D. ISMCTS (Information Set Monte Carlo Tree Search)

The literature's fix for determinization's flaws: one shared tree over
information sets, a fresh sampled world per iteration. Strictly stronger than
§A in principle, more machinery in practice. Only reach for it if §A+§B
plateaus and the blunder metrics (§3) say strategy fusion is the cause
(signature: overconfident finesse-style plays that assume later
clairvoyance).

### E. Systematic tuning of the current heuristic engine

The heuristics aren't going away (they're the opening-tricks player and the
fallback under time pressure), and past sweeps "couldn't distinguish values"
— that's a *variance* problem, and §3's duplicate-deal harness is the fix.
With paired-deal variance reduction, rerun sweeps over `SCHMEAR_CONFIDENCE`,
`OVERTAKE_MIN_GAIN`, the pick threshold, and the security constants with
CMA-ES or plain coordinate descent. The two "set on principle" tunables
become measurable.

### F. Search the pre-play decisions too

Pick / bury / call / under / alone are pure EV decisions and currently
formula-driven (`handStrength >= 10`, `aiBuryAndCall`'s enumeration):

- **Pick**: sample deals of the other four hands + blind, roll out with the
  current AI, compare stake-EV of picking vs. passing (position-aware — the
  last-seat mauer question). The threshold stops being a magic number.
- **Bury/call**: `aiBuryAndCall` already enumerates options; score each
  option by sampled rollout instead of formula. Bury mistakes are worth 10+
  points and are highly visible to experts — likely dense in the reported-hand
  corpus.
- These run once per hand, not once per card, so they can afford 10–50x the
  compute of a card decision.

### G. CFR / learned equilibrium — noted, probably not

Deep CFR or ReBeL-style training would target true optimality. Cost:
training infrastructure, a NN inference path in the browser, and
explainability drops to zero (bad for the recap/feedback loop, bad for
debugging). Revisit only if someone starts genuinely exploiting the AI,
which multiplayer would have to surface first.

### H. Distillation, once search is strong

If §A/§D produce a strong-but-slow player: generate millions of
(situation → search-chosen card) pairs offline, train a small policy net, run
it in-browser as the fast path with search as the verifier. This is the
standard endgame for shipping search-quality play on a compute budget — but
it's phase 3, not phase 1.

## 3. Assessment — how to know it's working

### 3.1 Automated blunder mining (do this first, it changes everything)

The project's own hard-won lesson is that aggregate simulation is blind and
expert-reported hands are the real detector. But `gradeHandPlays` **is an
expert** — it just only runs in the recap. Run it offline over 100k+
simulated hands and:

- Report a **blunder rate**: decisions costing >N points vs. DD-best, per
  seat-role (picker / partner / defender) and per trick number.
- **Cluster the blunders** (lead vs. follow, schmear vs. duck, trump vs.
  fail, early vs. late) and read the top clusters by total points lost. This
  finds the "wasted Queen" class of bug *without waiting for a friend to
  report it* — same detector, industrial scale.
- Caveat honestly: DD-cost > 0 is not always a real mistake (hidden
  information). Filter with the belief layer (§B) — a blunder that's a
  blunder in *most consistent worlds*, not just the actual one, is real. Even
  unfiltered, the *trend* of the blunder rate across versions is meaningful.

### 3.2 Duplicate-deal paired A/B (kill the noise)

Adopt duplicate bridge's methodology in `abtest.mjs`/`simulate.mjs`: play the
**same deal** under variant A and variant B (same seeds, all 5 seat
rotations), score the *difference* per deal, and t-test the paired
differences. Run-to-run deal luck — currently "far larger noise" than any
effect being measured — cancels exactly. This is what makes §E's sweeps and
every future A/B readable, and it retroactively fixes the reason past sweeps
were inconclusive. One more variance trick: report results split by
hand-type strata (picker holds both black queens, close pick decisions, ...)
so effects concentrated in rare situations aren't diluted to invisibility.

### 3.3 Version ladder

Keep frozen engine snapshots (v0.16.1, v0.21.0, ...) playable as opponents.
New engine vs. each ancestor over paired deals → a rating curve over time.
Guards against the classic tuning failure: beating the *current* self while
regressing against an older style. Mixed tables (3 new + 2 old, rotated)
catch interactions a pure self-play ladder misses.

### 3.4 The reported-hand corpus, formalized

Already half-built: expert-flagged hands become constructed assertions with
negative controls in `aiskilltest.mjs`. Extensions worth exploring:

- Store every reported hand (version stamp ties it to its engine) as a
  replayable fixture, *including the ones judged not-bugs* — they're the
  false-positive set for calibrating §3.1's blunder filter.
- Track "expert-reported mistakes per 100 shared recaps" per version — it's
  the closest thing to a ground-truth product metric for AI skill.

### 3.5 Decision-type scorecards

Aggregate win-rate hides which *decision* improved. Per-version, over a fixed
deal set, report separately: pick decision EV (vs. §F's sampled oracle), bury
cost (points buried vs. best bury, DD-graded), call choice agreement, schmear
accuracy (schmeared into a winner vs. fed the opponents), lead quality, and
endgame-tricks blunder rate (should be ~0 wherever exact solve is active —
this line *proves* §C's boundary is where you think it is).

### 3.6 Human evaluation

- Keep the recap loop as the qualitative channel (already versioned).
- A "grade my table" mode: run `gradeHandPlays` against the *AI's* seats and
  show their mistakes too — recruits every player into blunder-hunting.
- Eventually: can a strong player, shown anonymized hand histories, pick out
  the AI seat? When they can't, and §3.1 is flat at ~0, that's "perfect" for
  product purposes.

### 3.7 Performance budget as a first-class metric

Every strategy above spends compute at decision time, synchronously, in a
browser (and server-side in multiplayer, inside a request). Track p50/p95
think-time per decision alongside strength. A tiered policy keeps it honest:
heuristics answer instantly, search refines within budget, exact solve when
the tree is small — strength metrics should always be reported *at* a stated
time budget. (Web Worker for the solo client keeps the UI thread clean;
multiplayer's ai-runner has its own request-time ceiling.)

## 4. Suggested order

1. **§3.2 duplicate-deal harness** — everything else needs readable
   measurements; currently they aren't.
2. **§3.1 blunder mining** — establishes the baseline number to drive down,
   and produces a ranked list of real weaknesses to fix (likely worth several
   versions of pure heuristic fixes on its own).
3. **§C earlier exact solve** — cheap, provable wins in late tricks.
4. **§B belief layer**, validated by calibration tests.
5. **§A determinized search** for mid-hand decisions, belief-weighted.
6. **§F search-based pick/bury/call.**
7. Re-evaluate: if blunder rate is ~0 and experts are quiet, stop. Otherwise
   §D/§H.

One product caveat to keep in view: a perfect AI may not be the most *fun*
opponent for the solo game. If strength lands, the difficulty knob is easy —
degrade by sampling from the search's top-k instead of argmax — but the
knob's existence should probably ship alongside the strength.
