#!/usr/bin/env node
/* ============================================================================
   Scoring rule tests.

   Separate from aiskilltest.mjs on purpose: that harness is about which card
   the AI chooses, this one is about what a finished hand is worth. They fail
   for entirely different reasons and mixing them makes both harder to read.

   The two house rules under test:

   - **Double on the bump.** A set picker pays twice. The picking team wins
     about 61-62% of the hands it takes and wins them bigger than it loses them
     (average multiplier 1.49 winning vs 1.17 losing, because they hold the
     blind and the burial), which left alone makes picking worth about +1.27 a
     hand. Doubling the loss brings that to roughly +0.10.

   - **Doubler on a passed-out hand.** Nobody picks, the hand is thrown in, and
     the next one pays double. Stacks if it happens twice running.

   Every case also asserts the hand is zero-sum. That is the invariant most
   likely to break silently if the stake is ever applied to one side only.

   Usage: node scripts/scoringtest.mjs
   ========================================================================= */
import { scoreHand, freshHand } from "../src/engine.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

const C = (rank, suit) => ({ rank, suit });

// A finished hand, described by what the two sides took rather than by cards.
// `ptsTaken` must total 120 minus whatever is buried.
function finished({ ptsTaken, trickCounts, picker = 0, partner = 1, buried = [], doubler = 1 }) {
  return scoreHand({
    buried, picker, partner,
    alone: partner === null,
    scores: [0, 0, 0, 0, 0],
    ptsTaken, trickCounts, doubler,
  });
}

const deltasOf = (g) => g.result.handDelta;
const sum = (a) => a.reduce((s, n) => s + n, 0);
const show = (a) => `[${a.map((n) => (n >= 0 ? "+" : "") + n).join(", ")}]`;

// Every scored hand, whatever the rule, moves points between seats and creates
// none. Asserted on all of them.
function checkZeroSum(name, g) {
  check(`${name}: zero-sum`, sum(deltasOf(g)) === 0, show(deltasOf(g)));
}

/* ------------------- Schneider boundaries are asymmetric ------------------ */
// Schneider is half of what a side needs to win, and the sides need different
// things: 61 for the picker, 60 for the defenders, because a 60-60 tie goes to
// the defenders. So the picker is out of schneider at 31 and the defenders at
// 30 — every defender threshold one point below the picker's.
//
// The code used to test <= 30 on both sides. Measured over 19,218 played
// hands, that handed the picker an unearned 2x on 1.12% of them — 4.4% of all
// schneiders, every one in the picker's favour. Both sides of both boundaries
// are pinned here because an off-by-one is invisible anywhere except at the
// boundary itself.
{
  const label = (teamPts, tricks) => finished({
    // seat 0 is the picker, seat 2 a defender; the split is all that matters.
    ptsTaken: [teamPts, 0, 120 - teamPts, 0, 0],
    trickCounts: tricks,
  }).result.label;

  // Picker wins; the DEFENDERS are the side at risk. Out of schneider at 30.
  check("defenders on 31 are not schneidered", label(89, [3, 0, 3, 0, 0]) === "");
  check("defenders on 30 are NOT schneidered — this is the fix",
    label(90, [3, 0, 3, 0, 0]) === "", `got "${label(90, [3, 0, 3, 0, 0])}"`);
  check("defenders on 29 ARE schneidered",
    label(91, [3, 0, 3, 0, 0]) === "No Schneider!", `got "${label(91, [3, 0, 3, 0, 0])}"`);

  // Defenders win; the PICKER's team is the side at risk. Out of schneider at 31.
  check("picker on 31 is not schneidered", label(31, [3, 0, 3, 0, 0]) === "");
  check("picker on 30 IS schneidered",
    label(30, [3, 0, 3, 0, 0]) === "No Schneider!", `got "${label(30, [3, 0, 3, 0, 0])}"`);
  check("picker on 29 is schneidered", label(29, [3, 0, 3, 0, 0]) === "No Schneider!");

  // The boundary must not swallow the no-tricker, which outranks it.
  check("taking every trick is a no-tricker, not a schneider",
    label(120, [6, 0, 0, 0, 0]) === "No-tricker!", `got "${label(120, [6, 0, 0, 0, 0])}"`);
  check("losing every trick is a no-tricker",
    label(0, [0, 0, 6, 0, 0]) === "No-tricker!", `got "${label(0, [0, 0, 6, 0, 0])}"`);
}

/* ----------------------------- Ordinary hands ---------------------------- */
{
  // Picker team takes 70. Picker +2, partner +1, three defenders -1 each.
  const g = finished({ ptsTaken: [40, 30, 20, 20, 10], trickCounts: [2, 1, 1, 1, 1] });
  check("plain win: picker +2, partner +1, defenders -1",
    JSON.stringify(deltasOf(g)) === JSON.stringify([2, 1, -1, -1, -1]), show(deltasOf(g)));
  check("plain win is not flagged as bumped", g.result.bumped === false);
  check("plain win stake is 1", g.result.stake === 1, `stake=${g.result.stake}`);
  checkZeroSum("plain win", g);
}

{
  // The rule itself. Picker team takes 50 and is set, so everything doubles:
  // picker -4, partner -2, defenders +2 each.
  const g = finished({ ptsTaken: [30, 20, 30, 20, 20], trickCounts: [1, 1, 2, 1, 1] });
  check("set picker pays double: -4 / -2, defenders +2",
    JSON.stringify(deltasOf(g)) === JSON.stringify([-4, -2, 2, 2, 2]), show(deltasOf(g)));
  check("set hand is flagged as bumped", g.result.bumped === true);
  check("set hand stake is 2", g.result.stake === 2, `stake=${g.result.stake}`);
  checkZeroSum("set picker", g);
}

/* -------------------- The bump stacks with the multiplier ---------------- */
{
  // Picker team held to 25 — defenders take 95, so "No Schneider!" at 2x, and
  // the picker is set, so 2x again. Picker -8, partner -4, defenders +4.
  const g = finished({ ptsTaken: [15, 10, 40, 30, 25], trickCounts: [1, 1, 2, 1, 1] });
  check("set + no schneider is 4x", g.result.stake === 4, `stake=${g.result.stake}`);
  check("set + no schneider: -8 / -4, defenders +4",
    JSON.stringify(deltasOf(g)) === JSON.stringify([-8, -4, 4, 4, 4]), show(deltasOf(g)));
  check("label still reads No Schneider!", g.result.label === "No Schneider!", g.result.label);
  checkZeroSum("set + no schneider", g);
}

{
  // Picker team takes no trick at all: 3x for the no-tricker, 2x for the bump.
  const g = finished({ ptsTaken: [0, 0, 60, 40, 20], trickCounts: [0, 0, 3, 2, 1] });
  check("set + no-tricker is 6x", g.result.stake === 6, `stake=${g.result.stake}`);
  check("set + no-tricker: -12 / -6, defenders +6",
    JSON.stringify(deltasOf(g)) === JSON.stringify([-12, -6, 6, 6, 6]), show(deltasOf(g)));
  checkZeroSum("set + no-tricker", g);
}

{
  // Winning big is NOT doubled — the bump is a penalty on the picker, not a
  // general multiplier. Picker team takes 95: 2x for the schneider only.
  const g = finished({ ptsTaken: [60, 35, 10, 10, 5], trickCounts: [3, 2, 1, 0, 0] });
  check("winning at no-schneider stays 2x, not 4x", g.result.stake === 2, `stake=${g.result.stake}`);
  check("winning no-schneider: +4 / +2, defenders -2",
    JSON.stringify(deltasOf(g)) === JSON.stringify([4, 2, -2, -2, -2]), show(deltasOf(g)));
  checkZeroSum("winning no-schneider", g);
}

/* ------------------------------ Going alone ------------------------------ */
{
  // Alone and set: 4x base for the loner, doubled. -8 for the picker, +2 each
  // to the four defenders. The loner needs 31+ here — hold him to 30 and this
  // is a no-schneider as well, which is 4x and a different case (below).
  const g = finished({ ptsTaken: [45, 25, 20, 20, 10], trickCounts: [2, 1, 1, 1, 1], partner: null });
  check("alone and set: picker -8, four defenders +2",
    JSON.stringify(deltasOf(g)) === JSON.stringify([-8, 2, 2, 2, 2]), show(deltasOf(g)));
  checkZeroSum("alone and set", g);
}

{
  // The case the one above sidesteps: a loner held to 30 or less is both set
  // and no-schneidered, so 2x for the multiplier and 2x for the bump.
  const g = finished({ ptsTaken: [30, 25, 25, 20, 20], trickCounts: [1, 1, 2, 1, 1], partner: null });
  check("alone, set AND no-schneidered is 4x", g.result.stake === 4, `stake=${g.result.stake}`);
  check("alone + set + no schneider: picker -16, four defenders +4",
    JSON.stringify(deltasOf(g)) === JSON.stringify([-16, 4, 4, 4, 4]), show(deltasOf(g)));
  checkZeroSum("alone set no-schneider", g);
}

{
  const g = finished({ ptsTaken: [70, 20, 10, 10, 10], trickCounts: [4, 1, 1, 0, 0], partner: null });
  check("alone and home: picker +4, four defenders -1",
    JSON.stringify(deltasOf(g)) === JSON.stringify([4, -1, -1, -1, -1]), show(deltasOf(g)));
  checkZeroSum("alone and home", g);
}

/* -------------------------- Doubler on a throw-in ------------------------ */
{
  // Same ordinary win as the first case, on a hand carrying a doubler.
  const g = finished({ ptsTaken: [40, 30, 20, 20, 10], trickCounts: [2, 1, 1, 1, 1], doubler: 2 });
  check("doubler doubles an ordinary win",
    JSON.stringify(deltasOf(g)) === JSON.stringify([4, 2, -2, -2, -2]), show(deltasOf(g)));
  check("doubler is reported on the result", g.result.doubler === 2, `doubler=${g.result.doubler}`);
  checkZeroSum("doubler win", g);
}

{
  // Doubler and a bump compound: 2x for the doubler, 2x for the set.
  const g = finished({ ptsTaken: [30, 20, 30, 20, 20], trickCounts: [1, 1, 2, 1, 1], doubler: 2 });
  check("doubler and bump compound to 4x", g.result.stake === 4, `stake=${g.result.stake}`);
  check("doubler + set: -8 / -4, defenders +4",
    JSON.stringify(deltasOf(g)) === JSON.stringify([-8, -4, 4, 4, 4]), show(deltasOf(g)));
  checkZeroSum("doubler + set", g);
}

{
  // Two pass-outs running: the stake stacks, and stacks on top of everything
  // else. Doubler 4, set (2x), no schneider (2x) = 16x.
  const g = finished({ ptsTaken: [15, 10, 40, 30, 25], trickCounts: [1, 1, 2, 1, 1], doubler: 4 });
  check("stacked doubler compounds with bump and multiplier", g.result.stake === 16,
    `stake=${g.result.stake}`);
  checkZeroSum("stacked doubler", g);
}

/* ------------------------- The doubler has to ride ----------------------- */
{
  // freshHand carries the stake in, and defaults to a normal hand.
  const plain = freshHand(0, [0, 0, 0, 0, 0], 1);
  const doubled = freshHand(0, [0, 0, 0, 0, 0], 2, 2);
  check("a fresh hand is undoubled by default", plain.doubler === 1, `doubler=${plain.doubler}`);
  check("a fresh hand accepts an inherited doubler", doubled.doubler === 2, `doubler=${doubled.doubler}`);
}

{
  // Buried points belong to the picking team, and a doubled hand must not
  // change who they count for.
  const g = finished({
    ptsTaken: [35, 30, 20, 20, 10], trickCounts: [2, 1, 1, 1, 1],
    buried: [C("A", "H"), C("K", "S")], doubler: 2,
  });
  check("buried points still count to the picking team",
    g.result.teamPts === 35 + 30 + 15, `teamPts=${g.result.teamPts}`);
  check("both sides still total 120", g.result.teamPts + g.result.defPts === 120,
    `${g.result.teamPts} + ${g.result.defPts}`);
  checkZeroSum("buried points on a doubler", g);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — double on the bump and pass-out doublers price hands correctly.");
