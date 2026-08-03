#!/usr/bin/env node
/* ============================================================================
   Mine exported hands for places a human outplays the engine.

   The premise: at every decision, `gradeAllPlays` gives an exact double-dummy
   cost. Replaying the same hand and asking what the engine would have chosen
   gives a second cost. Where the two differ, the difference is a measurement —
   and because the human and the four AI seats face the SAME deal, comparing
   them within a hand removes nearly all the luck that makes per-hand scores
   useless for judging play.

   What comes out is not a fix. It is a ranked list of position-shapes where a
   human systematically does better, which is a place to go looking. Both AI
   fixes shipped this week were found this way by hand, from screenshots; this
   does the same reading mechanically.

   Three things to hold onto when reading the output:

     Double-dummy cost is biased AGAINST play that is correct under
     uncertainty — it judges with every hand visible. Comparing human against
     engine inside the same hands is what makes that survivable, since the bias
     falls on both. A cluster where the human "wins" may be a cluster where DD
     is simply wrong about both of you.

     A human may beat the engine by exploiting it rather than by playing well.
     For the purpose of improving the engine that is a feature.

     A cluster is a hypothesis. It still has to be reproduced against the
     engine, pinned with a negative control, and measured on the decisions it
     changes — never on a whole-hand aggregate, which is too coarse to see a
     rule that fires on under 1% of decisions.

   Usage:
     node scripts/minehands.mjs <hands.json> [--seat N]
     node scripts/minehands.mjs --selftest [hands]

   The JSON comes from `noschnitzExportHands()` in the browser console.
   ========================================================================= */
import { readFileSync } from "node:fs";
import {
  applyPlay, resolveTrick, legalPlays, aiChooseCard, gradeAllPlays, cid, NAMES,
} from "../src/engine.js";
import { rebuild, features, selfTestHands } from "./lib/handlog.js";

const args = process.argv.slice(2);
const selftest = args.includes("--selftest");
const seatArg = args.indexOf("--seat");
const WANT_SEAT = seatArg >= 0 ? Number(args[seatArg + 1]) : null;
// An exact grade of every decision in a hand costs seconds, not milliseconds —
// measured at ~24s a hand on a slow box — so a corpus of any size outlives any
// job timeout. `--budget-min` stops taking new hands once the clock is spent and
// says how far it got, which is the difference between a truncated run and a run
// that looks complete. Unset means no limit, which is right at a terminal.
const budgetArg = args.indexOf("--budget-min");
const BUDGET_MS = budgetArg >= 0 ? Number(args[budgetArg + 1]) * 60_000 : Infinity;
const startedAt = Date.now();

/* ---- rebuilding, feature buckets and the self-test: scripts/lib/handlog.js ----*/

/* ------------------------------- the mine --------------------------------- */
const rows = [];
let handsSeen = 0, handsGraded = 0, decisionsSeen = 0, disagreements = 0, skippedForBudget = 0;

function mineHand(rec) {
  handsSeen++;
  const g = rebuild(rec);
  const { decisions, graded } = gradeAllPlays(g);
  // An ungraded hand is not a clean one. Counting it as such would drag every
  // average toward zero, which is exactly the bias this is trying to detect.
  if (!graded) return;
  handsGraded++;

  const seat = WANT_SEAT ?? rec.humanSeat ?? 0;
  const byKey = new Map();
  for (const d of decisions) byKey.set(`${d.trickIdx}:${d.player}`, d);

  let sim = {
    ...g, phase: "playing", hands: g._startingHands.map((h) => [...h]),
    played: [], trick: [], tricksDone: 0, trickCounts: [0, 0, 0, 0, 0],
    ptsTaken: [0, 0, 0, 0, 0], calledAcePlayed: false, calledSuitLed: false,
    partnerRevealed: false, trickHistory: [], lastTrick: null,
    leader: g.leader, turn: g.leader,
  };

  g.trickHistory.forEach((th, trickIdx) => {
    for (const play of th.trick) {
      const idx = play.player;
      if (idx === seat && legalPlays(sim, idx).length > 1) {
        const d = byKey.get(`${trickIdx}:${idx}`);
        if (d) {
          decisionsSeen++;
          const engineCard = aiChooseCard(sim, idx);
          if (cid(engineCard) !== cid(play.card)) {
            disagreements++;
            // Both costs come from the one solve the grader already ran, so
            // this is a straight comparison of the two cards on the same
            // scale. Positive delta = the human's card lost fewer points.
            const engineCost = d.costs.find((c) => cid(c.card) === cid(engineCard))?.cost;
            if (engineCost === undefined) continue;
            rows.push({
              human: cid(play.card),
              engine: cid(engineCard),
              humanCost: d.cost,
              engineCost,
              delta: engineCost - d.cost,
              bestCard: cid(d.bestCard),
              swing: d.swing,
              feats: features(sim, idx, play.card),
              where: `${NAMES[idx]} trick ${trickIdx + 1}`,
            });
          }
        }
      }
      sim = applyPlay(sim, idx, play.card);
    }
    sim = resolveTrick(sim);
  });
}

/* --------------------------------- run ------------------------------------ */
let records;
if (selftest) {
  const n = Number(args[args.indexOf("--selftest") + 1]) || 40;
  console.log(`self-test: ${n} hands where seat 0 plays a random legal card 25% of the time\n`);
  records = selfTestHands(n);
} else {
  // Skip the values belonging to the flags as well as the flags themselves, so
  // the file can sit either side of them.
  const taken = new Set([seatArg + 1, budgetArg + 1].filter((i) => i > 0));
  const file = args.find((a, i) => !a.startsWith("--") && !taken.has(i));
  if (!file) { console.error("usage: node scripts/minehands.mjs <hands.json> [--seat N]"); process.exit(2); }
  records = JSON.parse(readFileSync(file, "utf8"));
}

// Newest first when the clock is bounded, because a truncated run should keep
// the hands played on the build that is live now — an old hand is graded against
// an engine that no longer exists, and is the first thing you would drop by
// hand. Unbounded runs keep the file's own order, which is chronological.
const order = BUDGET_MS === Infinity ? records : [...records].reverse();
for (const rec of order) {
  if (Date.now() - startedAt > BUDGET_MS) { skippedForBudget++; continue; }
  mineHand(rec);
}

const better = rows.filter((r) => r.delta > 0);
const worse = rows.filter((r) => r.delta < 0);
const level = rows.filter((r) => r.delta === 0);
const net = rows.reduce((s, r) => s + r.delta, 0);
const netGain = (rs) => rs.reduce((s, r) => s + r.delta, 0);

console.log(`${handsSeen} hands read · ${handsGraded} graded · ${decisionsSeen} decisions by the studied seat`);
console.log(`${disagreements} disagreements with the engine\n`);
if (skippedForBudget) {
  console.log(`NOTE: ${skippedForBudget} of ${records.length} hands went unmined — the ${BUDGET_MS / 60_000}-minute budget ran out.`);
  console.log(`      Newest hands were taken first, so what follows describes the most recent ${handsSeen}.\n`);
}
console.log(`  human's card cost less : ${better.length}  (+${netGain(better)} pts)`);
console.log(`  engine's card cost less: ${worse.length}  (${netGain(worse)} pts)`);
console.log(`  same cost either way   : ${level.length}`);
console.log(`  NET                    : ${net >= 0 ? "+" : ""}${net} pts to the human over ${rows.length} disagreements` +
            `  (${(net / Math.max(rows.length, 1)).toFixed(2)} per disagreement)`);

if (!better.length) {
  console.log("\nNothing to mine: the studied seat never beat the engine on a disagreement.");
} else {
  const tally = new Map();
  for (const r of better) for (const f of r.feats) {
    const t = tally.get(f) ?? { n: 0, swing: 0 };
    t.n++; t.swing += r.delta; tally.set(f, t);
  }
  const base = new Map();
  for (const r of rows) for (const f of r.feats) base.set(f, (base.get(f) ?? 0) + 1);

  console.log("\nWhere the human was right and the engine was not — shapes worth looking at:");
  console.log("  feature                        wins   of all disagreements   share    pts gained");
  [...tally.entries()]
    .filter(([, t]) => t.n >= Math.max(3, better.length * 0.08))
    .sort((a, b) => b[1].swing - a[1].swing)
    .slice(0, 14)
    .forEach(([f, t]) => {
      const all = base.get(f) ?? t.n;
      console.log(`  ${f.padEnd(30)} ${String(t.n).padStart(5)} ${String(all).padStart(22)} ${(100 * t.n / all).toFixed(0).padStart(6)}% ${String(t.swing).padStart(13)}`);
    });

  console.log("\n  a few of them:");
  better.sort((a, b) => b.delta - a.delta).slice(0, 6).forEach((r) => {
    console.log(`    ${r.where.padEnd(18)} human ${r.human.padEnd(4)} engine ${r.engine.padEnd(4)} (best ${r.bestCard}; engine cost ${r.engineCost}, human ${r.humanCost})  ${r.feats.slice(0, 4).join(" ")}`);
  });
}

if (selftest) {
  // A noisy seat must come out NET negative. It will still "win" individual
  // disagreements by luck, which is exactly why the count of wins is not the
  // metric and the signed total is.
  const ok = net < 0;
  console.log(`\nself-test: a deliberately noisy seat must be net negative — net ${net >= 0 ? "+" : ""}${net} — ${ok ? "OK" : "FAILED"}`);
  process.exit(ok ? 0 : 1);
}
