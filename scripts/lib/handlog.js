/* ============================================================================
   Shared reading of an exported hand record.

   `minehands.mjs` and `pimcmine.mjs` ask different questions of the same
   corpus — one compares a human's card against the engine's, the other prices
   every decision under uncertainty — but they must agree on what a record MEANS
   or their answers cannot be put side by side. Rebuilding, the feature buckets
   and the self-test generator therefore live here once rather than twice.
   ========================================================================= */
import {
  ALL_CARDS, freshHand, assignPartner, applyPlay, resolveTrick, legalPlays,
  trickWinner, handStrength, aiBuryAndCall, aiChooseCard, cardPts, isTrump,
  cardEquity, pickerTeamOf,
} from "../../src/engine.js";

/* ---------------------- rebuilding a recorded hand ------------------------ */
// The record keeps play order, which is enough: dealing every card back to the
// seat that played it reconstructs all five starting hands exactly.
export function rebuild(rec) {
  const hands = [[], [], [], [], []];
  const trickHistory = [];
  for (const tr of rec.tricks) {
    const trick = tr.map(([player, card]) => ({ player, card }));
    for (const p of trick) hands[p.player].push(p.card);
    trickHistory.push({ trick, winner: trickWinner(trick) });
  }
  const g = freshHand(0, [0, 0, 0, 0, 0], rec.handNum ?? 1);
  return {
    ...g,
    phase: "handEnd",
    hands: [[], [], [], [], []],
    blind: [],
    buried: rec.buried ?? [],
    picker: rec.picker,
    partner: rec.partner ?? null,
    alone: Boolean(rec.alone),
    calledSuit: rec.calledSuit ?? null,
    calledRank: rec.calledRank ?? null,
    calledUnder: Boolean(rec.calledUnder),
    underCard: rec.underCard ?? null,
    leader: rec.leader ?? trickHistory[0].trick[0].player,
    trickHistory,
    _startingHands: hands,
  };
}

/* --------------------------- position features ---------------------------- */
// Deliberately coarse and few. Fine-grained buckets on a small corpus invent
// clusters out of noise; these are the shapes the engine actually branches on.
export function features(sim, idx, card) {
  const role = idx === sim.picker ? "picker" : idx === sim.partner ? "partner" : "defender";
  const seatInTrick = sim.trick.length + 1;
  const winner = sim.trick.length ? trickWinner(sim.trick) : null;
  const mine = winner === null ? null : pickerTeamOf(sim).includes(winner) === pickerTeamOf(sim).includes(idx);
  const pot = sim.trick.reduce((s, t) => s + cardPts(t.card), 0);
  return [
    `role=${role}`,
    `trick=${sim.tricksDone + 1}`,
    `seat-in-trick=${seatInTrick}${seatInTrick === 5 ? " (last)" : seatInTrick === 1 ? " (lead)" : ""}`,
    winner === null ? "leading" : `holder=${mine ? "our side" : "opponent"}`,
    `played=${isTrump(card) ? "trump" : "fail"}`,
    `card-boss=${cardEquity(sim, idx, card) === 0}`,
    `pot=${pot === 0 ? "0" : pot <= 10 ? "1-10" : pot <= 20 ? "11-20" : "21+"}`,
  ];
}

/* ------------------------------ self-test --------------------------------- */
// Generates hands where seat 0 plays a random legal card `noise` of the time.
// A miner that cannot detect a deliberately worse player cannot be trusted to
// detect a better one, so this is the control on the tool itself.
//
// `noise = 0` gives clean engine-vs-engine hands instead, which is not a control
// but a SOURCE: the corpus is unreachable from a session, and the thing a fix
// would change is the engine's own play, which self-play supplies without limit.
// What it cannot supply is a human's decisions or the real distribution of
// positions people reach, so a ranking off self-play is about the engine in the
// abstract and the corpus remains the thing to run against.
export function selfTestHands(n, noise = 0.25, seed0 = 424242) {
  let seed = seed0;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  for (let h = 0; out.length < n && h < n * 4; h++) {
    let g = freshHand(h % 5, [0, 0, 0, 0, 0], 1);
    // ALL_CARDS, not makeDeck() — makeDeck shuffles with Math.random, so
    // starting from it made the seed above decorative and every run of this
    // "fixed seed" self-test sampled a different 30 hands. That is how a
    // control passes by luck: three runs of --selftest 30 gave nets of -37,
    // -38 and -45 on identical code, which reads as an effect if you are
    // comparing anything. ALL_CARDS is a fixed order, so the seed now decides
    // the deal on its own.
    const d = [...ALL_CARDS];
    for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
    g = { ...g, hands: [0, 1, 2, 3, 4].map((p) => d.slice(p * 6, (p + 1) * 6)), blind: d.slice(30) };
    while (g.phase === "picking" && g.passes < 5) {
      const i = g.pickTurn;
      if (!(handStrength(g.hands[i]) >= 10 || (g.passes === 4 && handStrength(g.hands[i]) >= 8))) {
        g = { ...g, passes: g.passes + 1, pickTurn: (i + 1) % 5 }; continue;
      }
      const { buried, call, hand } = aiBuryAndCall([...g.hands[i], ...g.blind]);
      g = assignPartner({ ...g, picker: i, buried, calledSuit: call,
        hands: g.hands.map((x, k) => (k === i ? hand : x)), phase: "playing", trick: [], turn: g.leader });
      break;
    }
    if (g.phase !== "playing") continue;
    let guard = 0;
    while (g.phase === "playing" && guard++ < 80) {
      if (g.trick.length === 5) { g = resolveTrick(g); continue; }
      const i = g.turn; if (i < 0) { g = resolveTrick(g); continue; }
      const legal = legalPlays(g, i);
      const card = (i === 0 && noise > 0 && rnd() < noise) ? legal[Math.floor(rnd() * legal.length)] : aiChooseCard(g, i);
      g = applyPlay(g, i, card);
    }
    if (g.phase !== "handEnd") continue;
    out.push({
      humanSeat: 0, handNum: 1, picker: g.picker, partner: g.partner, alone: g.alone,
      calledSuit: g.calledSuit, calledRank: g.calledRank, calledUnder: g.calledUnder,
      underCard: g.underCard, buried: g.buried, leader: g.trickHistory[0].trick[0].player,
      tricks: g.trickHistory.map((th) => th.trick.map((p) => [p.player, p.card])),
    });
  }
  return out;
}
