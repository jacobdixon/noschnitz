#!/usr/bin/env node
/* ============================================================================
   Head-to-head AI measurement: the working tree against any git revision.

   `npm run simulate` plays one AI against itself and reports aggregate rates.
   That answers "what does the game look like", but it is a poor instrument for
   "is this change an improvement", because both sides get the change and most
   of the effect cancels. Several times over it has failed to distinguish
   settings that turned out to matter, and once reported a change as neutral
   that this harness showed was worth 0.045 points a hand.

   This assigns the two policies to different SEATS and lets them play each
   other. The game is zero-sum across five seats, so the new-policy seats'
   average score per hand *is* the effect size — no baseline subtraction, no
   comparing two separately-run populations, no run-to-run noise between the
   two numbers being differenced. Several seat splits are run because a result
   that is really a seat-position artifact shows up as sign disagreement.

   Read the sign agreement line first and the mean second. Effects here are
   small in absolute terms — a good change is worth one or two hundredths of a
   point per seat per hand — so a mean without 5-of-5 agreement is noise. When
   a change matters, run it twice: three of the four AI changes shipped on
   2026-07-28 moved less than 0.015 and still held their sign across every
   replicate, and two hypotheses that looked good at 100k evaporated at 200k.

   Only card play is compared. Picking uses the working tree's `handStrength`
   and `aiBuryAndCall` for both sides, so a change to those will not show up
   here — measure those with `npm run simulate` instead.

   Usage:
     node scripts/headtohead.mjs <git-ref> [hands-per-split]
     node scripts/headtohead.mjs HEAD 200000
     node scripts/headtohead.mjs v0.19.0 100000
   ========================================================================= */
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  freshHand, assignPartner, applyPlay, resolveTrick, handStrength, aiBuryAndCall,
  aiChooseCard as aiNew,
} from "../src/engine.js";

const ref = process.argv[2];
const N = Number(process.argv[3] || 100000);
if (!ref) {
  console.error("usage: node scripts/headtohead.mjs <git-ref> [hands-per-split]");
  process.exit(2);
}

// `engine.js` has no imports of its own, so a bare copy of any revision loads
// standalone. That is worth preserving — it is what makes comparing two
// versions of the AI a three-line operation instead of a checkout dance.
const dir = mkdtempSync(join(tmpdir(), "h2h-"));
let aiOld;
try {
  const src = execFileSync("git", ["show", `${ref}:src/engine.js`], { encoding: "utf8", maxBuffer: 1 << 26 });
  const path = join(dir, "engine-base.js");
  writeFileSync(path, src);
  ({ aiChooseCard: aiOld } = await import(path));
} catch (e) {
  rmSync(dir, { recursive: true, force: true });
  console.error(`could not load src/engine.js at "${ref}": ${e.message}`);
  process.exit(1);
}

function playHand(dealer, scores, handNum, doubler, isNew) {
  let g = freshHand(dealer, scores, handNum, doubler);
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
  if (g.phase !== "playing") return { thrownIn: true, scores: g.scores };
  while (g.phase === "playing" && g.tricksDone < 6) {
    while (g.trick.length < 5) {
      const seat = g.turn;
      g = applyPlay(g, seat, (isNew[seat] ? aiNew : aiOld)(g, seat));
    }
    g = resolveTrick(g);
  }
  return { thrownIn: false, g };
}

function run(newSeats, numHands, startDealer) {
  const isNew = [0, 1, 2, 3, 4].map((s) => newSeats.includes(s));
  let scores = [0, 0, 0, 0, 0], dealer = startDealer, handNum = 1, doubler = 1;
  let picked = 0, pickerWins = 0;
  for (let i = 0; i < numHands; i++) {
    const res = playHand(dealer, scores, handNum, doubler, isNew);
    // A passed-out hand doubles the next one, so the stake has to ride across
    // iterations or every score here is wrong.
    if (res.thrownIn) { doubler *= 2; } else {
      doubler = 1; picked++;
      scores = res.g.scores;
      if (res.g.result.pickerWins) pickerWins++;
    }
    dealer = (dealer + 1) % 5; handNum++;
  }
  return {
    edge: newSeats.reduce((s, p) => s + scores[p], 0) / newSeats.length / numHands,
    pickerWinRate: pickerWins / (picked || 1),
  };
}

const SPLITS = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]];
console.log(`working tree vs ${ref} — ${N.toLocaleString()} hands per split, ${SPLITS.length} splits`);
console.log("zero-sum across five seats, so a positive number is the working tree winning\n");

const t0 = Date.now();
const edges = [];
for (let r = 0; r < SPLITS.length; r++) {
  const s = SPLITS[r];
  const out = run(s, N, r % 5);
  edges.push(out.edge);
  console.log(
    `  working tree on seats [${s}]   ${out.edge >= 0 ? "+" : ""}${out.edge.toFixed(4)}/seat/hand` +
    `   picker win ${(100 * out.pickerWinRate).toFixed(1)}%`,
  );
}
const mean = edges.reduce((a, b) => a + b, 0) / edges.length;
const ahead = edges.filter((e) => e > 0).length;
console.log(`\n  mean ${mean >= 0 ? "+" : ""}${mean.toFixed(4)}/seat/hand, ahead in ${ahead}/${edges.length} splits`);
if (ahead !== 0 && ahead !== edges.length) {
  console.log("  split sign disagreement — treat as noise until it reproduces at a larger N");
}
console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s`);

rmSync(dir, { recursive: true, force: true });
