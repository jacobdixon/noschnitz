#!/usr/bin/env node
/* ============================================================================
   Coalition A/B — does a change help the SIDE, not just the seat?

   scripts/abtest.mjs puts the variant in one seat against four unchanged, which
   is the right question for "is this seat playing better". It is the wrong
   question for a rule about co-operating with teammates, because one seat can
   stand down while the other two defenders still contest the trick — the seat
   banks the saving and somebody else pays the cost. Adopt it in all three
   defender seats and that free ride disappears.

   So this deals identical hands to both arms and applies the variant to EVERY
   DEFENDER, scoring the defending side. Paired on the shuffle, like abtest, and
   it null-tests to zero for the same reason.

   Usage: node scripts/coalitiontest.mjs <hands> [--seeds n] [--opt k=v ...]
   ========================================================================= */
import {
  ALL_CARDS, freshHand, assignPartner, applyPlay, resolveTrick,
  handStrength, aiBuryAndCall, aiChooseCard, scoreHand,
} from "../src/engine.js";

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Shuffles from ALL_CARDS, a fixed canonical order, NOT from the cards as
// freshHand left them — see the long note on the same function in abtest.mjs.
// Reshuffling an already-shuffled array composes with the unseeded shuffle
// underneath rather than replacing it, which made these deals unreproducible
// across runs while looking seeded.
function dealWith(rand, dealer) {
  const g = freshHand(dealer, [0, 0, 0, 0, 0], 1);
  const deck = [...ALL_CARDS];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return { ...g, hands: [0, 1, 2, 3, 4].map((p) => deck.slice(p * 6, p * 6 + 6)), blind: deck.slice(30, 32) };
}

// `defenderOpts` is applied to every seat that is NOT on the picker's team.
function playHand(start, defenderOpts) {
  let g = start;
  while (g.phase === "picking" && g.passes < 5) {
    const idx = g.pickTurn;
    const hs = handStrength(g.hands[idx]);
    if (!(hs >= 10 || (g.passes === 4 && hs >= 8))) {
      g = { ...g, passes: g.passes + 1, pickTurn: (idx + 1) % 5 }; continue;
    }
    const { buried, call, callRank, callKind, underCard, hand } = aiBuryAndCall([...g.hands[idx], ...g.blind]);
    g = assignPartner({
      ...g, picker: idx, buried, calledSuit: call,
      calledRank: call === null ? null : callRank,
      calledUnder: callKind === "under", underCard: underCard ?? null,
      hands: g.hands.map((h, i) => (i === idx ? hand : h)),
      phase: "playing", trick: [], turn: g.leader,
    });
  }
  if (g.phase !== "playing") return null;

  const onPickerTeam = (p) => p === g.picker || p === g.partner;
  let guard = 0;
  while (g.phase === "playing" && guard++ < 60) {
    const idx = g.turn;
    if (idx < 0) { g = resolveTrick(g); continue; }
    g = applyPlay(g, idx, aiChooseCard(g, idx, onPickerTeam(idx) ? {} : defenderOpts));
    if (g.trick.length === 5) g = resolveTrick(g);
  }
  if (g.phase !== "handEnd") return null;
  const scored = scoreHand(g);
  const team = [g.picker, ...(g.partner !== null ? [g.partner] : [])];
  const pts = team.reduce((s, p) => s + g.ptsTaken[p], 0) + g.buried.reduce((s, c) => s + (
    { A: 11, "10": 10, K: 4, Q: 3, J: 2 }[c.rank] || 0), 0);
  return { pickerWon: pts >= 61, partnered: g.partner !== null, pickerPts: pts, delta: scored.result.handDelta };
}

const args = process.argv.slice(2);
const hands = parseInt(args[0] || "20000", 10);
const si = args.indexOf("--seeds");
const seeds = si >= 0 ? parseInt(args[si + 1], 10) : 5;
const variant = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--opt") continue;
  const [k, v] = args[i + 1].split("=");
  variant[k] = v === "true" ? true : v === "false" ? false : Number(v);
}
console.log(`defender variant: ${JSON.stringify(variant)}`);
console.log(`${hands} hands x ${seeds} seeds, variant in ALL defender seats\n`);

const per = [];
for (let seed = 1; seed <= seeds; seed++) {
  const rand = mulberry32(seed * 7919);
  let cW = 0, vW = 0, n = 0, cP = 0, vP = 0;
  for (let h = 0; h < hands; h++) {
    const start = dealWith(rand, h % 5);
    const c = playHand(start, {});
    const v = playHand(start, variant);
    if (!c || !v || !c.partnered || !v.partnered) continue;
    n++;
    if (c.pickerWon) cW++;
    if (v.pickerWon) vW++;
    cP += c.pickerPts; vP += v.pickerPts;
  }
  const d = (vW - cW) / n;
  per.push(d);
  console.log(`  seed ${seed}: picker win ${(100 * cW / n).toFixed(2)}% -> ${(100 * vW / n).toFixed(2)}%  ` +
    `(${d >= 0 ? "+" : ""}${(100 * d).toFixed(2)}pp for the PICKER)   ` +
    `picker pts ${(cP / n).toFixed(2)} -> ${(vP / n).toFixed(2)}   n=${n}`);
}
const mean = per.reduce((a, b) => a + b, 0) / per.length;
const good = per.filter((d) => d < 0).length;
console.log(`\n  mean ${(100 * mean).toFixed(2)}pp picker win rate change; ` +
  `DEFENDERS better in ${good} of ${per.length} seeds`);
console.log(`  (negative = defenders gained, which is what a defender-side change must show)`);

// With no variant both arms are the same engine on the same shuffles, so the
// difference must be exactly zero. That is what makes a fraction of a point
// readable as a result rather than as noise — and it is why `npm test` runs
// this with no options: it asserts the harness, not a change.
//
// WHICH IS WHY `npm run coalitiontest` PASSES ONLY 500 HANDS. That looks like a
// weakened test and is not: the assertion is exact identity, not a statistical
// one, so sample size buys precision that an answer of exactly 0.0000 has no
// use for. It cost 127s at 4000x2 and costs 16s at 500x2 — 41% of the whole
// suite's runtime, to re-answer a yes/no question. Verified passing identically
// at 200, 500, 1000 and 4000 hands.
//
// What the sample size DID buy is breadth: more deals mean more chances to trip
// a rare nondeterministic branch in aiChooseCard. That is real, so it still
// happens — nightly and on demand, at full width, in
// .github/workflows/harness-nulls.yml. Do not raise the number here without
// moving it there too, and do not lower it to the point where the pool of deals
// stops covering the endgame solver at all.
//
// Invoking this to MEASURE something is unaffected: pass your own counts, which
// is what the usage line above has always described.
if (!Object.keys(variant).length) {
  if (mean !== 0) {
    console.error(`\nFAIL: null control drifted by ${(100 * mean).toFixed(4)}pp — the harness is not paired.`);
    process.exit(1);
  }
  console.log("\nPASS — null control is exactly zero; the coalition harness is paired.");
}
