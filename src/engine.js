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
    // How safe is it to assume this trick is already won? Previously this
    // only fired for J-club-or-better trump or the literal last card of the
    // trick, which passed up a lot of free points. Now also schmear when the
    // winning trump is any Jack-or-better AND when few enough unseen trump
    // remain relative to how many players still get to act that no one is
    // likely to be sitting on something bigger.
    const remainingToAct = 4 - g.trick.length; // players still to act after me, not counting me
    const oppTrumpLeft = unseenTrumpCount(g, g.hands[idx]);
    const trumpLooksSafe = isTrump(winningCard) && (trumpPower(winningCard) >= 7 || oppTrumpLeft <= remainingToAct);

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

    if ((lastToPlay || trumpLooksSafe) && !speculativeOpening) {
      // A schmear is paid in FAIL points only. Trump is what takes later
      // tricks, and no schmear is worth the trick a trump could win. This used
      // to sort every legal card by card points, and among trump the
      // highest-point card is a Queen (3) ahead of a Jack (2) — so with trump
      // led, the "schmear" threw the strongest card in the game away for one
      // extra point. Reported from a real hand where two seats each dumped a
      // Queen behind an already-unbeatable Q-clubs.
      const schmearable = legal.filter((c) => !isTrump(c) && cardPts(c) > 0);
      if (schmearable.length) {
        return schmearable.sort((a, b) => cardPts(b) - cardPts(a) || power(a) - power(b))[0];
      }
      // Nothing worth paying. Get out of the way as cheaply as possible rather
      // than falling through to the winners logic below and overtaking our own
      // teammate — cheapest by card points first, so a Queen is the last trump
      // we would ever part with.
      return [...legal].sort((a, b) => cardPts(a) - cardPts(b) || power(a) - power(b))[0];
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
  if (pickerWins) {
    if (teamTricks === 6) { mult = 3; label = "No-tricker!"; }
    else if (defPts <= 30) { mult = 2; label = "Schneider!"; }
  } else {
    if (teamTricks === 0) { mult = 3; label = "No-tricker!"; }
    else if (teamPts <= 30) { mult = 2; label = "Schneider!"; }
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
