#!/usr/bin/env node
/* ============================================================================
   Single-dummy Monte Carlo deal-sampler.

   Every other analysis tool in this repo is one of two things: a full
   simulation of complete, freshly-shuffled hands (simulate/abtest/
   coalitiontest), or a double-dummy solve of a FINISHED hand with every card
   already revealed (gradeAllPlays/solveHandValue in engine.js, used by the
   recap grader). Neither answers "given only what a player at the table can
   actually see right now, mid-hand, which of these two cards is better" —
   that question has real uncertainty in it, and answering it honestly means
   not peeking at the unseen cards, only sampling them.

   This is standard technique from bridge analysis, where it is called a
   "single-dummy" problem (as opposed to "double-dummy," which is what
   engine.js's exact solver does) and is conventionally solved by dealing the
   unseen cards randomly many times, consistent with everything already
   known — voids revealed by failing to follow suit, cards already played,
   remaining hand sizes — and averaging some evaluation over the samples.

   What makes a sampled deal "consistent" here:
     - every seat's remaining hand size matches how many cards they still hold
     - a seat that has already revealed a void in a suit (failed to follow it
       when it was led) never receives a card of that suit in the sample
     - the picker's buried two cards are excluded from OTHER seats' hands
       (they can never be played again) but are otherwise just as unknown to
       a non-picker viewer as anything else unseen — they get their own
       "buried" bucket in the deal rather than silently vanishing, which
       matters because it correctly thins the pool of "the ace could still be
       out there" without ever revealing which two cards they were.

   Two evaluators are provided because they answer different questions, and
   conflating them was exactly the confusion this script exists to resolve:

     exact       double-dummy solve of the SAMPLED deal (solveHandValue).
                 Answers "if this particular layout were the real one, and
                 both sides played it perfectly from here on, who'd be
                 ahead." Expensive — see the feasibility notes below.

     heuristic   plays the rest of the SAMPLED deal out with the engine's own
                 deployed policy (aiChooseCard) for every seat, including the
                 viewer. Answers "if everyone just plays the normal engine
                 from here, who's ahead on this layout." Cheap — it's a
                 handful of heuristic lookups per sample, not a search — and
                 it's the more honest question to ask if what you actually
                 want to know is "how much does the ACTUAL engine's play
                 gain or lose here," rather than "how much talent is left on
                 the table against a perfect opponent."

   Usage:
     node scripts/montecarlo.mjs [samples] [--seed n] [--evaluator exact|heuristic]

   With no arguments it replays the trick-3 decision from the "Hand 4, Kopps
   alone" recap analysed in session — Q-hearts (win) vs J-diamonds (duck) —
   but reconstructed from ONLY what the seat called "You" could actually see
   at that moment: its own hand and the true play history. Everyone else's
   remaining cards are sampled, not looked up.
   ========================================================================= */
import {
  ALL_CARDS, isTrump, cid, applyPlay, resolveTrick, solveHandValue,
  aiChooseCard, pickerTeamOf, SUIT_SYM,
} from "../src/engine.js";

/* -------------------------------- RNG -------------------------------- */
// Same generator as abtest.mjs/coalitiontest.mjs, for the same reason: a
// seed reproduces an exact run, which matters when a sample count is large
// enough that "run it again" is not a cheap way to check a surprising result.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const effectiveSuit = (card) => (isTrump(card) ? "T" : card.suit);

/* --------------------------- what's knowable --------------------------- */

// Every trick this hand has touched, completed or in progress, in play
// order. `trickHistory` for the resolved ones, `g.trick` for the live one.
function allTricksSoFar(g) {
  return [...(g.trickHistory || []).map((th) => th.trick), g.trick || []];
}

// A seat is void in a suit the moment it fails to match the suit that led
// a trick it was part of. This is public at the table the instant it
// happens — nobody needs to infer it, everyone just saw the card land.
//
// The called-ace protection rules in legalPlays() (the partner may not lead
// the called suit early, must play the ace the first time it's led, etc.)
// don't complicate this: every one of them still has the affected seat
// playing a card that MATCHES the led suit when they hold one. They shape
// which matching card gets played, never whether a mismatch appears, so a
// suit mismatch here always means a genuine void.
function computeVoids(g) {
  const voids = [new Set(), new Set(), new Set(), new Set(), new Set()];
  for (const trick of allTricksSoFar(g)) {
    if (!trick.length) continue;
    const led = effectiveSuit(trick[0].card);
    for (const play of trick) {
      if (effectiveSuit(play.card) !== led) voids[play.player].add(led);
    }
  }
  return voids;
}

// How many cards each seat still holds right now. Every seat starts play
// with exactly 6 (the picker's bury has already happened by then), so this
// is just 6 minus however many that seat has played across every trick,
// including whatever's already down in the trick still in progress.
function remainingSizes(g) {
  const played = [0, 0, 0, 0, 0];
  for (const trick of allTricksSoFar(g)) for (const p of trick) played[p.player]++;
  return played.map((n) => 6 - n);
}

// Cards not in the viewer's own hand and not yet seen played. Deliberately
// reads ONLY g.hands[viewer] — never another seat's hand — so this function
// stays honest even when it's handed a `g` that (for scripting convenience)
// still has the real answer sitting in g.hands[otherSeat]. The sampler is
// what enforces the rule; this just has to not go looking.
//
// `p.actual ?? p.card` is the one deliberate, documented crack in that rule:
// a card played "under" shows on the table as the 6 of the called suit, and
// a defender genuinely doesn't learn its real face until they win that
// trick or the hand ends (see hideUnder in engine.js). Using the real face
// here anyway is a simplification, not an oversight — without it, that
// exact card would look "unseen" and could get dealt into a sampled hand a
// second time, while the placeholder six (not a real card in this deck)
// has no slot to occupy at all. The alternative is tracking a phantom card
// through the whole sampler for one narrow case; this trades a small,
// bounded, documented leak (the sampler knows one specific already-played
// card a beat before a real defender would) for not needing that.
function unseenPool(g, viewer) {
  const seen = new Set();
  for (const c of g.hands[viewer] || []) seen.add(cid(c));
  for (const trick of allTricksSoFar(g)) {
    for (const p of trick) seen.add(cid(p.actual ?? p.card));
  }
  if (viewer === g.picker) for (const c of g.buried || []) seen.add(cid(c));
  return ALL_CARDS.filter((c) => !seen.has(cid(c)));
}

/* ---------------------------- the sampler ---------------------------- */

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// One random deal of the unseen cards, consistent with voids and remaining
// hand sizes. Buckets are seat indices (every seat but the viewer) plus,
// when the viewer isn't the picker, a "buried" bucket of size 2 that soaks
// up cards which are just as unknown as anyone's hand but can never be
// played again.
//
// Assignment is smallest-domain-first: at each step, whichever unseen card
// currently has the FEWEST eligible buckets left gets placed next, into a
// uniformly random one of them. This is the standard fix for the failure
// mode of naive random assignment — a card that can only legally go to one
// remaining seat is exactly the card a random fill paints into a corner if
// it's left until last. It is not a claim of an exactly uniform distribution
// over all consistent deals (getting that exactly right needs a rejection
// sampler or a more careful combinatorial method); it is the same practical
// approximation real double-dummy tools use for this, and it never produces
// an inconsistent deal.
//
// Failure (a domain hitting zero mid-assignment) triggers a full restart
// with a fresh shuffle rather than backtracking one step, since sheepshead's
// hand sizes are tiny (at most six cards a seat) and restarts are cheap.
// It should be rare to nonexistent for real game states: the true deal is
// itself always a valid completion, so a failure here is the heuristic
// ordering painting itself into an avoidable corner, not a sign that no
// completion exists.
function sampleConsistentDeal(g, viewer, rng, maxAttempts = 500) {
  const voids = computeVoids(g);
  const sizes = remainingSizes(g);
  const seats = [0, 1, 2, 3, 4].filter((s) => s !== viewer);
  const includeBuried = viewer !== g.picker;
  const pool = unseenPool(g, viewer);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const capacity = {};
    for (const s of seats) capacity[s] = sizes[s];
    if (includeBuried) capacity.buried = 2;

    const domainOf = (card) => {
      const suit = effectiveSuit(card);
      return Object.keys(capacity).filter(
        (k) => capacity[k] > 0 && (k === "buried" || !voids[k].has(suit)),
      );
    };

    let remaining = shuffle(pool, rng);
    const buckets = { buried: [] };
    for (const s of seats) buckets[s] = [];
    let ok = true;

    while (remaining.length) {
      let bestIdx = -1, bestDomain = null, bestSize = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = domainOf(remaining[i]);
        if (d.length < bestSize) { bestSize = d.length; bestIdx = i; bestDomain = d; }
        if (bestSize === 0) break;
      }
      if (bestSize === 0) { ok = false; break; }
      const card = remaining[bestIdx];
      const choice = bestDomain[Math.floor(rng() * bestDomain.length)];
      buckets[choice].push(card);
      capacity[choice]--;
      remaining.splice(bestIdx, 1);
    }
    if (ok) return buckets;
  }
  throw new Error("sampleConsistentDeal: no consistent deal found in maxAttempts");
}

// Splices a sampled deal into a concrete, fully-populated `g` — the viewer's
// own hand is real, everyone else's is whatever this particular sample said.
function buildSampledGame(g, viewer, buckets) {
  const hands = g.hands.map((h, s) => (s === viewer ? h : buckets[s]));
  return { ...g, hands };
}

/* -------------------------------- evaluators -------------------------------- */

function exactValue(g, viewer, card) {
  return solveHandValue(applyPlay(g, viewer, card));
}

// Plays the rest of the sampled deal out with the engine's real policy for
// every seat (viewer included), and reports the picker-team's final total.
// aiChooseCard already dispatches to the exact solver for the last two
// tricks on its own, so this is a hybrid, not a pure heuristic all the way
// down — which is correct, because that's exactly how a live hand actually
// gets played.
function heuristicPlayout(g, viewer, card) {
  let sim = applyPlay(g, viewer, card);
  sim.turn = (viewer + 1) % 5;
  while (sim.tricksDone < 6) {
    if (sim.trick.length === 5) {
      sim = resolveTrick(sim);
      sim.turn = sim.leader;
      continue;
    }
    const mover = sim.turn;
    const played = aiChooseCard(sim, mover);
    sim = applyPlay(sim, mover, played);
    sim.turn = (mover + 1) % 5;
  }
  return pickerTeamOf(sim).reduce((s, p) => s + sim.ptsTaken[p], 0);
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const stdev = (xs) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/* -------------------------- the public entry point -------------------------- */

// `g` only needs to be as populated as the viewer's actual knowledge: its
// own hand at g.hands[viewer], the real trickHistory/trick, and the public
// picker/partner/alone/calledSuit flags. What's sitting in g.hands for other
// seats is never read by anything above this line — only by whatever built
// `g` in the first place, which in a live game is nothing (the seats
// literally aren't known) and in this script's demo is the historical
// record, kept around only so the demo can print "here's what actually
// happened" for comparison.
export function monteCarloEvaluate(g, viewer, candidates, opts = {}) {
  const { samples = 300, seed = 1, evaluator = "heuristic" } = opts;
  const rng = mulberry32(seed);
  const values = candidates.map(() => []);
  let drawn = 0, failed = 0;

  for (let i = 0; i < samples; i++) {
    let buckets;
    try {
      buckets = sampleConsistentDeal(g, viewer, rng);
    } catch {
      failed++;
      continue;
    }
    const sampledG = buildSampledGame(g, viewer, buckets);
    candidates.forEach((card, ci) => {
      const v = evaluator === "exact"
        ? exactValue(sampledG, viewer, card)
        : heuristicPlayout(sampledG, viewer, card);
      values[ci].push(v);
    });
    drawn++;
  }

  return {
    drawn,
    failed,
    results: candidates.map((card, ci) => ({
      card,
      n: values[ci].length,
      mean: mean(values[ci]),
      stdev: stdev(values[ci]),
      min: Math.min(...values[ci]),
      max: Math.max(...values[ci]),
    })),
  };
}

export { sampleConsistentDeal, computeVoids, remainingSizes, unseenPool, buildSampledGame };

/* --------------------------------- CLI demo --------------------------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? def : args[i + 1];
  };
  const samples = Number(args.find((a) => !a.startsWith("--")) ?? flag("samples", 300));
  const seed = Number(flag("seed", 1));
  const evaluator = flag("evaluator", "heuristic");

  const c = (rank, suit) => ({ rank, suit });
  const fmt = (card) => `${card.rank}${SUIT_SYM[card.suit]}`;

  // The real history of "Hand 4" up through the moment before You's trick-3
  // decision — reconstructed from the finished recap (session context), but
  // only so this demo has a real position to stand on. From here down, the
  // sampler and evaluators are handed nothing about seats 1-4 except what
  // "You" actually saw: g.hands[0] and the play history.
  let g = {
    phase: "playing",
    hands: [
      [c("K", "D"), c("8", "S"), c("Q", "H"), c("7", "C"), c("J", "D"), c("8", "H")], // You
      [c("Q", "S"), c("10", "D"), c("Q", "D"), c("J", "H"), c("J", "C"), c("J", "S")], // Kopps
      [c("Q", "C"), c("A", "S"), c("9", "H"), c("K", "H"), c("9", "S"), c("K", "S")], // Bunny
      [c("8", "D"), c("7", "H"), c("9", "C"), c("A", "C"), c("10", "H"), c("A", "H")], // Fonzie
      [c("A", "D"), c("7", "S"), c("7", "D"), c("K", "C"), c("10", "C"), c("10", "S")], // Miller
    ],
    buried: [c("8", "C"), c("9", "D")],
    picker: 1,
    partner: null,
    alone: true,
    calledSuit: null,
    calledAcePlayed: false,
    calledSuitLed: false,
    played: [],
    trick: [],
    tricksDone: 0,
    trickCounts: [0, 0, 0, 0, 0],
    ptsTaken: [0, 0, 0, 0, 0],
    trickHistory: [],
    turn: 1,
    scores: [0, 0, 0, 0, 0],
    doubler: 1,
  };
  const play = (idx, card) => { g = applyPlay(g, idx, card); g.turn = (idx + 1) % 5; };
  const resolve = () => { g = resolveTrick(g); g.turn = g.leader; };

  play(1, c("Q", "S")); play(2, c("Q", "C")); play(3, c("8", "D")); play(4, c("A", "D")); play(0, c("K", "D"));
  resolve();
  play(2, c("A", "S")); play(3, c("7", "H")); play(4, c("7", "S")); play(0, c("8", "S")); play(1, c("10", "D"));
  resolve();
  play(1, c("Q", "D")); play(2, c("9", "H")); play(3, c("9", "C")); play(4, c("7", "D"));
  // Now it's You's turn — this is the actual decision point.

  console.log(`Monte Carlo single-dummy check — trick 3, seat "You", evaluator=${evaluator}, samples=${samples}, seed=${seed}`);
  console.log(`Viewer's actual legal choice: Q-hearts (win) vs J-diamonds (duck)\n`);

  const t0 = Date.now();
  const { drawn, failed, results } = monteCarloEvaluate(g, 0, [c("Q", "H"), c("J", "D")], { samples, seed, evaluator });
  const elapsedMs = Date.now() - t0;

  console.log(`${drawn} consistent deals sampled (${failed} sampling failures), ${elapsedMs}ms total, ${(elapsedMs / Math.max(drawn, 1)).toFixed(2)}ms/deal\n`);
  for (const r of results) {
    console.log(
      `${fmt(r.card).padEnd(4)} mean=${r.mean.toFixed(1).padStart(6)}  stdev=${r.stdev.toFixed(1).padStart(5)}  ` +
      `range=[${r.min.toFixed(0)}, ${r.max.toFixed(0)}]  (picker-team future points, n=${r.n})`
    );
  }

  // For reference only — the ACTUAL deal, which a real player at the table
  // would not get to see. Printed so the sampled distribution can be sanity-
  // checked against the one truth it's approximating.
  const trueVals = [c("Q", "H"), c("J", "D")].map((card) => ({
    card, exact: exactValue(g, 0, card), heuristic: heuristicPlayout(g, 0, card),
  }));
  console.log("\nFor reference — the real deal (not visible to a real player at this point):");
  for (const t of trueVals) {
    console.log(`  ${fmt(t.card).padEnd(4)} exact=${t.exact}  heuristic-playout=${t.heuristic}`);
  }
}
