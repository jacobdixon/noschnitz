/* ============================================================================
   Calling under.

   The first version of this rule reached real play and was wrong at the core:
   it read "calling under" as calling a suit you are VOID in, and then let the
   picker do as they liked when that suit was led. Duane called hearts under and
   trumped a heart trick — which is strictly better than playing the hand
   straight, so the call was free.

   Under is not being void. It is designating one of your six cards to stand in
   for the called suit. That card:

     plays as the lowest card of the suit — it cannot win a trick
     must be played when the called suit is led, and may be led itself
     keeps its own point value for whoever gathers the trick
     goes down FACE DOWN, seen only by the trick's winner and the picker,
       and by everyone in the recap

   These are the invariants of that, checked on constructed positions and then
   over a sweep of real playouts — because the rule touches follow-suit, trick
   resolution, scoring and redaction at once, and a break in any one of them is
   a hand that cannot be played honestly.
   ========================================================================= */
import {
  ALL_CARDS, callOptions, legalPlays, applyPlay, resolveTrick, trickWinner,
  cardPts, cid, isTrump, viewFor, freshHand, aiBuryAndCall, aiChooseCard,
  assignPartner, handStrength, sortHand, scoreHand, chooseUnderCard,
} from "../src/engine.js";

// Deterministic deals, so a failure here is reproducible. freshHand() shuffles
// off its own RNG; this replays a seeded shuffle over the same 32 cards, the
// way the A/B harness does.
//
// The shuffle base is ALL_CARDS, a fixed canonical order, and that detail is
// what makes the sentence above TRUE — see the note in abtest.mjs. Until
// 2026-08-03 this reshuffled the cards as freshHand left them, which composes
// with makeDeck's unseeded shuffle instead of replacing it, so these deals were
// re-drawn on every run. That mattered more here than in the A/B harnesses:
// this file asserts, so an assertion that holds for most deals but not all was
// free to pass locally and fail on master, and a marginal test in this repo
// withholds the beta deploy rather than merely going red (see CLAUDE.md).
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dealWith(seed) {
  const g = freshHand(seed % 5, [0, 0, 0, 0, 0], 1);
  const rand = mulberry32(seed + 1);
  const deck = [...ALL_CARDS];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return {
    ...g,
    hands: [0, 1, 2, 3, 4].map((p) => sortHand(deck.slice(p * 6, p * 6 + 6))),
    blind: deck.slice(30, 32),
  };
}

let passed = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) passed++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

const C = (s) => ({ rank: s.slice(0, -1), suit: s.slice(-1) });
const H = (a) => a.map(C);

/* --------------------------- eligibility, in full ------------------------- */
{
  // You may only call under in a suit you are void in AND whose ace is not
  // yours — and only when no ordinary ace call was ever available.
  const o = callOptions(H(["AC", "9C", "QC", "QS", "JD", "AD"]));
  check("void suits become under calls", o.length === 2 && o.every((x) => x.kind === "under"));
  check("...and never a suit whose ace you hold", !o.some((x) => x.suit === "C"));

  // The loophole. A picker dealt two low hearts can call the heart ace; buying
  // an under call by burying them both is not allowed, in ANY suit.
  const escape = callOptions(H(["QC", "JD", "AD", "10D", "9D", "8D"]), H(["7H", "8H"]));
  check("you cannot bury your way into an under call", escape.length === 0, JSON.stringify(escape));

  // But a genuine void survives the bury.
  const real = callOptions(H(["QC", "JD", "AD", "10D", "9D", "8D"]), H(["9D", "7D"]));
  check("a genuine void still calls under", real.length > 0 && real.every((x) => x.kind === "under"));
}

/* ------------------------- the card behaves as a 6 ------------------------ */
{
  // Q♣ is the highest trump in the deck. Designated under, it is the lowest
  // heart and can beat nothing.
  const base = {
    picker: 0, partner: 3, calledSuit: "H", calledRank: "A", calledUnder: true,
    underCard: C("QC"), partnerRevealed: false, calledAcePlayed: false,
    calledSuitLed: false, tricksDone: 0, phase: "playing",
    hands: [H(["QC", "JD", "KS"]), H(["8H"]), H(["7C"]), H(["AH"]), H(["9C"])],
  };

  const led = { ...base, trick: [{ player: 1, card: C("9H") }] };
  const legal = legalPlays(led, 0);
  check("hearts led forces the under card out", legal.length === 1 && cid(legal[0]) === "QC",
    legal.map(cid).join(" "));

  const after = applyPlay(led, 0, C("QC"));
  const e = after.trick.find((t) => t.under);
  check("it lands as the 6 of the called suit", e.card.rank === "6" && e.card.suit === "H");
  check("the top trump in the deck loses to a 9", trickWinner(after.trick) === 1);
  check("it still scores its own points",
    after.trick.reduce((s, t) => s + cardPts(t.actual ?? t.card), 0) === 3);
  check("playing under is not playing the called ace", after.partnerRevealed === false);

  // It may be led, and leading it puts the called suit in play.
  const leading = { ...base, trick: [], turn: 0 };
  check("the under card may be led", legalPlays(leading, 0).some((c) => cid(c) === "QC"));
  const ledUnder = applyPlay(leading, 0, C("QC"));
  check("leading it counts as leading the called suit", ledUnder.calledSuitLed === true);

  // A different suit led: the under card is NOT a club any more, so a picker
  // holding it cannot follow clubs with it.
  const clubs = { ...base, trick: [{ player: 1, card: C("9C") }] };
  check("the under card no longer follows its own suit",
    !legalPlays(clubs, 0).some((c) => cid(c) === "QC"), legalPlays(clubs, 0).map(cid).join(" "));

  // Once spent, the picker is void for real.
  const spent = { ...base, trick: [{ player: 1, card: C("9H") }], hands: base.hands.map((h, i) => (i === 0 ? H(["JD", "KS"]) : h)) };
  check("with the under card gone the picker may trump", legalPlays(spent, 0).length === 2);
}

/* ------------------------------- who may look ----------------------------- */
{
  const g = {
    picker: 0, partner: 3, calledSuit: "H", calledRank: "A", calledUnder: true,
    underCard: C("AD"), phase: "playing", partnerRevealed: false, calledAcePlayed: false,
    calledSuitLed: false, tricksDone: 0, trick: [{ player: 1, card: C("9H") }],
    hands: [H(["AD", "QC"]), H(["8H"]), H(["7C"]), H(["AH"]), H(["9C"])],
    blind: [], buried: [], scores: [0, 0, 0, 0, 0], trickHistory: [], lastTrick: null,
  };
  const played = applyPlay(g, 0, C("AD"));
  const done = { ...played, trickHistory: [{ trick: played.trick, winner: 1 }], trick: [] };
  const seen = (state, seat) => {
    const v = viewFor(state, seat);
    return v.trickHistory[0].trick.find((t) => t.under)?.actual ?? null;
  };

  check("the picker sees their own under card", cid(seen(done, 0)) === "AD");
  check("the trick's winner sees it", cid(seen(done, 1)) === "AD");
  check("nobody else does", seen(done, 2) === null && seen(done, 4) === null);
  check("everyone sees it once the hand ends", cid(seen({ ...done, phase: "handEnd" }, 2)) === "AD");

  // In progress, with no winner yet, even the eventual winner may not look.
  const live = { ...played, trickHistory: [], lastTrick: null };
  const inPlay = (seat) => viewFor(live, seat).trick.find((t) => t.under)?.actual ?? null;
  check("mid-trick, only the picker may look", cid(inPlay(0)) === "AD" && inPlay(1) === null && inPlay(3) === null);

  // And the designated card itself is never on the wire for anyone else.
  check("the designated card is redacted before it is played",
    viewFor(g, 2).underCard === null && cid(viewFor(g, 0).underCard) === "AD");

  // That a card was played under is public — only its face is not.
  check("the fact of the call stays public",
    viewFor(done, 2).trickHistory[0].trick.some((t) => t.under) && viewFor(done, 2).calledUnder === true);
}

/* ---------------------------- the AI's designation ------------------------ */
{
  const c = chooseUnderCard(H(["QC", "JD", "AD", "10D", "7S", "AH"]));
  check("the AI spends its cheapest card", cid(c) === "7S", cid(c));
  const allTrump = chooseUnderCard(H(["QC", "QS", "JD", "10D", "9D", "7D"]));
  check("...and the lowest trump when that is all there is", cid(allTrump) === "7D", cid(allTrump));

  // noschnitz.com hand 16, v0.28.0. The picker held Q♦ Q♠ Q♣ 10♦ A♦ K♥ after
  // burying A♥ 10♥ and sent the QUEEN OF DIAMONDS under — a card that would
  // have taken any trick in the hand, spent on a card that can take none, to
  // avoid giving up the four points on the King. An under card's cost is the
  // power it takes off the table, not the points it carries.
  const queens = H(["QD", "10D", "QS", "QC", "AD", "KH"]);
  check("a Queen is never the under card", cid(chooseUnderCard(queens)) === "KH",
    cid(chooseUnderCard(queens)));

  // The negative control, and the reason this was not obvious: scoring points
  // ten times heavier than everything else — the rule before the fix — really
  // does name the Queen as this hand's cheapest card.
  const byPointsFirst = [...queens]
    .map((x) => ({ x, score: cardPts(x) * 10 + (isTrump(x) ? 8 : 0) }))
    .sort((a, b) => a.score - b.score)[0].x;
  check("...and pricing it by points alone picks one", cid(byPointsFirst) === "QD", cid(byPointsFirst));

  // Jacks are the same mistake two points cheaper, which is why the rule is
  // about power trump rather than about Queens.
  const jack = chooseUnderCard(H(["JD", "8D", "QC", "AD", "10D", "KH"]));
  check("nor a Jack", cid(jack) === "KH", cid(jack));
  check("...with the low diamond preferred once the fail is gone",
    cid(chooseUnderCard(H(["JD", "8D", "QC", "AD", "10D"]))) === "8D");
}

/* ----------------------------- full playouts ------------------------------ */
{
  // The rule spans follow-suit, trick resolution, scoring and redaction, so the
  // only convincing test is hands played to the end.
  let under = 0, hands = 0, forced = 0;
  const bad = { unplayed: 0, won: 0, wrongTrick: 0, points: 0, leaked: 0 };

  for (let seed = 0; seed < 3000; seed++) {
    let g = dealWith(seed);
    while (g.phase === "picking" && g.passes < 5) {
      const idx = g.pickTurn;
      const s = handStrength(g.hands[idx]);
      if (!(s >= 10 || (g.passes === 4 && s >= 8))) {
        g = { ...g, passes: g.passes + 1, pickTurn: (idx + 1) % 5 };
        continue;
      }
      const eight = [...g.hands[idx], ...g.blind];
      const r = aiBuryAndCall(eight);
      g = assignPartner({
        ...g, picker: idx, buried: r.buried, calledSuit: r.call,
        calledRank: r.call === null ? null : r.callRank,
        calledUnder: r.callKind === "under", underCard: r.underCard ?? null,
        hands: g.hands.map((h, i) => (i === idx ? sortHand(r.hand) : h)),
        phase: "playing", trick: [], turn: g.leader,
      });
    }
    if (g.phase !== "playing") continue;
    hands++;
    const isUnder = g.calledUnder;
    const designated = g.underCard;
    if (isUnder) under++;

    let guard = 0;
    while (g.phase === "playing" && guard++ < 60) {
      const idx = g.turn;
      if (idx < 0) { g = resolveTrick(g); continue; }
      g = applyPlay(g, idx, aiChooseCard(g, idx));
      if (g.trick.length === 5) g = resolveTrick(g);
    }
    if (g.phase !== "handEnd") continue;

    if (!isUnder) {
      // No under call: nothing anywhere may claim to be one.
      if (g.trickHistory.some((th) => th.trick.some((t) => t.under))) bad.leaked++;
      continue;
    }

    const entries = g.trickHistory.flatMap((th, ti) =>
      th.trick.map((t) => ({ ...t, ti, winner: th.winner })));
    const u = entries.filter((t) => t.under);

    // Exactly one card is played under, it is the designated one, and it is
    // the picker who plays it.
    if (u.length !== 1 || cid(u[0].actual) !== cid(designated) || u[0].player !== g.picker) {
      bad.unplayed++;
      continue;
    }

    // It can never win the trick it falls in.
    if (u[0].winner === g.picker && trickWinner(g.trickHistory[u[0].ti].trick) === g.picker) {
      const t = g.trickHistory[u[0].ti].trick;
      if (t.find((x) => x.under)?.player === trickWinner(t)) bad.won++;
    }

    // It comes out on a trick where the called suit was led, or it led itself
    // — with one unavoidable exception. If the called suit is never led all
    // hand, the picker holds the card to the end and the last trick forces it
    // out with nothing else left to play. That is the retention rule working,
    // not failing: it held the card for six tricks.
    const its = g.trickHistory[u[0].ti].trick;
    const ledCard = its[0].actual ?? its[0].card;
    const ledSuit = its[0].under ? g.calledSuit : (isTrump(ledCard) ? "T" : ledCard.suit);
    const lastCard = u[0].ti === g.trickHistory.length - 1;
    if (ledSuit !== g.calledSuit) {
      if (lastCard) forced++;
      else bad.wrongTrick++;
    }

    // Its points went to whoever gathered the trick, not zero.
    const total = its.reduce((s, t) => s + cardPts(t.actual ?? t.card), 0);
    if (total < cardPts(designated)) bad.points++;
  }

  check("under calls actually occur in play", under > 20, `${under} of ${hands} hands`);
  check("sweep: the designated card is played, once, by the picker", bad.unplayed === 0, `${bad.unplayed}`);
  check("sweep: the under card never wins a trick", bad.won === 0, `${bad.won}`);
  check("sweep: it only comes out to the called suit, or as the last card",
    bad.wrongTrick === 0, `${bad.wrongTrick}`);
  check("sweep: it is never merely sluffed away mid-hand", bad.wrongTrick === 0);
  check("sweep: its points are counted", bad.points === 0, `${bad.points}`);
  check("sweep: no under card appears without an under call", bad.leaked === 0, `${bad.leaked}`);
  console.log(`  (${under} under calls across ${hands} played hands; ${forced} held to the last trick)`);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — the under card stands in for the called suit and stays hidden.");
