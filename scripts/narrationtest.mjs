#!/usr/bin/env node
/* ============================================================================
   Replaying the start of a hand.

   The server resolves every AI seat inside the request that deals, so a table's
   first state already has the picking finished, the blind buried, a suit called
   and often cards played. These pin the reconstruction that lets the client
   show it happening instead: who was asked, in what order, and what they did.

   Nothing here needs the network — the sequence is derived from the state — so
   it is all testable headlessly.

   Usage: node scripts/narrationtest.mjs
   ========================================================================= */
import { buildDecisionSequence } from "../src/dealNarration.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const kinds = (seq) => seq.map((d) => `${d.type}:${d.seat}`).join(" ");

/* ------------------------- who gets asked, in order ----------------------- */
{
  // Picking starts LEFT of the dealer and goes round. Dealer 0 means seat 1 is
  // asked first — getting this backwards would name the wrong player on every
  // hand, which is the kind of thing that reads as a bug in the AI.
  const seq = buildDecisionSequence({
    dealer: 0, passes: 2, picker: 3, phase: "playing", calledSuit: "C", handNum: 1,
  });
  check("asks left of the dealer first", seq[0].seat === 1, kinds(seq));
  check("goes round in seat order", seq[1].seat === 2, kinds(seq));
  check("the picker follows the passers", seq[2].type === "pick" && seq[2].seat === 3, kinds(seq));
  check("the bury is the last beat", seq[3].type === "bury" && seq[3].seat === 3, kinds(seq));
  check("the call rides with the bury", seq[3].calledSuit === "C");
  check("no extra beats", seq.length === 4, kinds(seq));
}

/* ------------------------------ wrapping round ---------------------------- */
{
  // Dealer 3, three passes: seats 4, 0, 1 are asked, then seat 2 picks.
  const seq = buildDecisionSequence({
    dealer: 3, passes: 3, picker: 2, phase: "playing", calledSuit: "S", handNum: 1,
  });
  check("wraps past the last seat",
    seq.slice(0, 3).map((d) => d.seat).join(",") === "4,0,1", kinds(seq));
  check("...and still finds the picker", seq[3].seat === 2 && seq[2].seat === 1, kinds(seq));
}

/* -------------------------- the picker went first ------------------------- */
{
  const seq = buildDecisionSequence({
    dealer: 0, passes: 0, picker: 1, phase: "playing", calledSuit: "H", handNum: 1,
  });
  check("nobody passed means the first asked picked",
    seq.length === 2 && seq[0].type === "pick" && seq[0].seat === 1, kinds(seq));
}

/* --------------------------------- alone ---------------------------------- */
{
  const seq = buildDecisionSequence({
    dealer: 0, passes: 1, picker: 2, phase: "playing", calledSuit: null, handNum: 1,
  });
  const bury = seq[seq.length - 1];
  check("going alone still gets a bury beat", bury.type === "bury");
  check("...with no suit to call", bury.calledSuit === null);
}

/* ------------------------------- thrown in -------------------------------- */
{
  // All five passed: no picker, no bury, and the passes are the whole story.
  const seq = buildDecisionSequence({
    dealer: 2, passes: 5, picker: null, phase: "picking", handNum: 1,
  });
  check("a thrown-in hand is five passes", seq.length === 5 && seq.every((d) => d.type === "pass"),
    kinds(seq));
  check("...starting left of the dealer", seq[0].seat === 3, kinds(seq));
  check("...and wrapping all the way round",
    new Set(seq.map((d) => d.seat)).size === 5, kinds(seq));
}

/* ----------------------- nothing that hasn't happened --------------------- */
{
  // Mid-decision: two have passed and the table is waiting on the third. The
  // beats must stop there — showing a pick nobody has made is the same class
  // of spoiler as showing the score before the cards.
  const waiting = buildDecisionSequence({
    dealer: 0, passes: 2, picker: null, phase: "picking", handNum: 1,
  });
  check("stops at what has actually happened",
    waiting.length === 2 && waiting.every((d) => d.type === "pass"), kinds(waiting));

  // Picked, but still burying: the pick is known, the bury is not.
  const burying = buildDecisionSequence({
    dealer: 0, passes: 1, picker: 2, phase: "bury", handNum: 1,
  });
  check("a bury still in progress is not a beat yet",
    burying.length === 2 && burying[1].type === "pick", kinds(burying));

  // And once the hand is over, the whole opening is still reconstructable.
  const over = buildDecisionSequence({
    dealer: 0, passes: 1, picker: 2, phase: "handEnd", calledSuit: "C", handNum: 1,
  });
  check("a finished hand still reconstructs", over.length === 3, kinds(over));
}

/* --------------------------------- edges ---------------------------------- */
{
  check("no state, no beats", buildDecisionSequence(null).length === 0);
  check("no dealer, no beats", buildDecisionSequence({ passes: 2, picker: 1 }).length === 0);
  check("a freshly dealt hand has nothing to show",
    buildDecisionSequence({ dealer: 0, passes: 0, picker: null, phase: "picking" }).length === 0);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — the start of a hand reconstructs exactly from the state.");
