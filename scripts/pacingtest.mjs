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
import { displayState } from "../src/displayState.js";
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

/* ------------------------- no spoilers before the cards -------------------- */
{
  // The complaint this exists for: "don't show score changes on the felt
  // before the recap — it ruins the ending." The server resolves a whole hand
  // in one request, so its scores and trick counts are final while the client
  // is still dealing out the last trick a card at a time. The felt must show
  // what the player has SEEN, not what the server knows.
  const g = hand.final;
  const seq = buildPlaySequence(g);

  // Mid-reveal of the final trick: four of the last trick's five cards shown.
  const midLast = frameAt(seq, seq.length - 1);
  const during = displayState(g, midLast, null, false);

  check("scores are rewound while the last trick is still landing",
    during.scores.every((n, i) => n === g.scores[i] - g.result.handDelta[i]),
    `got ${JSON.stringify(during.scores)} against final ${JSON.stringify(g.scores)}`);

  check("...and that actually differs from the final score",
    g.result.handDelta.some((d) => d !== 0),
    "fixture scored a flat hand, so this proves nothing");

  check("trick counts only count tricks that finished on screen",
    during.trickCounts.reduce((a, b) => a + b, 0) === midLast.trickIndex,
    `counted ${during.trickCounts.reduce((a, b) => a + b, 0)} with ${midLast.trickIndex} tricks seen`);

  // The moment the reveal catches up, the truth is allowed through — the
  // summary appears on the same condition, so they move together.
  const after = displayState(g, frameAt(seq, seq.length), null, true);
  check("scores are the real ones once the reveal catches up",
    after.scores.every((n, i) => n === g.scores[i]));
  check("trick counts are the real ones once the reveal catches up",
    after.trickCounts.every((n, i) => n === g.trickCounts[i]));

  // Mid-hand, before any hand-end result exists, nothing should be invented.
  const early = frameAt(seq, 7);
  const mid = displayState({ ...g, phase: "playing", result: null }, early, null, false);
  check("mid-hand scores pass through untouched",
    mid.scores.every((n, i) => n === g.scores[i]));

  // The partner is the hand's most guarded secret, and the server gives it away
  // the moment the called ace is played — which can be several plays ahead of
  // what the client has drawn.
  //
  // Dealt until a hand actually reveals a partner, rather than checking the
  // main fixture and quietly skipping when it doesn't: a random deal goes alone
  // or never has the ace played often enough that this would have been silent
  // coverage most runs. If no such hand turns up, that is a failure, not a pass.
  let pg = null;
  for (let i = 0; i < 200 && !pg; i++) {
    const h = playFullHand(1000 + i);
    if (h && h.final.calledSuit && h.final.partner !== null && h.final.partnerRevealed) pg = h.final;
  }
  check("dealt a hand where the called ace actually gets played", pg !== null,
    "200 deals without one — the check below never ran");

  if (pg) {
    const pseq = buildPlaySequence(pg);
    const aceId = `A${pg.calledSuit}`;
    const aceAt = pseq.findIndex((p) => p.card.rank + p.card.suit === aceId);
    check("the called ace is somewhere in the sequence", aceAt >= 0);

    // One play before the ace lands: the server knows, the felt must not.
    const before = displayState(pg, frameAt(pseq, aceAt), null, false);
    check("the partner stays hidden until the called ace is shown",
      before.partnerRevealed === false,
      `partnerRevealed was ${before.partnerRevealed} with the ace still to come`);

    // The moment it lands, the badge is earned.
    const after = displayState(pg, frameAt(pseq, aceAt + 1), null, false);
    check("...and is revealed as soon as it lands", after.partnerRevealed === true);

    // And it must not un-reveal for the rest of the hand.
    const atEnd = displayState(pg, frameAt(pseq, pseq.length), null, true);
    check("...and stays revealed once shown", atEnd.partnerRevealed === true);
  }

  // The active-seat glow must not run ahead of the cards either.
  check("turn is masked until the reveal catches up", during.turn === -1 && during.pickTurn === -1);
  check("turn is live once it has", after.turn === g.turn);
}

/* ------------------------ your own card, immediately ---------------------- */
{
  // Tapping a card must put it on the felt now, not when the server answers.
  // The gap that mattered: the beat right after a trick sweeps is exactly when
  // you LEAD the next one, and the stand-in was suppressed for the whole of it.
  // Measured at 3,565ms on beta before this was fixed.
  const g = hand.final;
  const seq = buildPlaySequence(g);
  // A card provably NOT in this hand's sequence — which is harder than it
  // sounds. Hardcoding A♠ was flaky because the fixture is a random deal and
  // the ace was often in the very trick being checked. Picking from a list of
  // likely candidates was worse: a full hand plays 30 of the 32 cards, so the
  // list gets exhausted and the test crashes rather than fails.
  //
  // The buried pair is exactly the two cards that are never played. It is the
  // only guaranteed answer.
  const buried = g.buried || [];
  check("the fixture buried two cards to stand in with", buried.length > 0,
    "no buried cards, so the stand-in has nothing safe to use");
  const stand = buried[0];
  const spare = stand ? stand.rank + stand.suit : null;
  const mine = { card: stand, player: 0 };
  check("the stand-in really is outside the deal",
    Boolean(spare) && !seq.some((p) => p.card.rank + p.card.suit === spare), spare || "none");

  // A completed trick that has been swept: cards gone, `cleared` set.
  const firstTrick = seq.filter((p) => p.trickIndex === 0).length;
  const swept = frameAt(seq, firstTrick, 0);
  check("the fixture frame really is a swept trick",
    swept.cleared === true && swept.cards.length === 0,
    `cleared=${swept.cleared} cards=${swept.cards.length}`);

  const led = displayState(g, swept, mine, true);
  check("a card led into a just-swept felt shows immediately",
    led.trick.some((p) => p.card.rank + p.card.suit === spare),
    `trick drew ${JSON.stringify(led.trick.map((p) => p.card.rank + p.card.suit))}`);

  // Mid-trick it must still show, alongside what is already down.
  const mid = frameAt(seq, firstTrick + 2);
  const joined = displayState(g, mid, mine, true);
  check("a card played into a trick in progress shows immediately",
    joined.trick.some((p) => p.card.rank + p.card.suit === spare));
  check("...without dropping the cards already on the felt",
    joined.trick.length === mid.cards.length + 1);

  // And it must not double up once the real card has been revealed.
  const real = seq[0].card;
  const dup = displayState(g, frameAt(seq, 1), { card: real, player: seq[0].player }, true);
  const ids = dup.trick.map((p) => p.card.rank + p.card.suit);
  check("the stand-in never doubles the real card",
    new Set(ids).size === ids.length, ids.join(","));
}

/* ------------------ nothing on the table while still dealing -------------- */
{
  // Reported from real play: the picking and the bury were being narrated
  // while three cards already sat on the felt — a table mid-deal and mid-trick
  // at once. Two cursors are rewound on a new hand and one of them arriving
  // late is enough to do it, so the rule is stated outright rather than left
  // to their timing.
  const g = hand.final;
  const seq = buildPlaySequence(g);
  const midTrick = frameAt(seq, 3);
  check("the fixture frame really has cards on it", midTrick.cards.length === 3,
    `got ${midTrick.cards.length}`);

  const dealing = displayState(g, midTrick, null, false, true);
  check("the felt is empty while the opening is still being narrated",
    dealing.trick.length === 0,
    `drew ${JSON.stringify(dealing.trick.map((p) => p.card.rank + p.card.suit))}`);

  // Your own card is no exception — it cannot be played before the bury.
  const withStandIn = displayState(g, midTrick, { card: (g.buried || [])[0], player: 0 }, false, true);
  check("...including your own stand-in", withStandIn.trick.length === 0);

  // And once the opening is done the cards come back exactly as before.
  const playing = displayState(g, midTrick, null, true, false);
  check("the felt fills again once the deal is over",
    playing.trick.length === midTrick.cards.length,
    `${playing.trick.length} vs ${midTrick.cards.length}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — plays sequence in order, reveals one trick at a time, and spoils nothing early.");
