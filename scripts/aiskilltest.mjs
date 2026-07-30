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
import {
  aiChooseCard, legalPlays, cid, isTrump, trumpPower, trickSecurity, securityAfterPlay,
  cardEquity, applyPlay, solveHandValue, cardPts, trickWinner, knowsTeammate,
  SCHMEAR_CONFIDENCE, OVERTAKE_MIN_GAIN,
  freshHand, assignPartner, resolveTrick, sortHand,
  calledCardCandidates, knownPartner, provenSide,
} from "../src/engine.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

const C = (rank, suit) => ({ rank, suit });

// A playing-phase position with only the fields aiChooseCard and legalPlays
// read. Most cases keep tricksDone <= 3 so the exact endgame solver doesn't
// take over; the endgame tie-break case at the bottom deliberately does not.
function position({
  hands, trick = [], picker, partner = null, partnerRevealed = false,
  calledSuit = null, calledAcePlayed = true, tricksDone = 0, leader = 0,
  played = [], turn = 0,
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
    played,
    trick,
    leader,
    turn,
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

/* ------ Forced into trump: spend the fat one, not the powerful one -------- */
// Reported 2026-07-27 from expert play. Patty picked and went ALONE, then led
// J-hearts on trick 2. Play ran Patty(4) -> You(0) -> Gus(1) -> Bunny(2) ->
// Duane(3), and You had already dropped Q-clubs, so the trick was unbeatable
// and belonged to the defenders before any AI seat acted. Every seat had to
// follow trump. Duane threw Q-diamonds (3 points) while holding the 10 (10
// points): "no points/power issue".
//
// The rule "trump is never schmear material" (0.8.0) was written for the free
// choice, where keeping trump beats paying with it. With trump led there is no
// free choice — a trump is going regardless — and the old code fell through to
// "cheapest by card points", which is precisely backwards: it spends the 4th
// highest trump in the game to save a card whose only value is the points it
// would have banked.
const alonePicker = { picker: 4, partner: null, partnerRevealed: false, calledSuit: null, calledAcePlayed: false };
const trick2 = [
  { player: 4, card: C("J", "H") },
  { player: 0, card: C("Q", "C") },
];

{
  // Duane, last to play, holding Q-D / K-D / 10-D.
  const g = position({
    hands: withHand(3, [C("Q", "D"), C("A", "H"), C("K", "D"), C("A", "C"), C("10", "D")]),
    trick: [...trick2, { player: 1, card: C("J", "S") }, { player: 2, card: C("7", "D") }],
    ...alonePicker, tricksDone: 1, leader: 4, played: [C("10", "S")],
  });
  const legal = legalPlays(g, 3);
  check("Duane must follow trump", legal.length === 3 && legal.every(isTrump),
    `legal=${legal.map(cid).join(",")}`);
  check("the trick is already certain — the only opponent has played",
    trickSecurity(g, 3) === 1, `security=${trickSecurity(g, 3)}`);

  const pick = aiChooseCard(g, 3);
  check("Duane does not throw the Queen when forced into trump", cid(pick) !== "QD", `played ${cid(pick)}`);
  check("Duane spends the fat diamond instead", cid(pick) === "10D", `played ${cid(pick)}`);
}

{
  // Gus, third to act in the same trick, holding J-spades and Q-spades — both
  // power trump, nothing fat. He played the Jack, and that stays right: when
  // Queens and Jacks are all there is, give up the weakest.
  const g = position({
    hands: withHand(1, [C("J", "S"), C("8", "H"), C("Q", "S"), C("7", "C"), C("10", "H")]),
    trick: trick2, ...alonePicker, tricksDone: 1, leader: 4, played: [C("9", "S")],
  });
  const pick = aiChooseCard(g, 1);
  check("Gus gives up the weakest power trump when he holds nothing fat",
    cid(pick) === "JS", `played ${cid(pick)}`);
}

{
  // Bunny, fourth, holding 7-diamonds and J-clubs. The 7 is fat by category but
  // worth nothing, and it's still the right card — the Jack keeps its power.
  const g = position({
    hands: withHand(2, [C("7", "D"), C("9", "H"), C("J", "C"), C("9", "C"), C("8", "S")]),
    trick: [...trick2, { player: 1, card: C("J", "S") }],
    ...alonePicker, tricksDone: 1, leader: 4, played: [C("A", "S")],
  });
  const pick = aiChooseCard(g, 2);
  check("Bunny sheds the worthless diamond and keeps the Jack",
    cid(pick) === "7D", `played ${cid(pick)}`);
}

/* --------- Schmear only into a trick our side is likely to keep ---------- */
// A teammate holding the trick is not the same as our side taking it. When
// opponents are still to act and the cards that beat the winner are unaccounted
// for, paying points in is a losing bet — sit on them and wait instead.
{
  // Teammate led the club Ace. It cannot be beaten in clubs, but every trump is
  // still out there and both picker-team seats have yet to play, so the trick
  // is very likely to be trumped away. Holding 10-clubs and 7-clubs, the 10
  // stays home.
  const g = position({
    hands: [
      [C("Q", "C"), C("Q", "S"), C("J", "C"), C("A", "D"), C("10", "D")], // picker, unseen to us
      [C("Q", "H"), C("Q", "D"), C("J", "S"), C("J", "H"), C("K", "D")],  // partner, unseen to us
      [C("7", "S")], [C("7", "H")],
      [C("10", "C"), C("7", "C"), C("9", "S"), C("8", "S"), C("9", "H")], // us
    ],
    trick: [{ player: 3, card: C("A", "C") }],
    picker: 0, partner: 1, partnerRevealed: true, calledSuit: "C", calledAcePlayed: true,
    tricksDone: 1, leader: 3,
    played: [C("K", "C"), C("9", "C"), C("8", "C"), C("A", "H"), C("10", "H")],
  });
  const security = trickSecurity(g, 4);
  check("trick reads as unsafe with every trump unaccounted for and two opponents to act",
    security < SCHMEAR_CONFIDENCE, `security=${security.toFixed(3)} vs threshold ${SCHMEAR_CONFIDENCE}`);
  const pick = aiChooseCard(g, 4);
  check("holds the 10 back rather than feeding a trick that will be trumped",
    cid(pick) === "7C", `played ${cid(pick)}`);
}

{
  // Same shape, but every trump has already been played. Nothing can beat the
  // club Ace any more, so the 10 goes on it even with opponents still to act.
  const allTrump = [
    C("Q", "C"), C("Q", "S"), C("Q", "H"), C("Q", "D"),
    C("J", "C"), C("J", "S"), C("J", "H"), C("J", "D"),
    C("A", "D"), C("10", "D"), C("K", "D"), C("9", "D"), C("8", "D"), C("7", "D"),
  ];
  const g = position({
    hands: [
      [C("K", "S"), C("9", "S"), C("8", "S")],
      [C("K", "H"), C("9", "H"), C("8", "H")],
      [C("7", "S")], [C("7", "H")],
      [C("10", "C"), C("7", "C"), C("8", "C")], // us
    ],
    trick: [{ player: 3, card: C("A", "C") }],
    picker: 0, partner: 1, partnerRevealed: true, calledSuit: "C", calledAcePlayed: true,
    tricksDone: 3, leader: 3, played: [...allTrump, C("A", "S")],
  });
  const security = trickSecurity(g, 4);
  check("trick reads as certain once nothing left can beat it",
    security === 1, `security=${security}`);
  const pick = aiChooseCard(g, 4);
  check("schmears the 10 when the Ace genuinely cannot be beaten",
    cid(pick) === "10C", `played ${cid(pick)}`);
}

/* ---------- Taking a trick off our own side has to buy something ---------- */
// Reported 2026-07-27 from expert play. Gus picked, Duane was his partner, and
// Duane led Q-hearts on trick 2. Gus overtook with Q-spades — and Bunny's
// Q-clubs took it anyway.
//
// The number that settles it: from Gus's seat, Q-hearts and Q-spades are beaten
// by exactly the same one unaccounted-for card, Q-clubs (Q-spades itself is in
// his hand, so it isn't a threat to anything). Overtaking therefore moves the
// trick from his partner's Queen onto his own better one without improving its
// odds by a single point. Reaching the winners branch means "I can win", and
// the old code read that as "I should win".
{
  const gusHand = [C("Q", "S"), C("7", "H"), C("Q", "D"), C("J", "C"), C("J", "S")];
  const g = position({
    hands: [[C("7", "C")], gusHand, [C("Q", "C"), C("K", "C"), C("K", "H"), C("9", "C"), C("8", "C")],
            [C("A", "D"), C("10", "H"), C("J", "H"), C("A", "H"), C("A", "S")], [C("9", "H")]],
    trick: [
      { player: 3, card: C("Q", "H") },
      { player: 4, card: C("9", "D") },
      { player: 0, card: C("8", "D") },
    ],
    picker: 1, partner: 3, partnerRevealed: true,
    calledSuit: "S", calledAcePlayed: true, tricksDone: 1, leader: 3,
    played: [C("K", "S"), C("8", "S"), C("7", "S"), C("10", "S"), C("9", "S")],
  });

  const asIs = trickSecurity(g, 1);
  const taken = securityAfterPlay(g, 1, C("Q", "S"));
  check("Q-spades is the only card Gus holds that beats Q-hearts",
    legalPlays(g, 1).filter((c) => trumpPower(c) > trumpPower(C("Q", "H"))).length === 1);
  check("overtaking buys nothing — both Queens die to the same outstanding card",
    Math.abs(taken - asIs) < 1e-9, `leave=${asIs.toFixed(3)} take=${taken.toFixed(3)}`);

  const pick = aiChooseCard(g, 1);
  check("Gus does not spend Q-spades to overtake his own partner",
    cid(pick) !== "QS", `played ${cid(pick)}`);
  check("Gus lets the trick ride and sheds his weakest trump",
    cid(pick) === "JS", `played ${cid(pick)}`);
}

{
  // The brake must not seize. Same shape, but here the teammate is holding the
  // trick with a fail card and this seat has the top trump in the game: taking
  // it turns a coin-flip into a certainty, which is worth the Queen.
  const g = position({
    hands: [
      [C("7", "D"), C("8", "D")],                  // You, already played K-clubs
      [C("Q", "C"), C("8", "H"), C("7", "H")],     // Gus, to act
      [C("9", "C"), C("8", "C"), C("Q", "S")],     // Bunny, the one opponent left
      [C("A", "D"), C("10", "H")],                 // Duane, led the club Ace
      [C("J", "H"), C("7", "C")],                  // Patty
    ],
    trick: [
      { player: 3, card: C("A", "C") },
      { player: 4, card: C("10", "C") },
      { player: 0, card: C("K", "C") },
    ],
    picker: 1, partner: 3, partnerRevealed: true,
    calledSuit: "S", calledAcePlayed: true, tricksDone: 2, leader: 3,
    played: [C("K", "S"), C("8", "S"), C("7", "S"), C("10", "S"), C("9", "S"),
             C("A", "S"), C("J", "S"), C("9", "H"), C("K", "H"), C("10", "D")],
  });
  const asIs = trickSecurity(g, 1);
  const taken = securityAfterPlay(g, 1, C("Q", "C"));
  check("taking this one genuinely helps", taken - asIs >= OVERTAKE_MIN_GAIN,
    `leave=${asIs.toFixed(3)} take=${taken.toFixed(3)}`);
  const pick = aiChooseCard(g, 1);
  check("still overtakes when it converts the trick to a certainty",
    cid(pick) === "QC", `played ${cid(pick)}`);
}

/* --------------------------------------------------------------------------
   Equity classes and trick ownership (2026-07-28 play brief).

   Six hands were reconstructed card-for-card and every decision solved double
   dummy. Nearly all of the large errors traced to one thing: the AI shed by
   minimum card points without asking which of the candidates could still win a
   later trick, or which side owned the trick it was shedding into.

   These three pin the mechanism rather than the literal deals — the source
   hands aren't reproducible from the brief alone, but each position isolates
   exactly one of the three symptoms and has an unambiguous right answer.
   -------------------------------------------------------------------------- */

// Symptom A — the dead-Ace shed. A defender under an unbeatable Queen holds
// J-spades and A-diamonds. Both lose this trick, so minimum-points throws the
// Jack; but with the Queens gone J-spades is near-boss of the remaining trump
// and A-diamonds cannot win another trick. The 11 points are the cheap card
// here. (Reported: the picker swept 44 two tricks later on a trick J-spades
// wins outright.)
{
  const g = position({
    hands: [
      [C("J", "D"), C("9", "D")],
      [C("K", "H"), C("9", "H")],
      [C("K", "C"), C("9", "C")],
      [C("8", "H"), C("7", "H")],
      [C("J", "S"), C("A", "D")],
    ],
    trick: [{ player: 0, card: C("Q", "S") }],
    picker: 0, partner: null, tricksDone: 3, leader: 0,
  });
  check("both candidates lose this trick", legalPlays(g, 4).length === 2);
  const pick = aiChooseCard(g, 4);
  check("sheds the dead Ace and keeps the boss Jack, not the reverse",
    cid(pick) === "AD", `played ${cid(pick)}`);
}

// Symptom A, sign flipped — ownership has to survive the control flow. Our own
// side owns the trick with J-clubs; this seat holds only trump strictly below
// it, so it cannot overtake, and the trick is not safe enough to schmear into.
// That combination used to fall out of the teammate branch entirely and land in
// the generic can't-win shed, which minimises points — handing the cheap Jack
// to a trick our side was taking. All three cards die to the same one
// outstanding Queen, so the big card is free.
{
  const g = position({
    hands: [
      [C("J", "S"), C("10", "D"), C("A", "D")],
      [C("K", "C"), C("9", "C")],
      [C("Q", "H"), C("8", "H")],
      [C("K", "H"), C("9", "H")],
      [C("8", "C"), C("7", "C")],
    ],
    trick: [
      { player: 3, card: C("7", "D") },
      { player: 4, card: C("8", "D") },
      { player: 1, card: C("J", "C") },
    ],
    picker: 0, partner: 1, partnerRevealed: true,
    calledSuit: "S", calledAcePlayed: true, tricksDone: 3, leader: 3,
  });
  check("nothing in hand can overtake the partner's J-clubs",
    legalPlays(g, 0).every((c) => trumpPower(c) < trumpPower(C("J", "C"))));
  check("and the trick isn't safe enough to schmear into",
    trickSecurity(g, 0) < SCHMEAR_CONFIDENCE, `security=${trickSecurity(g, 0).toFixed(3)}`);
  const pick = aiChooseCard(g, 0);
  check("pays the fat trump into a trick our own side owns",
    cid(pick) === "AD", `played ${cid(pick)}`);
}

// Symptom B — overtaking your own side's trick has to be paid for. A defender
// already owns trick 1 with Q-hearts against a lone picker; this seat, void of
// the led suit, holds Q-clubs. Taking it converts the trick to a certainty, so
// a flat security threshold is cleared by exactly the card it is most expensive
// to spend. The bar scales with the card: an unbeatable one has to buy four
// times the security. Note the existing "still overtakes when it converts the
// trick to a certainty" case above still passes — this is a price, not a ban.
{
  const g = position({
    hands: [
      [C("Q", "D"), C("J", "H"), C("7", "D"), C("K", "H"), C("A", "H"), C("10", "H")],
      [C("K", "C"), C("9", "C"), C("8", "C"), C("K", "S"), C("10", "S"), C("8", "H")],
      [C("A", "C"), C("J", "C"), C("J", "D"), C("A", "S"), C("9", "H"), C("8", "S")],
      [C("Q", "H"), C("J", "S"), C("A", "D"), C("10", "C"), C("K", "D"), C("7", "C")],
      [C("Q", "C"), C("10", "D"), C("K", "D"), C("9", "S"), C("7", "S"), C("7", "H")],
    ],
    trick: [
      { player: 2, card: C("A", "C") },
      { player: 3, card: C("Q", "H") },
    ],
    picker: 0, partner: null, tricksDone: 0, leader: 2,
  });
  const asIs = trickSecurity(g, 4);
  const taken = securityAfterPlay(g, 4, C("Q", "C"));
  check("the old flat gate would have permitted this overtake",
    taken - asIs >= OVERTAKE_MIN_GAIN, `leave=${asIs.toFixed(3)} take=${taken.toFixed(3)}`);
  const pick = aiChooseCard(g, 4);
  check("does not spend the boss trump on a trick its own side already owns",
    cid(pick) !== "QC", `played ${cid(pick)}`);
  check("and does not dump a fat trump into it either",
    !isTrump(pick), `played ${cid(pick)}`);
}

// Cheapest sufficient winner. A defender owns a 25-point trick with A-diamonds
// and the picker can take it with Q-clubs or Q-hearts. Both higher Queens and
// every Jack are already on the table, so nothing left to act can beat Q-hearts
// — it takes the identical 25, and Q-clubs stays in hand for a later trick.
// "Secure with strength" spent the boss here; reported as a 24-point error,
// where after burning it the picker led Q-hearts into a live Q-spades.
{
  const g = position({
    hands: [
      [C("Q", "C"), C("Q", "H"), C("9", "D"), C("8", "D")],
      [C("K", "C"), C("9", "C"), C("8", "C"), C("K", "H")],
      [C("K", "S"), C("9", "S"), C("8", "S")],
      [C("A", "H"), C("10", "H"), C("9", "H")],
      [C("8", "H"), C("7", "H"), C("7", "D")],
    ],
    trick: [
      { player: 2, card: C("A", "D") },
      { player: 3, card: C("10", "D") },
      { player: 4, card: C("K", "D") },
    ],
    picker: 0, partner: 3, partnerRevealed: true,
    calledSuit: "S", calledAcePlayed: true, tricksDone: 2, leader: 2,
    played: [C("Q", "S"), C("Q", "D"), C("J", "C"), C("J", "S"), C("J", "H"), C("J", "D"),
             C("A", "C"), C("10", "C"), C("A", "S"), C("10", "S")],
  });
  check("this is a fat trick, so the old rule reached for strength",
    g.trick.reduce((s, t) => s + (t.card.rank === "A" ? 11 : t.card.rank === "10" ? 10 : t.card.rank === "K" ? 4 : 0), 0) >= 10);
  check("Q-hearts is provably sufficient — nothing left to act beats it",
    securityAfterPlay(g, 0, C("Q", "H")) >= 1 - 1e-9,
    `security=${securityAfterPlay(g, 0, C("Q", "H")).toFixed(3)}`);
  const pick = aiChooseCard(g, 0);
  check("wins with the cheapest sufficient card, not the boss trump",
    cid(pick) === "QH", `played ${cid(pick)}`);
}

/* ------------- The endgame solver's tie-break (reported 2026-07-28) -------- */
// Hand 7, v0.22.0. Trick 5, so `tricksDone === 4` and aiChooseCard hands the
// decision to the exact double-dummy solver instead of anything above.
//
// You (0, the partner) led the called A-spades, Gus (1, picker) followed
// 9-spades, Bunny (2) cut with A-diamonds. Both members of the picking team
// have now played and the only seat left to act is Patty (4), a defender — so
// the trick is already the defense's no matter what Duane (3) does. Duane
// holds Q-hearts (boss of everything he cannot place) and 9-hearts.
//
// Double-dummy the two cards are worth exactly the same: the hand finishes
// 70-50 either way, because in THIS layout Bunny's last card happens to be
// 10-diamonds and covers the 9-hearts lead. The solver saw the tie and took
// `legal[0]` — sorted order, trump first — and burned the Queen.
//
// Enumerating the 144 deals of the seven cards Duane cannot place says the two
// are nothing alike: 9-hearts wins the hand in 144 of 144, Q-hearts in 59.
// Keeping the Queen guarantees the last trick; spending it forces Duane to
// lead a bare fail card into a picker who still holds trump.
{
  const g = position({
    hands: [
      [C("7", "C")],                 // You (0) — already played the called ace
      [C("K", "D")],                 // Gus (1, picker)
      [C("10", "D")],                // Bunny (2)
      [C("Q", "H"), C("9", "H")],    // Duane (3) — to play
      [C("K", "S"), C("8", "S")],    // Patty (4)
    ],
    trick: [
      { player: 0, card: C("A", "S") },
      { player: 1, card: C("9", "S") },
      { player: 2, card: C("A", "D") },
    ],
    picker: 1, partner: 0, partnerRevealed: true,
    calledSuit: "S", calledAcePlayed: true, tricksDone: 4, leader: 0, turn: 3,
    played: [
      C("Q", "D"), C("Q", "S"), C("9", "D"), C("Q", "C"), C("J", "D"),
      C("10", "H"), C("8", "H"), C("7", "D"), C("K", "H"), C("7", "H"),
      C("J", "S"), C("J", "C"), C("J", "H"), C("10", "S"), C("8", "D"),
      C("9", "C"), C("K", "C"), C("7", "S"), C("10", "C"), C("8", "C"),
    ],
  });

  const legal = legalPlays(g, 3);
  check("Duane is void in spades, so both hearts are legal",
    legal.length === 2 && legal.every((c) => "QH 9H".includes(cid(c))),
    `legal=${legal.map(cid).join(",")}`);

  // Why 9-hearts is right, in the terms the heuristics already reason in.
  check("the trick is already secure — no opponent is left to act",
    trickSecurity(g, 3) >= 1 - 1e-9, `security=${trickSecurity(g, 3)}`);
  check("Q-hearts is boss of everything Duane cannot place",
    cardEquity(g, 3, C("Q", "H")) === 0, `equity=${cardEquity(g, 3, C("Q", "H"))}`);
  check("9-hearts is not — it wins nothing later",
    cardEquity(g, 3, C("9", "H")) > 0);

  // NEGATIVE CONTROL. This case is only meaningful if the solver genuinely
  // cannot separate the two cards: if one were double-dummy better, the
  // tie-break would never run and asserting on it would prove nothing. So
  // pin the tie itself, and pin that the old rule — first optimal card in
  // legal order — is the wrong one. Break the tie-break and these stay green
  // while the assertion below goes red, which is the point.
  const ddValue = (card) => solveHandValue(applyPlay(g, 3, card), new Map(), { n: 0 });
  check("the double-dummy values really are tied, so the tie-break decides",
    ddValue(C("Q", "H")) === ddValue(C("9", "H")),
    `QH=${ddValue(C("Q", "H"))} 9H=${ddValue(C("9", "H"))}`);
  check("and legal order puts the Queen first, which is what the old rule took",
    cid(legal[0]) === "QH", `legal[0]=${cid(legal[0])}`);

  const pick = aiChooseCard(g, 3);
  check("keeps the boss trump rather than schmearing it onto a trick already won",
    cid(pick) === "9H", `played ${cid(pick)}`);
}

/* --------- The picker's free duck (reported 2026-07-28, hand 2) ----------- */
// Trick 1. You (the partner) led Q-spades, Gus followed J-spades, Bunny 8 of
// diamonds, Duane K-diamonds. Patty is the PICKER, sitting last, and holds
// Q-clubs — the boss, which nothing can ever beat — plus J-diamonds and the
// 7 of diamonds.
//
// She took it with Q-clubs. That spends the one card guaranteed to win a
// trick later on the thinnest trick of the hand, to gain three points, on a
// trick her own partner already held. The engine got here because
// `knowsTeammate` returns false for every seat while the picker has not seen
// the called ace, so this position reads to her exactly like an opponent's
// trick and falls through to "cheapest winner".
//
// Sampling deals consistent with what she actually knows put the break-even
// at ~13-16% confidence that the trick is her partner's; chance alone is 25%
// with four unknown seats. Measured in self-play over 24,000 hands the rule
// fires on 0.6% of picker-last decisions and is worth +2.2 picking-team points
// per firing (+18 when the trick really was the partner's, -4 when not, and it
// is the partner's 28% of the time).
{
  const g = position({
    hands: [
      [C("9", "D"), C("A", "H"), C("9", "C"), C("7", "S"), C("J", "H")],   // You — Q-spades already led
      [C("Q", "H"), C("K", "H"), C("7", "C"), C("9", "S"), C("10", "S")],  // Gus
      [C("A", "D"), C("Q", "D"), C("8", "C"), C("8", "S"), C("K", "C")],   // Bunny
      [C("10", "D"), C("7", "H"), C("J", "C"), C("K", "S"), C("9", "H")],  // Duane
      [C("Q", "C"), C("J", "D"), C("8", "H"), C("10", "C"), C("7", "D"), C("10", "H")], // Patty (picker)
    ],
    trick: [
      { player: 0, card: C("Q", "S") },
      { player: 1, card: C("J", "S") },
      { player: 2, card: C("8", "D") },
      { player: 3, card: C("K", "D") },
    ],
    picker: 4, partner: 0, partnerRevealed: false,
    calledSuit: "H", calledAcePlayed: false, tricksDone: 0, leader: 0, turn: 4,
  });

  check("Patty is last to act, so the pot is final",
    g.trick.length === 4);
  check("the trick is thin — 9 points, well under the cap",
    g.trick.reduce((s, t) => s + cardPts(t.card), 0) === 9);
  check("a trump is winning it, not a fail card",
    isTrump(g.trick.find((t) => t.player === trickWinner(g.trick)).card));
  check("Q-clubs is boss — nothing unaccounted for beats it",
    cardEquity(g, 4, C("Q", "C")) === 0);
  check("Q-clubs is her only winner, so taking it costs the boss",
    legalPlays(g, 4).filter((c) => trickWinner([...g.trick, { player: 4, card: c }]) === 4)
      .every((c) => cid(c) === "QC"));
  check("the 7 of diamonds is a free duck — zero points, and not a winner",
    cardPts(C("7", "D")) === 0);
  check("she cannot know whose trick it is",
    !knowsTeammate(g, 4, 0) && !g.partnerRevealed);

  // NEGATIVE CONTROL. The position only means something if the old engine was
  // genuinely tempted by it. Turning the rule off must bring Q-clubs back —
  // if this ever goes green alongside the assertion below, the case has
  // stopped testing the thing it was written for.
  check("with the rule disabled she still burns the boss, as she used to",
    cid(aiChooseCard(g, 4, { duckMaxTrickPoints: -1 })) === "QC",
    `played ${cid(aiChooseCard(g, 4, { duckMaxTrickPoints: -1 }))}`);

  const pick = aiChooseCard(g, 4);
  check("ducks the 7 of diamonds instead of spending the boss on a thin trick",
    cid(pick) === "7D", `played ${cid(pick)}`);
}

{
  // The other half of the rule: it must NOT fire when the duck costs points.
  // Reported in the same session (hand 4) — Patty held Q-clubs, Q-hearts and
  // the Ace of diamonds behind her partner's Q-spades. Ducking there means
  // handing over 3 or 11 points on a guess, and the break-even measured 85%
  // rather than 13%. That case wants a belief model, not this rule, so the
  // engine should still take the trick.
  const g = position({
    hands: [
      [C("7", "D"), C("J", "C"), C("8", "C"), C("A", "C")],
      [C("K", "D"), C("Q", "D"), C("9", "H"), C("K", "H")],
      [C("J", "H"), C("A", "H"), C("9", "C"), C("K", "C")],
      [C("J", "S"), C("7", "C"), C("7", "H"), C("8", "H")],
      [C("Q", "C"), C("Q", "H"), C("A", "D"), C("K", "S"), C("10", "C")],
    ],
    trick: [
      { player: 0, card: C("Q", "S") },
      { player: 1, card: C("9", "D") },
      { player: 2, card: C("J", "D") },
      { player: 3, card: C("8", "D") },
    ],
    picker: 4, partner: 0, partnerRevealed: false,
    calledSuit: "C", calledAcePlayed: false, tricksDone: 1, leader: 0, turn: 4,
  });
  check("no zero-point card is legal here, so there is no free duck",
    !legalPlays(g, 4).some((c) => cardPts(c) === 0));
  const pick = aiChooseCard(g, 4);
  check("takes the trick when ducking would cost points",
    cid(pick) === "QC", `played ${cid(pick)}`);
}

/* ============================================================================
   Hand 27, trick 2 — deducing the partnership, and pricing a forced trick.

   Reported 2026-07-30. Clubs called. Seats: 0 You, 1 Fonzie, 2 Leon,
   3 Gus (picker), 4 Kopps (partner). You led 7-clubs, Fonzie trumped with
   9-diamonds, and Leon overtook his own side with J-hearts.

   Two separate defects met on that card, which is why they get separate flags
   and separate assertions:

     1. Leon could PROVE Kopps was the partner. You led a low club instead of
        the ace, so You is not the partner; Fonzie trumped in and is therefore
        void in clubs, so nor is Fonzie; Gus is the picker; Leon holds no club.
        One seat left. calledCardCandidates already knew this and the play code
        never asked. -> deducePartner

     2. The trick could not be lost. Gus must follow clubs (legalPlays makes
        the picker retain a called-suit card until the suit is led) and Kopps
        must lay the called ace, and neither can beat a trump with a club.
        trickSecurity priced it at 0.05. -> forcedFollow

   The right card is K-hearts: 4 points onto a trick the defense already owns,
   keeping BOTH trump. It is also Leon's deadest card — eleven unseen cards
   beat it, and it takes no later trick.
   ========================================================================= */
{
  // Built by playing the real hand rather than hand-writing the state, so
  // calledSuitLed / calledAcePlayed / trickHistory are whatever the engine
  // actually derives. The deduction reads trickHistory; a hand-built fixture
  // would have quietly asserted nothing.
  const deal = [
    [C("J", "D"), C("7", "C"), C("7", "H"), C("7", "D"), C("K", "D"), C("9", "C")],
    [C("A", "S"), C("9", "D"), C("A", "H"), C("J", "S"), C("8", "S"), C("Q", "S")],
    [C("7", "S"), C("J", "H"), C("9", "H"), C("8", "D"), C("8", "H"), C("K", "H")],
    [C("10", "D"), C("8", "C"), C("A", "D"), C("Q", "H"), C("Q", "D"), C("J", "C")],
    [C("9", "S"), C("A", "C"), C("10", "H"), C("Q", "C"), C("10", "S"), C("K", "C")],
  ];
  let g = assignPartner({
    ...freshHand(0, [0, 0, 0, 0, 0], 27),
    phase: "playing", hands: deal.map(sortHand), blind: [],
    buried: [C("10", "C"), C("K", "S")],
    picker: 3, calledSuit: "C", calledRank: "A", leader: 1, turn: 1,
  });
  check("hand 27 reconstructs: Kopps holds the called ace", g.partner === 4, `partner=${g.partner}`);

  // Trick 1: Fonzie leads A-spades, You take it with J-diamonds.
  for (const [p, c] of [[1, C("A", "S")], [2, C("7", "S")], [3, C("10", "D")],
                        [4, C("9", "S")], [0, C("J", "D")]]) g = applyPlay(g, p, c);
  g = resolveTrick(g);
  // Trick 2: You lead 7-clubs — the called suit, for the first time.
  g = applyPlay(g, 0, C("7", "C"));
  g = applyPlay(g, 1, C("9", "D"));

  const LEON = 2;
  // What ships is the forcing rule alone. `deducePartner` measured as a
  // consistent loss (see its comment in engine.js) and is asserted here only
  // where it is the thing under test.
  const ON = { forcedFollow: true, deducePartner: true };
  const OFF = { forcedFollow: false, deducePartner: false };

  /* ---- the deduction itself ---- */
  check("hand 27: only one seat can still hold the called ace",
    calledCardCandidates(g, LEON).length === 1, `cands=${calledCardCandidates(g, LEON)}`);
  check("hand 27: Leon can name the partner before the ace is played",
    knownPartner(g, LEON) === 4 && !g.partnerRevealed, `knownPartner=${knownPartner(g, LEON)}`);
  check("hand 27: Fonzie is provably Leon's side", provenSide(g, LEON, 1) === true);
  check("hand 27: Kopps is provably NOT Leon's side", provenSide(g, LEON, 4) === false);
  check("knowsTeammate still calls the partner a teammate — the bug this replaces",
    knowsTeammate(g, LEON, 4) === true);

  /* ---- negative control: the deduction must not fire a trick earlier ---- */
  {
    // Same hand, rewound to trick 1. Nothing has narrowed the field yet, so
    // anything that claims certainty here is claiming it from thin air.
    let t = assignPartner({
      ...freshHand(0, [0, 0, 0, 0, 0], 27),
      phase: "playing", hands: deal.map(sortHand), blind: [],
      buried: [C("10", "C"), C("K", "S")],
      picker: 3, calledSuit: "C", calledRank: "A", leader: 1, turn: 1,
    });
    t = applyPlay(t, 1, C("A", "S"));
    check("control: with nothing led, Leon cannot name the partner",
      knownPartner(t, LEON) === null, `knownPartner=${knownPartner(t, LEON)}`);
    check("control: and provenSide admits it does not know",
      provenSide(t, LEON, 4) === null);
    check("control: the partner still knows themselves",
      knownPartner(t, 4) === 4);
    check("control: no called suit led, so nobody is forced",
      trickSecurity(t, LEON, ON) === trickSecurity(t, LEON, OFF),
      `${trickSecurity(t, LEON, ON)} vs ${trickSecurity(t, LEON, OFF)}`);
  }

  /* ---- the trick is unloseable, and the engine should say so ---- */
  check("hand 27: Gus is forced to follow clubs",
    legalPlays(applyPlay(g, LEON, C("8", "H")), 3).every((c) => c.suit === "C" && !isTrump(c)));
  check("hand 27: Kopps is forced to lay the called ace",
    (() => {
      let t = applyPlay(g, LEON, C("8", "H"));
      t = applyPlay(t, 3, C("8", "C"));
      const l = legalPlays(t, 4);
      return l.length === 1 && cid(l[0]) === "AC";
    })());
  check("hand 27: the trick prices as certain by default now",
    trickSecurity(g, LEON) === 1, `security=${trickSecurity(g, LEON)}`);
  check("hand 27: and did not, before", trickSecurity(g, LEON, OFF) < 0.1,
    `security=${trickSecurity(g, LEON, OFF)}`);

  /* ---- the card ---- */
  check("hand 27 (bug): the old engine overtakes its own side with the Jack",
    cid(aiChooseCard(g, LEON, OFF)) === "JH", `played ${cid(aiChooseCard(g, LEON, OFF))}`);
  // No opts — this is the shipped default, which is the thing that matters.
  const fixed = aiChooseCard(g, LEON);
  check("hand 27: Leon schmears the King instead", cid(fixed) === "KH", `played ${cid(fixed)}`);
  check("hand 27: and keeps both trump", !isTrump(fixed));

  // The halves separately, so a future regression says WHICH one broke.
  check("hand 27: the forcing rule is what gets the card",
    cid(aiChooseCard(g, LEON, { forcedFollow: true, deducePartner: false })) === "KH",
    `played ${cid(aiChooseCard(g, LEON, { forcedFollow: true, deducePartner: false }))}`);
  check("hand 27: deducing the partner alone would only stop the overtake",
    cid(aiChooseCard(g, LEON, { forcedFollow: false, deducePartner: true })) === "8H",
    `played ${cid(aiChooseCard(g, LEON, { forcedFollow: false, deducePartner: true }))}`);

  /* ---- negative control: forcing must not manufacture safety ---- */
  {
    // The picker sits behind Leon holding trump, and the called suit is NOT
    // what was led — so nothing forces anyone and the trick is genuinely at
    // risk. If this reads as certain, the rule is firing on the wrong tricks.
    let t = assignPartner({
      ...freshHand(0, [0, 0, 0, 0, 0], 27),
      phase: "playing", hands: deal.map(sortHand), blind: [],
      buried: [C("10", "C"), C("K", "S")],
      picker: 3, calledSuit: "C", calledRank: "A", leader: 0, turn: 0,
    });
    t = applyPlay(t, 0, C("7", "H"));   // hearts led, not the called suit
    t = applyPlay(t, 1, C("A", "H"));
    check("control: a trick with nobody forced is not certain",
      trickSecurity(t, LEON, ON) < 1, `security=${trickSecurity(t, LEON, ON)}`);
    check("control: forcing changes nothing when the called suit is not led",
      trickSecurity(t, LEON, ON) === trickSecurity(t, LEON, OFF));
  }

  /* ---- negative control: a forced seat that CAN still take the trick ---- */
  {
    // Clubs led and NOT trumped, so the called ace is still the best card out.
    // The partner is pinned to it exactly as in hand 27 — but here that pin
    // hands them the trick. "Forced" must never be read as "harmless"; this is
    // the sign error the rule is most likely to make.
    const t = position({
      hands: withHand(2, [C("K", "H"), C("9", "H"), C("8", "H")]),
      trick: [{ player: 0, card: C("7", "C") }, { player: 1, card: C("9", "C") }],
      picker: 3, partner: 4, calledSuit: "C", calledAcePlayed: false,
      tricksDone: 0, leader: 0, turn: 2,
    });
    check("control: this seat can name the partner too", knownPartner(t, 2) === 4);
    check("control: a forced ace that WINS the trick prices it at zero, not one",
      trickSecurity(t, 2, ON) === 0, `security=${trickSecurity(t, 2, ON)}`);
    check("control: the picker is forced but NOT harmless — a club can still win here",
      trickSecurity(t, 2, { forcedFollow: true }) < 1);
  }
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — the AI protects its trump power.");
