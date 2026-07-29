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

   Nothing in the engine acts on this yet, which is the point: the belief is
   measured before it is used, so a later "does using it help" result cannot be
   confounded with "is the inference right".

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
const bins = BUCKETS.map((b) => ({ ...b, n: 0, sumP: 0, hits: 0 }));

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
      const p = teammateProbability(g, viewer, target);
      const truth = truthTeam(viewer) === truthTeam(target);
      const b = bins.find((x) => p > x.lo && p <= x.hi) ?? bins[0];
      b.n++; b.sumP += p; if (truth) b.hits++;

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
console.log("  predicted        n     mean p    actually teammates   error");
for (const b of bins) {
  if (!b.n) continue;
  const meanP = b.sumP / b.n;
  const actual = b.hits / b.n;
  const err = Math.abs(meanP - actual);
  console.log(
    `  ${b.label.padEnd(11)} ${String(b.n).padStart(7)} ${(100 * meanP).toFixed(1).padStart(9)}% ${(100 * actual).toFixed(1).padStart(19)}% ${(100 * err).toFixed(1).padStart(7)}pp`
  );
  // 2pp is comfortably inside sampling noise at these counts and far tighter
  // than the 33pp and 25pp the hard-coded answers are off by.
  check(`bucket ${b.label} is calibrated`, err <= 0.02, `predicted ${(100 * meanP).toFixed(1)}%, actual ${(100 * actual).toFixed(1)}%`);
}

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
