#!/usr/bin/env node
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
   ========================================================================= */
import { readFileSync } from "node:fs";
import {
  ALL_CARDS, cid, cardPts, legalPlays, applyPlay, resolveTrick,
  assignPartner, solveHandValue, handStrength, aiChooseCard, gradeAllPlays, pickerTeamOf, SUIT_SYM,
} from "../src/engine.js";

/* ------------------------------- plumbing ------------------------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const parseCard = (s) => ({ rank: s.slice(0, -1), suit: s.slice(-1) });
const show = (c) => c.rank + SUIT_SYM[c.suit];
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
    underCard: spec.underCard ? parseCard(spec.underCard) : null,
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
function playSequence(spec) {
  const hands = spec.plays.map((p) => p.map(parseCard));
  let g = initialState(spec, hands, spec.buried.map(parseCard));
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
function replayTo(spec, hands, buried, seq, stop) {
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
function analyse(spec, opts) {
  const { seq, hands: actualHands, final } = playSequence(spec);
  const at = seq.findIndex((s) => s.trick === opts.trick && s.seat === opts.seat);
  if (at < 0) throw new Error(`no decision by ${spec.seats[opts.seat]} in trick ${opts.trick + 1}`);

  const viewer = opts.seat;
  const buriedActual = spec.buried.map(parseCard);
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

  const samples = legal.map(() => []);
  const partnerCount = [0, 0, 0, 0, 0];
  let tries = 0, kept = 0, rejLegal = 0, rejPass = 0;

  while (kept < opts.worlds && tries < opts.worlds * opts.maxTries) {
    tries++;
    const pool = [...unseen];
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
    for (const p of others) hands[p] = [...hands[p], ...pool.slice(di, (di += held[p]))];

    if (opts.passes && passers.some((p) => handStrength(hands[p]) >= PICK_STRENGTH)) { rejPass++; continue; }

    let g;
    try {
      g = replayTo(spec, hands, buried, seq, at);
    } catch (e) {
      if (!(e instanceof Inconsistent)) throw e;
      rejLegal++;
      continue;
    }
    kept++;
    if (g.partner !== null) partnerCount[g.partner]++;

    // One memo per world, shared across that world's legal cards — the
    // positions below sibling moves overlap heavily, which is most of the cost.
    const memo = new Map();
    const budget = { n: 0 };
    legal.forEach((card, i) => {
      samples[i].push(solveHandValue(applyPlay(g, viewer, card), memo, budget) + buriedPts);
    });
  }
  if (!kept) throw new Error("no consistent world found — the info set or the log is wrong");

  return { spec, viewer, legal, samples, ddActual, truth, final, kept, tries, rejLegal, rejPass, partnerCount, at, seq };
}

/* -------------------------------- scoring ------------------------------- */
// Stake for the picker's own seat from a finished point total, mirroring
// scoreHand. teamPts === 120 is treated as the no-tricker case: the picker team
// here can only reach 120 by taking every remaining trick in all but pathological
// lines, and the frequency is reported so it can be checked rather than assumed.
function pickerStake(teamPts, alone, doubler = 1) {
  const pickerWins = teamPts >= 61;
  const defPts = 120 - teamPts;
  let mult = 1;
  if (pickerWins) { if (teamPts === 120) mult = 3; else if (defPts <= 29) mult = 2; }
  else if (teamPts <= 30) mult = 2;
  const stake = mult * doubler * (pickerWins ? 1 : 2);
  return (pickerWins ? 1 : -1) * (alone ? 4 : 2) * stake;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// Paired difference against a reference card, which is the only honest error
// bar here: every card is evaluated on the SAME sampled worlds, so the spread
// of the difference is far tighter than the spread of either mean.
function pairedDiff(a, b) {
  const d = a.map((x, i) => x - b[i]);
  const m = mean(d);
  const v = d.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, d.length - 1);
  return { mean: m, se: Math.sqrt(v / d.length) };
}

/* --------------------------------- main --------------------------------- */
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? def : argv[i + 1];
};
if (!argv.length || argv[0].startsWith("--")) {
  console.error("usage: node scripts/pimc.mjs <hand.json> --trick N --seat NAME [--worlds n] [--seed n] [--no-passes]");
  process.exit(1);
}
const spec = JSON.parse(readFileSync(argv[0], "utf8"));

const seatArg = flag("seat", spec.seats[spec.picker]);
const seat = spec.seats.findIndex((n) => n.toLowerCase() === String(seatArg).toLowerCase());
if (seat < 0) throw new Error(`unknown seat ${seatArg} (have ${spec.seats.join(", ")})`);

const opts = {
  trick: Number(flag("trick", 1)) - 1,
  seat,
  worlds: Number(flag("worlds", 300)),
  seed: Number(flag("seed", 1)),
  passes: !argv.includes("--no-passes"),
  maxTries: 60,
};

const t0 = Date.now();
const r = analyse(spec, opts);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const actual = r.seq[r.at].card;
const alone = r.truth.alone;
const stakes = r.samples.map((s) => s.map((v) => pickerStake(v, alone)));
const refIdx = r.legal.findIndex((c) => cid(c) === cid(actual));

console.log(`\n${spec.label}`);
console.log(`decision: ${spec.seats[r.viewer]}, trick ${opts.trick + 1} — played ${show(actual)}`);
console.log(`worlds:   ${r.kept} kept of ${r.tries} sampled  (rejected ${r.rejLegal} illegal, ${r.rejPass} pick-strength)${opts.passes ? "" : "  [passer filter OFF]"}`);
const pc = r.partnerCount.map((n, p) => (n ? `${spec.seats[p]} ${(100 * n / r.kept).toFixed(0)}%` : null)).filter(Boolean);
console.log(`partner:  ${pc.join("  ")}   (truth: ${spec.seats[r.truth.partner]})`);
// What the shipped heuristic would have done from the same seat. It reads only
// what that seat may know, so it is a fair third opinion — and where it agrees
// with the played card and PIMC disagrees with both, the finding is about the
// ENGINE, not about one player's hand.
const engineCard = aiChooseCard(r.truth, r.viewer);
console.log(`engine:   aiChooseCard would play ${show(engineCard)}`);
console.log(`${r.legal.length} legal cards, ${secs}s\n`);

// The reconstruction is the whole result: analyse the wrong position and every
// number above is confidently wrong. `gradeAllPlays` walks the same hand by an
// entirely separate path, so its exact costs for this decision must equal the
// ones the DD(actual) column implies. A mismatch means the state was rebuilt
// wrong, which is exactly the failure that would otherwise go unnoticed.
if (!argv.includes("--no-verify")) {
  const { decisions, graded } = gradeAllPlays(r.final);
  const d = decisions.find((x) => x.trickIdx === opts.trick && x.player === r.viewer);
  if (!graded) console.log("verify:   hand exceeded the node budget, not cross-checked\n");
  else if (!d) console.log("verify:   forced play, nothing for the grader to compare\n");
  else {
    const onPickerTeam = pickerTeamOf(r.truth).includes(r.viewer);
    const best = onPickerTeam ? Math.max(...r.ddActual) : Math.min(...r.ddActual);
    for (const { card, cost } of d.costs) {
      const v = r.ddActual[r.legal.findIndex((c) => cid(c) === cid(card))];
      const mine = onPickerTeam ? best - v : v - best;
      if (mine !== cost) throw new Error(`reconstruction disagrees with gradeAllPlays on ${show(card)}: ${mine} vs ${cost}`);
    }
    console.log(`verify:   DD costs match gradeAllPlays on all ${d.costs.length} cards\n`);
  }
}

const rows = r.legal.map((card, i) => {
  const pts = mean(r.samples[i]);
  const win = 100 * r.samples[i].filter((v) => v >= 61).length / r.kept;
  const sch = 100 * r.samples[i].filter((v) => 120 - v <= 29).length / r.kept;
  const got = 100 * r.samples[i].filter((v) => v <= 30).length / r.kept;
  const all = 100 * r.samples[i].filter((v) => v === 120).length / r.kept;
  const st = mean(stakes[i]);
  const d = pairedDiff(r.samples[i], r.samples[refIdx]);
  const ds = pairedDiff(stakes[i], stakes[refIdx]);
  return { card, pts, win, sch, got, all, st, d, ds, dd: r.ddActual[i] };
});
const bestPts = Math.max(...rows.map((x) => x.pts));
const bestDD = Math.max(...rows.map((x) => x.dd));

console.log("card    PIMC pts   vs played     win%   schn%   set%   120%   stake   vs played     DD(actual)");
console.log("----   ---------  ------------   -----  ------  -----  -----  ------  -----------  -----------");
for (const x of rows.sort((a, b) => b.pts - a.pts)) {
  const mark = cid(x.card) === cid(actual) ? "*" : x.pts === bestPts ? "+" : " ";
  const dTxt = cid(x.card) === cid(actual) ? "     —      " : `${x.d.mean >= 0 ? "+" : ""}${x.d.mean.toFixed(2)} ± ${x.d.se.toFixed(2)}`.padStart(12);
  const dsTxt = cid(x.card) === cid(actual) ? "     —     " : `${x.ds.mean >= 0 ? "+" : ""}${x.ds.mean.toFixed(3)} ± ${x.ds.se.toFixed(3)}`.padStart(11);
  console.log(
    `${(mark + show(x.card)).padEnd(7)}${x.pts.toFixed(2).padStart(9)}  ${dTxt}   ` +
    `${x.win.toFixed(1).padStart(5)}  ${x.sch.toFixed(1).padStart(6)}  ${x.got.toFixed(1).padStart(5)}  ${x.all.toFixed(1).padStart(5)}  ` +
    `${x.st.toFixed(2).padStart(6)}  ${dsTxt}  ${(x.dd.toFixed(0) + (x.dd === bestDD ? " (best)" : "")).padStart(11)}`
  );
}
console.log("\n* = card actually played   + = PIMC best   points are the PICKER TEAM's, buried included");
console.log("stake is the PICKER's own hand delta under the house rules; DD(actual) solves the one real deal.\n");
