#!/usr/bin/env node
/* ============================================================================
   Post-hand grading tests — the recap must not invent mistakes.

   Two things are checked here, and the first is the one that matters most.

   1. The double-dummy solver must agree EXACTLY with a plain unpruned,
      unmemoised minimax. `solveHandValue` uses alpha-beta with a transposition
      table shared across a whole grading pass, and the classic way to get that
      wrong is to file a bound returned from a narrowed window as if it were an
      exact value. That failure mode does not crash and does not look wrong —
      it quietly returns plausible numbers — so the only way to know is to
      compare against a reference implementation that cannot be clever.

   2. The grader must report no best/worst play when no decision could have
      changed the outcome, rather than picking one arbitrarily. This is the
      bug that prompted the rewrite: on a hand that was a cold no-tricker, the
      old rollout-based grader flagged a defender's J-diamonds as the worst
      play of the hand, costing 14 points. It cost nothing.

   Usage: node scripts/gradetest.mjs
   ========================================================================= */
import {
  ALL_CARDS,
  freshHand, assignPartner, applyPlay, resolveTrick, handStrength, aiBuryAndCall,
  aiChooseCard, legalPlays, solveHandValue, gradeHandPlays, pickerTeamOf,
  sortHand, cid, NAMES,
} from "../src/engine.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

/* ---------- 1. solver vs. unpruned reference ---------- */
// No pruning, no memo, no cleverness. Slow by design — it is the yardstick.
function referenceValue(g) {
  if (g.tricksDone >= 6) return pickerTeamOf(g).reduce((s, p) => s + g.ptsTaken[p], 0);
  if (g.trick.length === 5) return referenceValue(resolveTrick(g));
  const idx = g.turn;
  const maximising = pickerTeamOf(g).includes(idx);
  let best = maximising ? -Infinity : Infinity;
  for (const card of legalPlays(g, idx)) {
    const v = referenceValue(applyPlay(g, idx, card));
    if (maximising ? v > best : v < best) best = v;
  }
  return best;
}

// Deterministic deals. Same defect as clairvoyancetest and the four harnesses
// fixed in 0.58.2: `freshHand` deals off makeDeck's unseeded RNG, so `seed`
// here only ever chose the DEALER and every run cross-checked a different
// population. The position counts said so out loud — 1493, 1415, 1421 locally
// against CI's 1443 — and a suite that asserts over a fresh sample every run is
// a deploy outage waiting for a rare deal, which is exactly how the shared-table
// collision above surfaced. Shuffling from ALL_CARDS replaces the unseeded deal
// instead of stirring it.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dealAndPick(seed) {
  let g = freshHand(seed % 5, [0, 0, 0, 0, 0], 1);
  const rand = mulberry32(seed + 1);
  const deck = [...ALL_CARDS];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  g = { ...g, hands: [0, 1, 2, 3, 4].map((p) => deck.slice(p * 6, p * 6 + 6)), blind: deck.slice(30, 32) };
  while (g.phase === "picking" && g.passes < 5) {
    const idx = g.pickTurn;
    const hs = handStrength(g.hands[idx]);
    if (!(hs >= 10 || (g.passes === 4 && hs >= 8))) {
      g = { ...g, passes: g.passes + 1, pickTurn: (idx + 1) % 5 };
      continue;
    }
    const { buried, call, hand } = aiBuryAndCall([...g.hands[idx], ...g.blind]);
    return assignPartner({
      ...g, picker: idx, hands: g.hands.map((h, i) => (i === idx ? hand : h)),
      buried, calledSuit: call, phase: "playing", trick: [], turn: g.leader,
    });
  }
  return g;
}

// One table shared across every position in a HAND, exactly as a grading pass
// shares it — a table that is only correct when freshly allocated would pass a
// per-call test and still corrupt real grades.
//
// PER HAND, and that word was missing until 0.59.0. This was one table across
// the whole run, i.e. across sixty different deals, which no caller in the
// project does: gradeAllPlays allocates a Map per hand (engine.js), and
// pimcsolve allocates one per world within a hand. Sharing across deals breaks
// an unstated precondition of `ddKey` — it omits picker and partner, correctly,
// because they are constant within a hand and it runs at every node. Two
// different deals reaching the same small late-trick layout therefore collide
// on the key while disagreeing about which side banks the points.
//
// It was not theoretical. This test failed CI on v0.59.0 with
// `shared=39 fresh=43 capped=43 reference=43`, and the collision reproduces
// deterministically at seed 1270 (shared=62 against a true 97 — a 35-point
// error) with a table shared across deals, and vanishes entirely with a
// per-hand table: 0 mismatches over 33,704 positions covering that same seed.
//
// So the engine was right and the test was wrong, which is the more dangerous
// way round: it reported a solver defect that does not exist, intermittently,
// on a suite whose red run silently withholds the beta deploy.
let compared = 0, mismatches = 0;
for (let i = 0; i < 60 && compared < 1500; i++) {
  let g = dealAndPick(i);
  if (g.phase !== "playing") continue;
  const sharedTable = new Map();
  // Play into the hand first: the reference is exponential, so compare where it
  // can still finish. This is also the window the grader actually uses.
  while (g.phase === "playing" && g.tricksDone < 3) {
    if (g.trick.length === 5) { g = resolveTrick(g); continue; }
    g = applyPlay(g, g.turn, aiChooseCard(g, g.turn));
  }
  while (g.phase === "playing" && g.tricksDone < 6) {
    if (g.trick.length === 5) { g = resolveTrick(g); continue; }
    for (const card of legalPlays(g, g.turn)) {
      const next = applyPlay(g, g.turn, card);
      const fresh = solveHandValue(next, new Map(), { n: 0 });
      const shared = solveHandValue(next, sharedTable, { n: 0 });
      // The transposition table is now capped and CLEARS when it fills, so
      // that a pathological hand cannot take the heap with it. A cap of 5
      // entries means it clears constantly, which is the point: if dropping
      // the table could ever change an answer, this is where it shows up.
      const capped = solveHandValue(next, new Map(), { n: 0, cap: 5 });
      const ref = referenceValue(next);
      compared++;
      if (fresh !== ref || shared !== ref || capped !== ref) {
        mismatches++;
        if (mismatches <= 3) {
          failures.push(`solver mismatch on ${cid(card)}: fresh=${fresh} shared=${shared} capped=${capped} reference=${ref}`);
        }
      }
    }
    g = applyPlay(g, g.turn, aiChooseCard(g, g.turn));
  }
}
check("solver agrees with unpruned minimax", mismatches === 0,
  `${mismatches} mismatches over ${compared} positions`);
check("cross-check actually ran", compared > 500, `only ${compared} positions compared`);

/* ---------- 2. the reported hand: a cold no-tricker ---------- */
// v0.18.0 hand 1. Patty picked, buried both black-and-red Aces, called spades;
// Gus held the called Ace. The defenders cannot take a trick against any
// defence, so no defender play in the hand costs anything.
const C = (s) => ({ rank: s.slice(0, -1), suit: s.slice(-1) });
const P = (...a) => a.map(C);
const REPORTED_HANDS = [
  P("7S", "8D", "9C", "9H", "KC", "10H"),
  P("AS", "QS", "8C", "KD", "9D", "KH"),
  P("8S", "10D", "JD", "JC", "9S", "8H"),
  P("10S", "7D", "7C", "QD", "10C", "7H"),
  P("KS", "AD", "JH", "QC", "QH", "JS"),
];
const REPORTED_TRICKS = [
  [[2, "8S"], [3, "10S"], [4, "KS"], [0, "7S"], [1, "AS"]],
  [[1, "QS"], [2, "10D"], [3, "7D"], [4, "AD"], [0, "8D"]],
  [[1, "8C"], [2, "JD"], [3, "7C"], [4, "JH"], [0, "9C"]],
  [[4, "QC"], [0, "9H"], [1, "KD"], [2, "JC"], [3, "QD"]],
  [[4, "QH"], [0, "KC"], [1, "9D"], [2, "9S"], [3, "10C"]],
  [[4, "JS"], [0, "10H"], [1, "KH"], [2, "8H"], [3, "7H"]],
];
let reported = {
  phase: "playing", handNum: 1, dealer: 1, hands: REPORTED_HANDS.map(sortHand),
  blind: [], buried: P("AH", "AC"), picker: 4, partner: 1, partnerRevealed: false,
  calledSuit: "S", calledAcePlayed: false, calledSuitLed: false, alone: false,
  doubler: 1, pickTurn: 2, passes: 0, played: [], trick: [], leader: 2, turn: 2,
  tricksDone: 0, trickCounts: [0, 0, 0, 0, 0], ptsTaken: [0, 0, 0, 0, 0],
  lastTrick: null, trickHistory: [], selected: [], scores: [0, 0, 0, 0, 0],
  message: null, result: null,
};
const midTrick3 = (() => {
  let g = reported;
  for (const th of REPORTED_TRICKS.slice(0, 2)) {
    for (const [p, c] of th) g = applyPlay(g, p, C(c));
    g = resolveTrick(g);
  }
  return applyPlay(g, 1, C("8C")); // Gus leads the club; Bunny (seat 2) to play
})();
const bunnyLegal = legalPlays(midTrick3, 2);
const bunnyOptions = bunnyLegal.map((card) => ({
  card, value: solveHandValue(applyPlay(midTrick3, 2, card), new Map(), { n: 0 }) + 22,
}));
check("every one of Bunny's trick-3 options is worth the same",
  bunnyOptions.every((o) => o.value === 120),
  bunnyOptions.map((o) => `${cid(o.card)}:${o.value}`).join(" "));

for (const th of REPORTED_TRICKS) {
  for (const [p, c] of th) reported = applyPlay(reported, p, C(c));
  reported = resolveTrick(reported);
}
// Cost, measured against this machine rather than against a stopwatch.
//
// This used to assert a flat `gradeMs < 1000`, and it was wrong twice over.
// The label claimed grading "renders synchronously", which stopped being true
// when it moved into grader.worker.js — that file documents the solve as a
// median of ~800ms and up to ~8s precisely because it is NOT on the render
// path any more. And an absolute millisecond budget measures the runner, not
// the code: on a slow container the identical commit failed on master having
// passed on its own pull request, which skipped the Release job and quietly
// left beta two versions behind.
//
// So the budget is now a RATIO against a reference solve on the same machine
// and the same hand. Machine speed divides out, and what is left is the thing
// actually worth guarding: grading a whole hand must not become dramatically
// more expensive per solve than solving one position. A real regression — an
// exponential blowup, a lost transposition table — moves this by an order of
// magnitude, which is what the bound is set to catch. Observed at 55-75x on the
// container this was written on; 150 leaves better than twice that headroom.
// The ratio is printed on every run, so if it drifts the number is visible long
// before the bound is reached.
const solveOnce = () => bunnyLegal.map((card) =>
  solveHandValue(applyPlay(midTrick3, 2, card), new Map(), { n: 0 }));

solveOnce();                      // warm: first call pays for JIT, not for work
gradeHandPlays(reported);
// Averaged over several runs. One reference solve is ~15ms, small enough that
// timer granularity and scheduling noise show up in the ratio; averaging pulls
// the denominator's spread well under the numerator's.
const REF_RUNS = 5;
const r0 = process.hrtime.bigint();
for (let i = 0; i < REF_RUNS; i++) solveOnce();
const refMs = Number(process.hrtime.bigint() - r0) / 1e6 / REF_RUNS;
const t0 = process.hrtime.bigint();
const grade = gradeHandPlays(reported);
const gradeMs = Number(process.hrtime.bigint() - t0) / 1e6;

check("no worst play is invented on a hand the defence could not affect",
  grade.worst === null,
  grade.worst ? `flagged ${NAMES[grade.worst.player]} ${cid(grade.worst.card)}` : "");
check("the reference solve is big enough to time against", refMs > 1,
  `reference took ${refMs.toFixed(1)}ms`);
console.log(`\n  grading cost: ${gradeMs.toFixed(0)}ms against a ${refMs.toFixed(1)}ms reference solve ` +
  `= ${(gradeMs / refMs).toFixed(0)}x (bound 150x)`);
check("grading a hand costs no more than 150 reference solves",
  gradeMs / refMs < 150,
  `grade ${gradeMs.toFixed(0)}ms / reference ${refMs.toFixed(1)}ms = ${(gradeMs / refMs).toFixed(1)}x`);

/* ---------- 3. an all-forced hand yields no grade at all ---------- */
// gradeHandPlays skips decisions with one legal card; a hand where nothing is
// gradeable must come back empty rather than picking something at random.
check("a hand with no trickHistory grades to nothing",
  (() => {
    const g = gradeHandPlays({ ...reported, trickHistory: [] });
    return g.best === null && g.worst === null;
  })());

/* ---------- report ---------- */
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log("FAIL — post-hand grading is not trustworthy.");
  process.exit(1);
}
console.log(`${passed} passed, 0 failed  (${compared} solver positions cross-checked)`);
console.log("PASS — grading is exact and does not invent mistakes.");
