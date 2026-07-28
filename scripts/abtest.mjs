#!/usr/bin/env node
/* ============================================================================
   Head-to-head A/B harness for card-play changes.

   `npm run simulate` drives all five seats with the same AI, so it answers
   "what do outcomes look like" but cannot answer "is this change stronger" —
   a change that helps pickers and hurts defenders equally moves nothing.
   `npm run aiskilltest` asserts specific behaviours but says nothing about
   whether a behaviour is worth having. This fills the gap, and it is the tool
   that produced the per-seat numbers quoted in engine.js and CHANGELOG.md.

   Method: the variant occupies ONE seat and the baseline the other four. Each
   deal is played six times — once all-baseline as a reference, then once per
   seat with the variant in that seat — so every comparison is on identical
   cards. Picking always uses the baseline, so both runs enter the play phase
   from an identical position and the measurement isolates card play.

   Metric is points/seat/hand: the variant seat's hand score minus the same
   seat's score in the reference run. Because most seat-hands come out
   identical, the pairing kills nearly all the variance — the reported CI is
   computed over the paired differences, not over raw scores, which is why a
   ~0.01 effect is resolvable at 20,000 hands.

   Usage:
     node scripts/abtest.mjs [hands] [seed] --variant <path-to-engine.js>

   Omit --variant to run the null control, which MUST report exactly 0.0000.
   Run that whenever you change this harness: it is the only check that the
   plumbing itself is not introducing a difference.
   ========================================================================= */
import * as B from "../src/engine.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const HANDS = Number(positional[0] || 20000);
const SEED = Number(positional[1] || 12345);
const variantPath = flag("--variant");
const V = variantPath ? await import(variantPath.startsWith(".") || variantPath.startsWith("/")
  ? variantPath : `./${variantPath}`) : B;

// Deterministic dealing. makeDeck() uses Math.random, which would give the
// baseline and variant runs different cards and make the whole thing noise.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deal(rng) {
  const d = B.ALL_CARDS.map((c) => ({ ...c }));
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function setup(deck, dealer) {
  const hands = [[], [], [], [], []];
  let di = 0;
  for (let p = 0; p < 5; p++) for (let k = 0; k < 6; k++) hands[p].push(deck[di++]);
  return {
    phase: "picking", handNum: 1, dealer, hands: hands.map(B.sortHand),
    blind: [deck[di++], deck[di++]], buried: [], picker: null, partner: null,
    partnerRevealed: false, calledSuit: null, calledAcePlayed: false,
    calledSuitLed: false, alone: false, doubler: 1, pickTurn: (dealer + 1) % 5,
    passes: 0, played: [], trick: [], leader: (dealer + 1) % 5, turn: (dealer + 1) % 5,
    tricksDone: 0, trickCounts: [0, 0, 0, 0, 0], ptsTaken: [0, 0, 0, 0, 0],
    lastTrick: null, trickHistory: [], selected: [], scores: [0, 0, 0, 0, 0],
    message: null, result: null,
  };
}

// Baseline picking for both runs, so any divergence is card play alone.
function picking(g) {
  while (g.phase === "picking" && g.passes < 5) {
    const idx = g.pickTurn;
    const hs = B.handStrength(g.hands[idx]);
    if (!(hs >= 10 || (g.passes === 4 && hs >= 8))) {
      g = { ...g, passes: g.passes + 1, pickTurn: (idx + 1) % 5 };
      continue;
    }
    const { buried, call, hand } = B.aiBuryAndCall([...g.hands[idx], ...g.blind]);
    return B.assignPartner({
      ...g, picker: idx, hands: g.hands.map((h, i) => (i === idx ? hand : h)),
      buried, calledSuit: call, phase: "playing", trick: [], turn: g.leader,
    });
  }
  return g;
}

function playOut(g, variantSeat) {
  while (g.phase === "playing" && g.tricksDone < 6) {
    if (g.trick.length === 5) { g = B.resolveTrick(g); continue; }
    const idx = g.turn;
    const choose = idx === variantSeat ? V.aiChooseCard : B.aiChooseCard;
    g = B.applyPlay(g, idx, choose(g, idx));
  }
  return g;
}

const rng = mulberry32(SEED);
const perSeat = [0, 0, 0, 0, 0];
const diffs = [];
let played = 0, changed = 0;

const t0 = Date.now();
for (let i = 0; i < HANDS; i++) {
  const start = picking(setup(deal(rng), i % 5));
  if (start.phase !== "playing") continue; // thrown in — nothing to play
  played++;
  const ref = playOut(start, -1);
  for (let k = 0; k < 5; k++) {
    const d = playOut(start, k).scores[k] - ref.scores[k];
    perSeat[k] += d;
    diffs.push(d);
    if (d !== 0) changed++;
  }
}

const n = diffs.length;
const total = perSeat.reduce((a, b) => a + b, 0);
const mean = total / n;
const variance = diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1);
const se = Math.sqrt(variance / n);

console.log(`A/B: ${variantPath ?? "(null control — expect exactly 0.0000)"}`);
console.log(`  ${played} hands played (seed ${SEED}) in ${Date.now() - t0}ms`);
console.log(`  per-seat delta:  ${perSeat.map((d) => (d / played).toFixed(4)).join("  ")}`);
console.log(`  points/seat/hand: ${mean >= 0 ? "+" : ""}${mean.toFixed(4)}` +
  `  95% CI +/-${(1.96 * se).toFixed(4)}  z=${se ? (mean / se).toFixed(2) : "n/a"}`);
console.log(`  seat-hands changed: ${changed} / ${n} (${(100 * changed / n).toFixed(1)}%)`);
