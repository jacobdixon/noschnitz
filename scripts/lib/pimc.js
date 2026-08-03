/* ============================================================================
   PIMC — Perfect Information Monte Carlo on a single decision.

   AI_PERFECT_PLAY.md §A, applied to one position rather than to the engine:
   sample N complete deals of the unseen cards that are CONSISTENT with what
   the deciding seat actually knows, run the exact double-dummy solver on every
   legal card in every sample, and average. It is what the recap grader is not:
   the grader solves the ONE deal that happened, so it can call a play a mistake
   that was correct under uncertainty. This answers the question the grader
   cannot — "was that right given what I could see?" — and prints both numbers
   side by side so the gap between them is visible.

   Consistency is enforced by REPLAY, not by a list of rules. A sampled world
   gives every seat its real already-played cards plus a sampled remainder; the
   hand is then replayed from trick 1 and the world is thrown away if any card
   somebody actually played would have been illegal in it. That picks up every
   void, the called-ace restrictions and the picker's retain rule for free, and
   it cannot drift from `legalPlays` the way a hand-written filter would.

   Two further filters, both optional and both reported separately because they
   are assumptions rather than observations:

     --passes   seats that passed hold a hand `handStrength` would have passed
                (the AI picks at >= 10), which is real information a strong
                player uses and which pushes power trump toward the seats that
                never had the chance to pick.
     --partner  the called ace is placed uniformly over the seats that could
                hold it; every world therefore names a partner, and worlds
                disagree about who it is. That is the point.

   Caveat worth keeping in view: `solveHandValue` maximises CARD POINTS, so
   each world is scored on a points-optimal line and the stake column converts
   afterwards. Where 61 and 91 sit relative to the mean, that conversion is an
   approximation — read the points column as the primary result.

   Usage:
     node scripts/pimc.mjs <hand.json> --trick N --seat NAME [options]
       --worlds n     sampled deals (default 300)
       --seed n       RNG seed (default 1)
       --no-passes    drop the passer-strength filter
       --partner NAME pin a read: only sample worlds where NAME holds the
                      called card, so the read can be priced against not having it
   ========================================================================= */
import {
  ALL_CARDS, cid, cardPts, legalPlays, applyPlay, resolveTrick,
  assignPartner, solveHandValue, handStrength, callOptions, SUIT_SYM,
} from "../../src/engine.js";

/* ------------------------------- plumbing ------------------------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const parseCard = (s) => ({ rank: s.slice(0, -1), suit: s.slice(-1) });
export const show = (c) => c.rank + SUIT_SYM[c.suit];
const PICK_STRENGTH = 10; // src/Sheepshead.jsx / src/ai-runner.js

class Inconsistent extends Error {}

/* ------------------------- state from a hand log ------------------------- */
// The spec lists each seat's six cards in TRICK order (the recap grid). Play
// order within a trick is implied by who won the previous one, so the sequence
// is derived rather than stored — a stored order could disagree with the cards.
function initialState(spec, hands, buried) {
  return assignPartner({
    phase: "playing",
    handNum: 1,
    dealer: (spec.firstLeader + 4) % 5,
    hands: hands.map((h) => [...h]),
    blind: [],
    buried,
    picker: spec.picker,
    partner: null,
    partnerRevealed: false,
    calledSuit: spec.calledSuit ?? null,
    calledRank: spec.calledRank ?? null,
    calledUnder: !!spec.calledUnder,
    underCard: spec.underCard ?? null,
    calledAcePlayed: false,
    calledSuitLed: false,
    alone: false,
    doubler: spec.doubler ?? 1,
    played: [],
    trick: [],
    leader: spec.firstLeader,
    turn: spec.firstLeader,
    tricksDone: 0,
    trickCounts: [0, 0, 0, 0, 0],
    ptsTaken: [0, 0, 0, 0, 0],
    lastTrick: null,
    trickHistory: [],
    selected: [],
    scores: [0, 0, 0, 0, 0],
    message: null,
    result: null,
  });
}

// Walks the real hand once to get the play ORDER and to sanity-check the log
// against the recap's winners. Everything downstream indexes into this.
export function playSequence(spec) {
  const hands = spec.plays.map((p) => [...p]);
  let g = initialState(spec, hands, [...spec.buried]);
  const seq = [];
  const winners = [];
  for (let t = 0; t < 6; t++) {
    let p = g.leader;
    for (let k = 0; k < 5; k++, p = (p + 1) % 5) {
      const card = hands[p][t];
      const legal = legalPlays(g, p);
      if (!legal.some((c) => cid(c) === cid(card)))
        throw new Error(`log is not legal: ${spec.seats[p]} ${show(card)} at trick ${t + 1}`);
      seq.push({ trick: t, seat: p, card });
      g = applyPlay(g, p, card);
    }
    g = resolveTrick(g);
    winners.push(g.trickHistory[t].winner);
  }
  if (spec.expectedWinners) {
    const got = winners.join(",");
    const want = spec.expectedWinners.join(",");
    if (got !== want) throw new Error(`replayed winners ${got} != recap ${want}`);
  }
  return { seq, hands, final: g, winners };
}

// Replays `seq` up to `stop` in a world where the hands may be sampled. Throws
// Inconsistent the moment a card somebody really played would not have been
// legal — that is the whole consistency check.
export function replayTo(spec, hands, buried, seq, stop) {
  let g = initialState(spec, hands, buried);
  for (let i = 0; i < stop; i++) {
    const { seat, card, trick } = seq[i];
    if (g.trick.length === 0 && g.leader !== seat) throw new Inconsistent("lead order");
    const legal = legalPlays(g, seat);
    if (!legal.some((c) => cid(c) === cid(card))) throw new Inconsistent(`${spec.seats[seat]} ${show(card)} t${trick + 1}`);
    g = applyPlay(g, seat, card);
    if (g.trick.length === 5) g = resolveTrick(g);
  }
  return g;
}

/* --------------------------------- PIMC --------------------------------- */
export function analyse(spec, opts) {
  const { seq, hands: actualHands, final } = playSequence(spec);
  const at = seq.findIndex((s) => s.trick === opts.trick && s.seat === opts.seat);
  if (at < 0) throw new Error(`no decision by ${spec.seats[opts.seat]} in trick ${opts.trick + 1}`);

  const viewer = opts.seat;
  const buriedActual = [...spec.buried];
  const viewerIsPicker = viewer === spec.picker;

  // ---- what the viewer knows -------------------------------------------
  const playedBefore = seq.slice(0, at);
  const seen = new Set(playedBefore.map((s) => cid(s.card)));
  const myHand = actualHands[viewer].filter((c) => !seen.has(cid(c)));
  const known = new Set([...seen, ...myHand.map(cid)]);
  if (viewerIsPicker) buriedActual.forEach((c) => known.add(cid(c)));
  const unseen = ALL_CARDS.filter((c) => !known.has(cid(c)));

  // How many cards each other seat still holds, in seat order.
  const held = [0, 0, 0, 0, 0];
  for (let p = 0; p < 5; p++) held[p] = actualHands[p].filter((c) => !seen.has(cid(c))).length;

  const truth = replayTo(spec, actualHands, buriedActual, seq, at);
  const legal = legalPlays(truth, viewer);
  const buriedPts = buriedActual.reduce((s, c) => s + cardPts(c), 0);

  // ---- the actual deal, for the grader's answer -------------------------
  const ddMemo = new Map();
  const ddBudget = { n: 0 };
  const ddActual = legal.map((card) => solveHandValue(applyPlay(truth, viewer, card), ddMemo, ddBudget) + buriedPts);

  // ---- sampling ---------------------------------------------------------
  const rand = mulberry32(opts.seed);
  const others = [0, 1, 2, 3, 4].filter((p) => p !== viewer);
  const passers = (spec.passers ?? []).filter((p) => p !== viewer);

  // The call itself is evidence, and for a DEFENDER it is most of the evidence
  // about the two cards nobody ever sees. A world that puts the called ace in
  // the picker's hand or in the bury is one where this call was not available,
  // and neither the replay nor any void filter would notice — the hand plays out
  // perfectly legally, it just could not have been called that way. Asking
  // `callOptions` rather than restating its rules keeps under-calls and
  // called-tens right for free, and keeps this from drifting away from the
  // engine the way a second copy of a rule always does.
  const calledKind = spec.calledUnder ? "under" : spec.calledRank === "10" ? "ten" : "ace";
  const callWasAvailable = (hands, buried) =>
    !spec.calledSuit ||
    callOptions(hands[spec.picker], buried).some((o) => o.kind === calledKind && o.suit === spec.calledSuit);

  // A READ, pinned by hand: restrict sampling to worlds where a named seat holds
  // the called card. This is not deduction from the rules — it is what a player
  // concludes from how somebody played, and the harness has no theory of that.
  // Pinning it is how you price the read: run the decision with and without, and
  // the gap is what the inference is worth in points. The card is dealt to that
  // seat rather than sampled and rejected, because rejection on top of the call
  // filter would throw away most of an already thin acceptance rate.
  const pinned = opts.partner ?? null;
  const calledCard = spec.calledSuit
    ? unseen.find((c) => c.suit === spec.calledSuit && c.rank === (spec.calledRank ?? "A"))
    : null;
  if (pinned !== null) {
    if (!spec.calledSuit) throw new Error("--partner is meaningless when the picker went alone");
    if (!calledCard) throw new Error("the called card is already out — the partner is known, not read");
    if (pinned === viewer || pinned === spec.picker) throw new Error(`${spec.seats[pinned]} cannot be the partner`);
    if (!held[pinned]) throw new Error(`${spec.seats[pinned]} has no cards left to hold it`);
  }

  const samples = legal.map(() => []);
  const worldPartner = [];
  const partnerCount = [0, 0, 0, 0, 0];
  let tries = 0, kept = 0, rejLegal = 0, rejPass = 0, rejCall = 0;

  while (kept < opts.worlds && tries < opts.worlds * opts.maxTries) {
    tries++;
    const pool = pinned === null ? [...unseen] : unseen.filter((c) => cid(c) !== cid(calledCard));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    let di = 0;
    const buried = viewerIsPicker ? buriedActual : pool.slice(di, (di += 2));
    // Each seat's ORIGINAL six: what they demonstrably played, plus a sampled
    // remainder. Reconstructing the original hand (not just the remainder) is
    // what lets the replay check legality and the passer filter check strength.
    const hands = [];
    for (let p = 0; p < 5; p++) hands[p] = actualHands[p].filter((c) => seen.has(cid(c)));
    hands[viewer] = [...actualHands[viewer]];
    for (const p of others) {
      const take = held[p] - (p === pinned ? 1 : 0);
      hands[p] = [...hands[p], ...pool.slice(di, (di += take))];
      if (p === pinned) hands[p].push(calledCard);
    }

    if (opts.passes && passers.some((p) => handStrength(hands[p]) >= PICK_STRENGTH)) { rejPass++; continue; }
    if (!callWasAvailable(hands, buried)) { rejCall++; continue; }

    let g;
    try {
      g = replayTo(spec, hands, buried, seq, at);
    } catch (e) {
      if (!(e instanceof Inconsistent)) throw e;
      rejLegal++;
      continue;
    }
    // Belt and braces on the same point: a called suit always has a partner,
    // because the picker cannot hold or bury the card that names one.
    if (spec.calledSuit && g.partner === null) { rejCall++; continue; }
    kept++;
    worldPartner.push(g.partner);
    if (g.partner !== null) partnerCount[g.partner]++;

    // The bury is sampled too when the viewer is not the picker, so its points
    // are part of the world rather than a constant — they belong to the picker
    // team and they move the schneider line.
    const bPts = buried.reduce((s, c) => s + cardPts(c), 0);
    // One memo per world, shared across that world's legal cards — the
    // positions below sibling moves overlap heavily, which is most of the cost.
    const memo = new Map();
    const budget = { n: 0 };
    legal.forEach((card, i) => {
      samples[i].push(solveHandValue(applyPlay(g, viewer, card), memo, budget) + bPts);
    });
  }
  if (!kept) throw new Error("no consistent world found — the info set or the log is wrong");

  return { spec, viewer, legal, samples, worldPartner, ddActual, truth, final, kept, tries, rejLegal, rejPass, rejCall, partnerCount, at, seq };
}

/* -------------------------------- scoring ------------------------------- */
// One seat's hand delta from a finished point total, mirroring scoreHand. The
// seat matters because the sides are not symmetric — the picker collects double
// what the partner does and the defenders each pay one — and for a DEFENDER
// viewer the sign flips, so a card that lowers the picker's points is the good
// one. teamPts === 120 is treated as the no-tricker case: the picker team can
// only reach it by taking every remaining trick in all but pathological lines,
// and the frequency is printed so that can be checked rather than assumed.
export function seatDelta(seat, picker, partner, teamPts, doubler = 1) {
  const pickerWins = teamPts >= 61;
  const defPts = 120 - teamPts;
  let mult = 1;
  if (pickerWins) { if (teamPts === 120) mult = 3; else if (defPts <= 29) mult = 2; }
  else if (teamPts <= 30) mult = 2;
  const stake = mult * doubler * (pickerWins ? 1 : 2);
  const sign = pickerWins ? 1 : -1;
  const alone = partner === null;
  if (seat === picker) return sign * (alone ? 4 : 2) * stake;
  if (seat === partner) return sign * 1 * stake;
  return -sign * stake;
}

export const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// Paired difference against a reference card, which is the only honest error
// bar here: every card is evaluated on the SAME sampled worlds, so the spread
// of the difference is far tighter than the spread of either mean.
export function pairedDiff(a, b) {
  const d = a.map((x, i) => x - b[i]);
  const m = mean(d);
  const v = d.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, d.length - 1);
  return { mean: m, se: Math.sqrt(v / d.length) };
}

/* ------------------------- spec adapters ------------------------- */
// Two callers, two on-disk shapes, one internal one. A hand file writes cards
// as strings because a human types it; an exported corpus record writes them as
// objects and stores tricks in PLAY order rather than by seat. Both normalise to
// the same spec here so the analysis has exactly one input format.
// The ONLY place a card string becomes a card object. Everything below this
// point assumes objects, which is why the analysis has no idea which shape it
// was handed.
export function normalizeSpec(raw) {
  const card = (c) => (typeof c === "string" ? parseCard(c) : c);
  return {
    ...raw,
    buried: (raw.buried ?? []).map(card),
    underCard: raw.underCard ? card(raw.underCard) : null,
    plays: raw.plays.map((h) => h.map(card)),
  };
}

// A record from /api/hands. `tricks` is [[seat, card], ...] per trick, so the
// per-seat view the analysis wants is a transpose. Every seat plays exactly once
// per trick, which is what makes that well defined.
export function specFromRecord(rec, seats) {
  const plays = [[], [], [], [], []];
  rec.tricks.forEach((tr, ti) => {
    for (const [seat, card] of tr) plays[seat][ti] = card;
  });
  if (plays.some((h) => h.length !== 6 || h.some((c) => !c))) return null;
  return normalizeSpec({
    seats: seats ?? ["S0", "S1", "S2", "S3", "S4"],
    picker: rec.picker,
    calledSuit: rec.calledSuit ?? null,
    calledRank: rec.calledRank ?? null,
    calledUnder: Boolean(rec.calledUnder),
    underCard: rec.underCard ?? null,
    buried: rec.buried ?? [],
    firstLeader: rec.leader ?? rec.tricks[0][0][0],
    doubler: rec.doubler ?? 1,
    plays,
  });
}
