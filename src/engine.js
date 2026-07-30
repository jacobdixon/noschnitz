/* ================= SHEEPSHEAD ENGINE — Call an Ace, 5-handed =================
   Pure game logic, no React/JSX. Kept separate from Sheepshead.jsx so it can be
   imported by a headless simulation harness (scripts/simulate.mjs) for testing
   AI changes without a browser. */

export const SUITS = ["C", "S", "H", "D"];
export const RANKS = ["7", "8", "9", "K", "10", "A", "J", "Q"];
export const SUIT_SYM = { C: "♣", S: "♠", H: "♥", D: "♦" };
export const SUIT_NAME = { C: "Clubs", S: "Spades", H: "Hearts", D: "Diamonds" };
export const CARD_POINTS = { A: 11, "10": 10, K: 4, Q: 3, J: 2, "9": 0, "8": 0, "7": 0, "6": 0 };

// The rank a card played "under" takes on. There is no 6 in a sheepshead deck,
// which is exactly why it works: it is unambiguous, it sorts below the 7, and
// it can never collide with a real card. The physical card keeps its own point
// value — only its rank and suit are replaced while it is on the table.
export const UNDER_RANK = "6";
export const NAMES = ["You", "Gus", "Bunny", "Duane", "Patty"];

// Solo's opponent roster, picked fresh once per session from a larger pool
// instead of always being the same four — so the AI's occasional blunder
// isn't forever pinned on the same name. Milwaukee-flavored beyond the
// original three: Bernie Brewer (the Brewers' mascot), Miller (Miller Park /
// Brewing), Fonzie (Happy Days, set in Milwaukee, statue on the Riverwalk),
// and Kopp's/Leon's, the city's dueling frozen-custard institutions.
// Multiplayer does NOT use this — table.js's AI_NAMES stays fixed per seat
// position, since a seat's name should only change when its occupant does.
export const BOT_NAME_POOL = ["Gus", "Bunny", "Patty", "Bernie", "Miller", "Fonzie", "Kopps", "Leon"];

export function pickBotNames() {
  const pool = [...BOT_NAME_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return ["You", ...pool.slice(0, 4)];
}

export const isTrump = (c) => c.rank === "Q" || c.rank === "J" || c.suit === "D";
export const effSuit = (c) => (isTrump(c) ? "T" : c.suit);
export const cardPts = (c) => CARD_POINTS[c.rank];
export const cid = (c) => c.rank + c.suit;

// The picker's designated under card, as it behaves on the table: the lowest
// card of the suit they called. `g.underCard` is the physical card they set
// aside; this is what everyone plays against.
export const underFace = (g) =>
  g.calledUnder && g.calledSuit ? { rank: UNDER_RANK, suit: g.calledSuit } : null;

export const isUnderCard = (g, idx, c) =>
  Boolean(g.underCard) && idx === g.picker && cid(c) === cid(g.underCard);

// What suit a card counts as in this player's hand — the called suit for the
// under card, its own otherwise. The under card stops being whatever it
// physically is: designate your last club and you can no longer follow clubs.
export const effSuitFor = (g, idx, c) => (isUnderCard(g, idx, c) ? g.calledSuit : effSuit(c));

export function trumpPower(c) {
  const qOrder = { C: 14, S: 13, H: 12, D: 11 };
  const jOrder = { C: 10, S: 9, H: 8, D: 7 };
  if (c.rank === "Q") return qOrder[c.suit];
  if (c.rank === "J") return jOrder[c.suit];
  return { A: 6, "10": 5, K: 4, "9": 3, "8": 2, "7": 1 }[c.rank];
}
export const failPower = (c) => ({ A: 6, "10": 5, K: 4, "9": 3, "8": 2, "7": 1, "6": 0 }[c.rank]);
export const power = (c) => (isTrump(c) ? 100 + trumpPower(c) : failPower(c));

export const TRUMP_COUNT = 14; // Q x4, J x4, diamonds x6

/* ---------- Card memory: what's been seen this hand ---------- */
// g.played accumulates every card from every *resolved* trick. Combined with
// the in-progress g.trick, this lets the AI reason about what's still
// unaccounted for (in other hands, the blind, or buried) instead of only
// ever looking at the current trick in isolation.
export function seenCards(g) {
  return [...g.played, ...g.trick.map((t) => t.card)];
}

// Trump not yet seen this hand and not in `hand` — i.e. still out there
// somewhere (other hands, blind/buried). Lets the AI judge how safe it is
// to lead or hold trump instead of using a fixed rule of thumb.
export function unseenTrumpCount(g, hand) {
  const seenTrump = seenCards(g).filter(isTrump).length;
  const mineTrump = hand.filter(isTrump).length;
  return Math.max(0, TRUMP_COUNT - seenTrump - mineTrump);
}

// How many cards of a given effective suit (fail suit letter, or "T" for
// trump) remain unseen and not in `hand`. Useful for judging whether a fail
// suit is likely exhausted around the table.
export function unseenSuitCount(g, hand, suit) {
  const totalPerSuit = suit === "T" ? TRUMP_COUNT : 6; // 6 non-trump ranks per fail suit
  const seenInSuit = seenCards(g).filter((c) => effSuit(c) === suit).length;
  const mineInSuit = hand.filter((c) => effSuit(c) === suit).length;
  return Math.max(0, totalPerSuit - seenInSuit - mineInSuit);
}

// Every card in the deck, in a fixed order. `makeDeck` shuffles, which is what
// dealing wants and what card-counting reasoning must not have.
export const ALL_CARDS = SUITS.flatMap((suit) => RANKS.map((rank) => ({ suit, rank })));

// Trump splits cleanly in two, and the split is what makes schmearing decidable:
// every point that lives in trump lives in the diamonds. Queens and Jacks are
// 3 and 2 points but carry all the power; A/10/K/9/8/7 of diamonds carry 11, 10,
// 4, 0, 0, 0 points and almost no power. So "give away points" and "give away
// power" only ever conflict if you hold nothing but Queens and Jacks.
export const isPowerTrump = (c) => c.rank === "Q" || c.rank === "J";

export function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export function sortHand(hand) {
  const suitOrd = { C: 0, S: 1, H: 2 };
  return [...hand].sort((a, b) => {
    const at = isTrump(a), bt = isTrump(b);
    if (at && bt) return trumpPower(b) - trumpPower(a);
    if (at) return -1;
    if (bt) return 1;
    if (a.suit !== b.suit) return suitOrd[a.suit] - suitOrd[b.suit];
    return failPower(b) - failPower(a);
  });
}

export function trickWinner(trick) {
  const led = effSuit(trick[0].card);
  let best = trick[0];
  for (const p of trick.slice(1)) {
    const bt = isTrump(best.card), pt = isTrump(p.card);
    if (pt && !bt) best = p;
    else if (pt && bt && trumpPower(p.card) > trumpPower(best.card)) best = p;
    else if (!pt && !bt && effSuit(p.card) === led && failPower(p.card) > failPower(best.card)) best = p;
  }
  return best.player;
}

/* ---------- Legality (follow suit + called-ace constraints) ---------- */
export function legalPlays(g, playerIdx) {
  const hand = g.hands[playerIdx];
  const called = g.calledSuit; // null when picker went alone
  const isPartner = playerIdx === g.partner;
  const isPicker = playerIdx === g.picker;
  const aceOut = g.calledAcePlayed;
  const lastTrick = g.tricksDone === 5;

  // The called CARD, which is the ace on an ordinary call and the ten when the
  // picker held all three aces. Everything downstream reasons about "the card
  // that names the partner", never about an ace specifically.
  const calledRank = g.calledRank || "A";
  const calledAce = (c) => called && c.suit === called && c.rank === calledRank && !isTrump(c);
  // The picker's under card counts as the called suit, which is what forces it
  // out when that suit is led — the picker holds no other card of it, so
  // ordinary follow-suit does the work with no special rule.
  const suitOf = (c) => effSuitFor(g, playerIdx, c);
  const inCalled = (c) => called && suitOf(c) === called;

  let legal;
  if (g.trick.length === 0) {
    legal = [...hand];
    // Partner may not lead the called suit except with the ace itself (until ace is played)
    if (isPartner && !aceOut && !lastTrick) {
      const filtered = legal.filter((c) => !inCalled(c) || calledAce(c));
      if (filtered.length) legal = filtered;
    }
  } else {
    const led = effSuit(g.trick[0].card);
    const follow = hand.filter((c) => suitOf(c) === led);
    legal = follow.length ? follow : [...hand];
    // Partner must play the called ace the first time the suit is led
    if (isPartner && !aceOut && led === called) {
      const ace = legal.find(calledAce);
      if (ace) legal = [ace];
    }
  }

  // Partner may not throw the called ace off-suit before the suit is led (unless forced or last trick)
  if (isPartner && !aceOut && !lastTrick && g.trick.length > 0) {
    const led = effSuit(g.trick[0].card);
    if (led !== called) {
      const filtered = legal.filter((c) => !calledAce(c));
      if (filtered.length) legal = filtered;
    }
  }
  // Picker must retain a called-suit card until the suit has been led
  if (isPicker && called && !g.calledSuitLed && !lastTrick) {
    const calledCards = hand.filter(inCalled);
    if (calledCards.length === 1 && g.trick.length > 0 && effSuit(g.trick[0].card) !== called) {
      const filtered = legal.filter((c) => !inCalled(c));
      if (filtered.length) legal = filtered;
    }
  }
  return legal;
}

/* ------------------------------ AI brains ------------------------------ */
export function handStrength(hand) {
  const t = hand.filter(isTrump);
  const q = t.filter((c) => c.rank === "Q").length;
  const j = t.filter((c) => c.rank === "J").length;
  return t.length * 2 + q * 2 + j;
}

export const CALLABLE_SUITS = ["C", "S", "H"];

export function callOptions(hand, buried = []) {
  const fails = { C: [], S: [], H: [] };
  hand.filter((c) => !isTrump(c)).forEach((c) => fails[c.suit]?.push(c));

  // Buried counts as held. Burying the card you were about to call would mean
  // no partner exists while the defenders believe one does.
  const holds = (su, rank) =>
    fails[su].some((c) => c.rank === rank) ||
    buried.some((c) => c.suit === su && c.rank === rank && !isTrump(c));

  // 1. The ordinary call: a fail suit you hold a card in, whose ace you lack.
  const ace = CALLABLE_SUITS
    .filter((su) => fails[su].length > 0 && !holds(su, "A"))
    .map((suit) => ({ kind: "ace", suit, rank: "A" }));
  if (ace.length) return ace;

  // 2. Under. You reach here holding no callable fail card at all, and the two
  //    reasons that can happen want opposite rules — so separate them.
  //
  //    Void in a suit whose ace you lack: there IS an ace to call and a partner
  //    to find, you simply have nothing of the suit to lead it with. Under is
  //    the fix — you designate one of your six cards to stand in for that suit.
  //
  //    Gated on all EIGHT cards, hand plus what you buried, which is the
  //    difference between a rule and a loophole: you must keep a callable card
  //    if you were dealt one. Measured against the six you kept, a picker dealt
  //    two low hearts simply buries them both and calls clubs under instead —
  //    and under, with a card of your choosing standing in, is the better call.
  //    So under is unavailable if ANY ordinary ace call existed before the bury,
  //    including in a suit that is not the one being called.
  const eight = [...hand, ...buried];
  const heldEight = (su, rank) => eight.some((c) => !isTrump(c) && c.suit === su && c.rank === rank);
  const couldHaveCalled = CALLABLE_SUITS.some(
    (su) => eight.some((c) => !isTrump(c) && c.suit === su) && !heldEight(su, "A")
  );
  if (!couldHaveCalled) {
    const under = CALLABLE_SUITS
      .filter((su) => !heldEight(su, "A"))
      .map((suit) => ({ kind: "under", suit, rank: "A" }));
    if (under.length) return under;
  }

  // 3. Holding every fail ace there is no ace left to call, so call a ten.
  //    This is why under comes first and why the two never compete: under
  //    calls a suit whose ace you do not have, and if you hold all three there
  //    is no such suit. Reaching here means every callable suit is one of
  //    yours, and the ten is the only partner left to look for.
  if (CALLABLE_SUITS.every((su) => holds(su, "A"))) {
    return CALLABLE_SUITS
      .filter((su) => fails[su].length > 0 && !holds(su, "10"))
      .map((suit) => ({ kind: "ten", suit, rank: "10" }));
  }

  return [];
}

// A stable number from a set of cards. Used to vary a choice that has no
// strategic basis without giving up determinism — the same hand always answers
// the same way, different hands spread across the options.
function handSeed(cards) {
  let hRaw = 2166136261;
  for (const c of cards) {
    for (const ch of cid(c)) {
      hRaw ^= ch.charCodeAt(0);
      hRaw = Math.imul(hRaw, 16777619);
    }
  }
  return (hRaw >>> 0);
}

/**
 * Which of the six to send under.
 *
 * The card cannot win a trick and it leaves as soon as the called suit is led,
 * so what you want is the card that was going to do the least anyway — and one
 * whose points you can afford, because it still scores for whoever gathers the
 * trick, and the trick will not be yours.
 *
 * Fail before trump, and a Queen or a Jack last of all. The first version
 * scored points ten times heavier than everything else, which reads sensibly
 * and is wrong at exactly the cards that matter: a Queen is three points, so
 * the cheapest card in the hand was routinely the boss trump. Reported from a
 * real hand where the picker held Q♦ Q♠ Q♣ 10♦ A♦ K♥ and sent a Queen under —
 * spending the strongest card on the table to save four points on a King.
 *
 * Power is the thing an under card destroys, not points. The card cannot win a
 * trick and it leaves the hand as soon as the called suit is led, so a Queen
 * sent under is a Queen that never takes anything; the points it carries are
 * the small part. Hence three tiers — fail, plain trump, power trump — and
 * only inside a tier do points decide, since a spare 7 really is worth less
 * than a King. Within the diamonds points and power agree anyway (7 8 9 K 10 A
 * runs the same way both times), so the tiers are what does the work.
 */
export function chooseUnderCard(hand) {
  const tier = (c) => (!isTrump(c) ? 0 : isPowerTrump(c) ? 2 : 1);
  return [...hand]
    .sort((a, b) => tier(a) - tier(b) || cardPts(a) - cardPts(b) || power(a) - power(b))[0] ?? null;
}

// Go it alone on hand for the 4x multiplier instead of calling a partner:
// reserved for hands well above the pick threshold (10) — this is the same
// handStrength() used to decide whether to pick at all, just held to a much
// higher bar since winning 61+ solo against four defenders is a lot harder
// than winning it with a secret partner's help. Module scope because the bury
// consults it too, so that going alone is never something the bury does by
// accident to a hand this far below the bar.
export const ALONE_HANDSTRENGTH = 17;

// When the "Go alone" button is worth putting in front of a human, which is a
// DIFFERENT question from the one above and measured to a different answer.
//
// `ALONE_HANDSTRENGTH` decides what the AI does with a hand it is still holding
// all eight of: it picks the bury to match the plan, banking points instead of
// protecting a call. By the time a human sees the button the bury is already
// spent, so the only thing left to choose is the call — and that is what this
// was measured on. Both arms got the identical deal AND the identical bury,
// differing in nothing but the call, with every seat on the unchanged engine;
// the metric is the picker's own handDelta, which already carries the 4x.
//
// Over 20,239 pickers who had a partner available (6,000 hands x 4 seeds),
// alone minus calling, in points per hand to the picker:
//
//     strength 15   -5.9      alone better on 18.0% of hands
//     strength 16   -4.0                      24.5%
//     strength 17   -1.9                      31.7%     negative in 4 of 4 seeds
//     strength 18   +0.3                      49.7%     positive in 3 of 4 seeds
//     strength 19   +2.5                      68.7%     positive in 4 of 4 seeds
//     strength 20   +4.3                      91.1%
//
// So 18, not 17. At the AI's bar the picker is still giving up about two points
// a hand by declining the partner, consistently across every seed — offering it
// there would be offering a losing move. This is a UI affordance and not a
// rule: the server deliberately does not enforce it, because going alone is
// legal at any strength and a client that wants to do it anyway is only hurting
// itself.
export const ALONE_OFFER_STRENGTH = 18;

// Tolerant of a missing hand on purpose — it answers "should we offer this?",
// and the safe answer when we do not know is no.
export const mayGoAlone = (hand) =>
  Array.isArray(hand) && handStrength(hand) >= ALONE_OFFER_STRENGTH;

// The trump the bury falls back on when the hand holds no fail card at all: a
// diamond below the King, so 7, 8 or 9 — no points, and beaten by every other
// trump in the deck. Buying a partner spends a trump too, but by a different
// rule: there the cheapest diamond the hand holds, whatever it is, since a
// hand with no low diamond should still get to name somebody.
export const SPARE_TRUMP_POWER = 3;

export function aiBuryAndCall(hand) {
  // choose 2 to bury from 8, then a suit to call
  const suitsHeld = (arr) => {
    const m = { C: [], S: [], H: [] };
    arr.forEach((c) => m[c.suit].push(c));
    return m;
  };
  // The shared rule, not a private copy of it. This was a fourth transcription
  // of "which suits may be called", and it only knew about aces — so the AI
  // would have gone alone on every hand where the rules now allow calling
  // under or calling a ten.
  const callable = (arr, buriedSoFar = []) => callOptions(arr, buriedSoFar);

  // Going alone is a decision, and it belongs to the call step below, not to
  // the bury. Reported from a real hand: the picker was dealt one spade, the
  // 10, and every other fail suit was a suit whose ace she held — so spades
  // was her only partner. The bury liked its ten points (10 x 2 = 20 beat the
  // old -8 for killing the call) and she played alone on two Jacks and three
  // diamonds. So keeping a call alive is a constraint, not a term in the score:
  // when some candidate preserves one, no candidate that destroys one is even
  // considered. `protectCall` is that constraint. A hand strong enough to go
  // alone on purpose does not want it — it wants the points, and it is not
  // going to name anybody.
  function buryPass(protectCall) {
    let h = [...hand];
    const fails = () => h.filter((c) => !isTrump(c));
    const buried = [];
    for (let k = 0; k < 2; k++) {
      const f = fails();
      let pool = f.length ? f : h.filter((c) => trumpPower(c) <= SPARE_TRUMP_POWER); // low diamonds as last resort
      if (!pool.length) pool = [...h].sort((a, b) => power(a) - power(b)).slice(0, 1);
      if (protectCall && callable(h, buried).length) {
        const keepsCall = (c) => callable(h.filter((x) => x !== c), [...buried, c]).length > 0;
        let keeps = pool.filter(keepsCall);
        // Nothing in the fail suits can be spared: every fail card left is the
        // last one of the only suit there is to call with. Buying the partner
        // costs a trump, then — the weakest one the hand holds, which is why
        // this sorts by power and not by points. Points buried are points
        // banked, so a diamond costs nothing but its rank; a Queen or a Jack
        // costs a trick, so those are never spent and a hand holding nothing
        // but power trump plays alone as before.
        if (!keeps.length) {
          const spare = h
            .filter((c) => isTrump(c) && !isPowerTrump(c) && keepsCall(c))
            .sort((a, b) => trumpPower(a) - trumpPower(b));
          if (spare.length) keeps = [spare[0]];
        }
        if (keeps.length) pool = keeps;
      }
      // prefer high points. The keepsCall term below only bites on the
      // unprotected pass, since otherwise the pool has already been filtered to
      // candidates that keep a call.
      const scored = pool
        .map((c) => {
          const rest = h.filter((x) => x !== c);
          const keepsCall = callable(rest, [...buried, c]).length > 0 || callable(h, buried).length === 0;
          const m = suitsHeld(fails());
          const shortBonus = !isTrump(c) && m[c.suit].length === 1 && !m[c.suit].some((x) => x.rank === "A") ? -3 : 0;
          return { c, score: cardPts(c) * 2 + (keepsCall ? 4 : -8) + shortBonus + (c.rank === "A" && !isTrump(c) ? 3 : 0) };
        })
        .sort((a, b) => b.score - a.score);
      const pick = scored[0].c;
      buried.push(pick);
      h = h.filter((c) => c !== pick);
    }
    return { buried, hand: h };
  }

  // Which pass to keep can only be decided on the six cards that remain, so
  // bury greedily first and look at the result. v0.32.0 asked the question of
  // all eight instead, on the reasoning that the bury only ever discards fail
  // cards so the number would not move — false for exactly the hands it
  // mattered to. A picker holding a single fail card spends a trump, so the
  // kept six come in two below the eight: hands reading 17 on eight were 15 on
  // six, claimed an alone exemption they had not earned, and went alone with
  // 0.34% of all picks landing there. Asking after the fact costs one more pass
  // and cannot be wrong about it.
  const greedy = buryPass(false);
  const { buried, hand: h } =
    handStrength(greedy.hand) >= ALONE_HANDSTRENGTH ? greedy : buryPass(true);

  const opts = callable(h, buried);
  let call = null;
  let callRank = null;
  let callKind = null;
  const strongEnoughToGoAlone = handStrength(h) >= ALONE_HANDSTRENGTH;
  if (opts.length && !strongEnoughToGoAlone) {
    const m = suitsHeld(h.filter((c) => !isTrump(c)));
    let chosen;

    if (opts[0].kind === "under") {
      // Under is vibes. Every option is a suit you hold nothing in, so the
      // "shortest suit" preference that orders ordinary calls has nothing to
      // sort by — they are all zero — and the sort is stable, so the AI called
      // the same suit every single time. Predictable is worse than arbitrary
      // here: a defender who learns the picker always goes under in clubs
      // knows something they should not.
      //
      // Varied but NOT random: seeded by the hand, so the same cards always
      // produce the same call. That keeps the engine deterministic, which is
      // what lets the A/B harness null-test to exactly 0.0000 and the suites
      // reproduce.
      chosen = opts[handSeed(h) % opts.length];
    } else {
      // Ordinary calls keep the old preference: the fewer cards you hold in
      // the called suit, the sooner your partner is forced to show.
      chosen = [...opts].sort((a, b) => (m[a.suit]?.length || 0) - (m[b.suit]?.length || 0))[0];
    }

    call = chosen.suit;
    callRank = chosen.rank;
    callKind = chosen.kind;
  }
  // An under call is not finished until a card stands in for the suit. Without
  // it the picker is simply exempt from their own call, which is how the first
  // version of this went wrong.
  const underCard = callKind === "under" ? chooseUnderCard(h) : null;
  return { buried, call, callRank, callKind, underCard, hand: h };
}

export function knowsTeammate(g, viewer, target) {
  if (viewer === target) return true;
  const onPickerTeam = (i) => i === g.picker || i === g.partner;
  const viewerOnPicker = onPickerTeam(viewer);
  // viewer knows picker; partner knows self; everyone knows partner after reveal
  const targetKnownPicker = target === g.picker || (g.partnerRevealed && target === g.partner);
  if (viewerOnPicker) {
    if (viewer === g.partner || viewer === g.picker) {
      if (target === g.picker) return true;
      if (viewer === g.partner && target === g.picker) return true;
      if (g.partnerRevealed && target === g.partner) return true;
      if (viewer === g.picker && !g.partnerRevealed) return false; // picker unsure of partner
      return targetKnownPicker;
    }
  }
  // defender: teammates are all non-picker-team players (as far as known)
  if (!viewerOnPicker) return !targetKnownPicker && target !== g.picker;
  return false;
}

/* --------------------- Who is my partner, probably? ---------------------- */

// Use what the table has PROVEN about the partnership (provenSide) instead of
// the three hardcoded ways of knowing it: ace played, alone, or I am the
// partner. Reported from hand 27, where the deduction was sitting right here
// in calledCardCandidates, unused, while a defender overtook his own side.
//
// MEASURED AND NOT SHIPPED. Default off, and the sub-flags are kept so nobody
// has to rebuild this to re-check it. At 20,000 hands x 5 seeds:
//
//   deducePartner (both call sites)  -0.0049, ahead in 0 of 5
//   deduceOpponents (trickSecurity)  -0.0006, ahead in 0 of 5
//   deduceOwner (heuristicCard)      -0.0006, ahead in 0 of 5
//
// and on top of the forcing rule below, either half costs the same ~0.0004:
// +0.0024 alone against +0.0020 with either, +0.0020 with both.
//
// Consistent losses, not noise — and the two halves together cost four times
// what they cost apart. The reason is already written down two screens below,
// in the overtake branch: this engine's defense is tuned around knowsTeammate's
// optimistic default, where an unrevealed seat is a friend. Being RIGHT about
// who the opponent is makes a defender count more opponents, price tricks
// lower, and schmear less — and the 2:1 asymmetry that made speculative
// schmearing worth keeping in 0.9.0 points the same way here. Better
// information, played by a policy calibrated for worse information, loses.
//
// So this is not "the deduction is wrong". It is correct, `belieftest` holds
// it to ground truth, and the forcing rule below depends on knownPartner().
// Acting on it wants the schmear and overtake thresholds re-tuned around it,
// which is a bigger change than the hand that prompted this one.
export const DEDUCE_PARTNER = false;

// Let trickSecurity see that a seat FORCED to follow the called suit cannot
// trump the trick. See forcedPlay. From the same hand: a trick that could not
// be lost priced at 0.05, which suppressed a 4-point schmear and sent a
// defender's Jack over his own partner's winning trump instead.
//
// +0.0021/seat/hand, ahead in 8 of 8 seeds at 20,000 hands per split
// (+0.0024 in 5 of 5 on the first five). The harness null-tests to exactly
// +0.0000 on the same run, which is what makes a number this small readable.
//
// Wider blast radius than it looks — every security estimate in the engine
// goes through trickSecurity, not only the branch the hand came from.
export const FORCED_FOLLOW = true;

// Read a power-trump lead as evidence the seat is on the picker's team, and let
// teammateProbability reweight its candidates by it. See partnerWeight.
//
// Worth nothing on its own (+0.0000, ahead in 0 of 5 seeds) because no branch
// consulted the belief. It is BELIEF_FLOOR below that spends it.
export const TRUMP_LEAD_READ = true;

// Gate the schmear on the PROBABILITY the trick is ours, not on the certainty
// knowsTeammate invents. See the call site in heuristicCard.
//
// MEASURED AND NOT SHIPPED: -0.0028/seat/hand, ahead in 1 of 5 seeds at 20,000
// hands per split. It bans speculative schmearing outright, because with no
// evidence the best a defender can believe is 1 - 1/n and that never reaches
// SCHMEAR_CONFIDENCE. That is the 0.6pp the overtake branch already documents,
// paid again. Kept switchable as the control BELIEF_FLOOR is measured against.
export const BELIEF_SCHMEAR = false;

// Minimum believed chance the trick is ours before points may be paid into it.
// Zero leaves the gate exactly as it was. Unlike BELIEF_SCHMEAR this does not
// touch the uninformed case — 1 - 1/n sits at 0.5 to 0.75 and clears any floor
// worth setting — so it fires only when the read has actual evidence.
//
// +0.0018/seat/hand, ahead in 8 of 8 seeds at 20,000 hands per split. The
// control that makes it readable: this floor with the read TURNED OFF measures
// +0.0000, ahead in 0 of 5 — nothing in the mechanism earns anything, the whole
// gain is the inference. Swept 0.3 / 0.5 / 0.6 at +0.0012 / +0.0017 / +0.0015,
// all ahead in 5 of 5, so the peak is broad and 0.5 is not a knife edge.
export const BELIEF_FLOOR = 0.5;

// Most this seat will pay into a trick whose owner is not proven. `Infinity`
// leaves speculative schmearing exactly as it was; 4 permits a King but not a
// Ten or an Ace. Reported from hand 1: two defenders each spent an eleven on a
// two-in-three guess and both guessed wrong.
//
// MEASURED AND NOT SHIPPED at 4: -0.0022/seat/hand, ahead in 0 of 5. Capping by
// the CARD is the wrong axis — it gives up the fat schmears that pay whenever
// the trick really is ours, to avoid the ones that do not, without ever asking
// which case this is. BELIEF_FLOOR asks. Left switchable, default off.
export const SPECULATIVE_SCHMEAR_MAX = Infinity;

// Which seats could still be holding the called card, as far as `viewer` can
// tell. Deduction only — every exclusion below is a fact, not a read.
//
// The engine's own rules do most of the work. `legalPlays` forces the partner
// to play the called card the first time that suit is led, and forbids leading
// that suit with anything else, so a called-suit lead settles the question
// inside the same trick. The interesting case is the one where it settles it
// *negatively*: if the suit is led and the card never appears, every seat that
// followed or showed void is excluded, and the table has just learned the
// picker is effectively alone without anyone announcing it.
//
// Returns [] when nobody can hold it (alone, declared or deduced), and a
// single seat once it is known. Never excludes the seat that actually holds
// it — `belieftest` asserts that invariant on every decision it sees.
export function calledCardCandidates(g, viewer) {
  if (!g.calledSuit) return [];
  const rank = g.calledRank || "A";
  const isCalled = (c) => c.suit === g.calledSuit && c.rank === rank && !isTrump(c);

  const tricks = [...(g.trickHistory || []).map((th) => th.trick), g.trick];

  // Already on the table: everyone saw who played it.
  for (const t of tricks) for (const pl of t || []) if (isCalled(pl.card)) return [pl.player];

  // Led that suit and it did not appear -> nobody in that trick holds it.
  // effSuit returns "T" for trump, so this can only match a fail lead. The
  // picker's under card is stored physically, so an under lead is missed here
  // rather than mis-read: a deduction we fail to make, never a wrong one.
  const out = new Set();
  for (const t of tricks) {
    if (!t || !t.length || effSuit(t[0].card) !== g.calledSuit) continue;
    for (const pl of t) out.add(pl.player);
  }

  const cands = [];
  for (let p = 0; p < 5; p++) {
    if (p === g.picker) continue;              // never calls a card it holds
    if (out.has(p)) continue;
    if (p === viewer) {
      // The one seat whose hand this viewer can read.
      if (g.hands[viewer]?.some(isCalled)) return [viewer];
      continue;
    }
    cands.push(p);
  }
  return cands;
}

// The partner's seat as `viewer` can PROVE it, or null when they cannot yet.
//
// Three ways it is settled, in increasing order of how easy they are to miss:
// the ace has been played and everyone saw it; the viewer holds the ace and so
// is the partner; or `calledCardCandidates` has eliminated every seat but one.
// The third is the interesting one, because it can settle mid-trick — before
// the ace is on the table — and the play code used to ignore it entirely.
//
// Reported from a real hand (27, trick 2): clubs called, clubs led for the
// first time, the leader played a low club rather than the ace, and the next
// seat trumped in and was therefore void. That leaves one candidate, and the
// deduction was already available here; nothing asked for it.
export function knownPartner(g, viewer) {
  if (g.partner === null || !g.calledSuit) return null;   // no partner exists
  if (g.partnerRevealed) return g.partner;
  if (viewer === g.partner) return viewer;
  const cands = calledCardCandidates(g, viewer);
  return cands.length === 1 ? cands[0] : null;
}

// Is `target` on `viewer`'s side? true / false when it is PROVEN, null when the
// table genuinely has not settled it.
//
// This is the third of three answers to the same question, and the distinction
// between them is the whole point. knowsTeammate() answers optimistically and
// is wrong by construction (see teammateProbability's comment). This one
// answers only when it can, which is what any branch that spends a card on a
// teammate's trick actually needs — "should I fight this seat" and "may I pay
// this seat" are different questions and want different defaults.
export function provenSide(g, viewer, target) {
  if (viewer === target) return true;
  // Alone: the picker stands by themselves and there is nothing to deduce.
  // Note this also swallows the case where a called ace found nobody, which
  // is NOT public until the suit is led. Left as-is deliberately — the
  // certainty test this replaces made the same assumption, and tightening it
  // is a separate change wanting its own measurement.
  if (g.partner === null) return (viewer === g.picker) === (target === g.picker);

  const kp = knownPartner(g, viewer);
  if (kp === null) return null;
  const onPickerTeam = (p) => p === g.picker || p === kp;
  return onPickerTeam(viewer) === onPickerTeam(target);
}

/* ------------- Behavioural evidence about who the partner is -------------- */
// Everything above this line is deduction — each exclusion is a fact. This is
// inference: what a seat's CHOICES say about which side they are on, given that
// the whole table is running one book and that book splits hard on side.
//
// The signal worth acting on is the trump lead. heuristicCard's leading branch:
//
//   picker's team   leads trump whenever it holds ANY, top-first when the top
//                   can plausibly hold the trick. Pulling trump is the plan —
//                   0.20.0 measured that rule as right much further down into
//                   weak holdings than the engine used to believe.
//   defenders       lead fail: an off-ace first, then the cheapest non-called
//                   fail. They reach for trump ONLY holding nothing else, and
//                   then the WEAKEST trump they have.
//
// So a seat that opens a trick with a Queen or a Jack is playing the picker's
// book almost by construction — the only defender path to a trump lead plays
// the weakest trump held, and a Queen is the weakest trump held only on a hand
// of nothing but Queens.
//
// Reported from hand 1: a defender won trick 1 with Q-clubs and led Q-hearts
// into trick 2, and BOTH remaining defenders read that seat as a teammate and
// schmeared an Ace onto it — 22 points handed to the picker's partner on one
// trick, in a hand that finished 120-0.
// CALIBRATED, not guessed. `belieftest` buckets every judgement by what the
// belief predicted and checks it against ground truth, so this constant is
// swept until the buckets come out honest. At 1,500 hands per point, the
// error on the two buckets the read actually moves:
//
//    8   4.4pp / 8.1pp        25   1.8pp / 3.8pp
//   12   3.6pp / 6.1pp        32   0.9pp / 1.9pp
//   16   2.5pp / 5.5pp        40   0.7pp / 1.4pp
//   20   2.1pp / 4.4pp        64   0.2pp / 0.5pp
//
// Monotonic all the way up, which is the finding: a seat that opens with a
// Queen or a Jack is on the picker's team about 98% of the time, so the honest
// number here is "nearly certain" rather than "somewhat more likely".
//
// Set at 40 rather than the flattest point on purpose. The calibration is
// measured in SELF-PLAY, where every seat runs this file's own book, and it is
// that book that makes a defender's power-trump lead nearly impossible. A human
// defender is off-book and will do it more often than an AI one, so the extra
// certainty at 64+ is buying accuracy against opponents this engine will not
// always face. 40 clears every gate that reads it with room to spare.
export const TRUMP_LEAD_ODDS = 40;

// The same read for a trump that is NOT a Queen or a Jack. Weaker on purpose:
// a defender's one legitimate route to leading trump is dumping its weakest
// trump, and that is usually a low diamond, so this is the muddy case the
// power-trump rule deliberately stayed out of.
//
// It is not mud, though. Measured over 6,000 self-play hands, of every trick
// opened by a NON-PICKER:
//
//   power trump (Q/J)   2908 leads   the partner 75.2% of the time
//   plain trump         1279 leads   the partner 60.4%
//   fail                13538 leads  the partner 12.8%
//                                    (base rate for "is the partner" is 25%)
//
// So a plain trump lead is real evidence — about 4.6:1 against the base rate,
// where a power lead is about 9:1 — and shipping it at 1 was leaving it on the
// floor. Reported by beta testers, who described the rule as "a non-picker
// leading TRUMP is almost certainly the partner" and were describing something
// broader than what 0.37.0 actually implemented.
//
// MEASURED AND NOT SHIPPED, default 1 (off). Swept at 2 / 3 / 5 / 8, every one
// of them +0.0000 to +0.0001 per seat per hand, ahead in 0 to 1 of 5 seeds. The
// inference is real; it is simply almost never ACTIONABLE. The gate it feeds is
// the schmear, which only exists as a decision when the leader is still holding
// the trick, and:
//
//   power trump lead   still won the trick 41.1%   (n=2989)
//   plain trump lead   still won the trick  9.4%   (n=1254)
//
// A low trump lead gets overtrumped nine times in ten, so there is no trick of
// the leader's to schmear into and nothing for the read to change. It also cost
// a calibration bucket at every weight above 1. Left switchable for the day
// something else consults the belief in a spot a losing lead still matters.
export const PLAIN_TRUMP_LEAD_ODDS = 1;

// The strongest trump lead this seat has opened a trick with: "power" for a
// Queen or a Jack, "plain" for any other trump, null for neither.
//
// Strongest, not a product. Repeat leads from one seat are not independent
// evidence — it is the same seat with the same hand and the same plan — and
// multiplying would put a three-time leader past any odds this can be
// calibrated to. The under card is recorded by its FACE (the 6 of the called
// suit, a fail card), so an under lead cannot be misread as trump here.
function trumpLeadKind(g, seat) {
  const tricks = [...(g.trickHistory || []).map((th) => th.trick), g.trick];
  let kind = null;
  for (const t of tricks) {
    if (!t?.length || t[0].player !== seat) continue;
    const c = t[0].card;
    if (!isTrump(c)) continue;
    if (isPowerTrump(c)) return "power";
    kind = "plain";
  }
  return kind;
}

// How much more likely this seat is to be the partner than a seat we know
// nothing about. A weight, not a probability — normalised across candidates
// below, which is what keeps the result a distribution and therefore testable
// against ground truth (`belieftest` asserts calibration per bucket).
function partnerWeight(g, seat, opts = {}) {
  if (!(opts.trumpLeadRead ?? TRUMP_LEAD_READ)) return 1;
  const kind = trumpLeadKind(g, seat);
  if (kind === "power") return opts.trumpLeadOdds ?? TRUMP_LEAD_ODDS;
  if (kind === "plain") return opts.plainTrumpLeadOdds ?? PLAIN_TRUMP_LEAD_ODDS;
  return 1;
}

// How likely `target` is on `viewer`'s side, in [0,1].
//
// This is the calibrated version of knowsTeammate(), which answers the same
// question with a hard 1 or 0 and is wrong in both directions by construction:
// it tells a defender every unrevealed seat is a teammate (really about two in
// three) and tells the picker no seat is (really about one in four, since the
// partner is one of the four other seats).
export function teammateProbability(g, viewer, target, opts = {}) {
  if (viewer === target) return 1;

  // Once the partnership is revealed it is public, so answer from it and skip
  // the inference entirely. In real play this agrees with the deduction below
  // by construction — partnerRevealed is set only when the partner plays the
  // called card — but it is cheaper, and it keeps the answer anchored to the
  // state's own account of who the partner is rather than re-deriving it.
  if (g.partnerRevealed && g.partner !== null) {
    const onTeam = (p) => p === g.picker || p === g.partner;
    return onTeam(viewer) === onTeam(target) ? 1 : 0;
  }

  const cands = calledCardCandidates(g, viewer);

  // Alone, declared or deduced: the picker stands by itself.
  if (!g.calledSuit || cands.length === 0) {
    if (viewer === g.picker) return 0;
    return target === g.picker ? 0 : 1;
  }

  // Settled: fall through to certainty rather than a probability.
  if (cands.length === 1) {
    const onPickerTeam = (p) => p === g.picker || p === cands[0];
    return onPickerTeam(viewer) === onPickerTeam(target) ? 1 : 0;
  }

  // Uniform over the candidates, then reweighted by how each of them has
  // PLAYED. With no evidence every weight is 1 and this is the old 1/n.
  const weights = cands.map((p) => partnerWeight(g, p, opts));
  const total = weights.reduce((a, b) => a + b, 0);
  const at = cands.indexOf(target);
  const pPartner = at === -1 ? 0 : weights[at] / total;

  if (viewer === g.picker) return pPartner;   // the picker's only teammate IS the partner
  if (target === g.picker) return 0;          // and a defender knows the picker
  return 1 - pPartner;                        // otherwise a teammate unless they are the partner
}

/* ------------------- How safe is the trick, really? --------------------- */
// A schmear is a bet, not a gift: the points go to whoever actually ends up
// taking the trick. Up to 0.11.x the AI decided this by looking at the rank of
// the winning card ("is it a Jack or better?"), which is the wrong question. It
// misses the case that settles most real schmears — that the danger isn't a
// card at all, it's a *seat*. Once every opponent has already played, the trick
// cannot move, whatever is winning it.
//
// Returns the probability the seat currently winning still has it once the
// trick is complete, from `viewer`'s point of view. Two cases collapse to
// certainty and cover most hands:
//   - no opponent is left to act, so nobody who could take it still can;
//   - nothing that beats the winning card is unaccounted for.
// Otherwise it's the chance that none of the cards which beat the winner is
// sitting in the hands of the opponents still to act — hypergeometric over the
// cards this seat cannot see (the other hands plus the buried pair).
//
// Deliberately conservative in one direction: a beater only threatens the trick
// if its holder is allowed to play it, and when a fail suit is led a defender
// holding trump usually is not. Counting those anyway overstates the danger,
// which costs a schmear that would have been fine. The opposite error pays
// points to the picker, so the bias points the right way.
// Seats still to play that could take this trick off us.
//
// The teammate test here is the optimistic one, which means a defender counts
// the picker's partner as a friend and reads the trick as safer than it is.
// `deducePartner` swaps in provenSide, which keeps the same optimistic default
// for the genuinely-unknown seats but stops calling a PROVEN opponent a
// teammate. Without this, the forcing rule below can never see the partner at
// all — they are not in the list it filters.
export function opponentsYetToAct(g, viewer, opts = {}) {
  const acted = new Set(g.trick.map((t) => t.player));
  const deduce = opts.deduceOpponents ?? opts.deducePartner ?? DEDUCE_PARTNER;
  const out = [];
  for (let p = 0; p < 5; p++) {
    if (p === viewer || acted.has(p)) continue;
    const proven = deduce ? provenSide(g, viewer, p) : null;
    if (!(proven ?? knowsTeammate(g, viewer, p))) out.push(p);
  }
  return out;
}

// Everything this seat genuinely cannot place: not yet played, not in hand,
// and — for the picker, who chose them — not in the burial. Every "what could
// still beat this" question in the AI resolves to this one list, so they all
// stay honest about the same information at the same time.
//
// The burial matters more than its two cards suggest. The picker buries from
// eight and often buries a fail Ace to void a suit, so "is my Jack the boss of
// what's left" is a question the picker can frequently answer exactly and every
// other seat can only estimate. Leaving it out made the picker reason as if
// their own discards were still in play.
export function unaccountedFor(g, viewer) {
  const seen = new Set([...seenCards(g), ...g.hands[viewer]].map(cid));
  if (viewer === g.picker) for (const c of g.buried) seen.add(cid(c));
  return ALL_CARDS.filter((c) => !seen.has(cid(c)));
}

// How many unaccounted-for cards outrank this one — i.e. could beat it in a
// trick it led. Zero means it is boss of everything that remains.
//
// This is deliberately asked about the card, not about the trick in front of
// it. Two cards that lose the current trick are not therefore equivalent: the
// question that decides which one to keep is which of them can still win a
// LATER trick, and that is what this measures.
export function cardEquity(g, viewer, card, unseen = unaccountedFor(g, viewer)) {
  const LEAD = -98, RIVAL = -99;
  return unseen.filter(
    (c) => trickWinner([{ player: LEAD, card }, { player: RIVAL, card: c }]) === RIVAL,
  ).length;
}

// Which card to part with when this trick is not ours to take with.
//
// Cards are bucketed by equity FIRST and points allocated only inside the
// weakest bucket. That ordering is the whole fix: a 2-point Jack that is boss
// of the remaining trump is worth vastly more than an 11-point Ace that cannot
// win another trick, and a bare minimum-points rule sheds exactly backwards in
// that spot. Reported from a hand where a defender under an unbeatable Queen
// held J-spades — provably the highest trump left — and threw it to keep a dead
// A-diamonds; the picker swept 44 two tricks later on a trick J-spades wins.
//
// `wantPoints` inverts the allocation for the case where our own side is taking
// the trick, where the points are banked rather than donated. Same rule, one
// sign — which is why it lives in one function.
//
// Inside a class the ordering is not raw points: it is the trump principle
// 0.8.0 and 0.12.0 already measured, now applied within the class instead of
// only on the schmear branch. Fail points go first, because trump takes later
// tricks. Then fat trump, because every point living in trump lives in the
// diamonds while all the power lives in the Queens and Jacks — spending the fat
// diamond banks more AND keeps the stronger card. Power trump is parted with
// last and weakest-first. Without that ordering the class rule would happily
// throw a Queen for one point over a Jack, which is the mistake 0.8.0 fixed.
function shedCard(g, idx, legal, wantPoints, opts = {}) {
  const unseen = unaccountedFor(g, idx);

  // MEASURED AND REJECTED — kept as a switch so nobody has to rebuild it to
  // re-check. The argument was: when the trick is NOT ours the only question
  // is how few points cross the table, so shed the cheapest card and use
  // deadness merely as a tiebreak. It came from a real hand where a defender
  // holding 10♣ (dead — the ace and three trump beat it), 8♥ (worthless) and
  // J♥ shed the TEN into a trick his side had a 12% chance of holding, and his
  // side then won both remaining tricks, so the ten was bankable at home. It
  // cost 10 points, double-dummy.
  //
  // It is still the wrong rule: -0.0278/seat/hand, behind in 3 of 3 seeds at
  // 5,000 hands per split (scripts/abtest.mjs). A dead card is going to be
  // captured whatever happens, so choosing WHEN to let it go is worth more
  // than the points saved on any one trick — and holding live cards to shed
  // later is what costs the tricks. That hand is a good policy losing, not a
  // bad policy showing.
  if (!wantPoints && opts.shedCheapestWhenLosing) {
    return [...legal].sort(
      (a, b) =>
        cardPts(a) - cardPts(b) ||
        cardEquity(g, idx, b, unseen) - cardEquity(g, idx, a, unseen) ||
        power(a) - power(b),
    )[0];
  }

  const scored = legal.map((card) => ({ card, equity: cardEquity(g, idx, card, unseen) }));
  const deadest = Math.max(...scored.map((s) => s.equity));
  const cls = scored.filter((s) => s.equity === deadest).map((s) => s.card);

  const fattest = (cards) => [...cards].sort((a, b) => cardPts(b) - cardPts(a) || power(a) - power(b))[0];
  if (wantPoints) {
    const fail = cls.filter((c) => !isTrump(c) && cardPts(c) > 0);
    if (fail.length) return fattest(fail);
    const fat = cls.filter((c) => isTrump(c) && !isPowerTrump(c));
    if (fat.length) return fattest(fat);
  }
  return [...cls].sort((a, b) => cardPts(a) - cardPts(b) || power(a) - power(b))[0];
}

/**
 * What the rules FORCE a seat yet to act to play, as far as `viewer` can prove.
 * Returns {card} when the exact card is determined, {suit} when only the suit
 * is, and null when the seat is free to choose.
 *
 * Everything here is a rule, not a read. Two of them, both live only on the
 * FIRST lead of the called suit:
 *
 *   - the partner must play the called card then (legalPlays), which pins them
 *     to one card once `knownPartner` can name them;
 *   - the picker must still be holding a called-suit card, because legalPlays
 *     forbids discarding the last one until the suit has been led — so they can
 *     follow, and therefore must. This one is public from the call itself.
 *
 * `g.calledSuitLed` cannot answer "is this the first lead of it", because
 * applyPlay sets it as soon as the card lands and it is already true by the
 * time anyone follows. The resolved tricks can.
 */
function forcedPlay(g, viewer, seat) {
  if (!g.calledSuit || !g.trick.length) return null;
  if (effSuit(g.trick[0].card) !== g.calledSuit) return null;

  const ledBefore = (g.trickHistory || []).some(
    (th) => th.trick?.length && effSuit(th.trick[0].card) === g.calledSuit,
  );
  if (ledBefore) return null;

  if (!g.calledAcePlayed && seat === knownPartner(g, viewer)) {
    return { card: { rank: g.calledRank || "A", suit: g.calledSuit } };
  }
  // Called under, the picker holds no real card of the suit — the stand-in is
  // the only thing they can follow with, so that seat is pinned exactly too.
  if (seat === g.picker) {
    return g.calledUnder
      ? { card: { rank: UNDER_RANK, suit: g.calledSuit } }
      : { suit: g.calledSuit };
  }
  return null;
}

// Can ANY card of this fail suit take the trick as it stands? Diamonds are all
// trump, so a "must follow diamonds" has no fail cards to be harmless with —
// the called suit is never diamonds, but the guard keeps that assumption local.
function suitIsHarmless(suit, takesIt) {
  if (suit === "D") return false;
  return !RANKS.some((rank) => {
    const c = { rank, suit };
    return !isTrump(c) && takesIt(c);
  });
}

export function trickSecurity(g, viewer, opts = {}) {
  if (!g.trick.length) return 1;

  // Would this card take the trick if it were played into it now?
  const SENTINEL = -99;
  const takesIt = (card) => trickWinner([...g.trick, { player: SENTINEL, card }]) === SENTINEL;

  const unseen = unaccountedFor(g, viewer);

  // Priced against every exit, not just the last one. The count below can
  // reach "certain" three separate ways, and the case this exists for takes
  // the very first of them: a defender with no KNOWN opponent left to act
  // returns 1.0 without ever looking at a card.
  const acePrice = opts.priceCalledAce === false ? 1 : calledAceRisk(g, viewer, takesIt, unseen);

  const opps = opponentsYetToAct(g, viewer, opts);
  if (!opps.length) return acePrice;

  // Seats the rules have already decided for. A seat that MUST follow the
  // called suit cannot trump, so it cannot take a trick a trump is winning —
  // and the count below, which prices every unseen card as reachable by every
  // seat still to act, has no way to see that. Reported from hand 27: a trick
  // where both remaining seats were pinned (the picker forced to follow clubs,
  // the partner forced to lay the called ace) priced at 0.05 when it was in
  // fact unloseable, and a defender spent a Jack overtaking his own side.
  let forcedTakes = false;
  const free = (opts.forcedFollow ?? FORCED_FOLLOW) === false ? opps : opps.filter((p) => {
    const f = forcedPlay(g, viewer, p);
    if (!f) return true;
    if (f.card) {
      if (takesIt(f.card)) forcedTakes = true;
      return false;
    }
    return !suitIsHarmless(f.suit, takesIt);
  });
  // Pinned to a card that beats what's down: not a probability, a certainty.
  if (forcedTakes) return 0;
  if (!free.length) return acePrice;

  const beaters = unseen.filter(takesIt).length;
  if (!beaters) return acePrice;

  // How many unknown cards those opponents hold between them.
  const k = free.reduce((s, p) => s + g.hands[p].length, 0);
  if (!k) return acePrice;
  if (beaters + k > unseen.length) return 0;

  let safe = 1;
  for (let i = 0; i < k; i++) safe *= (unseen.length - beaters - i) / (unseen.length - i);
  return safe * acePrice;
}

/**
 * The chance the called ace is NOT sitting in a hand still to play — from a
 * defender's point of view, and only while it would take the trick.
 *
 * This is the hole the ordinary count cannot see. `opponentsYetToAct` asks
 * knowsTeammate(), which calls every unrevealed seat a teammate, so a defender
 * with no *known* opponent left to act reads the trick as certain — security
 * 1.0 — and schmears into it. But one of those "teammates" is the picker's
 * partner, and the one card that partner is guaranteed to hold is the called
 * ace. Reported from a real hand: clubs led and the club ace still out, a
 * defender laid the ten of hearts on his own side's king, and the partner took
 * all of it with the ace two seats later. A 42-point swing, and it decided the
 * hand.
 *
 * Narrow on purpose. The called ace is the only card whose existence is public
 * — it was named at the call — and whose owner is known to be an opponent of
 * the defenders. Everything else a defender might fear is a guess, and this
 * file already records what applying that brake on a guess costs: 0.6pp to the
 * defense. So this prices exactly one card, and only when it beats what is
 * already down.
 */
function calledAceRisk(g, viewer, takesIt, unseen) {
  if (!g.calledSuit || g.calledAcePlayed) return 1;
  // The picker and the partner both want the called ace to land — it is their
  // own side taking the trick. Only the defense is hurt by it.
  if (viewer === g.picker || viewer === g.partner) return 1;

  const ace = { rank: g.calledRank || "A", suit: g.calledSuit };
  // Not in `unseen` means the viewer holds it or has already seen it fall.
  if (!unseen.some((c) => c.rank === ace.rank && c.suit === ace.suit)) return 1;
  if (!takesIt(ace)) return 1;

  const acted = new Set(g.trick.map((t) => t.player));
  let held = 0;
  for (let p = 0; p < 5; p++) {
    if (p !== viewer && !acted.has(p)) held += g.hands[p].length;
  }
  if (!held) return 1;

  // Uniform over what the viewer cannot account for: the ace is as likely to be
  // in any unseen card's place as any other.
  return Math.max(0, 1 - held / unseen.length);
}

// What the trick's security becomes if `idx` plays `card` into it — i.e. the
// chance that whoever is winning *after* that card lands still has it at the
// end. Comparing this against the security of leaving the trick alone is how
// the AI decides whether taking a trick off its own side actually buys
// anything.
export function securityAfterPlay(g, idx, card, opts = {}) {
  const next = {
    ...g,
    trick: [...g.trick, { player: idx, card }],
    hands: g.hands.map((h, i) => (i === idx ? h.filter((c) => cid(c) !== cid(card)) : h)),
  };
  return trickSecurity(next, idx, opts);
}

/* ------------------------- Endgame exact solver ------------------------- */
// With 2 tricks (<=2 cards per hand) left, the remaining game tree is tiny —
// at most 2 legal cards per player per decision, 10 decisions total, so it's
// cheap to solve exactly by minimax instead of leaning on heuristics right
// when the last tricks (which most often decide whether the picker's team
// crosses 61) are being played. Both "sides" (picker+partner vs. defenders)
// are treated as a single coalition maximizing/minimizing their own team's
// total trick points; buried points are a fixed offset already banked
// before this window, so they don't affect which move is optimal here.
export function pickerTeamOf(g) {
  return g.partner !== null ? [g.picker, g.partner] : [g.picker];
}

function endgameValue(g) {
  if (g.phase === "handEnd") {
    return pickerTeamOf(g).reduce((s, p) => s + g.ptsTaken[p], 0);
  }
  if (g.trick.length === 5) {
    return endgameValue(resolveTrick(g));
  }
  const idx = g.turn;
  const isPickerSide = pickerTeamOf(g).includes(idx);
  const legal = legalPlays(g, idx);
  let best = isPickerSide ? -Infinity : Infinity;
  for (const card of legal) {
    const val = endgameValue(applyPlay(g, idx, card));
    if (isPickerSide ? val > best : val < best) best = val;
  }
  return best;
}

// Exact play for the last two tricks — but exact *double-dummy*, which is a
// different thing from correct. This function reads every seat's hand, so it
// answers "what is best if you could see the cards", and the seat playing
// cannot. That gap is invisible while one card is strictly best, and it is the
// whole game once several tie.
//
// Ties are not an edge case: measured over 4,000 hands, 69% of endgame
// decisions have more than one double-dummy-optimal card. The old code took
// `legal[0]` — sorted-hand order, so trump first — and that arbitrary
// tie-break disagreed with the heuristics on 32% of endgame decisions.
//
// Reported from expert play: a defender holding Q-hearts and 9-hearts, with
// his own partner already winning the trick and only a fellow defender left to
// act, played the Queen. Double-dummy the two cards are identical — the hand
// finishes 70-50 either way — so the solver took the first. Enumerating the
// 144 deals of the seven cards that seat could not place says otherwise: the
// 9 wins the hand in 144 of 144, the Queen in 59. It spent boss trump and gave
// up guaranteed control of the last trick for a 3-point schmear onto a trick
// its side had already locked. It only worked because one specific unseen card
// sat in the right hand.
//
// So: keep the exact solve for *how good* each card is, and when it can't
// separate them, hand the choice back to the heuristics, which reason from
// what this seat actually knows (`cardEquity` had the Queen at 0 — boss of
// everything unaccounted for — and would have played the 9). Search decides
// what wins; judgement decides between things that tie.
export function solveEndgameCard(g, opts = {}) {
  const idx = g.turn;
  const legal = legalPlays(g, idx);
  if (legal.length <= 1) return legal[0];
  const isPickerSide = pickerTeamOf(g).includes(idx);
  let bestVal = isPickerSide ? -Infinity : Infinity;
  let optimal = [];
  for (const card of legal) {
    const val = endgameValue(applyPlay(g, idx, card));
    if (val === bestVal) {
      optimal.push(card);
    } else if (isPickerSide ? val > bestVal : val < bestVal) {
      bestVal = val;
      optimal = [card];
    }
  }
  if (optimal.length === 1) return optimal[0];
  // Every card here is worth exactly the same double-dummy, so restricting the
  // heuristics to this set cannot cost anything the solver could see. The
  // guard is for the case where a heuristic branch returns something outside
  // the set it was given — that would be a bug, not a preference, and falling
  // back keeps this function's contract (always a double-dummy-optimal card).
  const pick = heuristicCard(g, idx, { ...opts, restrictTo: optimal });
  return optimal.some((c) => cid(c) === cid(pick)) ? pick : optimal[0];
}

// How sure the AI wants to be that our side keeps the trick before paying
// points into it.
//
// Swept 0.50 / 0.65 / 0.75 / 0.85 / 0.95 over 3x200,000 hands each and the
// aggregate could not tell them apart — every value landed inside the others'
// run-to-run spread. That is not because the number is inert: 41.5% of security
// evaluations come back strictly between 0 and 1. It's that in most of those
// middle cases there is nothing pointy in hand to schmear, so both branches
// play the same card anyway.
//
// So this is set on principle, not on a measurement that distinguished it. The
// error is asymmetric: schmearing into a trick we lose hands points straight to
// the picker, while declining a schmear we'd have won only defers points we
// usually still get a chance to bank. Erring toward confidence is the cheaper
// mistake. Worth revisiting if a real hand shows the AI passing up good
// schmears rather than making bad ones.
export const SCHMEAR_CONFIDENCE = 0.85;

// How much safer taking a trick off our own side has to make it before it's
// worth the card.
//
// Swept and left alone. 0.08 / 0.12 / 0.20 / 0.30 all land inside the noise:
// 0.12 looked like +0.0013 ahead in 3 of 3 seeds at 3,000 hands per split and
// evaporated to -0.0004, ahead in 2 of 5, at 9,000 x 5. Worth recording
// because a real hand landed at a gain of 0.147 against this 0.150 gate and
// the near-miss looks like evidence the number is wrong. It isn't: the curve
// is flat here, and three thousandths either way buys nothing. Reported from expert play: the partner led Q-hearts, the
// picker overtook with Q-spades, and Q-clubs took it anyway. From the picker's
// seat Q-hearts and Q-spades were beaten by exactly the same one outstanding
// card, so the overtake bought nothing at all — it just moved the trick from
// his partner's third-best trump onto his own second-best, and lost both.
export const OVERTAKE_MIN_GAIN = 0.15;

// Minimum believed chance the trick is already ours before the overtake brake
// above applies WITHOUT proof. Above 1 disables it.
//
// This is the largest single AI gain measured in a while, and it took two
// harnesses to see it honestly, because they disagreed:
//
//   abtest (variant in ONE seat, four unchanged)   +0.0128/seat/hand, 8 of 8
//   simulate (all five seats, UNPAIRED)            looked like -0.6pp for the
//                                                  defence, matching the note
//                                                  in the branch below
//
// The comment in that branch records exactly that 0.6pp, from a 3x200,000-hand
// run, as the reason this brake was gated on certainty in the first place. So
// the disagreement had to be settled rather than voted on: scripts/coalitiontest
// deals identical hands to both arms and applies the variant to EVERY DEFENDER,
// which is the only way to ask whether the SIDE gains. Paired, 12,000 hands x 5
// seeds, as a change in the picker's win rate on partnered hands:
//
//   null control            0.00pp   defenders better in 0 of 5
//   floor 0.0 (no belief)  -0.53pp   defenders better in 5 of 5
//   floor 0.6              -0.74pp   defenders better in 5 of 5
//   floor 0.66             -0.87pp   defenders better in 5 of 5
//
// Defenders GAIN, consistently, and the unpaired simulate reading was noise —
// 3,000 unpaired hands against a ~1pp standard error on the difference. Worth
// remembering the next time a single simulate run seems to say something.
//
// The floor earns its place here in a way abtest could barely see (+0.0122 at
// 0.0 against +0.0128 at 0.3): standing down for a seat that is actually the
// picker's partner is exactly the mistake, and only the belief knows which
// "teammate" that is. The gain from consulting it is about half again as much.
//
// 0.6 rather than 0.66 purely to keep off the boundary — the uninformed value
// with three candidates is 1 - 1/3, and a threshold sitting on it is a rounding
// accident waiting to happen. Both accept three-or-more candidates and reject
// the two-candidate coin flip, which is the behaviour intended.
export const OVERTAKE_BELIEF_FLOOR = 0.6;

// How fat a trick the picker will hand over rather than spend boss trump on
// it. Above this she takes it; at or below, a free duck is the better card.
//
// A trick averages 20 points (120 over six), and the boss trump she keeps back
// will take one of the later ones, so the honest comparison is "this trick
// against an average one". Set below that average rather than at it, because
// she does not get to choose which later trick she takes — only that she takes
// one. Move it in response to a reported hand, not a sweep: the two values
// either side of it were inside the noise on 3x9,000 duplicate deals.
export const DUCK_MAX_TRICK_POINTS = 12;

// When a schmear may spend the second-fattest card instead of the fattest.
//
// Reported from a real hand (2026-07-29, hand 6). A defender void in trump sat
// behind her partner's winning Q-diamonds holding A-clubs, 10-hearts, 10-spades
// and 9-clubs, with hearts the called suit and the called A-hearts therefore
// known to sit in the picker's partner's hand. Sorting by card points alone
// schmeared the Ace for being one point fatter — but the Ace was boss of clubs
// with a single trump outstanding, a trick she still owned, while the ten of
// the called suit was a guaranteed donation the moment hearts was led. Which
// is what happened on the very next trick. It cost 4 points, double-dummy.
//
// The obvious generalisation is wrong, and was measured to be wrong before
// this narrower one was written. Discounting each candidate's points by its
// `cardEquity` and schmearing the largest product costs -0.0005/seat/hand
// (ahead in 1 of 5 seeds, 10,000 hands per split, against the pre-0.36 engine)
// and loses 0.311 points per disagreeing decision against the exact solver on
// the same baseline. The reason is visible in the
// hands it changes: a product lets a cheap exposed card outrank a fat safe one
// — it threw a King (4 points, equity 3) over an Ace (11 points, equity 1),
// because 12 > 11 — and a certain eleven now beats a speculative eleven later
// by more than the risk model gives back. Points-first is right; it is the
// near-tie at the top that it gets wrong.
//
// So the correction only fires where the measurement says it belongs: the
// fattest card must be nearly boss, meaning it genuinely expects to take a
// trick of its own rather than being trumped out of one, and the substitute
// must be within SCHMEAR_POINT_SLACK of it. In practice that is the Ace-versus-
// Ten choice with the trump nearly spent, and nothing else.
//
// Measured against 0.39.1, which is not the engine it was originally tuned on
// — and that matters enough to record. On the pre-0.36 engine this was
// +0.0003/seat/hand ahead in 7 of 8 seeds. The belief work in 0.36-0.39 put a
// probability gate in front of the whole schmear branch, and re-measuring
// afterwards halves it: +0.0001 ahead in 7 of 10 seeds at 60,000 hands per
// split, with the mirrored run (old rule in one seat against four new) at
// -0.0001, behind in 10 of 10. Both directions still lean the same way, and
// the null test resolves to exactly +0.0000, which is what makes a number this
// small readable at all — but it is now a sign, not a magnitude, and a future
// change to the gating could take it to zero. Re-measure rather than trusting
// this line.
//
// This pair is still the best of the four alternatives swept beside it, at
// 25,000 hands x 8 seeds each: keep-equity 0 is +0.0001 in 5 of 8, keep-equity
// 2 is -0.0000 in 3 of 8, point-slack 2 is +0.0001 in 6 of 8, point-slack 4 is
// +0.0001 in 5 of 8. The margins between them are thin.
//
// It fires about once in 120 hands. The case for keeping it rests as much on
// the pinned hand in scripts/aiskilltest.mjs — a demonstrated 4-point
// double-dummy error — as on the aggregate.
export const SCHMEAR_KEEP_EQUITY = 1;
export const SCHMEAR_POINT_SLACK = 1;

// The picker, sitting last, holding trump nothing can beat, looking at a thin
// trick already won by a trump — and a card worth nothing she could throw
// instead. See the call site in heuristicCard for why ducking wins here.
// Returns the card to duck with, or null to leave the decision alone.
function freeDuckForPicker(g, idx, legal, winners, opts = {}) {
  const cap = opts.duckMaxTrickPoints ?? DUCK_MAX_TRICK_POINTS;
  if (cap < 0) return null;

  // Only the picker, and only while the partnership is genuinely unknown to
  // her. Once the ace is down she knows whose trick it is and the ordinary
  // teammate logic upstream handles it properly.
  if (idx !== g.picker || g.partner === null || g.partnerRevealed) return null;

  // Last to act only. The pot is then final, so what she gives up is exactly
  // what she can see — no seat left to fatten it. This is also the seat both
  // reports came from. Whether the same reasoning holds from an earlier seat
  // is a separate question and wants its own evidence.
  if (g.trick.length !== 4) return null;

  // A trick a fail card is winning is worth capturing: trumping it takes
  // points that otherwise leave the table. The argument below is about tricks
  // already contested in trump.
  const winnerSoFar = trickWinner(g.trick);
  if (!isTrump(g.trick.find((t) => t.player === winnerSoFar).card)) return null;

  const pot = g.trick.reduce((s, t) => s + cardPts(t.card), 0);
  if (pot > cap) return null;

  // Winning has to actually cost the boss. If she holds a cheaper winner she
  // should just take the trick with that — nothing here argues otherwise.
  const cheapestWinner = [...winners].sort((a, b) => power(a) - power(b))[0];
  if (cardEquity(g, idx, cheapestWinner) !== 0) return null;

  // And the duck has to be free. A card that costs points is a donation to
  // whoever actually holds the trick, which is the whole risk being avoided.
  const isWinner = (c) => winners.some((w) => cid(w) === cid(c));
  const ducks = legal.filter((c) => cardPts(c) === 0 && !isWinner(c));
  if (!ducks.length) return null;

  // Weakest of them, so the better trump is kept back as well.
  return ducks.sort((a, b) => power(a) - power(b))[0];
}

// Fat trump: the A and 10 of diamonds. Every point that lives in trump lives
// in the diamonds (see isPowerTrump) and these two carry 11 and 10 of them,
// which is why the threshold is a points test rather than a rank list — a Queen
// is 3 and a Jack 2, so neither can reach it.
export const FAT_TRUMP_POINTS = 10;

// Is leading this card a bleed that also donates a pile of points? Asked only
// of a lead, and only where a cheaper trump is available to bleed with instead.
//
// `opts.guardFatTrumpLead === false` disables it, for measurement — the same
// shape as priceCalledAce.
function leadDonatesPoints(g, idx, card, opts = {}) {
  if (opts.guardFatTrumpLead === false) return false;
  return isTrump(card) && cardPts(card) >= FAT_TRUMP_POINTS && cardEquity(g, idx, card) > 0;
}

export function aiChooseCard(g, idx, opts = {}) {
  // Last two tricks: solve exactly rather than using heuristics, and let the
  // heuristics settle any tie the solve leaves behind — see solveEndgameCard.
  if (g.tricksDone >= 4) return solveEndgameCard(g, opts);
  return heuristicCard(g, idx, opts);
}

// The heuristic stack. Separate from aiChooseCard so the endgame solver can
// reach it directly without recursing back through the short-circuit.
//
// `opts.restrictTo` narrows the cards under consideration to a subset of the
// legal plays. Only the endgame tie-break passes it, to ask "of these equally
// good cards, which one would you play?" — everything downstream reads `legal`,
// so this is the single point that has to honour it.
export function heuristicCard(g, idx, opts = {}) {
  const overtakeGate = opts.overtakeMinGain ?? OVERTAKE_MIN_GAIN;

  const legal = opts.restrictTo ?? legalPlays(g, idx);
  if (legal.length === 1) return legal[0];
  const onPickerTeam = idx === g.picker || idx === g.partner;

  if (g.trick.length === 0) {
    // Leading
    const trumps = legal.filter(isTrump).sort((a, b) => trumpPower(b) - trumpPower(a));
    const fails = legal.filter((c) => !isTrump(c));
    if (onPickerTeam) {
      // Trump-aware leading: count what's still unseen instead of using a
      // fixed "3+ trumps or a Q" rule regardless of how the trump has fallen.
      const oppTrumpLeft = unseenTrumpCount(g, g.hands[idx]);
      if (trumps.length) {
        if (oppTrumpLeft === 0) {
          // We hold every remaining trump — completely risk-free. Lead the
          // weakest one to bleed opponents' fail-suit points across
          // multiple guaranteed tricks instead of burning strength early.
          return trumps[trumps.length - 1];
        }
        if (trumps[0].rank === "Q") return trumps[0]; // top trump is always a safe, pressuring lead
        // Opponents nearly tapped out — press now. But pressing means leading
        // the TOP trump, and that is only pressure if the top trump can
        // plausibly hold the trick. A fat diamond with higher trump still out
        // is not pressure, it is a donation: the defense has to follow either
        // card, so the bleed happens regardless and the only difference is
        // whether eleven points go with it. Declining here falls through to the
        // bleed rule below, which sends the weakest trump instead.
        //
        // Reported twice, from two different hands: the picker leads A-D into
        // two outstanding higher trumps holding a cheaper trump — once from a
        // recap screenshot, then again as hand 9 of the collected corpus, where
        // the human led K-D from the same shape.
        if (oppTrumpLeft <= 2 && trumps.length >= 2 && !leadDonatesPoints(g, idx, trumps[0], opts)) {
          return trumps[0];
        }
        // Holding any trump at all, the picker's side leads trump. The old bar
        // here was `trumps.length >= 3` — "real depth" — and the depth was the
        // wrong quantity to measure. Pulling trump works because the defenders
        // must *follow* it, so even a trump that cannot win the trick still
        // strips two trump from the defense and shortens the suit protecting
        // their fail points. A hand of three low diamonds bleeds just as well
        // as a hand of three Queens; it simply does not win while doing it.
        //
        // Loosening this gate to "any trump" is worth +0.019/seat/hand (ahead
        // in 5 of 5 seeds at 20,000 hands per split, z 8.5-11.9). Every attempt
        // to *tighten* it measured worse, monotonically so: requiring 4+ trump
        // costs 0.019, dropping the rule entirely costs 0.035, and gating it on
        // the top trump's `cardEquity` costs between 0.008 and 0.034 depending
        // on the threshold. The conventional wisdom — partner leads trump —
        // turns out to be right further down into weak holdings than the engine
        // believed.
        //
        // Which trump to lead is a separate question from whether to lead one.
        // Lead the top trump when it can plausibly hold the trick; otherwise
        // the lead is purely a bleed, and a bleed should not also donate
        // points, so send the weakest instead (+0.019 vs +0.012 for always
        // leading the top trump, +0.007 for always leading the weakest).
        return isPowerTrump(trumps[0]) || cardEquity(g, idx, trumps[0]) <= 1
          ? trumps[0]
          : trumps[trumps.length - 1];
      }
      // Reached only with a hand of pure fail, so the trump-lead rule above has
      // already declined to fire. Note this makes the picker's "call for the
      // ace" lead conditional on holding no trump: tested against a version
      // that kept it available while holding trump, which measured worse on
      // every seed (+0.013/+0.017/+0.015 against +0.016/+0.020/+0.019).
      if (idx === g.picker && g.calledSuit && !g.calledAcePlayed) {
        const cs = fails.filter((c) => c.suit === g.calledSuit);
        if (cs.length && g.tricksDone >= 2) return cs.sort((a, b) => failPower(a) - failPower(b))[0]; // call for the ace
      }
      return fails.sort((a, b) => cardPts(a) - cardPts(b) || failPower(a) - failPower(b))[0];
    } else {
      // Defenders: hunt for the picker's partner. Leading a short called-suit
      // holding forces whoever holds the called ace to play it right now
      // (see legalPlays), unmasking the partner and stripping the picker's
      // protection window — worth more than the trick itself while it's
      // still unknown who holds it.
      if (g.calledSuit && !g.calledAcePlayed) {
        const calledSuitCards = fails.filter((c) => c.suit === g.calledSuit);
        if (calledSuitCards.length && calledSuitCards.length <= 2) {
          return calledSuitCards.sort((a, b) => failPower(a) - failPower(b))[0];
        }
      }
      const aces = fails.filter((c) => c.rank === "A" && c.suit !== g.calledSuit);
      if (aces.length) return aces[0];
      const nonCalled = fails.filter((c) => c.suit !== g.calledSuit);
      if (nonCalled.length) return nonCalled.sort((a, b) => cardPts(a) - cardPts(b))[0];
      if (fails.length) return fails.sort((a, b) => cardPts(a) - cardPts(b))[0];
      return trumps.length ? trumps[trumps.length - 1] : legal[0];
    }
  }

  // Following
  const winnerSoFar = trickWinner(g.trick);
  const winningCard = g.trick.find((t) => t.player === winnerSoFar).card;
  // What this seat can prove about the trick's owner, or null when the table
  // has not settled it. Falling back to knowsTeammate keeps the old optimistic
  // default for "should I fight this seat" — the difference is that a PROVEN
  // opponent is now treated as one, instead of being called a teammate because
  // the ace has not physically landed yet.
  const proven = (opts.deduceOwner ?? opts.deducePartner ?? DEDUCE_PARTNER)
    ? provenSide(g, idx, winnerSoFar) : null;
  const mateWinning = proven ?? knowsTeammate(g, idx, winnerSoFar);
  const beats = (c) => {
    const hypo = [...g.trick, { player: idx, card: c }];
    return trickWinner(hypo) === idx;
  };
  const winners = legal.filter(beats);

  // Who owns this trick, and how sure am I — hoisted out of the branch below
  // because every path that sheds a card needs the answer, not just the ones
  // that schmear or overtake. Keeping it inside `if (mateWinning)` was the bug:
  // a seat whose own side held the trick, holding nothing that could overtake,
  // fell straight out of the block and landed in the generic can't-win shed,
  // which minimises points. The ownership was computed and then discarded one
  // branch later.
  const asIs = mateWinning ? trickSecurity(g, idx, opts) : 0;

  // `trickSecurity` answers "will whoever is winning still have this at the
  // end". The schmear branch has always read it as "will MY SIDE still have
  // this at the end", and those are the same question only when the trick's
  // owner is known. Reported from hand 1: a defender led Q-hearts into trick 2
  // holding a trick already won with Q-clubs, nothing outstanding could beat
  // it, and security came back a perfectly correct 1.0 — for a trick belonging
  // to the picker's partner. Both defenders schmeared an Ace onto it.
  //
  // So the gate multiplies by how likely the trick is ACTUALLY ours. With the
  // flag off this is 1 whenever mateWinning, which is exactly the old test.
  // Two ways to read the belief, and they are not the same idea:
  //
  //   beliefSchmear  multiply security by it. Blunt — with no evidence at all
  //                  the best a defender can believe is 1 - 1/n, which never
  //                  reaches 0.85, so this bans speculative schmearing outright.
  //
  //   beliefFloor    keep the old gate and add a floor the belief must clear.
  //                  The uninformed two-in-three clears it; a seat the read has
  //                  marked as the picker's does not. It therefore bites only
  //                  where there is actual EVIDENCE, and leaves the uninformed
  //                  case — where the 2:1 asymmetry says schmearing pays — as
  //                  it was. That distinction is the whole design.
  const useBelief = (opts.beliefSchmear ?? BELIEF_SCHMEAR) || (opts.beliefFloor ?? BELIEF_FLOOR) > 0;
  const ownership = useBelief && mateWinning ? teammateProbability(g, idx, winnerSoFar, opts) : 1;
  const scaled = (opts.beliefSchmear ?? BELIEF_SCHMEAR) ? asIs * ownership : asIs;
  const trickLooksSafe = scaled >= SCHMEAR_CONFIDENCE && ownership >= (opts.beliefFloor ?? BELIEF_FLOOR);

  // Until the called ace falls, a defender's "teammate" is a guess — the seat
  // winning may well be the picker's partner, and paying points to the wrong
  // side is worse than holding on. knowsTeammate() reports every unrevealed
  // seat as a teammate, which is the right default for deciding who to fight,
  // but far too loose a basis for handing over 11 points.
  //
  // Three ways the partnership is actually known:
  //   - the called ace has been played, so everyone saw it;
  //   - the picker went alone, so no partner exists at all (declared at pick
  //     time and shown all hand, hence public — and note partnerRevealed
  //     stays false for the whole hand here, so leaving this case out would
  //     mute defender schmearing exactly when pooling points matters most);
  //   - the viewer IS the partner and the picker is winning, which the
  //     partner has known since the ace was called, with no reveal needed.
  //
  // All three are special cases of provenSide(), which also settles the case
  // they miss: the candidates for the called card narrowing to one seat, which
  // can happen mid-trick and before the ace is ever played.
  const teammateIsCertain =
    proven !== null ||
    g.partnerRevealed ||
    g.partner === null ||
    (idx === g.partner && winnerSoFar === g.picker);

  const speculativeOpening = g.tricksDone === 0 && !teammateIsCertain;

  // `trickSecurity` read as a direction rather than a gate. A card played into
  // a trick our side keeps is banked; into one we lose it is donated — so the
  // sign of the whole shed decision is just "is our side more likely than not
  // to still hold this at the end", which breaks even at one half.
  //
  // That is a different question from SCHMEAR_CONFIDENCE, which stays where it
  // is. Schmearing is choosing to spend a valuable card, and its error is
  // asymmetric, so it wants confidence well above even money. Shedding is
  // forced — a card is going regardless — so the only question is which side
  // banks the points, and there the honest breakeven is a half. Reading one
  // number two ways is what lets both branches share `shedCard`.
  const ourTrick = mateWinning && teammateIsCertain && asIs > 0.5;

  if (mateWinning) {
    if (trickLooksSafe && !speculativeOpening) {
      // Pay in fail points first. Trump is what takes later tricks, and while
      // there's a free choice no schmear is worth the trick a trump could win.
      // This used to sort every legal card by card points, and among trump the
      // highest-point card is a Queen (3) ahead of a Jack (2) — so with trump
      // led, the "schmear" threw the strongest card in the game away for one
      // extra point. Reported from a real hand where two seats each dumped a
      // Queen behind an already-unbeatable Q-clubs.
      // What may be spent when the trick's owner is a guess rather than a fact.
      // Paying an Ace on a two-in-three read costs eleven when it is wrong, and
      // the 2:1 odds do not cover an eleven the way they cover a King.
      const cap = teammateIsCertain ? Infinity : (opts.speculativeSchmearMax ?? SPECULATIVE_SCHMEAR_MAX);

      const schmearable = legal.filter((c) => !isTrump(c) && cardPts(c) > 0 && cardPts(c) <= cap);
      if (schmearable.length) {
        const byPoints = schmearable.sort((a, b) => cardPts(b) - cardPts(a) || power(a) - power(b));
        const fattest = byPoints[0];

        // Don't spend a fail card that is still boss of what's left when a
        // card barely lighter is already doomed — see SCHMEAR_KEEP_EQUITY.
        // Deliberately narrow: it costs one point of schmear at most, and only
        // buys anything when the fat card can really still take a trick.
        const keepEquity = opts.schmearKeepEquity ?? SCHMEAR_KEEP_EQUITY;
        if (keepEquity >= 0 && byPoints.length > 1) {
          const unseen = unaccountedFor(g, idx);
          const fatRisk = cardEquity(g, idx, fattest, unseen);
          if (fatRisk <= keepEquity) {
            const slack = opts.schmearPointSlack ?? SCHMEAR_POINT_SLACK;
            const doomed = byPoints.filter(
              (c) => cardPts(c) >= cardPts(fattest) - slack && cardEquity(g, idx, c, unseen) > fatRisk,
            );
            if (doomed.length) return doomed[0];
          }
        }
        return fattest;
      }

      // No free choice: trump was led, so a trump is going regardless. "Never
      // schmear trump" was the right instinct for the free case and exactly
      // wrong here — it fell through to "cheapest by points", which threw the
      // Q of diamonds (3 points, 4th-highest trump) and kept the 10 (10 points,
      // nearly powerless). Reported from a real hand against a loner. Spending
      // the fat diamond instead is better on both counts at once: seven more
      // points banked AND the stronger card kept. Queens and Jacks are only
      // parted with when they're all that's left, and then the weakest one.
      //
      // The cap applies here too, and this is the branch hand 1 actually took:
      // Bernie held J/A/K of diamonds behind a led Q-hearts, none of which
      // could win, and "spend the fattest non-power trump" handed over the Ace.
      // Correct when the trick is ours; an eleven-point donation when it isn't.
      if (legal.every(isTrump)) {
        const fat = legal.filter((c) => !isPowerTrump(c) && cardPts(c) <= cap);
        if (fat.length) {
          return fat.sort((a, b) => cardPts(b) - cardPts(a) || power(a) - power(b))[0];
        }
      }

      // Nothing worth paying. Get out of the way rather than falling through to
      // the winners logic below and overtaking our own teammate.
      return shedCard(g, idx, legal, ourTrick, opts);
    }

    // The trick isn't safe enough to pay into, so the choice is between taking
    // it off our own side and letting it ride. Taking it is only worth a card
    // if it actually makes the trick safer.
    //
    // Gated on the partnership being *known*, and that gate is load-bearing.
    // knowsTeammate() calls every unrevealed seat a teammate, which is the right
    // default for deciding who to fight but a bad basis for standing down: one
    // of those "teammates" is the picker's partner. Measured over 3x200,000
    // hands, applying this brake on a guess costs defenders 0.6pp in partnered
    // hands (62.0-62.2% -> 62.6-62.8% picker win rate) — the same 2:1 asymmetry
    // that made speculative schmearing worth keeping in 0.9.0, pointing the
    // other way. Where the partnership is actually known it's a clear gain.
    //
    // Reported from expert play: the partner led Q-hearts and the picker
    // overtook with Q-spades. From the picker's seat both of those Queens were
    // beaten by exactly one unaccounted-for card — Q-clubs — so the overtake
    // moved the trick from his partner's Queen onto his own better one without
    // improving its odds by a single point, and Q-clubs took it anyway. The old
    // code did this because reaching the winners branch below means "I can win",
    // which it treated as "I should win".
    //
    // What the flat threshold missed is that the gain has to be paid for. A
    // seat holding the boss trump can *always* take the trick's security to
    // 1.0, so a fixed bar is cleared most easily by exactly the card it is
    // most expensive to spend. Reported from a real hand: a defender's Q-hearts
    // already owned trick 1 and their partner over-trumped with Q-clubs — the
    // boss card of the game, spent on a trick their own side already had,
    // against a lone picker who then got out for 7-diamonds. The old gate
    // permitted it precisely *because* Q-clubs was unbeatable.
    //
    // So the bar a card has to clear scales with what that card is: an
    // unbeatable card has to buy four times the security of a card half the
    // table can beat. Note this is a price, not a prohibition — "never overtake
    // your own side" would be the wrong rule, since holding the lead is
    // sometimes the entire plan.
    // The brake is worth applying on a strong BELIEF, not only on proof —
    // that is the question this floor exists to answer. 0.36.0 measured
    // applying it on the deduction alone at -0.0006/seat/hand, so the bar is
    // not "is the belief right" but "is it right enough to beat the cost of
    // standing down". Above 1 by default, i.e. off. Note the uninformed 2/3
    // never clears a floor worth setting, so like BELIEF_FLOOR this bites only
    // where the read has actually fired.
    const overtakeBrake = teammateIsCertain ||
      (mateWinning && ownership >= (opts.overtakeBeliefFloor ?? OVERTAKE_BELIEF_FLOOR));
    if (winners.length && overtakeBrake) {
      const unseen = unaccountedFor(g, idx);
      const priceOf = (c) => {
        const beaters = cardEquity(g, idx, c, unseen);
        return beaters === 0 ? 4 : beaters === 1 ? 2 : 1;
      };
      const affordable = winners.filter(
        (c) => securityAfterPlay(g, idx, c, opts) - asIs >= overtakeGate * priceOf(c) - 1e-9,
      );

      // FORCING. The gate above asks only "does this make the trick mine?" —
      // and when the trick is already certainly gone the answer is no, so a
      // trump that would make the winner PAY for it never gets played.
      //
      // Reported from a real hand: the trick was 100% lost, a defender held
      // J-spades, and the picker took it with 9-diamonds — her weakest trump.
      // Trumping in would have forced a Queen out of her and left the 9 to be
      // beaten later. Double-dummy that is worth 8 points, and it is the
      // conventional play.
      //
      // MEASURED AND NOT SHIPPED, default off, in two rounds.
      //
      // Blunt (fire whenever the trick is gone and a winner is held):
      //   +0.0006/seat/hand ahead 3 of 3 at 5,000 hands, decaying to +0.0001
      //   ahead 3 of 5 at 9,000 x 5.
      // Sharpened, from profiling 172 firing positions scored double-dummy —
      // the ones where forcing helped spent a stronger card (mean equity 4.8
      // against 5.7) and were held by seats with less trump (1.5 against 1.8):
      //   forceMaxTrump 2  +0.0007 ahead 3 of 3 at 5,000, +0.0005 ahead 3 of 5
      //                    at 9,000 x 5
      //   forceMaxEquity 4 / 5 both inside the same band.
      //
      // The interesting number is the gap between theory and play. Across those
      // 172 positions forcing is worth +1.52 points each, double-dummy, and it
      // fires in roughly 1.9% of hands from trick three — which would be about
      // +0.03/hand if it were converted. It measures at a twentieth of that,
      // so the advantage is real and this engine does not follow it up. That is
      // a statement about the rest of the hand, not about this branch, and no
      // trigger here can fix it.
      //
      // Left switchable rather than deleted: the hand that prompted it really
      // is misplayed, and the follow-up is a thing that could improve.
      if (!affordable.length && opts.forceWhenLost && asIs <= 1e-9 && winners.length) {
        const cheapest = [...winners].sort((a, b) => power(a) - power(b))[0];
        // Sharpened from a sample of the positions where this fires, scored
        // double-dummy. Where it helped, the forcing card was stronger (mean
        // equity 4.8 against 5.7) and the seat held fewer trump (1.5 against
        // 1.8) — spend a card that can still make them work, and only when
        // trump is not the thing you are hoarding.
        const equityOk =
          opts.forceMaxEquity === undefined ||
          cardEquity(g, idx, cheapest, unseen) <= opts.forceMaxEquity;
        const trumpOk =
          opts.forceMaxTrump === undefined ||
          g.hands[idx].filter(isTrump).length <= opts.forceMaxTrump;
        // Only when it actually costs them something: forcing with a card the
        // winner can beat with what they already played is just a donation.
        if (equityOk && trumpOk && securityAfterPlay(g, idx, cheapest, opts) > asIs) return cheapest;
      }

      if (!affordable.length) return shedCard(g, idx, legal, ourTrick, opts);
      // Cheapest overtake that pays for itself, not the strongest one available.
      return affordable.sort((a, b) => power(a) - power(b))[0];
    }
  }
  if (winners.length) {
    // Before taking it: the picker's boss trump is not a resource that can be
    // lost. Nothing outstanding beats it, so it takes a trick whenever she
    // chooses to play it. Spending it to overtake therefore buys only the
    // difference between this trick and the one it would have taken later,
    // and on a thin early trick that difference is negative.
    //
    // She also cannot tell whose trick she is taking. `knowsTeammate` returns
    // false for every seat while the picker has not seen the called ace, so
    // this branch treats a trick her own partner is winning exactly like an
    // opponent's. Reported twice from real play, both times the same shape:
    // the partner led a high trump, the picker sat last, and she overtook with
    // Q-clubs — the boss — on the thinnest trick of the hand.
    //
    // What makes ducking safe rather than a guess is that the duck is free.
    // The trick's existing points are at risk either way; a zero-point card
    // donates nothing on top. Measured on the reported hand by sampling deals
    // consistent with what the picker actually knows, ducking with the 7 of
    // diamonds beats overtaking once she is more than ~13-16% sure the trick
    // is her partner's — and with four unknown seats, chance alone already
    // puts that at 25%. So this needs no read on who the partner is. It is
    // decidable from the cards, which is why it lives here and not behind the
    // belief model the 85%-threshold cases would need.
    const duck = freeDuckForPicker(g, idx, legal, winners, opts);
    if (duck) return duck;

    // The weakest card that takes the trick takes it — always, with no
    // "secure with strength" exception for a fat or late trick.
    //
    // A trick won by one rank scores exactly what a trick won by eight scores,
    // and the surplus rank is a later trick you no longer win. That makes
    // overkill a pure loss in all but pathological cases, so there is nothing
    // for a "when the trick is worth it, reach for strength" rule to buy.
    //
    // Removing that rule is worth +0.089/seat/hand (ahead in 5 of 5 seeds at
    // 20,000 hands per split, z ~ 19), measured with the variant in one seat
    // against the previous engine in the other four. For scale, 0.18.0 —
    // which softened the same rule with a sufficiency filter rather than
    // deleting it — was +0.013 on the identical harness. Every attempt to keep
    // the rule and merely improve it measured worse than deleting it: pricing
    // the security gain the way the overtake branch does lands between -0.005
    // and +0.016 depending on the threshold, and the whole curve is dominated
    // by simply playing the cheapest winner.
    //
    // Reported from a real hand: the picker held Q-clubs Q-hearts J-spades
    // J-hearts behind a fail lead and took a 13-point trick with Q-hearts,
    // where J-hearts took the identical 13. The sufficiency filter could not
    // certify the Jack because `trickSecurity` counts beaters the one seat
    // left to act could not legally play — it was following a fail suit — so
    // the code fell through to strength and burned a Queen for nothing.
    //
    // MEASURED AND NOT SHIPPED, 2026-07-30 — a third attempt, from the other
    // direction, and the most tempting one yet. Written up here because the
    // hand that prompts it is genuinely misplayed, so it WILL be noticed again.
    //
    // Corpus hand 1, trick 1, and the largest single error in the collected
    // corpus: a defender holds Q-clubs (boss) and Q-hearts behind the partner's
    // J-clubs lead, plays Q-hearts — the cheaper Queen, identical 3 points —
    // and the picker, last to act and KNOWN to be an opponent, takes it with
    // Q-spades. Double-dummy 43 points, and it flips the hand.
    //
    // The play really is wrong, which is the part worth knowing: over 3,000
    // deals of the unseen cards consistent with what that seat can actually see
    // (clubs called, so the ace is with one of the three seats that are not the
    // picker), Q-clubs is worth +2.8 points to the defense and wins 81.3% of
    // the hands against 75.4%. So this is not double-dummy hindsight — it is
    // only much smaller than 43.
    //
    // The rule that fixes it does not survive contact with the rest of the
    // game. "Upgrade to a boss winner when the cheap winner has a live beater
    // and `securityAfterPlay` says the trick is not already certain" — the
    // legality-aware test, which is what the 0.18.0 filter lacked — measured
    // -7.37 per firing over 2,929 firings in 24,000 deals, 0 of 3 seeds, acting
    // side's win rate 62.5% against 75.1%. It fires on ~12% of hands, mostly
    // the picking team, and every slice of it is negative.
    //
    // Narrowing to the reported shape exactly — defenders only, power trump for
    // power trump at identical points, a known opponent still to act — reads
    // +1.25 per firing in-sample and **-0.61 on fresh seeds** (557 firings,
    // ahead in 3 of 5, win rate 49.9% against 49.7%). That is noise, and the
    // in-sample number was the best of twenty slices. Note it was worth +0.10
    // at trick 1 even in-sample, i.e. nothing at the very trick it came from.
    //
    // Why no card-shape rule can work here: what makes Q-clubs right is not
    // anything about the holding, it is that Q-spades — the one card that beats
    // Q-hearts — is likelier to sit with the PICKER, who is behind us. Pickers
    // pick because they hold trump. Nothing in this engine models that prior,
    // and until something does, this position is not decidable from the cards.
    // That is the fix, and it belongs with the belief layer, not here.
    const cheapest = (cards) => [...cards].sort((a, b) => power(a) - power(b))[0];
    return cheapest(winners);
  }
  // Can't win it. This is where a seat whose own side owns the trick used to
  // land after failing the safety bar with nothing able to overtake — the exact
  // path that threw a boss Jack to keep a dead Ace. `ourTrick` carries the
  // ownership down here now, so the same shed serves both cases with the sign
  // flipped.
  return shedCard(g, idx, legal, ourTrick, opts);
}

/* ------------------------------ Game setup ------------------------------ */
// `doubler` scales the whole hand and is inherited, not earned: a hand nobody
// picks is thrown in and the next one pays double. Passing it in rather than
// deriving it keeps the rule where it belongs — the hand that pays is not the
// hand that caused it.
export function freshHand(dealer, scores, handNum, doubler = 1) {
  const deck = makeDeck();
  const hands = [[], [], [], [], []];
  let di = 0;
  for (let p = 0; p < 5; p++) for (let k = 0; k < 6; k++) hands[p].push(deck[di++]);
  const blind = [deck[di++], deck[di++]];
  return {
    phase: "picking",
    handNum,
    dealer,
    hands: hands.map(sortHand),
    blind,
    buried: [],
    picker: null,
    partner: null,
    partnerRevealed: false,
    calledSuit: null,
    // The rank that names the partner: "A" normally, "10" when the picker held
    // every fail ace. `calledUnder` records that the picker is void in the
    // called suit, which is public — it is announced at the table, and it
    // changes how the hand plays for everyone.
    calledRank: null,
    calledUnder: false,
    // The physical card the picker set aside to stand in for the called suit.
    underCard: null,
    calledAcePlayed: false,
    calledSuitLed: false,
    alone: false,
    doubler,
    pickTurn: (dealer + 1) % 5,
    passes: 0,
    played: [],
    trick: [],
    leader: (dealer + 1) % 5,
    turn: (dealer + 1) % 5,
    tricksDone: 0,
    trickCounts: [0, 0, 0, 0, 0],
    ptsTaken: [0, 0, 0, 0, 0],
    lastTrick: null,
    trickHistory: [], // every resolved trick this hand, in order — for the hand recap
    selected: [],
    scores,
    message: null,
    result: null,
  };
}

/**
 * What the picker may call, as DATA rather than a bare list of suits.
 *
 * The rule itself is old: you may call the ace of a fail suit you hold at least
 * one card of and do not hold the ace of (buried counts as held — burying the
 * ace you were going to call is not a loophole). It existed in three places —
 * the solo screen, the table screen, and nowhere authoritative — which is the
 * shape every drift in this project has taken.
 *
 * Each option is an object, not a suit string, because the next rules to land
 * are calling a TEN (when the picker holds every callable ace) and calling
 * UNDER. Those are different calls of the same suit, so a suit alone cannot
 * describe them, and a UI that renders a list of suits has to be rewritten to
 * show them. A UI that renders a list of options does not.
 *
 * @returns {{kind: "ace", suit: string}[]}
 */

export function assignPartner(g) {
  if (!g.calledSuit) return { ...g, partner: null, alone: true };
  let partner = null;
  for (let p = 0; p < 5; p++) {
    if (p === g.picker) continue;
    const rank = g.calledRank || "A";
    if (g.hands[p].some((c) => c.suit === g.calledSuit && c.rank === rank && !isTrump(c))) partner = p;
  }
  return { ...g, partner, alone: partner === null };
}

export function applyPlay(g, idx, card) {
  const hands = g.hands.map((h, i) => (i === idx ? h.filter((c) => cid(c) !== cid(card)) : h));
  // Played under, the card goes down as the 6 of the called suit and its real
  // face travels alongside as `actual`: it still scores its own points, and it
  // is what gets revealed to the trick's winner and in the recap.
  const under = isUnderCard(g, idx, card);
  const played = under ? { player: idx, card: underFace(g), actual: card, under: true }
                       : { player: idx, card };
  const trick = [...g.trick, played];
  let { partnerRevealed, calledAcePlayed, calledSuitLed } = g;
  // The under card counts as the called suit here too — leading it is what
  // puts the called suit in play and drags the called ace out.
  const asSuit = under ? g.calledSuit : (isTrump(card) ? null : card.suit);
  if (g.calledSuit && asSuit === g.calledSuit) {
    if (trick.length === 1) calledSuitLed = true;
    if (effSuit(trick[0].card) === g.calledSuit) calledSuitLed = true;
    if (!under && card.rank === (g.calledRank || "A")) {
      calledAcePlayed = true;
      if (idx === g.partner) partnerRevealed = true;
    }
  }
  const next = { ...g, hands, trick, partnerRevealed, calledAcePlayed, calledSuitLed };
  if (trick.length < 5) next.turn = (idx + 1) % 5;
  else next.turn = -1; // wait for trick resolution
  return next;
}

export function resolveTrick(g) {
  const w = trickWinner(g.trick);
  // The under card scores its own face, not the 6 it played as.
  const pts = g.trick.reduce((s, t) => s + cardPts(t.actual ?? t.card), 0);
  const ptsTaken = [...g.ptsTaken];
  ptsTaken[w] += pts;
  const trickCounts = [...g.trickCounts];
  trickCounts[w] += 1;
  const tricksDone = g.tricksDone + 1;
  const base = {
    ...g,
    ptsTaken,
    trickCounts,
    tricksDone,
    played: [...g.played, ...g.trick.map((t) => t.card)],
    lastTrick: { trick: g.trick, winner: w },
    trickHistory: [...g.trickHistory, { trick: g.trick, winner: w }],
    trick: [],
    leader: w,
    turn: w,
  };
  if (tricksDone === 6) return scoreHand(base);
  return base;
}

export function scoreHand(g) {
  const buriedPts = g.buried.reduce((s, c) => s + cardPts(c), 0);
  const pickerTeam = [g.picker, ...(g.partner !== null ? [g.partner] : [])];
  const teamPts = pickerTeam.reduce((s, p) => s + g.ptsTaken[p], 0) + buriedPts;
  const defPts = 120 - teamPts;
  const teamTricks = pickerTeam.reduce((s, p) => s + g.trickCounts[p], 0);
  const pickerWins = teamPts >= 61;
  let mult = 1;
  let label = "";
  // "No Schneider!" — the losing side failed to get out of schneider. The two
  // branches are NOT the same number, which is what this used to get wrong.
  //
  // Schneider is half of what a side needs to win, and the two sides do not
  // need the same thing: the picker's team needs 61 and the defenders 60,
  // because a 60-60 tie goes to the defenders. Halving each gives 30.5 -> 31
  // for the picker and 30 for the defenders, so every defender threshold sits
  // one point below the picker's, exactly as 60 sits below 61.
  //
  //   picker's team   out of schneider at 31, schneidered at <= 30
  //   defenders       out of schneider at 30, schneidered at <= 29
  //
  // The old code used <= 30 on both sides and the comment asserted the
  // symmetry as if it were the rule. Measured over 19,218 played hands, that
  // handed the picker an unearned 2x on 1.12% of hands — 4.4% of all
  // schneiders, every one of them in the picker's favour.
  if (pickerWins) {
    if (teamTricks === 6) { mult = 3; label = "No-tricker!"; }
    else if (defPts <= 29) { mult = 2; label = "No Schneider!"; }
  } else {
    if (teamTricks === 0) { mult = 3; label = "No-tricker!"; }
    else if (teamPts <= 30) { mult = 2; label = "No Schneider!"; }
  }
  // Double on the bump: a set picker pays twice. The picking team wins about
  // 61-62% of the hands it takes, and wins them bigger than it loses them
  // (average multiplier 1.49 winning against 1.17 losing, because they hold the
  // blind and the burial). Left alone that makes picking worth about +1.27 a
  // hand — close enough to free that loose picking is rewarded as well as good
  // picking. Doubling the loss brings it to roughly +0.10, which turns picking
  // back into a decision instead of a formality.
  const bumped = !pickerWins;

  // A passed-out hand doubles the next one, and stacks if it happens twice
  // running. Carried on the state rather than recomputed, since the hand that
  // pays it is not the hand that caused it.
  const doubler = g.doubler || 1;

  // Everything that scales the hand, in one place. Zero-sum either way: what
  // one side pays, the other collects.
  const stake = mult * doubler * (bumped ? 2 : 1);

  const scores = [...g.scores];
  const sign = pickerWins ? 1 : -1;
  if (g.alone || g.partner === null) {
    scores[g.picker] += sign * 4 * stake;
    for (let p = 0; p < 5; p++) if (p !== g.picker) scores[p] -= sign * stake;
  } else {
    scores[g.picker] += sign * 2 * stake;
    scores[g.partner] += sign * 1 * stake;
    for (let p = 0; p < 5; p++) if (!pickerTeam.includes(p)) scores[p] -= sign * stake;
  }
  const handDelta = scores.map((s, i) => s - g.scores[i]);
  return {
    ...g,
    phase: "handEnd",
    scores,
    result: {
      teamPts, defPts, pickerWins, mult, label, buriedPts, pickerTeam, handDelta,
      bumped, doubler, stake,
    },
  };
}

/* ------------------------- Post-hand play grading ------------------------ */
// Grading used to roll the hand forward with aiChooseCard driving all five
// seats and compare the resulting totals. That measures the wrong thing. The
// rollout's continuation is only as good as the AI, so any weakness in the
// AI's later play is charged to whoever happened to be moving now — the grade
// answers "what would our AI do with this" when the player is asking "was that
// a mistake".
//
// Reported from a real hand (v0.18.0, hand 1): a defender's J-diamonds was
// flagged as the worst play of the hand, costing 14 points against the
// alternative of ducking. It cost nothing — with every hand face up, all four
// of that seat's legal cards end 120-0, as does every card at every one of the
// defenders' eleven decisions in the hand. The 14 points were the AI misplaying
// the *picker's* side after the duck, and the grader billed them to the
// defender. (The picker's side did have two live decisions in that hand, worth
// 24 and 17 points, and got both right — so the hand was cold for the defense
// specifically, not for everybody.)
//
// So grade against exact play instead: solve the position double-dummy. Two
// properties matter more than the precision itself. A play can never be
// flagged as a mistake unless a better one genuinely existed, and when every
// legal card leads to the same result the swing is zero, so a locked hand is
// reported as having no best or worst play rather than an arbitrary one.
//
// The honest caveat is that this judges with all hands visible, so it can mark
// a play that was right given what the player could actually see. That is the
// standard trade for post-mortem analysis and it is the safer direction: it
// never invents a mistake where no better card existed.
// Grading looks at decisions from this trick on (0-indexed, so trick 1 — the
// whole hand). It used to start at trick 3, which left the opening lead and
// every trick-2 decision ungraded; two separately reported mistakes turned out
// to live exactly there and the recap could not see either.
//
// The cost of an exact solve is set by how many cards are still out and it
// falls off a cliff. Re-measured over 40 AI-played hands on the current
// solver: from trick 3 a median of 8ms and p90 20ms, from trick 2 a median of
// 100ms and p90 259ms, from trick 1 a median of 795ms, p90 3.9s and a worst
// case of 6.8s. (An older note here recorded 4.2s/14.4s for trick 1; the
// `handMask` transposition key is most of the ~5x between then and now. It is
// still nowhere near render budget.)
//
// So the threshold did not move on its own — the search moved off the main
// thread first. `grader.worker.js` owns it and `useHandGrade` delivers the
// result asynchronously; both screens render the recap immediately and fill
// the verdict in. Putting this back on the render path means putting the
// threshold back with it.
const GRADE_FROM_TRICK = 0;

// Backstop against pathology, not a latency guard — latency is the worker's
// problem now. Sized by measurement: grading from trick 1 over 40 hands leaves
// 20 of them ungraded at 2M nodes and 3 at 10M, and none at 40M. Set above
// that so the budget decides nothing on a normal hand; a hand that trips it
// reports no verdict rather than hanging the recap.
const DD_NODE_BUDGET = 50_000_000;

// Every card gets a bit, so a hand is a 32-bit mask and two orderings of the
// same holding collide for free. Built as a nested lookup rather than keyed by
// `cid` because the key function runs at every node of the search, and building
// a string per card there was most of the solve time — masks took a full-hand
// solve from 771ms to well under a tenth of that.
const CARD_BIT = (() => {
  const t = {};
  ALL_CARDS.forEach((c, i) => { (t[c.suit] ??= {})[c.rank] = i; });
  return t;
})();
const handMask = (h) => { let m = 0; for (const c of h) m |= 1 << CARD_BIT[c.suit][c.rank]; return m; };

// Position key for the transposition table. The called-ace flags are included
// because `legalPlays` reads them — two states with identical cards but a
// different ace status have different legal moves. `tricksDone` is implied by
// the card counts and `leader` by `turn` on an empty trick, so neither is here.
function ddKey(g) {
  const h = g.hands;
  let k = `${handMask(h[0])},${handMask(h[1])},${handMask(h[2])},${handMask(h[3])},${handMask(h[4])}|`;
  for (const t of g.trick) k += `${t.player}.${CARD_BIT[t.card.suit][t.card.rank]},`;
  return k + g.turn + (g.calledAcePlayed ? "1" : "0") + (g.calledSuitLed ? "1" : "0");
}

// Picker-team points won from here to the end of the hand, both sides perfect.
//
// The transposition table stores a bound flag rather than a bare value. A node
// searched inside a narrowed alpha-beta window may return a bound instead of
// the true minimax value, and filing those as exact silently corrupts every
// later lookup that hits them — the sort of bug that produces plausible grades
// rather than obviously broken ones.
function ddFuture(g, alpha, beta, memo, budget) {
  if (g.trick.length === 5) {
    const w = trickWinner(g.trick);
    const gain = pickerTeamOf(g).includes(w)
      ? g.trick.reduce((s, t) => s + cardPts(t.actual ?? t.card), 0)
      : 0;
    if (g.tricksDone === 5) return gain; // resolving this one ends the hand
    return gain + ddFuture(resolveTrick(g), alpha - gain, beta - gain, memo, budget);
  }
  if (++budget.n > DD_NODE_BUDGET) throw new RangeError("dd budget");

  const alpha0 = alpha, beta0 = beta;
  const key = ddKey(g);
  const hit = memo.get(key);
  if (hit) {
    if (hit.flag === 0) return hit.v;
    if (hit.flag < 0) { if (hit.v <= alpha) return hit.v; beta = Math.min(beta, hit.v); }
    else { if (hit.v >= beta) return hit.v; alpha = Math.max(alpha, hit.v); }
    if (alpha >= beta) return hit.v;
  }

  const idx = g.turn;
  const maximising = pickerTeamOf(g).includes(idx);
  let best = maximising ? -Infinity : Infinity;
  // Strongest first. Whether a card takes the trick is what moves the value
  // most, so this finds the cutoff early far more often than deal order does.
  const moves = legalPlays(g, idx).sort((a, b) => power(b) - power(a));
  for (const card of moves) {
    const v = ddFuture(applyPlay(g, idx, card), alpha, beta, memo, budget);
    if (maximising) {
      if (v > best) best = v;
      if (best > alpha) alpha = best;
    } else {
      if (v < best) best = v;
      if (best < beta) beta = best;
    }
    if (alpha >= beta) break;
  }
  memo.set(key, { v: best, flag: best <= alpha0 ? -1 : best >= beta0 ? 1 : 0 });
  return best;
}

// Exact picker-team total for a position, on the same scale the old rollout
// used (points already banked plus points still to be won), so callers compare
// sibling moves directly. `memo` is shared across a whole grading pass: the
// positions reachable from one decision overlap heavily with those reachable
// from the next, and sharing the table is most of what makes grading a full
// hand affordable.
export function solveHandValue(g, memo = new Map(), budget = { n: 0 }) {
  const banked = pickerTeamOf(g).reduce((s, p) => s + g.ptsTaken[p], 0);
  if (g.tricksDone >= 6) return banked;
  return banked + ddFuture(g, -Infinity, Infinity, memo, budget);
}

// Replays a finished hand from trickHistory and grades every real decision
// (skipping forced plays with only one legal card) by comparing the actual
// card's exact double-dummy value against the best and worst legal
// alternative, from the mover's own team's perspective. Returns the single
// biggest mistake ("worst") and the single most impactful correct call
// ("best" — must have cost 0 relative to the best option AND have actually
// mattered, i.e. the legal alternatives weren't all equivalent).
//
// On a hand where no decision could have changed anything, every cost and
// every swing is zero and both come back null. That is the intended answer,
// not a failure to find one: labelling a best and a worst play on a hand that
// was decided at the deal is worse than labelling neither.
// Every graded decision in the hand, not just the two the recap shows.
//
// gradeHandPlays already computed this and threw all but two entries away.
// Keeping it is what makes a played hand a dataset: each entry is an exact
// double-dummy cost for one decision, so a human seat and the four AI seats
// can be compared *within the same deal*, which removes almost all of the
// luck that makes per-hand scores useless for judging play.
//
// `graded` distinguishes "nothing was worth flagging" from "this hand blew the
// node budget and was not graded at all" — a distinction the recap can ignore
// and an analysis absolutely cannot, since counting an ungraded hand as a
// clean one biases every average toward zero.
export function gradeAllPlays(g) {
  if (!g.trickHistory || g.trickHistory.length < 6) return { decisions: [], graded: false };

  // Shared across every decision in the hand — see solveHandValue. The budget
  // is shared too, so a pathological hand gives up rather than freezing the
  // recap: both call sites run this synchronously inside a render.
  const memo = new Map();
  const budget = { n: 0 };

  const startingHands = [[], [], [], [], []];
  for (const th of g.trickHistory) for (const play of th.trick) startingHands[play.player].push(play.card);

  let sim = {
    ...g,
    phase: "playing",
    hands: startingHands,
    played: [],
    trick: [],
    tricksDone: 0,
    trickCounts: [0, 0, 0, 0, 0],
    ptsTaken: [0, 0, 0, 0, 0],
    calledAcePlayed: false,
    calledSuitLed: false,
    partnerRevealed: false,
    trickHistory: [],
    lastTrick: null,
    leader: g.trickHistory[0].trick[0].player,
    turn: g.trickHistory[0].trick[0].player,
  };

  const decisions = [];
  try {
  g.trickHistory.forEach((th, trickIdx) => {
    for (const play of th.trick) {
      const idx = play.player;
      const legal = legalPlays(sim, idx);
      if (trickIdx >= GRADE_FROM_TRICK && legal.length > 1) {
        const isPickerSide = pickerTeamOf(sim).includes(idx);
        const vals = legal.map((card) => ({ card, val: solveHandValue(applyPlay(sim, idx, card), memo, budget) }));
        const allVals = vals.map((v) => v.val);
        const bestVal = isPickerSide ? Math.max(...allVals) : Math.min(...allVals);
        const worstVal = isPickerSide ? Math.min(...allVals) : Math.max(...allVals);
        const actual = vals.find((v) => cid(v.card) === cid(play.card));
        const cost = isPickerSide ? bestVal - actual.val : actual.val - bestVal;
        const swing = Math.abs(bestVal - worstVal);
        const bestCard = vals.find((v) => v.val === bestVal).card;
        // The cost of EVERY legal card, not just the one played. Without this
        // an analysis can only ask "did they find the best card", which
        // rewards a careless player for stumbling onto it; with it the
        // question becomes "how much did this choice cost against that one",
        // which is a magnitude and cannot be answered by luck. The solve has
        // already been paid for here — these are the same values.
        const costs = vals.map((v) => ({
          card: v.card,
          cost: isPickerSide ? bestVal - v.val : v.val - bestVal,
        }));
        decisions.push({ trickIdx, player: idx, card: play.card, cost, swing, bestCard, costs });
      }
      sim = applyPlay(sim, idx, play.card);
    }
    sim = resolveTrick(sim);
  });
  } catch (e) {
    // Only the node budget aborts a grade. Anything else is a real bug and
    // should surface rather than be swallowed into a silent "no mistakes".
    if (!(e instanceof RangeError && e.message === "dd budget")) throw e;
    return { decisions: [], graded: false };
  }

  return { decisions, graded: true };
}

// The recap's view: the single biggest mistake and the single most impactful
// correct call. Unchanged behaviour — an ungraded hand yields [] above and so
// still reports neither, which is the intended answer rather than a failure.
export function gradeHandPlays(g) {
  const { decisions } = gradeAllPlays(g);

  let worst = null;
  let best = null;
  for (const d of decisions) {
    if (d.cost > 0 && (!worst || d.cost > worst.cost || (d.cost === worst.cost && d.swing > worst.swing))) worst = d;
    if (d.cost === 0 && d.swing > 0 && (!best || d.swing > best.swing)) best = d;
  }
  return {
    best: best ? { trick: best.trickIdx, player: best.player, card: best.card } : null,
    worst: worst ? { trick: worst.trickIdx, player: worst.player, card: worst.card } : null,
  };
}

/* --------------------------- Per-seat redacted views --------------------------- */
// In solo play the client holding the whole `g` is harmless: the only human is
// seat 0 and the four AI opponents read the same object. With human opponents
// it is a cheat vector — anything shipped to a browser is readable in devtools.
// `viewFor` builds the state a single seat is entitled to see, and is the ONLY
// thing a server may send to a client. Three redactions here are subtler than
// "hide the other hands":
//
//   - `g.blind` stays populated after the picker takes it (the cards are merged
//     into their hand, the pile isn't cleared), so it leaks two known cards to
//     everyone else unless explicitly dropped.
//   - `g.partner` is assigned the moment the ace is called, long before the
//     table may know it. The partner knows (they hold the called ace); the
//     picker does not, until the ace falls. Everyone learns on reveal.
//   - `g.alone` conflates "picker declared alone", which is public, with "the
//     called ace turned out to be buried or in the blind", which is secret —
//     see `assignPartner`. Passing it through tells defenders there's no
//     partner the instant the suit is called. The view derives the public fact
//     instead: alone is only visible when no suit was called at all.
//
// Hand contents aside, everything already public at a real table (the current
// trick, resolved tricks, points taken, whose turn it is) passes through as-is.
export function viewFor(g, seat) {
  const revealed = g.phase === "handEnd";
  const isPicker = seat === g.picker;

  // The partner is known to themselves from the moment the suit is called, to
  // the picker and defenders only once the called ace has been played.
  let partner = null;
  if (revealed || g.partnerRevealed) partner = g.partner;
  else if (g.partner !== null && seat === g.partner) partner = g.partner;

  return {
    ...g,

    // Who this view belongs to. Clients render from this rather than assuming
    // seat 0 is "you", which is what the solo UI does today.
    you: seat,

    // Own hand only. Counts stay visible so the UI can still fan face-down
    // cards for the other four seats.
    hands: g.hands.map((h, i) => (i === seat || revealed ? h : null)),
    handCounts: g.hands.map((h) => h.length),

    // The picker has these cards in hand anyway; nobody else may see them.
    blind: isPicker || revealed ? g.blind : null,
    buried: isPicker || revealed ? g.buried : null,

    partner,
    alone: revealed ? g.alone : g.calledSuit === null && g.phase === "playing",

    // Which card the picker set aside is theirs alone to know until the hand
    // is over. It is on the table as the 6 of the called suit and face down to
    // everyone else — the whole point of playing under is that nobody can see
    // what you spent.
    underCard: isPicker || revealed ? g.underCard : null,

    // ...and the same for its face once played. Revealed to whoever WON the
    // trick it fell in — they gathered it, so they saw it — and to everybody
    // at the end. `under` itself stays visible: that a card was played under
    // is public, only its identity is not.
    trick: hideUnder(g.trick, seat, null, isPicker, revealed),
    trickHistory: (g.trickHistory || []).map((th) => ({
      ...th,
      trick: hideUnder(th.trick, seat, th.winner, isPicker, revealed),
    })),
    lastTrick: g.lastTrick
      ? { ...g.lastTrick, trick: hideUnder(g.lastTrick.trick, seat, g.lastTrick.winner, isPicker, revealed) }
      : g.lastTrick,

    // Purely a UI scratch field for the local player's card selection; it has
    // no business crossing the wire.
    selected: undefined,
  };
}

// Strips the real face off any card played under, unless this viewer is
// entitled to it. `winner` is null for a trick still in progress, where nobody
// but the picker may look.
function hideUnder(trick, seat, winner, isPicker, revealed) {
  if (!trick?.length) return trick;
  const maySee = revealed || isPicker || (winner !== null && winner === seat);
  if (maySee) return trick;
  return trick.map((t) => (t.under ? { player: t.player, card: t.card, under: true } : t));
}
