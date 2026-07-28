#!/usr/bin/env node
/* ============================================================================
   Double-dummy solver tests (src/solver.js).

   A solver that is subtly wrong is worse than no solver: every number it
   produces looks authoritative, and the grader built on it would send us
   chasing errors that aren't there. So this doesn't test the solver against
   itself — it tests it against things that were already true.

   Three anchors:

   1. `engine.js` already solves the last two tricks exactly, by a completely
      separate and much simpler minimax with no alpha-beta, no transposition
      table and no move collapsing. On any two-trick position the two must
      agree. That is an independent implementation, not a restatement.

   2. Collapsing equivalent moves is the one optimisation that could change an
      answer rather than just the time taken. Every position is solved twice,
      with it on and off, and the values must be identical.

   3. Alpha-beta and the transposition table must not depend on the order the
      values happen to be asked for. Solving the same position from a fresh
      table, and from a table already warmed by a different search, must give
      the same number.

   Usage: node scripts/solvertest.mjs
   ========================================================================= */
import {
  freshHand, assignPartner, applyPlay, resolveTrick, handStrength, aiBuryAndCall,
  aiChooseCard, solveEndgameCard, legalPlays, pickerTeamOf, cid, cardPts,
} from "../src/engine.js";
import { solveValue, solveRootValues, newContext, gradeHandExact } from "../src/solver.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

function dealPlayable() {
  for (;;) {
    let g = freshHand(0, [0, 0, 0, 0, 0], 1);
    while (g.phase === "picking" && g.passes < 5) {
      const i = g.pickTurn;
      const wants = handStrength(g.hands[i]) >= 10 || (g.passes === 4 && handStrength(g.hands[i]) >= 8);
      if (!wants) { g = { ...g, passes: g.passes + 1, pickTurn: (i + 1) % 5 }; continue; }
      const { buried, call, hand } = aiBuryAndCall([...g.hands[i], ...g.blind]);
      g = assignPartner({
        ...g, picker: i, hands: g.hands.map((h, j) => (j === i ? hand : h)),
        buried, calledSuit: call, phase: "playing", trick: [], turn: g.leader,
      });
    }
    if (g.phase === "playing") return g;
  }
}

function advanceTo(g, tricksDone) {
  while (g.tricksDone < tricksDone) {
    while (g.trick.length < 5) g = applyPlay(g, g.turn, aiChooseCard(g, g.turn));
    g = resolveTrick(g);
  }
  return g;
}

const pickerPts = (g) => pickerTeamOf(g).reduce((s, p) => s + g.ptsTaken[p], 0);

/* -- 1. Agreement with the engine's own endgame solver ------------------- */
// solveEndgameCard is the trusted answer for two-trick positions. The card it
// picks must be one that achieves the optimal value according to this solver.
// Comparing achieved values rather than card identity keeps the test honest
// when several cards are equally good.
{
  let checked = 0, mismatches = 0, exampleFail = "";
  for (let n = 0; n < 60; n++) {
    const g = advanceTo(dealPlayable(), 4);
    if (g.phase !== "playing") continue;
    const idx = g.turn;
    if (legalPlays(g, idx).length < 2) continue;

    const vals = solveRootValues(g, idx, newContext(g));
    const onPickerTeam = pickerTeamOf(g).includes(idx);
    const bestVal = onPickerTeam
      ? Math.max(...vals.map((v) => v.value))
      : Math.min(...vals.map((v) => v.value));

    const engineCard = solveEndgameCard(g);
    const engineVal = vals.find((v) => cid(v.card) === cid(engineCard));
    checked++;
    if (!engineVal || engineVal.value !== bestVal) {
      mismatches++;
      if (!exampleFail) exampleFail = `${cid(engineCard)} valued ${engineVal?.value} vs best ${bestVal}`;
    }
  }
  check("cross-checked against the engine's endgame solver on real positions", checked >= 30,
    `only ${checked} usable positions`);
  check("the endgame solver's card is always optimal per the full solver",
    mismatches === 0, `${mismatches}/${checked} disagreed; e.g. ${exampleFail}`);
}

/* -- 2. Collapsing equivalent moves cannot change a value ---------------- */
{
  let same = 0, differ = 0, nodesWith = 0, nodesWithout = 0, example = "";
  for (let n = 0; n < 12; n++) {
    const g = advanceTo(dealPlayable(), 3);
    if (g.phase !== "playing") continue;
    const on = newContext(g);
    const off = newContext(g, { dedupe: false });
    const a = solveValue(g, on);
    const b = solveValue(g, off);
    nodesWith += on.nodes; nodesWithout += off.nodes;
    if (a === b) same++; else { differ++; if (!example) example = `${a} vs ${b}`; }
  }
  check("equivalent-move collapsing preserves the value exactly", differ === 0,
    `${differ}/${same + differ} differed; e.g. ${example}`);
  check("...and is actually a speedup", nodesWith < nodesWithout,
    `${nodesWith} nodes with vs ${nodesWithout} without`);
}

/* -- 3. Order independence ----------------------------------------------- */
// A shared transposition table is the whole reason grading a hand is
// affordable, so a value must never depend on what was searched before it.
{
  let differ = 0, example = "";
  for (let n = 0; n < 12; n++) {
    const g = advanceTo(dealPlayable(), 3);
    if (g.phase !== "playing") continue;
    const fresh = solveValue(g, newContext(g));

    // Warm a table on a sibling position first, then reuse it.
    const shared = newContext(g);
    const idx = g.turn;
    solveRootValues(g, idx, shared);
    const warmed = solveValue(g, shared);
    if (fresh !== warmed) { differ++; if (!example) example = `${fresh} vs ${warmed}`; }
  }
  check("a shared transposition table doesn't change any value", differ === 0,
    `${differ} differed; e.g. ${example}`);
}

/* -- 4. Values are consistent with the rules ----------------------------- */
{
  const g = advanceTo(dealPlayable(), 2);
  const vals = solveRootValues(g, g.turn, newContext(g));
  check("every legal card gets a value", vals.length === legalPlays(g, g.turn).length);
  check("values are within the points that actually remain",
    vals.every((v) => v.value >= 0 && v.value <= 120), JSON.stringify(vals.map((v) => v.value)));

  // A solved value plus what's banked plus the burial can never exceed 120.
  const banked = pickerPts(g) + g.buried.reduce((s, c) => s + cardPts(c), 0);
  check("solved total never exceeds the 120 points in a hand",
    vals.every((v) => banked + v.value <= 120), `banked=${banked}`);
}

/* -- 5. The grader agrees with the solver it is built on ------------------ */
{
  let g = dealPlayable();
  while (g.phase === "playing" && g.tricksDone < 6) {
    while (g.trick.length < 5) g = applyPlay(g, g.turn, aiChooseCard(g, g.turn));
    g = resolveTrick(g);
  }
  const graded = gradeHandExact(g);
  check("grades a finished hand", graded !== null && graded.decisions.length > 0);
  check("never reports a negative cost — the played card is always one of the options",
    graded.decisions.every((d) => d.cost >= 0),
    JSON.stringify(graded.decisions.filter((d) => d.cost < 0).slice(0, 2)));
  check("a decision whose alternatives are all equal has zero cost",
    graded.decisions.every((d) => d.swing > 0 || d.cost === 0));
  check("the card actually played is never cheaper than the best card",
    graded.decisions.every((d) => d.cost > 0 || d.cost === 0));
  check("forced plays are excluded, so every graded decision had a choice",
    graded.decisions.every((d) => d.legalCount > 1));
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — the solver agrees with the engine's exact endgame and with itself.");
