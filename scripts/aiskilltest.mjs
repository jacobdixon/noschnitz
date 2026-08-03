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
  unseenTrumpCount, SCHMEAR_CONFIDENCE, OVERTAKE_MIN_GAIN, SCHMEAR_KEEP_EQUITY,
  freshHand, assignPartner, resolveTrick, sortHand,
  calledCardCandidates, knownPartner, provenSide, teammateProbability,
  isPowerTrump, unaccountedFor,
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
  played = [], turn = 0, buried = [],
}) {
  return {
    phase: "playing",
    handNum: 1,
    dealer: 0,
    hands,
    blind: [],
    buried,
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

// Every card in the deck, exactly once, across hands + trick + played + buried.
// Only meaningful for fixtures built as a whole deal (most cases here are
// deliberately partial), but where a case turns on a PROBABILITY the deal has
// to be complete: trickSecurity counts unaccounted-for cards, so a duplicate
// or a missing card silently changes the odds it is being asserted against.
function dealIsComplete(g) {
  const all = [
    ...g.hands.flat(), ...g.trick.map((t) => t.card), ...g.played, ...g.buried,
  ].map(cid);
  return all.length === 32 && new Set(all).size === 32;
}

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
  // The brake must not seize. The teammate is holding the trick with a fail
  // Ace and this seat has the top trump in the game, so taking it converts a
  // trick that is genuinely gone into a certainty — worth the Queen.
  //
  // Rebuilt as a complete 32-card deal. It used to be 25 cards with Bunny
  // holding 9- and 8-clubs, which meant that in the deal as literally written
  // Bunny had to FOLLOW clubs and could never have taken the trick at all —
  // the Ace was already safe and the Queen bought nothing. The old security
  // count could not see that and priced the trick at 0.018, so the fixture
  // asserted an overtake that its own cards made pointless. Every fail club is
  // accounted for here instead, so Bunny is certainly void and the danger is
  // real rather than an artifact of the estimate.
  const g = position({
    hands: [
      [C("J", "C"), C("Q", "D"), C("10", "D")],               // You, played K-clubs
      [C("Q", "C"), C("8", "H"), C("7", "H"), C("7", "D")],   // Gus, to act
      [C("Q", "S"), C("A", "H"), C("9", "D"), C("8", "D")],   // Bunny, one opponent left
      [C("A", "D"), C("10", "H"), C("K", "D")],               // Duane, led the club Ace
      [C("J", "H"), C("Q", "H"), C("J", "D")],                // Patty
    ],
    trick: [
      { player: 3, card: C("A", "C") },
      { player: 4, card: C("10", "C") },
      { player: 0, card: C("K", "C") },
    ],
    picker: 1, partner: 3, partnerRevealed: true,
    calledSuit: "S", calledAcePlayed: true, tricksDone: 2, leader: 3,
    buried: [C("9", "C"), C("8", "C")],
    played: [C("K", "S"), C("8", "S"), C("7", "S"), C("10", "S"), C("9", "S"),
             C("A", "S"), C("J", "S"), C("9", "H"), C("K", "H"), C("7", "C")],
  });
  check("fixture is a complete 32-card deal", dealIsComplete(g));
  check("every fail club is accounted for, so the last opponent is certainly void",
    unaccountedFor(g, 1).filter((c) => !isTrump(c) && c.suit === "C").length === 0);
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
      // A-clubs and Q-hearts are on the table below, so they are NOT still in
      // these hands — they were, which duplicated them and left K-diamonds in
      // two hands at once. trickSecurity counts unaccounted-for cards, so a
      // deck that cannot exist was pricing the very odds this case asserts.
      [C("J", "C"), C("J", "D"), C("A", "S"), C("9", "H"), C("8", "S")],
      [C("J", "S"), C("A", "D"), C("10", "C"), C("K", "D"), C("7", "C")],
      [C("Q", "C"), C("10", "D"), C("9", "D"), C("9", "S"), C("7", "S"), C("7", "H")],
    ],
    trick: [
      { player: 2, card: C("A", "C") },
      { player: 3, card: C("Q", "H") },
    ],
    // Q-spades stays OUT of this seat's hand: with both Queens that beat
    // Q-hearts visible to the viewer there is no unseen beater at all, the
    // trick prices as already certain, and the overtake this case is about
    // stops existing.
    buried: [C("Q", "S"), C("8", "D")],
    picker: 0, partner: null, tricksDone: 0, leader: 2,
  });
  check("fixture is a complete 32-card deal", dealIsComplete(g));
  // Asked of the OLD estimate on purpose — this case exists to show the flat
  // gate was too permissive, so it has to be measured against the numbers that
  // gate actually saw. The follow-suit odds now decline this overtake for an
  // entirely separate reason (the picker is usually stuck following clubs, so
  // the trick was never as loose as the raw count said), which would hide the
  // thing being demonstrated.
  const RAW = { followSuitOdds: false };
  const asIsRaw = trickSecurity(g, 4, RAW);
  const takenRaw = securityAfterPlay(g, 4, C("Q", "C"), RAW);
  check("the old flat gate would have permitted this overtake",
    takenRaw - asIsRaw >= OVERTAKE_MIN_GAIN,
    `leave=${asIsRaw.toFixed(3)} take=${takenRaw.toFixed(3)}`);
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

/* ------------- Don't schmear a boss fail card over a doomed one ------------ */
// Reported 2026-07-29, hand 6, and pinned from the real deal rather than a
// constructed one: every card of that hand is visible in the recap grid, so
// this is the position exactly as it stood.
//
// Leon (1) picked and called hearts; Kopps (3) holds the A-hearts and is his
// partner, not yet revealed — the ace does not fall until the next trick, so
// `partnerRevealed` is false here, as it was in the game. Kopps led J-spades
// into trick 3, Bunny (4) took it with Q-diamonds, and Patty (2) is last to
// play, void in trump, holding A-clubs, 10-hearts, 9-clubs and 10-spades.
//
// Bunny is a defender like Patty, so the trick is hers to schmear into. The old
// rule sorted by card points and dropped the Ace for its single extra point.
// The Ace was boss of clubs with one trump left in the game; the 10-hearts was
// dead the moment hearts was led, which is precisely what happened on the very
// next trick — it fell under Kopps's called A-hearts, 10 points to the picker.
{
  const g = {
    ...position({
      hands: [
        [C("9", "H"), C("8", "S"), C("K", "S")],                    // You
        [C("7", "H"), C("8", "D"), C("8", "H")],                    // Leon (picker)
        [C("A", "C"), C("10", "H"), C("9", "C"), C("10", "S")],     // Patty
        [C("A", "H"), C("8", "C"), C("9", "S")],                    // Kopps (partner)
        [C("K", "H"), C("10", "C"), C("7", "S")],                   // Bunny
      ],
      played: [
        C("Q", "C"), C("Q", "S"), C("10", "D"), C("9", "D"), C("J", "H"),
        C("J", "D"), C("7", "C"), C("Q", "H"), C("A", "D"), C("K", "D"),
      ],
      trick: [
        { player: 3, card: C("J", "S") },
        { player: 4, card: C("Q", "D") },
        { player: 0, card: C("J", "C") },
        { player: 1, card: C("7", "D") },
      ],
      picker: 1, partner: 3, partnerRevealed: false, calledSuit: "H",
      calledAcePlayed: false, tricksDone: 2, leader: 3, turn: 2,
    }),
    calledRank: "A",
    buried: [C("A", "S"), C("K", "C")],
  };

  const legal = legalPlays(g, 2);
  check("Patty is void in trump, so all four of her cards are legal",
    legal.length === 4 && !legal.some(isTrump), `legal=${legal.map(cid).join(",")}`);
  check("she cannot win the trick — Q-diamonds is trump and she has none",
    !legal.some((c) => trickWinner([...g.trick, { player: 2, card: c }]) === 2));
  check("the trick reads as her own side's, which is what opens the schmear",
    knowsTeammate(g, 2, 4) && trickSecurity(g, 2) >= SCHMEAR_CONFIDENCE,
    `security=${trickSecurity(g, 2)}`);
  check("A-clubs is all but boss — one outstanding card beats it",
    cardEquity(g, 2, C("A", "C")) === 1, `equity=${cardEquity(g, 2, C("A", "C"))}`);
  check("10-hearts is strictly more exposed — the called Ace also beats it",
    cardEquity(g, 2, C("10", "H")) === 2, `equity=${cardEquity(g, 2, C("10", "H"))}`);
  check("and it is only one card point lighter, which is what makes it a swap",
    cardPts(C("A", "C")) - cardPts(C("10", "H")) === 1);

  // This is a real mistake, not a tie the tie-break happens to settle: the
  // exact solver separates the two cards by four points.
  const dd = (card) => solveHandValue(applyPlay(g, 2, card), new Map(), { n: 0 });
  check("double-dummy, the ten really is four points better than the Ace",
    dd(C("A", "C")) - dd(C("10", "H")) === 4,
    `AC=${dd(C("A", "C"))} 10H=${dd(C("10", "H"))}`);

  // NEGATIVE CONTROL. The position only tests something if the old rule was
  // genuinely tempted. Turning the rule off has to bring the Ace back.
  check("with the rule disabled she schmears the Ace, as she used to",
    cid(aiChooseCard(g, 2, { schmearKeepEquity: -1 })) === "AC",
    `played ${cid(aiChooseCard(g, 2, { schmearKeepEquity: -1 }))}`);

  const pick = aiChooseCard(g, 2);
  check("keeps the boss Ace and schmears the doomed ten instead",
    cid(pick) !== "AC", `played ${cid(pick)}`);
  check("and the card it picks is double-dummy optimal",
    dd(pick) === Math.min(...legal.map(dd)), `played ${cid(pick)}, dd=${dd(pick)}`);
}

{
  // The other half of the rule, and the failure mode that killed the first
  // attempt at it. Discounting points by exposure across the board schmears a
  // King over an Ace whenever the King is deader — 4 points banked instead of
  // 11, for a risk saving that never repays the seven. The rule must only ever
  // reach for a card within SCHMEAR_POINT_SLACK of the fattest.
  const hand = [C("A", "H"), C("K", "S"), C("8", "H")];
  const g = position({
    hands: withHand(4, hand),
    trick: [
      { player: 0, card: C("A", "C") },
      { player: 1, card: C("K", "C") },
      { player: 2, card: C("9", "C") },
      { player: 3, card: C("7", "C") },
    ],
    picker: 0, partner: 4, partnerRevealed: true, tricksDone: 2, leader: 0,
    // All the trump but the 7 of diamonds is gone, so the Ace of hearts is
    // as close to boss as the reported hand's Ace of clubs was.
    played: [
      C("Q", "C"), C("Q", "S"), C("Q", "H"), C("Q", "D"), C("J", "C"), C("J", "S"),
      C("J", "H"), C("J", "D"), C("A", "D"), C("10", "D"), C("K", "D"), C("9", "D"), C("8", "D"),
    ],
  });
  check("the King is the more exposed card of the two",
    cardEquity(g, 4, C("K", "S")) > cardEquity(g, 4, C("A", "H")),
    `KS=${cardEquity(g, 4, C("K", "S"))} AH=${cardEquity(g, 4, C("A", "H"))}`);
  check("but it is seven points lighter, so the Ace still goes",
    cid(aiChooseCard(g, 4)) === "AH", `played ${cid(aiChooseCard(g, 4))}`);
}

{
  // And it must stay off when the fat card is not boss. With trump still out
  // in quantity the Ace is going to be trumped anyway, so banking eleven now
  // beats keeping a card that cannot be defended — the rule's whole premise is
  // that the fat card genuinely expects to take a trick of its own.
  const hand = [C("A", "H"), C("10", "S"), C("8", "H")];
  const g = position({
    hands: withHand(4, hand),
    trick: [
      { player: 0, card: C("A", "C") },
      { player: 1, card: C("K", "C") },
      { player: 2, card: C("9", "C") },
      { player: 3, card: C("7", "C") },
    ],
    picker: 0, partner: 4, partnerRevealed: true, tricksDone: 1, leader: 0,
  });
  check("with the trump barely touched the Ace is not remotely boss",
    cardEquity(g, 4, C("A", "H")) > SCHMEAR_KEEP_EQUITY,
    `equity=${cardEquity(g, 4, C("A", "H"))}`);
  check("so the fattest card still goes, rule or no rule",
    cid(aiChooseCard(g, 4)) === "AH", `played ${cid(aiChooseCard(g, 4))}`);
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
  // Every flag added after this hand has to be pinned off too, or "what the old
  // engine did" quietly becomes "what the current engine does minus one thing".
  // "The engine as it was" now needs both follow-suit corrections turned off:
  // `forcedFollow` for the two called-suit pins, and `followSuitOdds` for the
  // general case. The second is a strictly wider version of the same insight,
  // so leaving it on recovers most of hand 27 by itself and the before/after
  // contrast below stops showing anything.
  const OFF = {
    forcedFollow: false, deducePartner: false, overtakeBeliefFloor: 1.01,
    followSuitOdds: false,
  };

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
    // Vary ONLY forcedFollow. OFF also disables followSuitOdds, which is a
    // different correction and does move this number, so comparing against it
    // would no longer be a statement about forcing.
    check("control: no called suit led, so nobody is forced",
      trickSecurity(t, LEON, ON) === trickSecurity(t, LEON, { ...ON, forcedFollow: false }),
      `${trickSecurity(t, LEON, ON)} vs ${trickSecurity(t, LEON, { ...ON, forcedFollow: false })}`);
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
      trickSecurity(t, LEON, ON) === trickSecurity(t, LEON, { ...ON, forcedFollow: false }));
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


/* ============================================================================
   Hand 1 — reading the partnership off how a seat has PLAYED.

   Reported 2026-07-30, a hand that finished 120-0. Seats: 0 You (partner),
   1 Bernie, 2 Patty (picker), 3 Fonzie, 4 Kopps. Hearts called. You won trick 1
   with Q-clubs and led Q-hearts into trick 2 — pulling trump, which is the
   picker's side's plan and nobody else's. Both remaining defenders read that
   seat as a teammate and schmeared an Ace onto it: 22 points handed to the
   picker's partner on one trick.

   Nothing here is deducible. Hearts has not been led, so calledCardCandidates
   still holds three live seats and no amount of deduction narrows it. What is
   available is INFERENCE: this engine's leading branch has the picker's team
   lead trump whenever it holds any, while defenders lead fail and touch trump
   only holding nothing else, weakest-first. A Queen on lead is the picker's
   book. `belieftest` puts that read at ~98% against ground truth.

   The fix is deliberately NOT "stop schmearing speculatively" — that measured
   -0.0028 (see BELIEF_SCHMEAR). It is a floor the belief must clear, which the
   uninformed two-in-three clears and a seat marked by the read does not.
   ========================================================================= */
{
  const deal = [
    [C("Q", "C"), C("Q", "H"), C("8", "S"), C("K", "C"), C("8", "H"), C("A", "H")],
    [C("7", "D"), C("A", "D"), C("K", "D"), C("J", "D"), C("K", "H"), C("8", "C")],
    [C("Q", "S"), C("9", "D"), C("J", "H"), C("Q", "D"), C("J", "C"), C("10", "H")],
    [C("8", "D"), C("A", "C"), C("9", "S"), C("9", "H"), C("K", "S"), C("10", "S")],
    [C("10", "D"), C("J", "S"), C("7", "H"), C("7", "C"), C("9", "C"), C("10", "C")],
  ];
  const start = () => assignPartner({
    ...freshHand(1, [0, 0, 0, 0, 0], 1),
    phase: "playing", hands: deal.map(sortHand), blind: [],
    buried: [C("A", "S"), C("7", "S")],
    picker: 2, calledSuit: "H", calledRank: "A", leader: 2, turn: 2,
  });
  const OFF = { trumpLeadRead: false, beliefFloor: 0 };

  let g = start();
  check("hand 1 reconstructs: You hold the called ace", g.partner === 0, `partner=${g.partner}`);

  // Trick 1: Patty leads Q-spades, You take it with Q-clubs.
  for (const [p, c] of [[2, C("Q", "S")], [3, C("8", "D")], [4, C("10", "D")],
                        [0, C("Q", "C")], [1, C("7", "D")]]) g = applyPlay(g, p, c);
  g = resolveTrick(g);
  // Trick 2: You lead Q-hearts — a power trump, and the whole signal.
  g = applyPlay(g, 0, C("Q", "H"));
  const gFonzie = applyPlay(applyPlay(g, 1, C("A", "D")), 2, C("9", "D"));

  check("hand 1: nothing is deducible — three seats could still hold the ace",
    calledCardCandidates(g, 1).length === 3, `cands=${calledCardCandidates(g, 1)}`);
  check("hand 1: and the deduction layer correctly declines to guess",
    knownPartner(g, 1) === null && provenSide(g, 1, 0) === null);

  /* ---- the read ---- */
  check("hand 1: without the read a defender believes the trump-leader is a friend",
    Math.abs(teammateProbability(g, 1, 0, OFF) - 2 / 3) < 1e-9,
    `p=${teammateProbability(g, 1, 0, OFF)}`);
  check("hand 1: the read flips that to almost certainly an opponent",
    teammateProbability(g, 1, 0) < 0.1, `p=${teammateProbability(g, 1, 0)}`);
  check("hand 1: knowsTeammate still says friend — the belief this replaces",
    knowsTeammate(g, 1, 0) === true);

  /* ---- the cards ---- */
  check("hand 1 (bug): the old engine schmears Bernie's Ace of trump",
    cid(aiChooseCard(g, 1, OFF)) === "AD", `played ${cid(aiChooseCard(g, 1, OFF))}`);
  check("hand 1 (bug): and Fonzie's Ace of clubs",
    cid(aiChooseCard(gFonzie, 3, OFF)) === "AC", `played ${cid(aiChooseCard(gFonzie, 3, OFF))}`);

  const bernie = aiChooseCard(g, 1);
  const fonzie = aiChooseCard(gFonzie, 3);
  check("hand 1: Bernie no longer donates the Ace", cid(bernie) !== "AD", `played ${cid(bernie)}`);
  check("hand 1: Fonzie no longer donates the Ace", cid(fonzie) !== "AC", `played ${cid(fonzie)}`);
  check("hand 1: and Fonzie, free to choose, gives up nothing at all",
    cardPts(fonzie) === 0, `played ${cid(fonzie)} worth ${cardPts(fonzie)}`);
  check("hand 1: the trick costs the defence 20 points less",
    cardPts(bernie) + cardPts(fonzie) <= 2,
    `${cardPts(bernie)} + ${cardPts(fonzie)}`);

  /* ---- CONTROL: speculative schmearing must SURVIVE ---- */
  {
    // The thing that separates this from the version that measured -0.0028.
    // A fail lead, no power trump played by anyone, partnership unknown: the
    // defender's belief is the uninformed two-in-three, which is exactly the
    // case the 2:1 asymmetry says to schmear into. It must still fire.
    const g2 = position({
      hands: withHand(4, [C("K", "C"), C("9", "C"), C("8", "C")]),
      trick: [
        { player: 0, card: C("7", "H") },
        { player: 1, card: C("8", "H") },
        { player: 2, card: C("A", "H") },
        { player: 3, card: C("9", "H") },
      ],
      picker: 0, partner: 3, partnerRevealed: false,
      calledSuit: "S", calledAcePlayed: false, tricksDone: 2, leader: 0, turn: 4,
    });
    check("control: nobody led a power trump, so the read stays silent",
      Math.abs(teammateProbability(g2, 4, 2) - teammateProbability(g2, 4, 2, OFF)) < 1e-9);
    check("control: the uninformed belief is two-in-three, above the floor",
      teammateProbability(g2, 4, 2) > 0.6, `p=${teammateProbability(g2, 4, 2)}`);
    check("control: so a speculative schmear STILL happens",
      cid(aiChooseCard(g2, 4)) === "KC", `played ${cid(aiChooseCard(g2, 4))}`);
  }

  /* ---- CONTROL: the read must not fire on a low-trump lead ---- */
  {
    // A defender out of fail leads its WEAKEST trump. That is the one defender
    // path to a trump lead, and reading it as the picker's book would invert
    // the inference on exactly the seat it is meant to protect.
    const g3 = position({
      hands: withHand(2, [C("K", "C"), C("9", "C")]),
      trick: [{ player: 0, card: C("7", "D") }],
      picker: 4, partner: 1, partnerRevealed: false,
      calledSuit: "S", calledAcePlayed: false, tricksDone: 1, leader: 0, turn: 2,
    });
    check("control: a low-diamond lead is not read as the picker's book",
      Math.abs(teammateProbability(g3, 2, 0) - teammateProbability(g3, 2, 0, OFF)) < 1e-9,
      `${teammateProbability(g3, 2, 0)} vs ${teammateProbability(g3, 2, 0, OFF)}`);
  }
}


/* ============================================================================
   Standing down from a teammate's trick on a BELIEF, not only on proof.

   The overtake brake — "taking a trick off our own side has to buy something"
   — was gated on the partnership being certain. Everywhere else, a seat that
   could win simply won, which meant defenders routinely spent a card taking a
   trick another defender already had.

   Opening that gate to a strong belief is worth more than anything else
   measured this week, and it needed a second harness to see honestly: abtest
   said +0.0128/seat/hand ahead in 8 of 8, while an unpaired simulate run looked
   like the 0.6pp defensive LOSS this branch's own comment records. The paired
   coalition test (scripts/coalitiontest.mjs), which applies the variant to
   every defender on identical deals, settles it — defenders gain 0.74pp, ahead
   in 5 of 5, and the simulate reading was noise.
   ========================================================================= */
{
  // Seat 0 leads a fail heart, seat 1 trumps in with the 9 of diamonds. Seat 1
  // is winning but did NOT lead, so the trump-lead read has nothing to say and
  // the belief is the uninformed two-in-three — the case under test.
  const board = (mine, winCard) => position({
    hands: [
      [C("7", "S")], [C("8", "S"), C("9", "S")],
      [mine, C("8", "C"), C("7", "C")],
      [C("K", "S"), C("10", "S"), C("9", "C")],
      [C("A", "S"), C("10", "C"), C("K", "C")],
    ],
    trick: [{ player: 0, card: C("9", "H") }, { player: 1, card: winCard }],
    picker: 4, partner: 3, partnerRevealed: false,
    calledSuit: "C", calledAcePlayed: false, tricksDone: 2, leader: 0, turn: 2,
  });
  const NOBRAKE = { overtakeBeliefFloor: 1.01 };

  const g = board(C("10", "D"), C("9", "D"));
  check("brake: the partnership is genuinely unproven here",
    knownPartner(g, 2) === null && !g.partnerRevealed);
  check("brake: but believed two-in-three a teammate",
    teammateProbability(g, 2, 1) > 0.6, `p=${teammateProbability(g, 2, 1)}`);
  check("brake: the 10 of trump would take the trick",
    legalPlays(g, 2).some((c) => cid(c) === "10D"));
  check("brake: and taking it buys almost nothing",
    securityAfterPlay(g, 2, C("10", "D")) - trickSecurity(g, 2) < 0.1,
    `gain=${(securityAfterPlay(g, 2, C("10", "D")) - trickSecurity(g, 2)).toFixed(3)}`);

  check("brake (old): the engine spent the 10 to take it anyway",
    cid(aiChooseCard(g, 2, NOBRAKE)) === "10D", `played ${cid(aiChooseCard(g, 2, NOBRAKE))}`);
  const kept = aiChooseCard(g, 2);
  check("brake: now stands down from a believed teammate's trick",
    cid(kept) !== "10D", `played ${cid(kept)}`);
  check("brake: and keeps the ten points rather than donating them",
    cardPts(kept) === 0, `played ${cid(kept)} worth ${cardPts(kept)}`);

  /* ---- CONTROL: a price, not a prohibition ---- */
  {
    // Q-spades over K-diamonds genuinely secures the trick — beaten by one
    // outstanding card instead of nine. "Never overtake your own side" would be
    // the wrong rule, and the gain here pays for the card.
    const g2 = board(C("Q", "S"), C("K", "D"));
    // Stated against the gate this has to clear rather than a bare 0.5. The
    // structural claim — one outstanding beater instead of nine — is what the
    // case is really about, and it is asserted directly; the gain itself moved
    // from 0.61 to 0.36 when the odds started conditioning on the picker
    // having to follow hearts, which changes the number without touching the
    // point. A card beaten by exactly one card is priced at 2x, so clearing
    // 2 x OVERTAKE_MIN_GAIN is precisely what "affordable" means here.
    check("control: Q-spades is beaten by one card where K-diamonds is beaten by nine",
      cardEquity(g2, 2, C("Q", "S")) === 1 && cardEquity(g2, 2, C("K", "D")) === 9,
      `QS=${cardEquity(g2, 2, C("Q", "S"))} KD=${cardEquity(g2, 2, C("K", "D"))}`);
    check("control: this overtake really does secure the trick",
      securityAfterPlay(g2, 2, C("Q", "S")) - trickSecurity(g2, 2) >= 2 * OVERTAKE_MIN_GAIN,
      `gain=${(securityAfterPlay(g2, 2, C("Q", "S")) - trickSecurity(g2, 2)).toFixed(3)}`);
    check("control: so it still happens, brake or no brake",
      cid(aiChooseCard(g2, 2)) === "QS", `played ${cid(aiChooseCard(g2, 2))}`);
  }

  /* ---- CONTROL: the read must be able to switch the brake back off ---- */
  {
    // The seat winning LED a power trump earlier in the hand, so the read marks
    // it as the picker's. Standing down for the picker's partner is precisely
    // the mistake the floor exists to avoid.
    const g3 = board(C("10", "D"), C("9", "D"));
    g3.trickHistory = [{ trick: [
      { player: 1, card: C("Q", "D") }, { player: 2, card: C("8", "S") },
      { player: 3, card: C("9", "S") }, { player: 4, card: C("K", "S") },
      { player: 0, card: C("7", "S") },
    ] }];
    check("control: the read marks the earlier trump-leader as the picker's",
      teammateProbability(g3, 2, 1) < 0.6, `p=${teammateProbability(g3, 2, 1)}`);
    check("control: so the brake stands aside and the trick is contested",
      cid(aiChooseCard(g3, 2)) === "10D", `played ${cid(aiChooseCard(g3, 2))}`);
  }
}

/* ------- The fat-trump lead (reported twice; corpus hand 9, 2026-07-29) ---- */
// Trick 4, and this is a real hand out of the collected corpus, not a
// construction: You are the picker holding K-D, A-D and 10-D. Both jacks of
// trump are still out, so every one of those three cards loses to the same two
// cards — they are equal in power and differ only in what they pay.
//
// The engine led A-D. The branch responsible is "opponents nearly tapped out,
// press now", which leads the TOP trump; with two higher trumps outstanding
// that is not pressure, it is eleven points handed to whoever holds a jack. The
// defense has to follow trump either way, so the bleed is identical and the
// only variable is the price. The human led K-D.
//
// Measured the way a rare rule has to be — every firing finished twice from
// identical state, engine driving all five seats, over 100,000 deals across 5
// seeds: fires on 0.5% of hands, worth +5.34 picking-team points per firing,
// ahead in 5 of 5 seeds, and it moves the schneider multiplier on 10% of
// firings (picker win rate 85.7% against 84.3%). The whole-hand aggregate is
// the wrong instrument at this firing rate and would have called it noise.
{
  const g = position({
    hands: [
      [C("K", "D"), C("A", "D"), C("10", "D")],   // You — picker, on lead
      [C("J", "S"), C("9", "C"), C("9", "H")],    // Gus holds a jack
      [C("J", "D"), C("8", "H"), C("A", "H")],    // Bunny (partner) holds the other
      [C("10", "S"), C("7", "H"), C("10", "H")],
      [C("10", "C"), C("K", "C"), C("K", "H")],
    ],
    played: [
      C("9", "S"), C("K", "S"), C("8", "S"), C("A", "S"), C("7", "S"),
      C("J", "C"), C("Q", "D"), C("Q", "S"), C("Q", "C"), C("8", "D"),
      C("Q", "H"), C("J", "H"), C("7", "D"), C("9", "D"), C("7", "C"),
    ],
    buried: [C("A", "C"), C("8", "C")],
    picker: 0, partner: 2, partnerRevealed: true,
    calledSuit: "S", calledAcePlayed: true, tricksDone: 3, leader: 0, turn: 0,
  });

  check("two trump are still outstanding, which is what opens the press branch",
    unseenTrumpCount(g, g.hands[0]) === 2);
  check("all three trump in hand are equally beatable — the choice is price only",
    legalPlays(g, 0).every((c) => cardEquity(g, 0, c) === 2));
  check("and A-D is the dearest of them",
    cardPts(C("A", "D")) === 11 && cardPts(C("K", "D")) === 4);

  // NEGATIVE CONTROL. If this ever passes alongside the assertion below, the
  // position has stopped reproducing the bug and the case is worthless.
  check("with the guard disabled it still leads the fat ace, as it used to",
    cid(aiChooseCard(g, 0, { guardFatTrumpLead: false })) === "AD",
    `led ${cid(aiChooseCard(g, 0, { guardFatTrumpLead: false }))}`);

  const pick = aiChooseCard(g, 0);
  check("bleeds with the cheap trump instead of donating eleven points",
    cid(pick) === "KD", `led ${cid(pick)}`);
}

{
  // The other half: a fat trump that nothing can beat is a perfectly good
  // press, and must stay one. Every Queen and Jack is gone, so A-D is boss and
  // the two unseen trump are both below it.
  const g = position({
    hands: [
      [C("A", "D"), C("K", "D"), C("8", "S")],
      [C("9", "C"), C("9", "H"), C("A", "H")],
      [C("8", "H"), C("A", "C"), C("K", "C")],
      [C("10", "S"), C("7", "H"), C("10", "H")],
      [C("10", "C"), C("K", "H"), C("9", "S")],
    ],
    played: [
      C("Q", "C"), C("Q", "S"), C("Q", "H"), C("Q", "D"), C("J", "C"),
      C("J", "S"), C("J", "H"), C("J", "D"), C("10", "D"), C("9", "D"),
    ],
    picker: 0, partner: 2, partnerRevealed: true,
    calledSuit: "C", calledAcePlayed: true, tricksDone: 2, leader: 0, turn: 0,
  });
  check("the press branch is live — two trump unseen, two in hand",
    unseenTrumpCount(g, g.hands[0]) === 2 && g.hands[0].filter(isTrump).length === 2);
  check("A-D is boss of everything left",
    cardEquity(g, 0, C("A", "D")) === 0);
  const pick = aiChooseCard(g, 0);
  check("still presses with the fat ace when nothing can beat it",
    cid(pick) === "AD", `led ${cid(pick)}`);
}

{
  // And the guard must not leak into the measured trump-lead rule. A lone fat
  // trump is still led — pulling trump is worth more than the points it risks,
  // which is the +0.019/seat/hand result the leading block documents. This
  // shape appeared twice in the same corpus and is NOT the bug.
  const g = position({
    hands: [
      [C("10", "D"), C("8", "S"), C("7", "H")],
      [C("J", "S"), C("9", "C"), C("9", "H")],
      [C("J", "D"), C("8", "H"), C("A", "H")],
      [C("10", "S"), C("Q", "D"), C("10", "H")],
      [C("10", "C"), C("K", "C"), C("K", "H")],
    ],
    played: [
      C("9", "S"), C("K", "S"), C("8", "S"), C("A", "S"), C("7", "S"),
      C("J", "C"), C("Q", "S"), C("Q", "C"), C("8", "D"), C("Q", "H"),
      C("J", "H"), C("7", "D"), C("9", "D"), C("7", "C"), C("A", "D"),
    ],
    picker: 0, partner: 2, partnerRevealed: true,
    calledSuit: "S", calledAcePlayed: true, tricksDone: 3, leader: 0, turn: 0,
  });
  check("only one trump in hand, so the press branch cannot be the one deciding",
    g.hands[0].filter(isTrump).length === 1);
  const pick = aiChooseCard(g, 0);
  check("leads the lone fat trump anyway — pulling trump is the measured rule",
    cid(pick) === "10D", `led ${cid(pick)}`);
}

/* ---- Follow-suit is a constraint on the OPPONENT too (hand 1, trick 2) ---- */
// Found while validating the PIMC harness, and reproduced from the real hand:
// the picker overtook his own partner with a Queen while holding two cards
// that could not win a trick all night. Double-dummy, every Queen costs 19
// and both dead cards cost 0.
//
// The overtake gate is not what is wrong. It already prices an unbeatable card
// at 4x, so the Queen had to buy 0.60 of security — and `trickSecurity` handed
// it 0.676 by claiming the trick was only 32% safe. That number is the bug.
//
// Kopps' J-hearts is beaten by three unseen cards (Q-diamonds, J-clubs,
// J-spades) and Bunny is the only opponent left to act, so the count says
// P(Bunny holds none of them) = 0.324. But CLUBS were led. Bunny can only play
// a trump at all when void in clubs, and two fail clubs are still unaccounted
// for. The honest number conditions on that:
//
//     P(safe) = P(Bunny holds a club) + P(void) x P(no beater | void)
//             = 0.515 + 0.485 x 0.264 = 0.643
//
// which halves the overtake's gain to 0.36 and leaves it short of the 0.60 it
// has to clear. engine.js already names this hole — "the count below, which
// prices every unseen card as reachable by every seat still to act, has no way
// to see that" — but only closes it for the called-suit pins `forcedPlay`
// knows about, never for ordinary follow-suit.
{
  const g = position({
    hands: [
      [C("A", "D"), C("Q", "H"), C("Q", "C"), C("Q", "S"), C("10", "D")], // picker
      [C("A", "C"), C("8", "H"), C("8", "D"), C("J", "C"), C("Q", "D")],  // Bunny, yet to act
      [C("9", "H"), C("J", "D"), C("J", "S"), C("K", "H")],
      [C("9", "S"), C("7", "D"), C("K", "D"), C("10", "C")],
      [C("7", "S"), C("A", "H"), C("10", "H"), C("7", "H")],
    ],
    trick: [
      { player: 2, card: C("8", "C") },
      { player: 3, card: C("K", "C") },
      { player: 4, card: C("J", "H") }, // partner trumps in
    ],
    played: [C("8", "S"), C("A", "S"), C("K", "S"), C("10", "S"), C("9", "D")],
    buried: [C("9", "C"), C("7", "C")],
    picker: 0, partner: 4, partnerRevealed: true,
    calledSuit: "S", calledAcePlayed: true, tricksDone: 1, leader: 2, turn: 0,
  });

  check("fixture is a complete 32-card deal", dealIsComplete(g));
  const legal = legalPlays(g, 0);
  check("picker is void in clubs, so all five trump are legal",
    legal.length === 5 && legal.every(isTrump), `legal=${legal.map(cid).join(",")}`);
  check("the partner is winning the trick",
    trickWinner(g.trick) === 4 && knowsTeammate(g, 0, 4));
  check("A-diamonds and 10-diamonds are the dead cards here",
    cardEquity(g, 0, C("A", "D")) === 4 && cardEquity(g, 0, C("10", "D")) === 4);
  check("every Queen is unbeatable, so the gate prices it at 4x",
    [C("Q", "H"), C("Q", "C"), C("Q", "S")].every((c) => cardEquity(g, 0, c) === 0));

  // The exact anchor, independent of any heuristic: spending a Queen here is
  // a 19-point error and the dead cards are free.
  const value = (c) => solveHandValue(applyPlay(g, 0, c));
  const best = Math.max(...legal.map(value));
  check("double-dummy: a dead diamond is optimal", value(C("A", "D")) === best);
  check("double-dummy: a Queen costs 19", best - value(C("Q", "H")) === 19,
    `cost ${best - value(C("Q", "H"))}`);

  // The old estimate, kept as the contrast: it is what made this hand go wrong,
  // and asserting it directly means a future change cannot quietly reintroduce
  // the bias and still look fine here.
  const RAW = { followSuitOdds: false };
  check("the raw count reads this trick as two-thirds lost",
    trickSecurity(g, 0, RAW) < 0.35, `security ${trickSecurity(g, 0, RAW).toFixed(3)}`);
  check("and on that number the picker spends a Queen",
    isPowerTrump(aiChooseCard(g, 0, RAW)), `played ${cid(aiChooseCard(g, 0, RAW))}`);

  // The root cause, asserted directly so a future change to the overtake gate
  // cannot make the card assertions below pass for the wrong reason.
  check("security conditions on Bunny having to follow clubs",
    trickSecurity(g, 0) > 0.6,
    `security ${trickSecurity(g, 0).toFixed(3)} — raw count gives 0.324, truth is 0.643`);

  const pick = aiChooseCard(g, 0);
  check("picker does not overtake its own partner with a Queen",
    !isPowerTrump(pick), `played ${cid(pick)}`);
  check("picker plays a card that was never going to win anyway",
    cid(pick) === "AD" || cid(pick) === "10D", `played ${cid(pick)}`);
}

/* ---- Negative control: no unseen led-suit cards, so nothing to condition on ---- */
// The same shape with every fail club already accounted for. There is no
// "Bunny might have to follow" left to discover, the honest security really is
// the raw count, and the overtake must still fire — otherwise the fix above is
// not a correction, it is a blanket "never overtake your own side", which
// engine.js explicitly rejects ("holding the lead is sometimes the entire
// plan"). Both fixtures are complete 32-card deals, asserted below, because a
// position with a duplicated card prices security against a deck that cannot
// exist and would let either of these pass for the wrong reason.
{
  const g = position({
    hands: [
      [C("A", "D"), C("Q", "H"), C("Q", "C"), C("Q", "S"), C("10", "D")], // picker
      [C("A", "H"), C("8", "H"), C("8", "D"), C("J", "C"), C("Q", "D")],  // Bunny, yet to act
      [C("9", "H"), C("J", "D"), C("J", "S"), C("K", "H")],
      [C("7", "D"), C("K", "D"), C("10", "H"), C("7", "S")],
      [C("7", "H"), C("8", "S"), C("K", "S"), C("9", "D")],
    ],
    trick: [
      { player: 2, card: C("8", "C") },
      { player: 3, card: C("K", "C") },
      { player: 4, card: C("J", "H") },
    ],
    // A-clubs and 10-clubs are gone here rather than sitting unseen, so a void
    // in clubs is not something the count could have been conditioning on.
    played: [C("10", "S"), C("A", "C"), C("10", "C"), C("9", "S"), C("A", "S")],
    buried: [C("9", "C"), C("7", "C")],
    picker: 0, partner: 4, partnerRevealed: true,
    calledSuit: "S", calledAcePlayed: true, tricksDone: 1, leader: 2, turn: 0,
  });
  check("negative control: fixture is a complete 32-card deal", dealIsComplete(g));
  const unseenClubs = unaccountedFor(g, 0).filter((c) => !isTrump(c) && c.suit === "C").length;
  check("negative control: no fail clubs left unseen", unseenClubs === 0,
    `${unseenClubs} still out`);
  check("negative control: security stays at the raw count, so the overtake is still affordable",
    trickSecurity(g, 0) < 0.5, `security ${trickSecurity(g, 0).toFixed(3)}`);
  check("negative control: the picker still overtakes to lock the trick",
    isPowerTrump(aiChooseCard(g, 0)), `played ${cid(aiChooseCard(g, 0))}`);
}

/* -------------------------------------------------------------------------
   Reported 2026-08-03 (hand 4, v0.48.0): the picker overtakes a partner's
   K-diamonds lead with A-diamonds from THIRD seat, hangs 11 points in front of
   two unplayed defenders, and a defender takes the trick with Q-hearts for 21.

   The cause is structural rather than a bad read. In the trump order the two
   point-fat trump sit BELOW every Jack and Queen:

       Q♣ Q♠ Q♥ Q♦ J♣ J♠ J♥ J♦ A♦ 10♦ K♦ 9♦ 8♦ 7♦
                                 ▲   ▲
                                11   10 points

   so `cheapest(winners)` — which sorts by power, the right axis for keeping
   winning strength back — picks the most EXPENSIVE card in the pile whenever
   A♦ or 10♦ is the low winner. J♦ and A♦ are adjacent in that order, so a seat
   holding both always has two winners with an identical beater set: the same
   cards beat them, they hold the trick with the same probability, and the only
   difference between them is 9 points of exposure.

   Note the exact solver scores A♦, J♦ and 7♦ at cost 0 on the real deal — the
   defence had the hand whatever she played, so double-dummy cannot anchor this
   one. The anchor is PIMC over 10,000 worlds consistent with what she could
   see (scripts/scenarios/hand4-patty-ad.mjs): 7♦ 57.62 ± 0.25 and 40.5% wins,
   J♦ 57.27 and 41.4%, A♦ 54.94 and 36.7%. The played card is ~11 SE behind.
   That is why this is asserted here and not as a double-dummy cost.
   ------------------------------------------------------------------------- */
{
  const g = position({
    hands: [
      [C("A", "C"), C("10", "S"), C("9", "S"), C("K", "S")],                    // partner, led K♦
      [C("8", "C"), C("8", "H"), C("10", "H"), C("9", "C")],                    // sloughed 7♥
      [C("A", "D"), C("K", "C"), C("7", "S"), C("7", "D"), C("J", "D")],        // picker, to act
      [C("Q", "D"), C("9", "D"), C("8", "S"), C("10", "D"), C("K", "H")],       // yet to act
      [C("Q", "H"), C("7", "C"), C("A", "S"), C("Q", "S"), C("9", "H")],        // yet to act
    ],
    trick: [
      { player: 0, card: C("K", "D") },
      { player: 1, card: C("7", "H") },
    ],
    played: [C("J", "H"), C("J", "S"), C("J", "C"), C("Q", "C"), C("8", "D")],
    buried: [C("A", "H"), C("10", "C")],
    picker: 2, partner: 0, partnerRevealed: false,
    calledSuit: "C", calledAcePlayed: false, tricksDone: 1, leader: 0, turn: 2,
  });

  check("fixture is a complete 32-card deal", dealIsComplete(g));
  const legal = legalPlays(g, 2);
  check("trump was led, so only the picker's three trump are legal",
    legal.length === 3 && legal.every(isTrump), `legal=${legal.map(cid).join(",")}`);
  check("two of them beat the K♦",
    legal.filter((c) => trumpPower(c) > trumpPower(C("K", "D"))).length === 2);

  // The heart of it: these two winners are interchangeable.
  check("A♦ and J♦ have the same beaters, so rank buys nothing here",
    cardEquity(g, 2, C("A", "D")) === 3 && cardEquity(g, 2, C("J", "D")) === 3,
    `A♦=${cardEquity(g, 2, C("A", "D"))} J♦=${cardEquity(g, 2, C("J", "D"))}`);
  check("and they hold the trick with the same probability",
    Math.abs(securityAfterPlay(g, 2, C("A", "D")) - securityAfterPlay(g, 2, C("J", "D"))) < 1e-9);
  check("which is nowhere near safe — two defenders still to act",
    securityAfterPlay(g, 2, C("A", "D")) < 0.2,
    `security ${securityAfterPlay(g, 2, C("A", "D")).toFixed(3)}`);
  check("so the fat one costs 9 more points for nothing",
    cardPts(C("A", "D")) - cardPts(C("J", "D")) === 9);

  check("the picker overtakes with the CHEAP twin, not the 11-point Ace",
    cid(aiChooseCard(g, 2)) === cid(C("J", "D")), `played ${cid(aiChooseCard(g, 2))}`);
}

/* Negative control 1 — same shape, but the trick is already safe.
   The picker is last to act, so nothing can take the trick off her whatever
   she plays. Spending the fat trump is then correct: it banks 11 points into a
   trick she is certain of AND keeps the stronger card back. The rule must not
   fire on security, only on its absence. */
{
  const g = position({
    hands: [
      [C("Q", "S"), C("Q", "D"), C("10", "D"), C("10", "S")],
      [C("A", "C"), C("8", "C"), C("7", "C"), C("8", "H")],                     // void in trump
      [C("A", "D"), C("J", "D"), C("K", "C"), C("10", "C"), C("9", "C")],       // picker, last
      [C("Q", "H"), C("7", "D"), C("K", "H"), C("10", "H")],
      [C("A", "S"), C("K", "S"), C("9", "S"), C("8", "S")],                     // void in trump
    ],
    trick: [
      { player: 0, card: C("K", "D") },
      { player: 1, card: C("7", "H") },
      { player: 3, card: C("9", "D") },
      { player: 4, card: C("9", "H") },
    ],
    played: [C("J", "H"), C("J", "S"), C("J", "C"), C("Q", "C"), C("8", "D")],
    buried: [C("A", "H"), C("7", "S")],
    picker: 2, partner: 1, partnerRevealed: false,
    calledSuit: "C", calledAcePlayed: false, tricksDone: 1, leader: 0, turn: 2,
  });

  check("negative control 1: fixture is a complete 32-card deal", dealIsComplete(g));
  check("negative control 1: A♦ and J♦ are still interchangeable as winners",
    cardEquity(g, 2, C("A", "D")) === cardEquity(g, 2, C("J", "D")));
  check("negative control 1: but the trick cannot move — nobody is left to act",
    securityAfterPlay(g, 2, C("A", "D")) > 0.999,
    `security ${securityAfterPlay(g, 2, C("A", "D")).toFixed(3)}`);
  check("negative control 1: so the picker banks the fat trump as before",
    cid(aiChooseCard(g, 2)) === cid(C("A", "D")), `played ${cid(aiChooseCard(g, 2))}`);
}

/* Negative control 2 — insecure trick, but the winners are NOT interchangeable.
   J♣ is beaten by three cards and A♦ by four, so the Jack is genuinely the
   stronger card and burning it to save points would be the overkill the
   cheapest-winner rule exists to prevent. Unequal equity must switch the whole
   thing off, whatever the security is. */
{
  const g = position({
    hands: [
      [C("Q", "C"), C("10", "D"), C("10", "S"), C("K", "S")],
      [C("A", "C"), C("8", "C"), C("7", "C"), C("8", "H")],                     // void in trump
      [C("A", "D"), C("J", "C"), C("K", "C"), C("10", "C"), C("9", "C")],       // picker, to act
      [C("Q", "H"), C("J", "D"), C("9", "D"), C("K", "H"), C("10", "H")],
      [C("Q", "D"), C("A", "S"), C("9", "S"), C("8", "S"), C("9", "H")],
    ],
    trick: [
      { player: 0, card: C("K", "D") },
      { player: 1, card: C("7", "H") },
    ],
    played: [C("J", "H"), C("J", "S"), C("8", "D"), C("Q", "S"), C("7", "D")],
    buried: [C("A", "H"), C("7", "S")],
    picker: 2, partner: 1, partnerRevealed: false,
    calledSuit: "C", calledAcePlayed: false, tricksDone: 1, leader: 0, turn: 2,
  });

  check("negative control 2: fixture is a complete 32-card deal", dealIsComplete(g));
  check("negative control 2: the trick is still wide open",
    securityAfterPlay(g, 2, C("A", "D")) < 0.5,
    `security ${securityAfterPlay(g, 2, C("A", "D")).toFixed(3)}`);
  check("negative control 2: J♣ is strictly stronger than A♦ here",
    cardEquity(g, 2, C("J", "C")) === 3 && cardEquity(g, 2, C("A", "D")) === 4,
    `J♣=${cardEquity(g, 2, C("J", "C"))} A♦=${cardEquity(g, 2, C("A", "D"))}`);
  check("negative control 2: so the cheapest winner still wins it, Ace and all",
    cid(aiChooseCard(g, 2)) === cid(C("A", "D")), `played ${cid(aiChooseCard(g, 2))}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — the AI protects its trump power.");
