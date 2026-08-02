#!/usr/bin/env node
/* ============================================================================
   Exact double-dummy ("full hindsight") grade of ONE decision from a PIMC
   scenario file (see scripts/scenarios/*.mjs and scripts/pimc.mjs).

   This is the opposite extreme from pimc.mjs, on purpose: it uses the WHOLE
   known deal — every hand face up — via engine.js's own gradeAllPlays, the
   same exact solver the app's recap screen uses to flag best/worst plays.
   It answers "was this a mistake given everything", where pimc.mjs answers
   "was this a good decision given only what the player could see". Reading
   both together is the point — see .claude/skills/analyze-sheepshead-hand.

   Reuses the exact same scenario file as pimc.mjs; only `decision` matters
   for which play gets reported (gradeAllPlays grades every real decision in
   the hand, this just prints the one you asked about).

   Usage: node scripts/gradedecision.mjs <scenario-file.mjs>
   ========================================================================= */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gradeAllPlays, isTrump } from "../src/engine.js";
import { fmt } from "./pimc.mjs";

function fullHandOf(trickHistory, seat) {
  return trickHistory.flatMap((t) => t.trick).filter((p) => p.player === seat).map((p) => p.card);
}

// Ground truth: whoever's complete hand actually holds the called card. Not
// sampled here — gradeAllPlays operates on the one true, fully-known deal.
function assignedPartner({ picker, calledSuit, calledRank = "A", trickHistory }) {
  if (!calledSuit) return null;
  for (let p = 0; p < 5; p++) {
    if (p === picker) continue;
    if (fullHandOf(trickHistory, p).some((c) => c.suit === calledSuit && c.rank === calledRank && !isTrump(c))) return p;
  }
  return null;
}

async function main() {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    console.error("Usage: node scripts/gradedecision.mjs <scenario-file.mjs>");
    process.exit(1);
  }
  const mod = await import(pathToFileURL(path.resolve(scenarioPath)).href);
  const scenario = mod.default;
  const partner = assignedPartner(scenario);
  const g = {
    picker: scenario.picker, partner, calledSuit: scenario.calledSuit, calledRank: scenario.calledRank || "A",
    calledUnder: scenario.calledUnder || false, underCard: scenario.underCard || null,
    buried: scenario.buried, alone: !scenario.calledSuit || partner === null,
    scores: [0, 0, 0, 0, 0], doubler: 1, trickHistory: scenario.trickHistory,
  };

  const { decisions, graded } = gradeAllPlays(g);
  const names = scenario.names || ["P0", "P1", "P2", "P3", "P4"];
  const { trickIdx, player } = scenario.decision;

  console.log(`Exact double-dummy grade (full hindsight) — ${names[player]}'s decision, trick ${trickIdx + 1}\n`);
  if (!graded) {
    console.log("Could not grade this hand — the node budget was exceeded (very rare, pathological hand).");
    return;
  }
  const d = decisions.find((x) => x.trickIdx === trickIdx && x.player === player);
  if (!d) {
    console.log("This was a forced play (only one legal card at the time) — nothing to grade.");
    return;
  }
  console.log(`Played: ${fmt(d.card)}  |  cost vs. best: ${d.cost >= 0 ? "+" : ""}${d.cost}  |  swing: ${d.swing}  |  best card: ${fmt(d.bestCard)}\n`);
  console.log("Exact cost of every legal alternative (0 = tied-optimal given the true deal):");
  for (const { card, cost } of d.costs) {
    console.log(`  ${fmt(card).padEnd(5)} cost ${cost >= 0 ? "+" : ""}${cost}`);
  }
}
main();
