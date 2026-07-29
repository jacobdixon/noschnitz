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
  freshHand, assignPartner, applyPlay, resolveTrick, legalPlays, aiChooseCard,
  gradeAllPlays, cid, cardPts, isTrump, cardEquity, trickWinner, pickerTeamOf,
  handStrength, aiBuryAndCall, makeDeck, NAMES,
} from "../src/engine.js";

const args = process.argv.slice(2);
const selftest = args.includes("--selftest");
const seatArg = args.indexOf("--seat");
const WANT_SEAT = seatArg >= 0 ? Number(args[seatArg + 1]) : null;

/* ---------------------- rebuilding a recorded hand ------------------------ */
// The record keeps play order, which is enough: dealing every card back to the
// seat that played it reconstructs all five starting hands exactly.
function rebuild(rec) {
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
function features(sim, idx, card) {
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

/* ------------------------------- the mine --------------------------------- */
const rows = [];
let handsSeen = 0, handsGraded = 0, decisionsSeen = 0, disagreements = 0;

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

/* ------------------------------ self-test --------------------------------- */
// Generates hands where seat 0 plays a random legal card a quarter of the
// time. A miner that cannot detect a deliberately worse player cannot be
// trusted to detect a better one, so this is the control on the tool itself.
function selfTestHands(n) {
  let seed = 424242;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  for (let h = 0; out.length < n && h < n * 4; h++) {
    let g = freshHand(h % 5, [0, 0, 0, 0, 0], 1);
    const d = [...makeDeck()];
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
      const card = (i === 0 && rnd() < 0.25) ? legal[Math.floor(rnd() * legal.length)] : aiChooseCard(g, i);
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

/* --------------------------------- run ------------------------------------ */
let records;
if (selftest) {
  const n = Number(args[args.indexOf("--selftest") + 1]) || 40;
  console.log(`self-test: ${n} hands where seat 0 plays a random legal card 25% of the time\n`);
  records = selfTestHands(n);
} else {
  const file = args.find((a) => !a.startsWith("--") && a !== String(WANT_SEAT));
  if (!file) { console.error("usage: node scripts/minehands.mjs <hands.json> [--seat N]"); process.exit(2); }
  records = JSON.parse(readFileSync(file, "utf8"));
}

for (const rec of records) mineHand(rec);

const better = rows.filter((r) => r.delta > 0);
const worse = rows.filter((r) => r.delta < 0);
const level = rows.filter((r) => r.delta === 0);
const net = rows.reduce((s, r) => s + r.delta, 0);
const netGain = (rs) => rs.reduce((s, r) => s + r.delta, 0);

console.log(`${handsSeen} hands read · ${handsGraded} graded · ${decisionsSeen} decisions by the studied seat`);
console.log(`${disagreements} disagreements with the engine\n`);
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
