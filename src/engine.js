/* ================= SHEEPSHEAD ENGINE — Call an Ace, 5-handed =================
   Pure game logic, no React/JSX. Kept separate from Sheepshead.jsx so it can be
   imported by a headless simulation harness (scripts/simulate.mjs) for testing
   AI changes without a browser. */

export const SUITS = ["C", "S", "H", "D"];
export const RANKS = ["7", "8", "9", "K", "10", "A", "J", "Q"];
export const SUIT_SYM = { C: "♣", S: "♠", H: "♥", D: "♦" };
export const SUIT_NAME = { C: "Clubs", S: "Spades", H: "Hearts", D: "Diamonds" };
export const CARD_POINTS = { A: 11, "10": 10, K: 4, Q: 3, J: 2, "9": 0, "8": 0, "7": 0 };
export const NAMES = ["You", "Gus", "Bunny", "Duane", "Patty"];

export const isTrump = (c) => c.rank === "Q" || c.rank === "J" || c.suit === "D";
export const effSuit = (c) => (isTrump(c) ? "T" : c.suit);
export const cardPts = (c) => CARD_POINTS[c.rank];
export const cid = (c) => c.rank + c.suit;

export function trumpPower(c) {
  const qOrder = { C: 14, S: 13, H: 12, D: 11 };
  const jOrder = { C: 10, S: 9, H: 8, D: 7 };
  if (c.rank === "Q") return qOrder[c.suit];
  if (c.rank === "J") return jOrder[c.suit];
  return { A: 6, "10": 5, K: 4, "9": 3, "8": 2, "7": 1 }[c.rank];
}
export const failPower = (c) => ({ A: 6, "10": 5, K: 4, "9": 3, "8": 2, "7": 1 }[c.rank]);
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

  const calledAce = (c) => called && c.suit === called && c.rank === "A" && !isTrump(c);
  const inCalled = (c) => called && !isTrump(c) && c.suit === called;

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
    const follow = hand.filter((c) => effSuit(c) === led);
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

export function aiBuryAndCall(hand) {
  // choose 2 to bury from 8, then a suit to call
  let h = [...hand];
  const fails = () => h.filter((c) => !isTrump(c));
  const suitsHeld = (arr) => {
    const m = { C: [], S: [], H: [] };
    arr.forEach((c) => m[c.suit].push(c));
    return m;
  };
  const callable = (arr, buriedSoFar = []) => {
    const m = suitsHeld(arr.filter((c) => !isTrump(c)));
    return ["C", "S", "H"].filter(
      (s) =>
        m[s].length > 0 &&
        !m[s].some((c) => c.rank === "A") &&
        !buriedSoFar.some((c) => c.suit === s && c.rank === "A")
    );
  };

  const buried = [];
  for (let k = 0; k < 2; k++) {
    const f = fails();
    let pool = f.length ? f : h.filter((c) => trumpPower(c) <= 3); // low diamonds as last resort
    if (!pool.length) pool = [...h].sort((a, b) => power(a) - power(b)).slice(0, 1);
    // prefer high points; avoid destroying the only callable suit
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
  const opts = callable(h, buried);
  let call = null;
  // Go it alone on hand for the 4x multiplier instead of calling a partner:
  // reserved for hands well above the pick threshold (10) — this is the same
  // handStrength() used to decide whether to pick at all, just held to a much
  // higher bar since winning 61+ solo against four defenders is a lot harder
  // than winning it with a secret partner's help.
  const ALONE_HANDSTRENGTH = 17;
  const strongEnoughToGoAlone = handStrength(h) >= ALONE_HANDSTRENGTH;
  if (opts.length && !strongEnoughToGoAlone) {
    const m = suitsHeld(h.filter((c) => !isTrump(c)));
    opts.sort((a, b) => m[a].length - m[b].length);
    call = opts[0];
  }
  return { buried, call, hand: h };
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
export function opponentsYetToAct(g, viewer) {
  const acted = new Set(g.trick.map((t) => t.player));
  const out = [];
  for (let p = 0; p < 5; p++) {
    if (p === viewer || acted.has(p)) continue;
    if (!knowsTeammate(g, viewer, p)) out.push(p);
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
function shedCard(g, idx, legal, wantPoints) {
  const unseen = unaccountedFor(g, idx);
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

export function trickSecurity(g, viewer) {
  if (!g.trick.length) return 1;
  const opps = opponentsYetToAct(g, viewer);
  if (!opps.length) return 1;

  // Would this card take the trick if it were played into it now?
  const SENTINEL = -99;
  const takesIt = (card) => trickWinner([...g.trick, { player: SENTINEL, card }]) === SENTINEL;

  const unseen = unaccountedFor(g, viewer);
  const beaters = unseen.filter(takesIt).length;
  if (!beaters) return 1;

  // How many unknown cards those opponents hold between them.
  const k = opps.reduce((s, p) => s + g.hands[p].length, 0);
  if (!k) return 1;
  if (beaters + k > unseen.length) return 0;

  let safe = 1;
  for (let i = 0; i < k; i++) safe *= (unseen.length - beaters - i) / (unseen.length - i);
  return safe;
}

// What the trick's security becomes if `idx` plays `card` into it — i.e. the
// chance that whoever is winning *after* that card lands still has it at the
// end. Comparing this against the security of leaving the trick alone is how
// the AI decides whether taking a trick off its own side actually buys
// anything.
export function securityAfterPlay(g, idx, card) {
  const next = {
    ...g,
    trick: [...g.trick, { player: idx, card }],
    hands: g.hands.map((h, i) => (i === idx ? h.filter((c) => cid(c) !== cid(card)) : h)),
  };
  return trickSecurity(next, idx);
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

export function solveEndgameCard(g) {
  const idx = g.turn;
  const legal = legalPlays(g, idx);
  if (legal.length <= 1) return legal[0];
  const isPickerSide = pickerTeamOf(g).includes(idx);
  let bestCard = legal[0];
  let bestVal = isPickerSide ? -Infinity : Infinity;
  for (const card of legal) {
    const val = endgameValue(applyPlay(g, idx, card));
    if (isPickerSide ? val > bestVal : val < bestVal) {
      bestVal = val;
      bestCard = card;
    }
  }
  return bestCard;
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
// worth the card. Reported from expert play: the partner led Q-hearts, the
// picker overtook with Q-spades, and Q-clubs took it anyway. From the picker's
// seat Q-hearts and Q-spades were beaten by exactly the same one outstanding
// card, so the overtake bought nothing at all — it just moved the trick from
// his partner's third-best trump onto his own second-best, and lost both.
export const OVERTAKE_MIN_GAIN = 0.15;

export function aiChooseCard(g, idx) {
  // Last two tricks: solve exactly rather than using heuristics.
  if (g.tricksDone >= 4) return solveEndgameCard(g);

  const legal = legalPlays(g, idx);
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
        if (oppTrumpLeft <= 2 && trumps.length >= 2) return trumps[0]; // opponents nearly tapped out — press now
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
  const mateWinning = knowsTeammate(g, idx, winnerSoFar);
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
  const asIs = mateWinning ? trickSecurity(g, idx) : 0;
  const trickLooksSafe = asIs >= SCHMEAR_CONFIDENCE;

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
  const teammateIsCertain =
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
      const schmearable = legal.filter((c) => !isTrump(c) && cardPts(c) > 0);
      if (schmearable.length) {
        return schmearable.sort((a, b) => cardPts(b) - cardPts(a) || power(a) - power(b))[0];
      }

      // No free choice: trump was led, so a trump is going regardless. "Never
      // schmear trump" was the right instinct for the free case and exactly
      // wrong here — it fell through to "cheapest by points", which threw the
      // Q of diamonds (3 points, 4th-highest trump) and kept the 10 (10 points,
      // nearly powerless). Reported from a real hand against a loner. Spending
      // the fat diamond instead is better on both counts at once: seven more
      // points banked AND the stronger card kept. Queens and Jacks are only
      // parted with when they're all that's left, and then the weakest one.
      if (legal.every(isTrump)) {
        const fat = legal.filter((c) => !isPowerTrump(c));
        if (fat.length) {
          return fat.sort((a, b) => cardPts(b) - cardPts(a) || power(a) - power(b))[0];
        }
      }

      // Nothing worth paying. Get out of the way rather than falling through to
      // the winners logic below and overtaking our own teammate.
      return shedCard(g, idx, legal, ourTrick);
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
    if (winners.length && teammateIsCertain) {
      const unseen = unaccountedFor(g, idx);
      const priceOf = (c) => {
        const beaters = cardEquity(g, idx, c, unseen);
        return beaters === 0 ? 4 : beaters === 1 ? 2 : 1;
      };
      const affordable = winners.filter(
        (c) => securityAfterPlay(g, idx, c) - asIs >= OVERTAKE_MIN_GAIN * priceOf(c) - 1e-9,
      );
      if (!affordable.length) return shedCard(g, idx, legal, ourTrick);
      // Cheapest overtake that pays for itself, not the strongest one available.
      return affordable.sort((a, b) => power(a) - power(b))[0];
    }
  }
  if (winners.length) {
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
    const cheapest = (cards) => [...cards].sort((a, b) => power(a) - power(b))[0];
    return cheapest(winners);
  }
  // Can't win it. This is where a seat whose own side owns the trick used to
  // land after failing the safety bar with nothing able to overtake — the exact
  // path that threw a boss Jack to keep a dead Ace. `ourTrick` carries the
  // ownership down here now, so the same shed serves both cases with the sign
  // flipped.
  return shedCard(g, idx, legal, ourTrick);
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
export function callOptions(hand, buried = []) {
  const fails = { C: [], S: [], H: [] };
  hand.filter((c) => !isTrump(c)).forEach((c) => fails[c.suit]?.push(c));

  const holdsTheAce = (su) =>
    fails[su].some((c) => c.rank === "A") ||
    buried.some((c) => c.suit === su && c.rank === "A" && !isTrump(c));

  return ["C", "S", "H"]
    .filter((su) => fails[su].length > 0 && !holdsTheAce(su))
    .map((suit) => ({ kind: "ace", suit }));
}

export function assignPartner(g) {
  if (!g.calledSuit) return { ...g, partner: null, alone: true };
  let partner = null;
  for (let p = 0; p < 5; p++) {
    if (p === g.picker) continue;
    if (g.hands[p].some((c) => c.suit === g.calledSuit && c.rank === "A" && !isTrump(c))) partner = p;
  }
  return { ...g, partner, alone: partner === null };
}

export function applyPlay(g, idx, card) {
  const hands = g.hands.map((h, i) => (i === idx ? h.filter((c) => cid(c) !== cid(card)) : h));
  const trick = [...g.trick, { player: idx, card }];
  let { partnerRevealed, calledAcePlayed, calledSuitLed } = g;
  if (g.calledSuit && !isTrump(card) && card.suit === g.calledSuit) {
    if (trick.length === 1) calledSuitLed = true;
    if (effSuit(trick[0].card) === g.calledSuit) calledSuitLed = true;
    if (card.rank === "A") {
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
  const pts = g.trick.reduce((s, t) => s + cardPts(t.card), 0);
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
  // "No Schneider!" — the losing side failed to get out of schneider, i.e. it
  // finished under 31 while the winners took 90 or more. Both branches are the
  // same event seen from the two sides: defenders held to <= 30, or the picker
  // team held to <= 30.
  if (pickerWins) {
    if (teamTricks === 6) { mult = 3; label = "No-tricker!"; }
    else if (defPts <= 30) { mult = 2; label = "No Schneider!"; }
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
// Grading only looks at decisions from this trick on (0-indexed, so trick 3).
// The cost of an exact solve is set by how many cards are still out, and it
// falls off a cliff: measured over 38 AI-played hands, grading every decision
// from trick 1 costs a median of 4.2s and a p90 of 14.4s (and blows any sane
// node budget on ~10% of hands), from trick 2 a median of 345ms and p90 1.2s,
// and from trick 3 a median of 34ms and p90 88ms. Both call sites run this
// synchronously inside a render, so seconds are not available.
//
// This is a real limitation and not a tuning knob to nudge: a genuine blunder
// in the first two tricks is not graded at all. It is the right trade against
// the alternative, which was reporting mistakes that did not happen. Grading
// the whole hand needs the search off the main thread, not a bigger budget.
const GRADE_FROM_TRICK = 2;

// Backstop only. At trick 3+ the observed worst case was 161ms, nowhere near
// this, so tripping it means something is wrong rather than merely slow.
const DD_NODE_BUDGET = 500_000;

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
      ? g.trick.reduce((s, t) => s + cardPts(t.card), 0)
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
export function gradeHandPlays(g) {
  if (!g.trickHistory || g.trickHistory.length < 6) return { best: null, worst: null };

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
        decisions.push({ trickIdx, player: idx, card: play.card, cost, swing });
      }
      sim = applyPlay(sim, idx, play.card);
    }
    sim = resolveTrick(sim);
  });
  } catch (e) {
    // Only the node budget aborts a grade. Anything else is a real bug and
    // should surface rather than be swallowed into a silent "no mistakes".
    if (!(e instanceof RangeError && e.message === "dd budget")) throw e;
    return { best: null, worst: null };
  }

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

    // Purely a UI scratch field for the local player's card selection; it has
    // no business crossing the wire.
    selected: undefined,
  };
}
