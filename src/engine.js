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

export function trickSecurity(g, viewer) {
  if (!g.trick.length) return 1;
  const opps = opponentsYetToAct(g, viewer);
  if (!opps.length) return 1;

  // Would this card take the trick if it were played into it now?
  const SENTINEL = -99;
  const takesIt = (card) => trickWinner([...g.trick, { player: SENTINEL, card }]) === SENTINEL;

  const seen = new Set([...seenCards(g), ...g.hands[viewer]].map(cid));
  const unseen = ALL_CARDS.filter((c) => !seen.has(cid(c)));
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
        if (trumps.length >= 3) return trumps[0]; // real depth, original conservative bar
      }
      if (idx === g.picker && g.calledSuit && !g.calledAcePlayed) {
        const cs = fails.filter((c) => c.suit === g.calledSuit);
        if (cs.length && g.tricksDone >= 2) return cs.sort((a, b) => failPower(a) - failPower(b))[0]; // call for the ace
      }
      if (fails.length) return fails.sort((a, b) => cardPts(a) - cardPts(b) || failPower(a) - failPower(b))[0];
      return trumps[trumps.length - 1];
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
  const trickPts = g.trick.reduce((s, t) => s + cardPts(t.card), 0);
  const lastToPlay = g.trick.length === 4;

  if (mateWinning) {
    // Only pay into a trick our side is actually likely to keep. Below this the
    // points are more often than not being handed to the picker, and the two
    // better options are both below: overtake the teammate, or sit on the
    // points and wait.
    const asIs = trickSecurity(g, idx);
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

      // Nothing worth paying. Get out of the way as cheaply as possible rather
      // than falling through to the winners logic below and overtaking our own
      // teammate — cheapest by card points first, so a Queen is the last trump
      // we would ever part with.
      return [...legal].sort((a, b) => cardPts(a) - cardPts(b) || power(a) - power(b))[0];
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
    if (winners.length && teammateIsCertain) {
      let best = null;
      for (const c of winners) {
        const gain = securityAfterPlay(g, idx, c) - asIs;
        const better =
          !best ||
          gain > best.gain + 1e-9 ||
          (Math.abs(gain - best.gain) <= 1e-9 && power(c) < power(best.card));
        if (better) best = { card: c, gain };
      }
      if (best.gain < OVERTAKE_MIN_GAIN) {
        return [...legal].sort((a, b) => cardPts(a) - cardPts(b) || power(a) - power(b))[0];
      }
      return best.card;
    }
  }
  if (winners.length) {
    if (lastToPlay) {
      // cheapest winner, but prefer pointy winner if it's ours anyway
      return winners.sort((a, b) => power(a) - power(b))[0];
    }
    if (trickPts >= 10 || g.tricksDone >= 3) {
      // try to secure with strength
      return winners.sort((a, b) => power(b) - power(a))[0];
    }
    return winners.sort((a, b) => power(a) - power(b))[0];
  }
  // can't win: dump lowest points, lowest power
  return [...legal].sort((a, b) => cardPts(a) - cardPts(b) || power(a) - power(b))[0];
}

/* ------------------------------ Game setup ------------------------------ */
export function freshHand(dealer, scores, handNum) {
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
  const scores = [...g.scores];
  const sign = pickerWins ? 1 : -1;
  if (g.alone || g.partner === null) {
    scores[g.picker] += sign * 4 * mult;
    for (let p = 0; p < 5; p++) if (p !== g.picker) scores[p] -= sign * mult;
  } else {
    scores[g.picker] += sign * 2 * mult;
    scores[g.partner] += sign * 1 * mult;
    for (let p = 0; p < 5; p++) if (!pickerTeam.includes(p)) scores[p] -= sign * mult;
  }
  const handDelta = scores.map((s, i) => s - g.scores[i]);
  return {
    ...g,
    phase: "handEnd",
    scores,
    result: { teamPts, defPts, pickerWins, mult, label, buriedPts, pickerTeam, handDelta },
  };
}

/* ------------------------- Post-hand play grading ------------------------ */
// Rolls a game state forward to hand-end using the built-in AI (aiChooseCard)
// for every remaining decision, on both sides. Deterministic (aiChooseCard
// has no randomness), so this is a cheap single-path counterfactual rather
// than a real search: "if everyone played the built-in AI's way from here,
// how many points would the picker's team end up with?" Because aiChooseCard
// itself calls the exact minimax solver once the last two tricks are
// reached, that precision folds into the rollout automatically — one
// consistent yardstick across the whole hand instead of switching formulas
// partway through, which is what keeps early- and late-trick grades on the
// same scale.
export function rolloutValue(g) {
  let cur = g;
  while (cur.tricksDone < 6) {
    if (cur.trick.length === 5) { cur = resolveTrick(cur); continue; }
    const idx = cur.turn;
    const card = aiChooseCard(cur, idx);
    cur = applyPlay(cur, idx, card);
  }
  return pickerTeamOf(cur).reduce((s, p) => s + cur.ptsTaken[p], 0);
}

// Replays a finished hand from trickHistory and grades every real decision
// (skipping forced plays with only one legal card) by comparing the actual
// card's rollout value against the best and worst legal alternative, from
// the mover's own team's perspective. Returns the single biggest mistake
// ("worst") and the single most impactful correct call ("best" — must have
// cost 0 relative to the best option AND have actually mattered, i.e. the
// legal alternatives weren't all equivalent).
export function gradeHandPlays(g) {
  if (!g.trickHistory || g.trickHistory.length < 6) return { best: null, worst: null };

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
  g.trickHistory.forEach((th, trickIdx) => {
    for (const play of th.trick) {
      const idx = play.player;
      const legal = legalPlays(sim, idx);
      if (legal.length > 1) {
        const isPickerSide = pickerTeamOf(sim).includes(idx);
        const vals = legal.map((card) => ({ card, val: rolloutValue(applyPlay(sim, idx, card)) }));
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
