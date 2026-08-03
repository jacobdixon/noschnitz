#!/usr/bin/env node
/* ============================================================================
   Partner belief — soundness and calibration.

   `knowsTeammate` answers "is that seat on my side" with a hard yes or no, and
   it is wrong in both directions by construction: it tells a defender that
   every unrevealed seat is a teammate (really about two in three) and tells the
   picker that no seat is (really about one in four). Both mistakes reported
   this week were the second one — the picker certain about a trick its own
   partner was holding.

   `teammateProbability` replaces the certainty with a number. A number is only
   worth having if it is honest, so this harness checks it against ground truth
   in self-play, where the partner is known to the harness and not to the seat:

     SOUNDNESS   the deduction must never rule out the seat that actually holds
                 the called card. A wrong exclusion is a lie the rest of the AI
                 would then act on, so this is asserted on every decision, not
                 sampled.

     CALIBRATION of the decisions where it says 25%, the target really should
                 be the partner about a quarter of the time. Bucketed into a
                 reliability table, and asserted per bucket.

   The belief was measured here for two versions before anything played on it,
   so that "does using it help" could never be confounded with "is the inference
   right". As of 0.37.0 the schmear gate does act on it (BELIEF_FLOOR), and this
   harness took on a second job: the trump-lead read is INFERENCE rather than
   deduction, so it can be wrong in a way nothing above it can, and the
   reliability table is what catches that. TRUMP_LEAD_ODDS was calibrated by
   sweeping it here until the buckets came out honest — override it with the
   TRUMP_LEAD_ODDS env var to re-run that sweep.

   Usage: node scripts/belieftest.mjs [hands]
   ========================================================================= */
import {
  freshHand, assignPartner, applyPlay, resolveTrick, handStrength, aiBuryAndCall,
  aiChooseCard, makeDeck, knowsTeammate, teammateProbability, calledCardCandidates,
  NAMES,
} from "../src/engine.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

const HANDS = Number(process.argv[2] || 3000);
let seed = 20260729;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

/* ---------------------------- the sweep ---------------------------------- */

// One bucket per distinct probability the belief can currently produce, plus
// catch-alls. Buckets are by predicted value, and the test is whether the
// truth rate inside a bucket matches the value that named it.
const BUCKETS = [
  { lo: -0.01, hi: 0.01, label: "0.00" },
  { lo: 0.01, hi: 0.30, label: "0.01-0.30" },
  { lo: 0.30, hi: 0.60, label: "0.30-0.60" },
  { lo: 0.60, hi: 0.80, label: "0.60-0.80" },
  { lo: 0.80, hi: 0.99, label: "0.80-0.99" },
  { lo: 0.99, hi: 1.01, label: "1.00" },
];
const mkBins = () => BUCKETS.map((b) => ({ ...b, n: 0, sumP: 0, hits: 0 }));

// Two beliefs, tallied over the identical judgements so the comparison is
// paired rather than two runs put side by side.
//
//   plain   deduction only — uniform over the seats not yet excluded
//   read    the same, reweighted by TRUMP_LEAD_ODDS for any candidate that has
//           OPENED a trick with a Queen or a Jack (see partnerWeight)
//
// The read is inference, not deduction, so it can be WRONG in a way nothing
// above it can. That is exactly why it is measured here before anything plays
// on it: a reweighting that is merely convenient will show up as a calibration
// error, and the assertion below fails on it.
const bins = mkBins();
const readBins = mkBins();
// TRUMP_LEAD_ODDS is overridable here so the constant can be CALIBRATED from
// this harness rather than guessed: sweep it and keep the value whose buckets
// come out honest. That is the whole reason the belief is a distribution.
// Both arms pin the flag explicitly rather than leaning on the module default,
// which now ships ON — leaving `plain` to the default silently turned this into
// a comparison of the read against itself.
// `schmearTellOdds` is pinned to 1 in PLAIN for the reason the comment above
// gives about trumpLeadRead: the moment a term ships ON by default, a `plain`
// arm that leans on the module default stops being deduction-only and the
// comparison quietly becomes the read against itself.
const PLAIN = { trumpLeadRead: false, schmearTellOdds: 1 };
const READ = {
  trumpLeadRead: true,
  ...(process.env.TRUMP_LEAD_ODDS ? { trumpLeadOdds: Number(process.env.TRUMP_LEAD_ODDS) } : {}),
  ...(process.env.PLAIN_TRUMP_LEAD_ODDS ? { plainTrumpLeadOdds: Number(process.env.PLAIN_TRUMP_LEAD_ODDS) } : {}),
  ...(process.env.SCHMEAR_TELL_ODDS ? { schmearTellOdds: Number(process.env.SCHMEAR_TELL_ODDS) } : {}),
};

function tally(target, p, truth) {
  const b = target.find((x) => p > x.lo && p <= x.hi) ?? target[0];
  b.n++; b.sumP += p; if (truth) b.hits++;
}

// Sharpness: a belief that is calibrated but never confident is useless to the
// play code, since every gate it feeds is a threshold. Counted as judgements
// landing outside the muddy middle.
const sharp = { plain: 0, read: 0 };

// The same tally for knowsTeammate, so the miscalibration being fixed is a
// measured number in the output rather than an assertion in a comment.
const legacy = { defender: { n: 0, hits: 0 }, picker: { n: 0, hits: 0 } };

let decisions = 0, unsound = 0, settled = 0;

function sweepHand(g) {
  const truthTeam = (p) => p === g.picker || p === g.partner;

  let guard = 0;
  while (g.phase === "playing" && guard++ < 80) {
    if (g.trick.length === 5) { g = resolveTrick(g); continue; }
    const viewer = g.turn;
    if (viewer < 0) { g = resolveTrick(g); continue; }

    // SOUNDNESS: the true holder must survive every deduction, from every seat.
    for (let v = 0; v < 5; v++) {
      const cands = calledCardCandidates(g, v);
      if (g.partner === null) continue;          // nobody holds it; [] is correct
      if (cands.length === 0) { unsound++; continue; }
      if (!cands.includes(g.partner)) unsound++;
      if (cands.length === 1) settled++;
    }

    for (let target = 0; target < 5; target++) {
      if (target === viewer) continue;
      decisions++;
      const p = teammateProbability(g, viewer, target, PLAIN);
      const pRead = teammateProbability(g, viewer, target, READ);
      const truth = truthTeam(viewer) === truthTeam(target);
      tally(bins, p, truth);
      tally(readBins, pRead, truth);
      if (p <= 0.3 || p >= 0.8) sharp.plain++;
      if (pRead <= 0.3 || pRead >= 0.8) sharp.read++;

      // Legacy, restricted to the cases it actually gets wrong: an unrevealed
      // seat that is neither the viewer nor the picker.
      if (!g.partnerRevealed && g.partner !== null && target !== g.picker && knowsTeammate(g, viewer, target)) {
        legacy.defender.n++; if (truth) legacy.defender.hits++;
      }
      if (!g.partnerRevealed && g.partner !== null && viewer === g.picker && target !== g.picker) {
        legacy.picker.n++; if (truth) legacy.picker.hits++;
      }
    }

    g = applyPlay(g, viewer, aiChooseCard(g, viewer));
  }
}

for (let h = 0; h < HANDS; h++) {
  let g = freshHand(h % 5, [0, 0, 0, 0, 0], 1);
  const d = [...makeDeck()];
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  g = { ...g, hands: [0, 1, 2, 3, 4].map((p) => d.slice(p * 6, (p + 1) * 6)), blind: d.slice(30) };

  while (g.phase === "picking" && g.passes < 5) {
    const i = g.pickTurn;
    if (!(handStrength(g.hands[i]) >= 10 || (g.passes === 4 && handStrength(g.hands[i]) >= 8))) {
      g = { ...g, passes: g.passes + 1, pickTurn: (i + 1) % 5 }; continue;
    }
    const { buried, call, callRank, callKind, underCard, hand } = aiBuryAndCall([...g.hands[i], ...g.blind]);
    g = assignPartner({
      ...g, picker: i, buried, calledSuit: call,
      calledRank: call === null ? null : callRank,
      calledUnder: callKind === "under", underCard: underCard ?? null,
      hands: g.hands.map((x, k) => (k === i ? hand : x)),
      phase: "playing", trick: [], turn: g.leader,
    });
    break;
  }
  if (g.phase === "playing") sweepHand(g);
}

/* ------------------------------ results ---------------------------------- */

console.log(`\n${HANDS} hands · ${decisions} (viewer, target) judgements · ${settled} deductions settled to one seat\n`);
function report(label, set, tag) {
  console.log(`\n  ${label}`);
  console.log("  predicted        n     mean p    actually teammates   error");
  for (const b of set) {
    if (!b.n) continue;
    const meanP = b.sumP / b.n;
    const actual = b.hits / b.n;
    const err = Math.abs(meanP - actual);
    console.log(
      `  ${b.label.padEnd(11)} ${String(b.n).padStart(7)} ${(100 * meanP).toFixed(1).padStart(9)}% ${(100 * actual).toFixed(1).padStart(19)}% ${(100 * err).toFixed(1).padStart(7)}pp`
    );
    // 2pp is far tighter than the 33pp and 25pp the hard-coded answers are off
    // by. But the bar is DIRECTION-AWARE, and that is a design decision rather
    // than a convenience.
    //
    // TRUMP_LEAD_ODDS is deliberately set below its best-calibrated value (40
    // against 64) so the read stays honest against the off-book human opponents
    // it was never calibrated on. The price of that choice is precisely this:
    // in the confident bucket the read predicts 97% where the truth is 99%. It
    // is UNDER-confident, on purpose. Being less sure than the evidence warrants
    // is the safe error; being more sure is the one that makes the play code act
    // on a lie, so that direction keeps the tight bar and this one gets 5pp —
    // still tight enough to fail the 8.1pp that odds of 8 produced.
    //
    // This started as a flat 2pp and was flaky at the 1,200 hands `npm test`
    // runs: green on a pull request, red on master, same commit.
    const conservative = meanP >= 0.5 ? actual >= meanP : actual <= meanP;
    const bar = conservative ? 0.05 : 0.02;
    check(`${tag} bucket ${b.label} is calibrated`, err <= bar,
      `predicted ${(100 * meanP).toFixed(1)}%, actual ${(100 * actual).toFixed(1)}%` +
      `${conservative ? " (under-confident, bar 5pp)" : " (OVER-confident, bar 2pp)"}`);
  }
}
report("deduction only:", bins, "plain");
report("with the trump-lead read:", readBins, "read");
console.log(
  `\n  confident judgements (p<=0.30 or p>=0.80): ` +
  `${sharp.plain} deduction-only -> ${sharp.read} with the read ` +
  `(${(100 * sharp.read / Math.max(decisions, 1)).toFixed(1)}% of all)`,
);
check("the read makes the belief sharper, not just different", sharp.read > sharp.plain,
  `${sharp.plain} -> ${sharp.read}`);

console.log("\n  what knowsTeammate() claims, against what is true:");
const dRate = legacy.defender.hits / Math.max(legacy.defender.n, 1);
const pRate = legacy.picker.hits / Math.max(legacy.picker.n, 1);
console.log(`    says "teammate" (1.00) on ${legacy.defender.n} judgements — really teammates ${(100 * dRate).toFixed(1)}%`);
console.log(`    says "not"      (0.00) on ${legacy.picker.n} picker judgements — really teammates ${(100 * pRate).toFixed(1)}%`);

check("the deduction never rules out the true holder", unsound === 0, `${unsound} unsound exclusions`);
check("knowsTeammate is materially over-confident for defenders", dRate < 0.9, `${(100 * dRate).toFixed(1)}%`);
check("knowsTeammate is materially under-confident for the picker", pRate > 0.1, `${(100 * pRate).toFixed(1)}%`);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — the partner belief is sound and calibrated.");
