#!/usr/bin/env node
/* ============================================================================
   Rank the corpus by what mistakes actually COST.

   `minehands.mjs` ranks decisions by exact double-dummy cost, and that ranking
   is wrong — not slightly, and not in one direction. Measured on the hand that
   prompted this (scripts/hands/2026-08-02-hand1), inside a single trick:

     the picker's 10 of diamonds   DD said 0    PIMC said 4.3
     a defender's 10 of spades     DD said 6    PIMC said 0.9

   The grader solves the ONE deal that happened, so it scores a play against
   cards nobody could see: it forgives a bad decision that got lucky and
   convicts a sound one that did not. For "did this seat find the best card" it
   is the right tool. For "which mistakes are worth fixing" it is a
   mis-calibrated ruler, and every list sorted by it inherits that.

   So: re-price every decision under uncertainty, bucket by the same coarse
   features `minehands` already uses, and rank the BUCKETS by total PIMC cost.
   One expensive decision is an anecdote; a bucket of them is a rule worth
   changing.

   Three things this is careful about, because each would quietly fake a result:

     - It grades EVERY seat, not the human. The corpus is one human against four
       AI seats, and the AI's own decisions are the ones a fix would change.
       Reported split by role so the two never get conflated.
     - It does not pre-filter to DD-flagged decisions. That would be circular —
       it would discard exactly the class the 10 of diamonds belongs to, where
       DD says zero and the real cost is large.
     - The budget bounds the HANDS, not the decisions within a hand, so no hand
       is half-graded. Whatever it did not reach is reported, per the project's
       no-silent-caps rule.

   Usage:
     node scripts/pimcmine.mjs <hands.json> [--worlds n] [--from-trick n]
     node scripts/pimcmine.mjs --selfplay [hands]      clean engine-vs-engine source
     node scripts/pimcmine.mjs --selftest [hands]      the paired control
       --worlds n      sampled deals per decision (default 60)
       --from-trick n  first trick to price, 1-based (default 3 — see below)
       --budget-min m  stop taking new hands after m minutes
       --seed n        RNG seed
   ========================================================================= */
import { readFileSync } from "node:fs";
import { cid, pickerTeamOf, gradeAllPlays, legalPlays, applyPlay, resolveTrick, aiChooseCard } from "../src/engine.js";
import { analyse, show, specFromRecord } from "./lib/pimc.js";
import { rebuild, features, selfTestHands } from "./lib/handlog.js";

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i < 0 ? def : Number(args[i + 1]); };
const WORLDS = flag("worlds", 60);
// Tricks 1-2 are not skipped to save time alone — AI_PERFECT_PLAY.md §A points
// at 3-6 because that is where the trees are small AND the heuristics weakest.
// A trick-1 decision costs roughly a full-hand solve per sampled world, so
// pricing it at any useful world count is minutes per decision, and the corpus
// would be one hand deep. Reported in the header rather than assumed.
const FROM_TRICK = flag("from-trick", 3) - 1;
const SEED = flag("seed", 1);
const budgetArg = args.indexOf("--budget-min");
const BUDGET_MS = budgetArg >= 0 ? Number(args[budgetArg + 1]) * 60_000 : Infinity;
const selftest = args.includes("--selftest");
const selfplay = args.includes("--selfplay");
const startedAt = Date.now();

/* ------------------------------ the mine --------------------------------- */
let rows = [];
let handsSeen = 0, handsPriced = 0, decisions = 0, skipped = 0, failed = 0;

function mineHand(rec, seats) {
  const spec = specFromRecord(rec, seats);
  if (!spec) { failed++; return; }
  const g = rebuild(rec);
  // The DD costs come from one shared solve of the whole hand, exactly as the
  // recap computes them, so the two columns are the same numbers the app would
  // have shown — this is a comparison of rulers, not of implementations.
  const { decisions: dd, graded } = gradeAllPlays(g);
  if (!graded) { failed++; return; }
  const ddBy = new Map(dd.map((d) => [`${d.trickIdx}:${d.player}`, d]));

  // Walk the hand to recover the position at each decision, for the features.
  let sim = {
    ...g, phase: "playing", hands: g._startingHands.map((h) => [...h]),
    played: [], trick: [], tricksDone: 0, trickCounts: [0, 0, 0, 0, 0],
    ptsTaken: [0, 0, 0, 0, 0], calledAcePlayed: false, calledSuitLed: false,
    partnerRevealed: false, trickHistory: [], lastTrick: null,
    leader: g.leader, turn: g.leader,
  };

  let priced = false;
  g.trickHistory.forEach((th, trickIdx) => {
    for (const play of th.trick) {
      const idx = play.player;
      // `aiChooseCard` dispatches to `solveEndgameCard` from tricks 5-6, which
      // solves the REAL deal — the seat plays with perfect information. Two
      // things follow and both would corrupt this ranking. Its double-dummy
      // cost is 0 by construction, since it played the double-dummy card. And
      // its PIMC "cost" is not an error at all: it measures the gap between the
      // clairvoyant card and the best card under uncertainty, which is the
      // VALUE OF THE INFORMATION, and the seat really has it. Priced separately
      // and kept out of the ranking rather than dropped, because "what would it
      // cost to stop doing that" is a real question — just not this one.
      const clairvoyant = sim.tricksDone >= 4;
      if (trickIdx >= FROM_TRICK && legalPlays(sim, idx).length > 1) {
        const d = ddBy.get(`${trickIdx}:${idx}`);
        if (d) {
          let r;
          try {
            r = analyse(spec, { trick: trickIdx, seat: idx, worlds: WORLDS, seed: SEED,
                                passes: false, partner: null, maxTries: 200 });
          } catch { r = null; }
          if (r) {
            // Oriented to the MOVER's side, like the grader: for the picker's
            // team more picker-team points is better, for a defender fewer is.
            const ours = pickerTeamOf(sim).includes(idx);
            const meanOf = (col) => col.reduce((s, x) => s + x, 0) / col.length;
            const vals = r.samples.map(meanOf);
            const best = ours ? Math.max(...vals) : Math.min(...vals);
            const actualAt = r.legal.findIndex((c) => cid(c) === cid(play.card));
            const pimcCost = ours ? best - vals[actualAt] : vals[actualAt] - best;
            const bestCard = r.legal[vals.indexOf(best)];
            // The same price for the card the ENGINE would have played from
            // this seat, so every row carries a paired comparison. For an AI
            // seat the two are the same card and the excess is exactly zero,
            // which is what makes the control below an exact null rather than
            // a small number somebody has to believe.
            const engineCard = aiChooseCard(sim, idx);
            const engAt = r.legal.findIndex((c) => cid(c) === cid(engineCard));
            const engineCost = engAt < 0 ? null : (ours ? best - vals[engAt] : vals[engAt] - best);
            decisions++; priced = true;
            rows.push({
              role: idx === sim.picker ? "picker" : idx === sim.partner ? "partner" : "defender",
              seat: idx, clairvoyant,
              human: idx === (rec.humanSeat ?? -1),
              pimcCost, ddCost: d.cost, engineCost, engineCard: cid(engineCard),
              excess: engineCost === null ? null : pimcCost - engineCost,
              card: cid(play.card), pimcBest: cid(bestCard), ddBest: cid(d.bestCard),
              feats: features(sim, idx, play.card),
              where: `trick ${trickIdx + 1} seat ${idx}`,
              played: show(play.card), bestShown: show(bestCard),
            });
          }
        }
      }
      sim = applyPlay(sim, idx, play.card);
    }
    sim = resolveTrick(sim);
  });
  if (priced) handsPriced++;
}

/* --------------------------------- run ----------------------------------- */
let records, seats = null;
if (selfplay) {
  const n = Number(args[args.indexOf("--selfplay") + 1]) || 40;
  console.log(`self-play: ${n} clean engine-vs-engine hands (no corpus reachable from a session — see the header)\n`);
  // `selfTestHands` stamps humanSeat 0 because its usual job is the control.
  // With the noise off there is no human at the table, and leaving the stamp on
  // would label an engine seat as one in the report.
  records = selfTestHands(n, 0, flag("seed", 1) * 7919 + 424242).map((r) => ({ ...r, humanSeat: -1 }));
} else if (selftest) {
  const n = Number(args[args.indexOf("--selftest") + 1]) || 12;
  console.log(`self-test: ${n} hands where seat 0 plays a random legal card 25% of the time\n`);
  records = selfTestHands(n);
} else {
  const taken = new Set(["worlds", "from-trick", "seed", "budget-min", "selfplay", "selftest"].map((f) => args.indexOf(`--${f}`) + 1).filter((i) => i > 0));
  const file = args.find((a, i) => !a.startsWith("--") && !taken.has(i));
  if (!file) { console.error("usage: node scripts/pimcmine.mjs <hands.json> [--worlds n]"); process.exit(2); }
  records = JSON.parse(readFileSync(file, "utf8"));
}

// Newest first when bounded, for the reason minehands gives: a truncated run
// should keep the hands played on the build that is live now.
const order = BUDGET_MS === Infinity ? records : [...records].reverse();
for (const rec of order) {
  handsSeen++;
  if (Date.now() - startedAt > BUDGET_MS) { skipped++; continue; }
  mineHand(rec, seats);
}

/* -------------------------------- report ---------------------------------- */
const mins = ((Date.now() - startedAt) / 60_000).toFixed(1);
console.log(`${handsSeen} hands read · ${handsPriced} priced · ${decisions} decisions re-priced under uncertainty`);
console.log(`(${WORLDS} worlds each, tricks ${FROM_TRICK + 1}-6, ${mins} min)`);
if (skipped) console.log(`NOTE: ${skipped} of ${records.length} hands went unpriced — the ${BUDGET_MS / 60_000}-minute budget ran out. Newest first, so this describes the most recent ${handsSeen - skipped}.`);
if (failed) console.log(`NOTE: ${failed} hands could not be graded (node budget or a malformed record) and are excluded rather than counted clean.`);

if (!rows.length) {
  console.log("\nNothing priced.");
  process.exit(selftest ? 1 : 0);
}

const sum = (rs, k) => rs.reduce((s, r) => s + r[k], 0);
const mean = (rs, k) => sum(rs, k) / Math.max(1, rs.length);

// The ranking is over decisions the engine makes UNDER UNCERTAINTY. Everything
// from trick 5 on is a different animal and is reported on its own terms below.
const seen = rows;
const clair = rows.filter((r) => r.clairvoyant);
rows = rows.filter((r) => !r.clairvoyant);
if (!rows.length) { console.log("\nNothing priced outside the clairvoyant endgame."); process.exit(selftest ? 1 : 0); }

console.log(`\n${seen.length} decisions priced; ${clair.length} of them from tricks 5-6, where the engine solves the real deal and is NOT under uncertainty.`);
if (clair.length) {
  console.log(`  those ${clair.length} are excluded from everything below. Their mean DD cost is ${mean(clair, "ddCost").toFixed(2)} — zero by construction, it played the double-dummy card —`);
  console.log(`  and their mean PIMC cost ${mean(clair, "pimcCost").toFixed(2)} is the value of seeing the other hands, not an error to fix.`);
}
console.log(`\n  mean PIMC cost per decision : ${mean(rows, "pimcCost").toFixed(2)} pts`);
console.log(`  mean DD cost per decision   : ${mean(rows, "ddCost").toFixed(2)} pts`);

// The headline claim of this whole exercise, as a measured number rather than
// two anecdotes: how often the two rulers disagree about whether a decision was
// even a mistake. Both directions counted separately, because they are
// different failures — one hides errors, the other invents them.
const ddZeroPimcCostly = rows.filter((r) => r.ddCost === 0 && r.pimcCost >= 1);
const ddCostlyPimcZero = rows.filter((r) => r.ddCost >= 1 && r.pimcCost < 0.5);
console.log(`\n  DD says fine, PIMC says it cost >=1 : ${ddZeroPimcCostly.length} (${(100 * ddZeroPimcCostly.length / rows.length).toFixed(1)}%)  — errors the recap HIDES`);
console.log(`  DD says >=1, PIMC says under 0.5   : ${ddCostlyPimcZero.length} (${(100 * ddCostlyPimcZero.length / rows.length).toFixed(1)}%)  — errors the recap INVENTS`);

// The corpus question minehands asks, asked with the right ruler: not "did the
// human find the best card" but "what did their card cost against the one the
// engine would have played", priced under uncertainty. Positive means the
// engine's card was better.
const paired = rows.filter((r) => r.excess !== null);
if (paired.length) {
  const human = paired.filter((r) => r.human);
  console.log(`\n  cost of the card played vs the card the engine would pick: ${mean(paired, "excess") >= 0 ? "+" : ""}${mean(paired, "excess").toFixed(3)} pts/decision`);
  if (human.length) console.log(`    ...over the ${human.length} decisions by the HUMAN seat: ${mean(human, "excess") >= 0 ? "+" : ""}${mean(human, "excess").toFixed(3)}  (negative = the human outplayed the engine)`);
}

console.log("\nBy role:");
for (const role of ["picker", "partner", "defender"]) {
  const rs = rows.filter((r) => r.role === role);
  if (!rs.length) continue;
  console.log(`  ${role.padEnd(9)} ${String(rs.length).padStart(5)} decisions   mean PIMC ${mean(rs, "pimcCost").toFixed(2)}   mean DD ${mean(rs, "ddCost").toFixed(2)}   total PIMC ${sum(rs, "pimcCost").toFixed(0)}`);
}

// Buckets ranked by TOTAL cost, not mean: a shape that is slightly wrong very
// often is worth more than one that is badly wrong once, and only the total
// says which is which. The minimum count keeps a single expensive decision from
// naming a "class" on its own.
const MIN_N = Math.max(3, Math.round(rows.length * 0.02));
const tally = new Map();
for (const r of rows) for (const f of r.feats) {
  const t = tally.get(f) ?? { n: 0, pimc: 0, dd: 0 };
  t.n++; t.pimc += r.pimcCost; t.dd += r.ddCost; tally.set(f, t);
}
console.log(`\nDecision shapes ranked by TOTAL cost under uncertainty (n >= ${MIN_N}):`);
console.log("  shape                                    n     total PIMC   mean PIMC   mean DD   DD misses by");
[...tally.entries()]
  .filter(([, t]) => t.n >= MIN_N)
  .sort((a, b) => b[1].pimc - a[1].pimc)
  .slice(0, 18)
  .forEach(([f, t]) => {
    const mp = t.pimc / t.n, md = t.dd / t.n;
    console.log(`  ${f.padEnd(38)} ${String(t.n).padStart(5)} ${t.pimc.toFixed(0).padStart(12)} ${mp.toFixed(2).padStart(11)} ${md.toFixed(2).padStart(9)} ${(mp - md >= 0 ? "+" : "") + (mp - md).toFixed(2)}`);
  });

console.log("\nMost expensive individual decisions the recap would NOT have flagged:");
ddZeroPimcCostly.sort((a, b) => b.pimcCost - a.pimcCost).slice(0, 8).forEach((r) => {
  console.log(`  ${r.role.padEnd(9)} ${r.where.padEnd(16)} played ${r.played.padEnd(5)} best ${r.bestShown.padEnd(5)} PIMC ${r.pimcCost.toFixed(1).padStart(5)}  DD 0   ${r.feats.slice(0, 3).join(" ")}`);
});

if (selftest) {
  // The control on the tool, PAIRED: every row also prices the card the engine
  // would have chosen from that same seat in that same position, so the four
  // engine seats must come out at EXACTLY zero excess — they played that card —
  // and the noisy seat, which plays a random legal card a quarter of the time,
  // must come out positive. An unpaired seat-vs-seat gap was the first version
  // and it measured +0.06, which is not a control, it is a coin landing the
  // right way up: seat 0 is also the picker more often than not, so the
  // comparison was mostly about role.
  const paired = rows.filter((r) => r.excess !== null);
  const noisy = paired.filter((r) => r.seat === 0);
  const rest = paired.filter((r) => r.seat !== 0);
  const nullArm = mean(rest, "excess");
  const gap = mean(noisy, "excess");
  // The noisy seat only deviates a quarter of the time, so three rows in four
  // are structurally zero and dilute the mean. The population where the excess
  // CAN be nonzero is the one to read.
  const differing = noisy.filter((r) => r.card !== r.engineCard);
  const gapD = mean(differing, "excess");
  console.log(`\nself-test: engine seats excess over their own choice ${nullArm.toFixed(4)} (must be exactly 0)`);
  console.log(`self-test: noisy seat, all ${String(noisy.length).padStart(3)} decisions          ${gap >= 0 ? "+" : ""}${gap.toFixed(3)}`);
  console.log(`self-test: noisy seat, the ${String(differing.length).padStart(3)} it deviated on    ${gapD >= 0 ? "+" : ""}${gapD.toFixed(3)}`);
  const ok = Math.abs(nullArm) < 1e-9 && gap > 0;
  console.log(`self-test: ${ok ? "OK" : "FAILED"}`);
  process.exit(ok ? 0 : 1);
}
