#!/usr/bin/env node
/* ============================================================================
   The status line and the call options.

   Both halves of the game describe the same moments, and they had drifted into
   describing them differently — including one moment the table did not describe
   at all. These pin the copy and the rule so the next divergence is a failure
   rather than a screenshot someone notices weeks later.

   Usage: node scripts/statustest.mjs
   ========================================================================= */
import { statusLine, progressLine, callLabel, callPrompt } from "../src/status.js";
import { callOptions } from "../src/engine.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

const NAMES = ["You", "Gus", "Bunny", "Duane", "Patty"];
const TABLE = ["Jacob", "Gus", "Bunny", "Duane", "Patty"];
const line = (g, over = {}) =>
  statusLine({ g, names: NAMES, mySeat: 0, isMyTurn: false, ...over });

/* -------------------------------- picking --------------------------------- */
{
  check("your own pick decision is an invitation, not a prompt",
    line({ phase: "picking", pickTurn: 0, passes: 0 }) === "Blind's yours if you want it.",
    line({ phase: "picking", pickTurn: 0, passes: 0 }));
  check("someone else deciding is named",
    line({ phase: "picking", pickTurn: 2, passes: 1 }) === "Bunny is thinking…");
  check("an all-pass says what happens next",
    line({ phase: "picking", pickTurn: 0, passes: 5 }) === "Everyone passed — redealing…");
}

/* --------------------------------- burying -------------------------------- */
{
  // The live count is the point: it says how many more to tap without looking
  // back at the button. The table used to say "Bury two, then call an ace."
  // and left you counting cards yourself.
  check("burying counts as you pick",
    line({ phase: "bury", picker: 0 }, { selected: 1 }) === "Bury two cards (1/2)",
    line({ phase: "bury", picker: 0 }, { selected: 1 }));
  check("someone else burying is named",
    line({ phase: "bury", picker: 3 }) === "Duane is burying…");
}

/* ---------------------------------- calling ------------------------------- */
{
  // THE bug this file exists for. The table had no call branch, so it fell
  // through to the play branch — and with no turn set during the call it
  // announced "Someone's play…" while you were choosing an ace.
  const opts = [{ kind: "ace", suit: "C" }];
  const mine = line({ phase: "call", picker: 0, turn: -1 }, { options: opts });
  check("your call is a prompt about calling", mine === "Call an ace — your partner holds it.", mine);
  check("...and never mentions whose play it is", !/play/i.test(mine), mine);

  const none = line({ phase: "call", picker: 0, turn: -1 }, { options: [] });
  check("no callable suit says you're alone",
    none === "No callable suit. You're going alone.", none);

  check("someone else calling is named",
    line({ phase: "call", picker: 4, turn: -1 }) === "Patty is calling…");
}

/* ---------------------------------- playing ------------------------------- */
{
  check("your turn is short", line({ phase: "playing", turn: 0, trick: [] }, { isMyTurn: true }) === "Your play.");
  check("another seat's turn is named",
    line({ phase: "playing", turn: 1, trick: [] }) === "Gus's play…");

  // Second person, or it reads "You takes the trick".
  const trick = [
    { player: 0, card: { rank: "A", suit: "S" } },
    { player: 1, card: { rank: "7", suit: "S" } },
    { player: 2, card: { rank: "8", suit: "S" } },
    { player: 3, card: { rank: "9", suit: "S" } },
    { player: 4, card: { rank: "K", suit: "S" } },
  ];
  check("winning it yourself is second person",
    line({ phase: "playing", turn: -1, trick }) === "You take the trick",
    line({ phase: "playing", turn: -1, trick }));

  // Led by you with the lowest spade, so the ace at the end takes it. (My
  // first attempt swapped your card for an off-suit heart — which, since you
  // LEAD, made hearts the suit and handed you the trick.)
  const theirs = [
    { player: 0, card: { rank: "7", suit: "S" } },
    { player: 1, card: { rank: "8", suit: "S" } },
    { player: 2, card: { rank: "9", suit: "S" } },
    { player: 3, card: { rank: "K", suit: "S" } },
    { player: 4, card: { rank: "A", suit: "S" } },
  ];
  check("someone else winning is third person",
    line({ phase: "playing", turn: -1, trick: theirs }) === "Patty takes the trick",
    line({ phase: "playing", turn: -1, trick: theirs }));
}

/* -------------------------- named from the seat list ---------------------- */
{
  // A table passes real names and a seat that isn't 0. Solo's cast calls seat
  // 0 "You"; a table has to derive it, and getting it wrong seats a stranger
  // in your chair.
  const g = { phase: "picking", pickTurn: 1, passes: 0 };
  check("your own seat is 'You' whatever it is called",
    statusLine({ g: { ...g, pickTurn: 3 }, names: TABLE, mySeat: 3, isMyTurn: false }) ===
      "Blind's yours if you want it.");
  check("other seats use the table's names",
    statusLine({ g, names: TABLE, mySeat: 3, isMyTurn: false }) === "Gus is thinking…");
}

/* -------------------------------- progress -------------------------------- */
{
  check("no progress line before the first trick is done",
    progressLine({ g: { phase: "playing", tricksDone: 0, ptsTaken: [0,0,0,0,0] } }) === null);
  check("progress counts tricks and your points",
    progressLine({ g: { phase: "playing", tricksDone: 2, ptsTaken: [24,0,0,0,0] }, mySeat: 0 }) ===
      "Trick 3 of 6 · You've taken 24 pts");
  check("progress reads the viewer's own seat",
    progressLine({ g: { phase: "playing", tricksDone: 1, ptsTaken: [0,0,0,11,0] }, mySeat: 3 }) ===
      "Trick 2 of 6 · You've taken 11 pts");
  check("no progress line once the hand is over",
    progressLine({ g: { phase: "handEnd", tricksDone: 6, ptsTaken: [0,0,0,0,0] } }) === null);
}

/* ---------------------- room for the calls still to come ------------------ */
{
  // Calling a ten and calling under are different calls of the SAME suit, so a
  // list of suits cannot describe them. These assert the shape is ready even
  // though engine.callOptions() only emits aces today.
  check("an ace call reads plainly", callLabel({ kind: "ace", suit: "C" }) === "Call ♣ Clubs",
    callLabel({ kind: "ace", suit: "C" }));
  check("a ten call names the ten", callLabel({ kind: "ten", suit: "S" }) === "Call the ♠ Spades ten",
    callLabel({ kind: "ten", suit: "S" }));
  check("calling under says under", callLabel({ kind: "under", suit: "H" }) === "Call ♥ Hearts under",
    callLabel({ kind: "under", suit: "H" }));

  check("a mixed set gets a prompt that doesn't say 'ace'",
    callPrompt([{ kind: "ten", suit: "S" }]) === "Call your partner.",
    callPrompt([{ kind: "ten", suit: "S" }]));

  // The rule itself, which lived in two screens and no engine.
  const hand = [
    { rank: "K", suit: "C" }, { rank: "A", suit: "S" }, { rank: "9", suit: "S" },
    { rank: "8", suit: "H" }, { rank: "Q", suit: "C" }, { rank: "J", suit: "D" },
  ];
  const opts = callOptions(hand, []);
  check("callable needs a card of the suit", opts.some((o) => o.suit === "C"));
  check("callable excludes a suit whose ace you hold", !opts.some((o) => o.suit === "S"),
    JSON.stringify(opts));
  check("every option is shaped for a kind", opts.every((o) => o.kind === "ace" && o.suit));

  // Burying the ace you were about to call is not a loophole.
  const buried = callOptions(hand, [{ rank: "A", suit: "C" }]);
  check("burying an ace removes its suit", !buried.some((o) => o.suit === "C"),
    JSON.stringify(buried));
}

/* --------------------- narrating the start of a hand ---------------------- */
{
  // The table replays the opening from state, so the line has to follow it.
  const g = { phase: "playing", turn: -1, trick: [], picker: 4 };
  const say = (over) => statusLine({ g, names: TABLE, mySeat: 0, isMyTurn: false, ...over });

  check("a pass is named in the third person",
    say({ dealing: true, narrating: { type: "pass", seat: 1 } }) === "Gus passes.");
  check("your own pass is second person",
    say({ dealing: true, narrating: { type: "pass", seat: 0 } }) === "You pass.");
  check("taking the blind is named",
    say({ dealing: true, narrating: { type: "pick", seat: 4 } }) === "Patty takes the blind.");
  check("your own pick is second person",
    say({ dealing: true, narrating: { type: "pick", seat: 0 } }) === "You take the blind.");
  check("the call is spoken with the suit",
    say({ dealing: true, narrating: { type: "bury", seat: 4, calledSuit: "C" } }) ===
      "Patty calls ♣ Clubs.");
  check("going alone is spoken as going alone",
    say({ dealing: true, narrating: { type: "bury", seat: 4, calledSuit: null } }) ===
      "Patty goes alone.");

  // THE gap: state has arrived, no beat shown yet. Falling through to the play
  // branch announced "Someone's play…" over a table where nobody had decided.
  const gap = say({ dealing: true });
  check("the moment before the first beat says it's dealing", gap === "Dealing…", gap);
  check("...and never claims it is someone's play", !/play/i.test(gap), gap);

  // Once the opening is done the line goes back to the game.
  check("after the opening it reads normally",
    say({ dealing: false, isMyTurn: true }) === "Your play.");
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — both halves describe the same moments the same way.");
