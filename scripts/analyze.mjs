#!/usr/bin/env node
/* ============================================================================
   Double-dummy error analysis.

   Plays AI-vs-AI hands and solves every decision in them exactly, then buckets
   the resulting error by trick, by seat role and by decision shape. This is the
   automated form of the hand-reconstruction that produced the 2026-07-28 play
   brief — that took six deals reconstructed from result screens by hand, and
   found defects 200,000 simulated hands had missed. The point of this script is
   that the next six hundred don't need a human.

   Read the output with the same caveats the brief carried. Double dummy gives
   every seat perfect knowledge and perfect coordination, which flatters the
   four defenders more than the picker, and it is ex post — a decision that was
   right for what a seat knew but wrong for the actual layout scores as an
   error. Trick 1 is where the gap between double dummy and any real player is
   widest, so trick-1 totals are the least trustworthy line in the table. What
   the numbers are good for is ranking: which decision shapes leak most, and
   which specific positions to go look at.

   Usage: node scripts/analyze.mjs [hands] [--top N] [--from-trick N]
   ========================================================================= */
import {
  freshHand, assignPartner, applyPlay, resolveTrick, handStrength, aiBuryAndCall,
  aiChooseCard, NAMES,
} from "../src/engine.js";
import { gradeHandExact } from "../src/solver.js";

const args = process.argv.slice(2);
const numArg = args.find((a) => /^\d+$/.test(a));
const HANDS = Number(numArg || 25);
const TOP = Number(args[args.indexOf("--top") + 1]) || 12;
// Solving a trick-1 decision searches the entire hand; a trick-3 decision
// searches a small fraction of it. Skipping the early tricks is what makes a
// run of thousands of hands practical, at the cost of saying nothing about the
// opening — which is exactly where double dummy is least trustworthy anyway.
const FROM = args.includes("--from-trick") ? Number(args[args.indexOf("--from-trick") + 1]) - 1 : 0;

function dealPlayable() {
  for (;;) {
    let g = freshHand(Math.floor(Math.random() * 5), [0, 0, 0, 0, 0], 1);
    while (g.phase === "picking" && g.passes < 5) {
      const i = g.pickTurn;
      const wants = handStrength(g.hands[i]) >= 10 || (g.passes === 4 && handStrength(g.hands[i]) >= 8);
      if (!wants) { g = { ...g, passes: g.passes + 1, pickTurn: (i + 1) % 5 }; continue; }
      const { buried, call, hand } = aiBuryAndCall([...g.hands[i], ...g.blind]);
      g = assignPartner({
        ...g, picker: i, hands: g.hands.map((h, j) => (j === i ? hand : h)),
        buried, calledSuit: call, phase: "playing", trick: [], turn: g.leader,
      });
    }
    if (g.phase === "playing") return g;
  }
}

function playOut(g) {
  while (g.phase === "playing" && g.tricksDone < 6) {
    while (g.trick.length < 5) g = applyPlay(g, g.turn, aiChooseCard(g, g.turn));
    g = resolveTrick(g);
  }
  return g;
}

const all = [];
let graded = 0, nodes = 0;
const t0 = Date.now();
for (let h = 0; h < HANDS; h++) {
  const done = playOut(dealPlayable());
  const res = gradeHandExact(done, { fromTrick: FROM });
  if (!res) continue;
  graded++;
  nodes += res.nodes;
  for (const d of res.decisions) all.push({ ...d, hand: h });
  if ((h + 1) % 5 === 0) {
    const per = (Date.now() - t0) / (h + 1) / 1000;
    process.stderr.write(`  ${h + 1}/${HANDS} hands  (${per.toFixed(1)}s/hand)\r`);
  }
}
const elapsed = (Date.now() - t0) / 1000;
process.stderr.write(" ".repeat(50) + "\r");

const errs = all.filter((d) => d.cost > 0);
const sum = (rows) => rows.reduce((s, d) => s + d.cost, 0);
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");

console.log(`\nSolved ${graded} hands · ${all.length} real decisions · ${nodes.toLocaleString()} nodes`);
console.log(`${elapsed.toFixed(1)}s total, ${(elapsed / graded).toFixed(1)}s/hand\n`);

console.log(`Decisions matching double-dummy best: ${all.length - errs.length}/${all.length} (${pct(all.length - errs.length, all.length)})`);
console.log(`Total DD error: ${sum(errs)} points over ${graded} hands (${(sum(errs) / graded).toFixed(1)}/hand)`);
console.log(`Decisions that flipped the hand result: ${all.filter((d) => d.flipped).length}\n`);

/* -- by trick -------------------------------------------------------------- */
console.log("By trick:");
console.log("  trick   decisions   errors    points   pts/hand");
for (let t = FROM; t < 6; t++) {
  const rows = all.filter((d) => d.trick === t);
  const e = rows.filter((d) => d.cost > 0);
  console.log(`    ${t + 1}   ${String(rows.length).padStart(9)}   ${String(e.length).padStart(6)}   ${String(sum(e)).padStart(7)}   ${(sum(e) / graded).toFixed(2).padStart(8)}`);
}

/* -- by decision shape ----------------------------------------------------- */
console.log("\nBy decision shape:");
console.log("  shape          decisions   errors   err rate    points   pts/hand");
for (const k of ["lead", "win-option", "concede"]) {
  const rows = all.filter((d) => d.kind === k);
  const e = rows.filter((d) => d.cost > 0);
  console.log(`  ${k.padEnd(12)}   ${String(rows.length).padStart(9)}   ${String(e.length).padStart(6)}   ${pct(e.length, rows.length).padStart(8)}   ${String(sum(e)).padStart(7)}   ${(sum(e) / graded).toFixed(2).padStart(8)}`);
}

/* -- by role --------------------------------------------------------------- */
console.log("\nBy role:");
console.log("  role        decisions   errors   err rate    points   pts/hand");
for (const r of ["picker", "partner", "defender"]) {
  const rows = all.filter((d) => d.role === r);
  const e = rows.filter((d) => d.cost > 0);
  console.log(`  ${r.padEnd(9)}   ${String(rows.length).padStart(9)}   ${String(e.length).padStart(6)}   ${pct(e.length, rows.length).padStart(8)}   ${String(sum(e)).padStart(7)}   ${(sum(e) / graded).toFixed(2).padStart(8)}`);
}

/* -- the individual positions worth looking at ----------------------------- */
console.log(`\nLargest ${TOP} errors:`);
console.log("   hand  trick  seat        role      shape       played -> best   cost  flipped");
for (const d of [...errs].sort((a, b) => b.cost - a.cost).slice(0, TOP)) {
  console.log(
    `  ${String(d.hand).padStart(5)}  ${String(d.trick + 1).padStart(5)}  ${NAMES[d.player].padEnd(8)}  ` +
    `${d.role.padEnd(8)}  ${d.kind.padEnd(10)}  ${(`${d.card} -> ${d.bestCard}`).padEnd(14)}  ` +
    `${String(d.cost).padStart(4)}  ${d.flipped ? "yes" : ""}`,
  );
}

/* -- where the concede errors concentrate ---------------------------------- */
const concede = errs.filter((d) => d.kind === "concede");
if (concede.length) {
  console.log(`\nConcede errors by trick: ${[0, 1, 2, 3, 4, 5].map((t) => `t${t + 1}:${concede.filter((d) => d.trick === t).length}`).join("  ")}`);
}
