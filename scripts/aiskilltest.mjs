#!/usr/bin/env node
/* ============================================================================
   AI skill regression tests — protecting trump power.

   `npm run simulate` measures aggregate outcomes, which is the right tool for
   "is the AI stronger overall" but useless for "does it make this specific
   mistake". Aggregate win rate barely moves when a queen is wasted, because
   the loss is a few points across a hand and the noise is larger. So the
   behaviours players actually notice get asserted directly, on constructed
   positions.

   The reported case (2026-07-26): with a Jack led, two AI seats played Queens
   while holding lower trump. The schmear branch sorts candidates by card
   points, and among trump the Queen (3) outranks the Jack (2) — so the AI was
   throwing its most powerful card away for one extra point.

   Usage: node scripts/aiskilltest.mjs
   ========================================================================= */
import { aiChooseCard, legalPlays, cid, isTrump, trumpPower } from "../src/engine.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

const C = (rank, suit) => ({ rank, suit });

// A playing-phase position with only the fields aiChooseCard and legalPlays
// read. tricksDone stays <= 3 so the exact endgame solver doesn't take over.
function position({
  hands, trick = [], picker, partner = null, partnerRevealed = false,
  calledSuit = null, calledAcePlayed = true, tricksDone = 0, leader = 0,
}) {
  return {
    phase: "playing",
    handNum: 1,
    dealer: 0,
    hands,
    blind: [],
    buried: [],
    picker,
    partner,
    partnerRevealed,
    calledSuit,
    calledAcePlayed,
    calledSuitLed: false,
    alone: partner === null,
    pickTurn: 0,
    passes: 0,
    played: [],
    trick,
    leader,
    turn: 0,
    tricksDone,
    trickCounts: [0, 0, 0, 0, 0],
    ptsTaken: [0, 0, 0, 0, 0],
    lastTrick: null,
    trickHistory: [],
    selected: [],
    scores: [0, 0, 0, 0, 0],
    message: null,
    result: null,
  };
}

const empty = [[], [], [], [], []];
const withHand = (idx, cards) => empty.map((h, i) => (i === idx ? cards : [C("7", "S")]));

/* ------------------- The reported hand, in play order --------------------- */
// The recap grid lists seats, not play order. Patty (4) LED, so the trick ran
// Patty -> You (0) -> Gus (1) -> Bunny (2) -> Duane (3), and You had already
// dropped Q-clubs — the highest trump in the game — before either AI acted.
//
// That is the whole point: neither Gus nor Bunny could win this trick. Both
// were choosing what to THROW, and both threw a Queen. Duane (3) is picker,
// Patty his partner and not yet revealed, so the defenders believe whoever is
// winning is a teammate — which is what opens the schmear branch.
const ledByPatty = { player: 4, card: C("J", "S") };
const topTrumpDown = { player: 0, card: C("Q", "C") };

{
  // Gus held Q-hearts and J-clubs. Both beat the led J-spades, so the correct
  // play is the CHEAPER winner: take the trick with the Jack and keep the
  // Queen. The bug schmeared the Queen for one extra card point.
  const hand = [C("Q", "H"), C("J", "C"), C("K", "S"), C("9", "H"), C("K", "C"), C("9", "C")];
  const g = position({
    hands: withHand(1, hand), trick: [ledByPatty, topTrumpDown], picker: 3, partner: 4,
  });
  const legal = legalPlays(g, 1);
  check("Gus: following trump, both trumps are legal",
    legal.length === 2 && legal.every(isTrump), `legal=${legal.map(cid).join(",")}`);
  check("Gus cannot win — Q-clubs is already down",
    !legal.some((c) => trumpPower(c) > trumpPower(C("Q", "C"))));

  const pick = aiChooseCard(g, 1);
  check("Gus does not throw the Queen", cid(pick) !== "QH", `played ${cid(pick)}`);
  check("Gus throws its lowest trump instead", cid(pick) === "JC", `played ${cid(pick)}`);
}

{
  // Bunny acted fourth, with Q-clubs and Gus's Q-hearts already down, holding
  // Q-spades and 8-diamonds. Also unable to win, and threw the Queen over a
  // worthless 8 for the sake of three card points.
  const hand = [C("Q", "S"), C("8", "D"), C("7", "S"), C("7", "H"), C("10", "C"), C("K", "H")];
  const g = position({
    hands: withHand(2, hand),
    trick: [ledByPatty, topTrumpDown, { player: 1, card: C("Q", "H") }],
    picker: 3, partner: 4,
  });
  const pick = aiChooseCard(g, 2);
  check("Bunny does not throw the Queen", cid(pick) !== "QS", `played ${cid(pick)}`);
  check("Bunny throws its worthless trump instead", cid(pick) === "8D", `played ${cid(pick)}`);
}

/* --------------- Queens are never schmear material at all ----------------- */
{
  // Teammate winning with the top trump, so the trick is genuinely safe — but
  // every legal card is trump. There is nothing here worth spending power on:
  // play the cheapest trump, not the most valuable one.
  const hand = [C("Q", "D"), C("J", "D"), C("8", "D")];
  const g = position({
    hands: withHand(1, hand),
    trick: [{ player: 0, card: C("Q", "C") }],
    picker: 0, partner: 1, partnerRevealed: true, tricksDone: 2,
  });
  const pick = aiChooseCard(g, 1);
  check("never schmears a Queen to a winning teammate", cid(pick) !== "QD", `played ${cid(pick)}`);
  check("never schmears a Jack to a winning teammate", cid(pick) !== "JD", `played ${cid(pick)}`);
  check("gives up the cheapest trump instead", cid(pick) === "8D", `played ${cid(pick)}`);
}

/* ------------------ Real schmears must still happen ----------------------- */
{
  // Fail suit led, teammate winning with the top trump, and this seat is void
  // in the led suit so anything is legal. Handing over the fail Ace is correct
  // Sheepshead — 11 points to your own side, and a fail Ace can be trumped
  // later anyway. The fix must not suppress this.
  const hand = [C("A", "H"), C("7", "H"), C("9", "D")];
  const g = position({
    hands: withHand(4, hand),
    trick: [
      { player: 0, card: C("A", "C") },
      { player: 1, card: C("K", "C") },
      { player: 2, card: C("9", "C") },
      { player: 3, card: C("7", "C") },
    ],
    picker: 0, partner: 4, partnerRevealed: true, tricksDone: 2, leader: 0,
  });
  const pick = aiChooseCard(g, 4);
  check("still schmears fail points to a winning teammate", cid(pick) === "AH", `played ${cid(pick)}`);
}

{
  // Same shape, but the only points available are on a trump. Trump keeps its
  // trick-taking value; three points is not a reason to give that up.
  const hand = [C("Q", "D"), C("7", "H"), C("8", "H")];
  const g = position({
    hands: withHand(4, hand),
    trick: [
      { player: 0, card: C("A", "C") },
      { player: 1, card: C("K", "C") },
      { player: 2, card: C("9", "C") },
      { player: 3, card: C("7", "C") },
    ],
    picker: 0, partner: 4, partnerRevealed: true, tricksDone: 2, leader: 0,
  });
  const pick = aiChooseCard(g, 4);
  check("won't schmear trump when only fail junk is the alternative",
    cid(pick) !== "QD", `played ${cid(pick)}`);
}

/* -------------------- Winning when it's actually worth it ------------------ */
{
  // A fat trick with the PICKER winning it, last to play: take it. Protecting
  // power must not turn into refusing to win.
  //
  // (An earlier version of this case had a teammate winning the trick, where
  // playing the 8 is correct — you don't overtake your own partner on 27
  // points. The assertion was wrong, not the engine.)
  const hand = [C("Q", "S"), C("8", "D")];
  const g = position({
    hands: withHand(4, hand),
    trick: [
      { player: 0, card: C("A", "C") },
      { player: 1, card: C("10", "C") },
      { player: 2, card: C("K", "C") },
      { player: 3, card: C("J", "D") },
    ],
    picker: 3, partner: 0, partnerRevealed: true, tricksDone: 1, leader: 0,
  });
  const pick = aiChooseCard(g, 4);
  check("still takes a valuable trick off the picker with a Queen",
    cid(pick) === "QS", `played ${cid(pick)}`);
}

{
  // Late in the hand a Queen has fewer tricks left to win, so spending it to
  // take a trick is fine — the protection rule must be about early tricks.
  const hand = [C("Q", "S"), C("8", "D")];
  const g = position({
    hands: withHand(2, hand),
    trick: [{ player: 1, card: C("J", "H") }],
    picker: 0, partner: 1, partnerRevealed: true, tricksDone: 3, leader: 1,
  });
  const pick = aiChooseCard(g, 2);
  check("late in the hand, a Queen may still be spent to win",
    cid(pick) === "QS", `played ${cid(pick)}`);
}

/* ------------- Against a loner, there is no partner to fear --------------- */
// v0.8.0 stopped defenders from schmearing on the opening trick while the
// partnership is still a guess. That guard keyed off `partnerRevealed`, which
// is never set when the picker goes alone — there is no called ace to fall — so
// it also muted defenders in the one situation with no uncertainty at all.
// Going alone is declared at pick time and shown all hand ("Picker · Alone"),
// so every defender knows from the first card that the other three seats are
// teammates. That is exactly when pooling points matters most: a loner needs
// 61 on their own, and defenders beat them by piling points onto each other.
{
  // Opening trick of an alone hand. Player 4 is winning with Q-diamonds and is
  // certainly a teammate, because there is no partner for them to be.
  const hand = [C("A", "S"), C("7", "S"), C("8", "S")];
  const g = position({
    hands: withHand(1, hand),
    trick: [
      { player: 2, card: C("9", "H") },
      { player: 3, card: C("7", "H") },
      { player: 4, card: C("Q", "D") },
    ],
    picker: 3, partner: null, partnerRevealed: false,
    calledSuit: null, calledAcePlayed: false, tricksDone: 0, leader: 2,
  });
  check("defender is void and free to throw anything",
    legalPlays(g, 1).length === 3, `legal=${legalPlays(g, 1).map(cid).join(",")}`);

  const pick = aiChooseCard(g, 1);
  check("defender schmears to a teammate on the opening trick of a loner hand",
    cid(pick) === "AS", `played ${cid(pick)}`);
}

{
  // Same certainty later in an alone hand — unchanged by this fix, but it is
  // the case a `partnerRevealed`-only gate would break, so it stays asserted.
  const hand = [C("A", "S"), C("7", "S"), C("8", "S")];
  const g = position({
    hands: withHand(1, hand),
    trick: [
      { player: 2, card: C("9", "H") },
      { player: 3, card: C("7", "H") },
      { player: 4, card: C("Q", "D") },
    ],
    picker: 3, partner: null, partnerRevealed: false,
    calledSuit: null, calledAcePlayed: false, tricksDone: 2, leader: 2,
  });
  const pick = aiChooseCard(g, 1);
  check("defenders still schmear to each other against a loner mid-hand",
    cid(pick) === "AS", `played ${cid(pick)}`);
}

/* ---- Speculative schmearing in PARTNERED hands is deliberate, not a bug --- */
// Tempting symmetry, measured and rejected: knowsTeammate() reports every
// unrevealed seat as a teammate, so from trick 2 onward a defender may hand 11
// points to the picker's hidden partner. Extending v0.8.0's opening-trick guard
// to cover the whole pre-reveal window looks like the same fix — and it is a
// net loss. With the picker excluded, an unrevealed winner is a fellow defender
// two times in three and the partner only one in three, and an Ace held back
// gets trumped later often enough that pooling it beats hoarding it.
//
// Measured over 5x200,000 hands per variant. Suppressing until the reveal moved
// partnered picker win rate 61.7-62.0% -> 62.4-62.8% — non-overlapping ranges,
// so ~0.8pp handed to the picker. Keep the guard scoped to the opening trick.
{
  const hand = [C("A", "S"), C("7", "S"), C("8", "S")];
  const g = position({
    hands: withHand(1, hand),
    trick: [
      { player: 2, card: C("9", "H") },
      { player: 3, card: C("7", "H") },
      { player: 4, card: C("Q", "D") },
    ],
    picker: 3, partner: 4, partnerRevealed: false,
    calledSuit: "C", calledAcePlayed: false, tricksDone: 2, leader: 2,
  });
  const pick = aiChooseCard(g, 1);
  check("defender still takes the 2:1 bet and schmears before the reveal",
    cid(pick) === "AS", `played ${cid(pick)}`);
}

{
  // ...but not on the opening trick of a partnered hand. That is v0.8.0's
  // guard, and this fix must leave it standing.
  const hand = [C("A", "S"), C("7", "S"), C("8", "S")];
  const g = position({
    hands: withHand(1, hand),
    trick: [
      { player: 2, card: C("9", "H") },
      { player: 3, card: C("7", "H") },
      { player: 4, card: C("Q", "D") },
    ],
    picker: 3, partner: 4, partnerRevealed: false,
    calledSuit: "C", calledAcePlayed: false, tricksDone: 0, leader: 2,
  });
  const pick = aiChooseCard(g, 1);
  check("defender holds the Ace on the opening trick of a partnered hand",
    cid(pick) === "7S", `played ${cid(pick)}`);
}

{
  // Once the ace has fallen the partnership is public, so this is a real
  // teammate and the schmear is correct.
  const hand = [C("A", "S"), C("7", "S"), C("8", "S")];
  const g = position({
    hands: withHand(1, hand),
    trick: [
      { player: 2, card: C("9", "H") },
      { player: 3, card: C("7", "H") },
      { player: 0, card: C("Q", "D") },
    ],
    picker: 3, partner: 4, partnerRevealed: true,
    calledSuit: "C", calledAcePlayed: true, tricksDone: 2, leader: 2,
  });
  const pick = aiChooseCard(g, 1);
  check("defender still schmears once the partner is revealed",
    cid(pick) === "AS", `played ${cid(pick)}`);
}

{
  // The partner knows the picker from the moment they pick up the ace call,
  // with no reveal needed — that asymmetry is the one case where schmearing
  // into an unrevealed partnership is certain, and it has to survive.
  const hand = [C("A", "C"), C("A", "H"), C("7", "H")];
  const g = position({
    hands: withHand(4, hand),
    trick: [
      { player: 0, card: C("9", "S") },
      { player: 1, card: C("7", "S") },
      { player: 3, card: C("Q", "D") },
    ],
    picker: 3, partner: 4, partnerRevealed: false,
    calledSuit: "C", calledAcePlayed: false, tricksDone: 2, leader: 0,
  });
  check("partner may not throw the called ace off-suit",
    !legalPlays(g, 4).some((c) => cid(c) === "AC"),
    `legal=${legalPlays(g, 4).map(cid).join(",")}`);
  const pick = aiChooseCard(g, 4);
  check("partner still schmears to the picker before the reveal",
    cid(pick) === "AH", `played ${cid(pick)}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — the AI protects its trump power.");
