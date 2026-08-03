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
       --partner NAME pin a read: only sample worlds where NAME holds the
                      called card, so the read can be priced against not having it
       --no-verify    skip the gradeAllPlays cross-check of the reconstruction
   ========================================================================= */
import { readFileSync } from "node:fs";
import { cid, aiChooseCard, gradeAllPlays, pickerTeamOf } from "../src/engine.js";
import {
  analyse, seatDelta, mean, pairedDiff, show, normalizeSpec,
} from "./lib/pimc.js";

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
const spec = normalizeSpec(JSON.parse(readFileSync(argv[0], "utf8")));

const seatArg = flag("seat", spec.seats[spec.picker]);
const seat = spec.seats.findIndex((n) => n.toLowerCase() === String(seatArg).toLowerCase());
if (seat < 0) throw new Error(`unknown seat ${seatArg} (have ${spec.seats.join(", ")})`);

const partnerArg = flag("partner", null);
const partnerSeat = partnerArg === null ? null : spec.seats.findIndex((n) => n.toLowerCase() === String(partnerArg).toLowerCase());
if (partnerSeat !== null && partnerSeat < 0) throw new Error(`unknown seat ${partnerArg} (have ${spec.seats.join(", ")})`);

const opts = {
  trick: Number(flag("trick", 1)) - 1,
  seat,
  partner: partnerSeat,
  worlds: Number(flag("worlds", 300)),
  seed: Number(flag("seed", 1)),
  passes: !argv.includes("--no-passes"),
  maxTries: 60,
};

const t0 = Date.now();
const r = analyse(spec, opts);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const actual = r.seq[r.at].card;
// Oriented to the DECIDING seat, not to the picker. A defender's best card is
// the one that MINIMISES picker-team points, so sorting and the "best" marker
// have to flip with the side or the table reads exactly backwards.
const onPickerTeam = pickerTeamOf(r.truth).includes(r.viewer);
const side = onPickerTeam ? (r.viewer === r.truth.picker ? "picker" : "partner") : "defender";
const stakes = r.samples.map((col, i) =>
  col.map((v, w) => seatDelta(r.viewer, r.truth.picker, r.worldPartner[w], v, spec.doubler ?? 1)));
const refIdx = r.legal.findIndex((c) => cid(c) === cid(actual));

console.log(`\n${spec.label}`);
console.log(`decision: ${spec.seats[r.viewer]}, trick ${opts.trick + 1} — played ${show(actual)}`);
console.log(`seat:     ${spec.seats[r.viewer]} is a ${side}; points below are the PICKER TEAM's, stake is ${spec.seats[r.viewer]}'s own`);
console.log(`worlds:   ${r.kept} kept of ${r.tries} sampled  (rejected ${r.rejLegal} illegal, ${r.rejPass} pick-strength, ${r.rejCall} call-inconsistent)${opts.passes ? "" : "  [passer filter OFF]"}`);
const pc = r.partnerCount.map((n, p) => (n ? `${spec.seats[p]} ${(100 * n / r.kept).toFixed(0)}%` : null)).filter(Boolean);
console.log(`partner:  ${pc.join("  ")}   (truth: ${spec.seats[r.truth.partner]})${opts.partner === null ? "" : "  [PINNED by read]"}`);
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
const bestPts = onPickerTeam ? Math.max(...rows.map((x) => x.pts)) : Math.min(...rows.map((x) => x.pts));
const bestDD = onPickerTeam ? Math.max(...rows.map((x) => x.dd)) : Math.min(...rows.map((x) => x.dd));

// The answer somebody actually asked for, before the diagnostics. Framed from
// the DECIDING SEAT's side rather than the picker's, because "your side took 42
// points and won 27% of the time" is a sentence you can send to a friend and
// "picker-team points 78" is not — and a defender reading a picker-framed table
// has to invert every number in their head to use it.
const sideOf = (pts) => (onPickerTeam ? pts : 120 - pts);
const sideWin = (w) => (onPickerTeam ? w : 100 - w);
const ordered = [...rows].sort((a, b) => (onPickerTeam ? b.pts - a.pts : a.pts - b.pts));
const who = spec.seats[r.viewer];
// The solo screen names the human seat "You", so possessives have to bend or the
// summary reads "You's side" — small, but this block exists to be pasted to a
// person and that would be the first thing they noticed.
const isYou = who.toLowerCase() === "you";
const subj = isYou ? "you" : who;
const poss = isYou ? "your" : who.endsWith("s") ? `${who}'` : `${who}'s`;
console.log(`If ${subj} had played...        ${poss} side: avg pts of 120   wins the hand`);
for (const x of ordered) {
  const tag = cid(x.card) === cid(actual) ? "(played)" : x === ordered[0] ? "(best)" : "";
  console.log(`  ${show(x.card).padEnd(4)} ${tag.padEnd(9)}${" ".repeat(12)}${sideOf(x.pts).toFixed(1).padStart(8)}${sideWin(x.win).toFixed(1).padStart(15)}%`);
}
const bestRow = ordered[0], playedRow = rows[refIdx];
if (cid(bestRow.card) !== cid(actual)) {
  const gap = pairedDiff(r.samples[refIdx], r.samples[rows.indexOf(bestRow)]);
  const wpp = sideWin(bestRow.win) - sideWin(playedRow.win);
  console.log(`\n  ${show(actual)} cost ${Math.abs(gap.mean).toFixed(1)} ± ${gap.se.toFixed(2)} points against ${show(bestRow.card)}` +
              (Math.abs(wpp) < 0.5 ? ", and made no difference to whether the hand was won."
                                   : `, and ${Math.abs(wpp).toFixed(1)}pp of win rate.`));
} else {
  console.log(`\n  ${show(actual)} was the best card available.`);
}
console.log(`  Averaged over ${r.kept} deals consistent with what ${subj} could see at the time.\n`);

console.log("card    PIMC pts   vs played     win%   schn%   set%   120%   stake   vs played     DD(actual)");
console.log("----   ---------  ------------   -----  ------  -----  -----  ------  -----------  -----------");
for (const x of rows.sort((a, b) => (onPickerTeam ? b.pts - a.pts : a.pts - b.pts))) {
  const mark = cid(x.card) === cid(actual) ? "*" : x.pts === bestPts ? "+" : " ";
  const dTxt = cid(x.card) === cid(actual) ? "     —      " : `${x.d.mean >= 0 ? "+" : ""}${x.d.mean.toFixed(2)} ± ${x.d.se.toFixed(2)}`.padStart(12);
  const dsTxt = cid(x.card) === cid(actual) ? "     —     " : `${x.ds.mean >= 0 ? "+" : ""}${x.ds.mean.toFixed(3)} ± ${x.ds.se.toFixed(3)}`.padStart(11);
  console.log(
    `${(mark + show(x.card)).padEnd(7)}${x.pts.toFixed(2).padStart(9)}  ${dTxt}   ` +
    `${x.win.toFixed(1).padStart(5)}  ${x.sch.toFixed(1).padStart(6)}  ${x.got.toFixed(1).padStart(5)}  ${x.all.toFixed(1).padStart(5)}  ` +
    `${x.st.toFixed(2).padStart(6)}  ${dsTxt}  ${(x.dd.toFixed(0) + (x.dd === bestDD ? " (best)" : "")).padStart(11)}`
  );
}
console.log(`\n* = card actually played   + = PIMC best for the ${side}   points are the PICKER TEAM's, buried included`);
console.log(`stake is ${spec.seats[r.viewer]}'s own hand delta under the house rules; DD(actual) solves the one real deal.\n`);
