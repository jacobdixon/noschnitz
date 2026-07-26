#!/usr/bin/env node
/* ============================================================================
   Paced trick reveal — regression tests.

   The feel of the game depends on cards appearing ONE AT A TIME at the seat
   that played them. A build that renders the whole trick at once still
   compiles, still passes every other suite, and still ruins the game, so the
   sequencing gets its own tests.

   Only the pure half is tested here (buildPlaySequence + frameAt). The hook
   around them is timers and React state; what actually matters — the order of
   plays, that a completed trick is fully shown before the next begins, and
   that the server having already cleared g.trick doesn't lose the fifth card —
   all lives in these two functions.

   Usage: node scripts/pacingtest.mjs
   ========================================================================= */
import { buildPlaySequence, frameAt } from "../src/usePacedTrick.js";
import { freshHand, assignPartner, applyPlay, resolveTrick, aiChooseCard, aiBuryAndCall, handStrength, cid } from "../src/engine.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

/* --------------------------- a real played hand --------------------------- */
function playFullHand(seed = 0) {
  let g = freshHand(seed % 5, [0, 0, 0, 0, 0], 1);
  const states = [g];
  while (g.phase === "picking" && g.passes < 5) {
    const idx = g.pickTurn;
    if (handStrength(g.hands[idx]) >= 10 || (g.passes === 4 && handStrength(g.hands[idx]) >= 8)) {
      const eight = [...g.hands[idx], ...g.blind];
      const { buried, call, hand } = aiBuryAndCall(eight);
      g = { ...g, picker: idx, hands: g.hands.map((h, i) => (i === idx ? hand : h)), buried, calledSuit: call, phase: "playing", trick: [], turn: g.leader };
      g = assignPartner(g);
      states.push(g);
      break;
    }
    g = { ...g, passes: g.passes + 1, pickTurn: (idx + 1) % 5 };
  }
  if (g.phase !== "playing") return null;

  while (g.phase === "playing" && g.tricksDone < 6) {
    while (g.trick.length < 5) {
      g = applyPlay(g, g.turn, aiChooseCard(g, g.turn));
      states.push(g);
    }
    g = resolveTrick(g);
    states.push(g);
  }
  return { final: g, states };
}

// freshHand shuffles, so a given deal may be thrown in (all five pass). Retry
// until we get one that was actually played — the earlier version dealt once
// and happened to work, which made this whole suite fail at random.
function dealPlayedHand(attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    const h = playFullHand(i);
    if (h) return h;
  }
  return null;
}

const hand = dealPlayedHand();
if (!hand) {
  console.error("could not deal a played hand for the test after 50 attempts");
  process.exit(1);
}

/* ------------------------------ sequencing -------------------------------- */
{
  const seq = buildPlaySequence(hand.final);
  check("a completed hand yields all 30 plays", seq.length === 30, `got ${seq.length}`);
  check("plays are grouped into six tricks",
    new Set(seq.map((p) => p.trickIndex)).size === 6);
  check("trick indexes never go backwards",
    seq.every((p, i) => i === 0 || p.trickIndex >= seq[i - 1].trickIndex));
  check("every trick holds exactly five plays",
    [0, 1, 2, 3, 4, 5].every((ti) => seq.filter((p) => p.trickIndex === ti).length === 5));
  check("no card appears twice", new Set(seq.map((p) => cid(p.card))).size === 30);

  // THE regression this file exists for: the server resolves a trick inside
  // the same request, so g.trick is already [] when the client sees it. If the
  // sequence were built from g.trick alone, every fifth card would vanish.
  check("the fifth card of a resolved trick survives",
    hand.final.trick.length === 0 && seq.filter((p) => p.trickIndex === 0).length === 5);
}

/* ------------------------- mid-hand (unresolved) --------------------------- */
{
  // A state captured with three cards down and the trick not yet resolved.
  const mid = hand.states.find((s) => s.trick.length === 3 && s.tricksDone === 1);
  if (mid) {
    const seq = buildPlaySequence(mid);
    check("in-progress trick is appended after history",
      seq.length === 5 + 3, `got ${seq.length}`);
    check("in-progress plays carry the next trick index",
      seq.slice(5).every((p) => p.trickIndex === 1));
  } else {
    check("found a mid-trick state to test", false, "no state with 3 cards in trick 2");
  }
}

/* --------------------------------- frames ---------------------------------- */
{
  const seq = buildPlaySequence(hand.final);

  check("nothing revealed yet shows an empty felt", frameAt(seq, 0).cards.length === 0);

  // Walking the cursor forward one card at a time must only ever show the
  // trick in progress, and must never show a partial trick as complete.
  let ok = true, completeCount = 0;
  for (let n = 1; n <= seq.length; n++) {
    const f = frameAt(seq, n);
    const expectedTrick = seq[n - 1].trickIndex;
    if (f.trickIndex !== expectedTrick) ok = false;
    if (f.cards.some((p) => p.trickIndex !== expectedTrick)) ok = false;
    if (f.cards.length > 5) ok = false;
    if (f.complete && f.cards.length !== 5) ok = false;
    if (f.complete) completeCount++;
  }
  check("each frame shows only the current trick, never overfilled", ok);
  check("a trick reads complete exactly once per trick", completeCount === 6, `got ${completeCount}`);

  const firstFull = frameAt(seq, 5);
  check("a full trick reports its winner", firstFull.complete && firstFull.winner !== null);
  check("a winner is one of the five seats",
    firstFull.winner >= 0 && firstFull.winner <= 4);

  const partial = frameAt(seq, 3);
  check("a partial trick has no winner yet", !partial.complete && partial.winner === null);
  check("a partial trick shows exactly what's been revealed", partial.cards.length === 3);

  // Cards must appear in the order they were played, not sorted or grouped.
  const f4 = frameAt(seq, 4);
  check("revealed cards keep play order",
    f4.cards.map((p) => cid(p.card)).join(",") === seq.slice(0, 4).map((p) => cid(p.card)).join(","));
}


/* --------------------------- sweeping a finished trick --------------------- */
{
  // The bug: a completed trick only vanished when the NEXT card arrived. When
  // the next move belongs to a human there is no next card, so five cards sat
  // on the felt while somebody was being asked to lead the following trick.
  const seq = buildPlaySequence(hand.final);

  const held = frameAt(seq, 5, -1);
  check("a finished trick is shown before it's swept",
    held.cards.length === 5 && held.complete && !held.cleared);

  const swept = frameAt(seq, 5, 0);
  check("sweeping a finished trick empties the felt",
    swept.cards.length === 0 && swept.cleared === true);
  check("a swept trick no longer reads as complete", swept.complete === false);
  check("a swept trick drops its winner banner", swept.winner === null);

  // Sweeping trick 0 must not blank trick 1.
  const nextTrick = frameAt(seq, 8, 0);
  check("sweeping one trick doesn't affect the next",
    nextTrick.cards.length === 3 && !nextTrick.cleared && nextTrick.trickIndex === 1);

  // A partial trick is never swept — only finished ones get a beat and a sweep.
  const partial = frameAt(seq, 3, 0);
  check("a partial trick is never swept", partial.cards.length === 3 && !partial.cleared);
}

/* ---------------------------------- edges ---------------------------------- */
{
  check("a null game yields no plays", buildPlaySequence(null).length === 0);
  check("a freshly dealt hand yields no plays",
    buildPlaySequence(freshHand(0, [0, 0, 0, 0, 0], 1)).length === 0);

  const seq = buildPlaySequence(hand.final);
  check("a cursor past the end clamps to the last trick",
    frameAt(seq, 999).trickIndex === 5 && frameAt(seq, 999).cards.length === 5);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — plays sequence in order and reveal one trick at a time.");
