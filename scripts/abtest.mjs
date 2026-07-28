#!/usr/bin/env node
/* ============================================================================
   A/B harness for AI tuning.

   The convention the engine's tuning notes are written against: put the
   VARIANT in one seat and the current engine in the other four, deal the same
   hands to both arms, and measure points per seat per hand. A change that only
   looks good when everyone plays it has not been shown to be stronger — it may
   just have changed the game.

   Each deal is played twice, from an identical shuffle:

     control   all five seats on the current engine
     variant   seat S on the variant, the other four unchanged

   and we score seat S in both. Rotating S over all five seats cancels seat
   effects (the dealer rotates, so seats are not symmetric within one hand).
   Repeated over several seeds, because one seed is an anecdote.

   Usage: node scripts/abtest.mjs <hands> [--seeds n] [--opt key=value ...]
     node scripts/abtest.mjs 4000 --seeds 3 --opt shedCheapestWhenLosing=true
     node scripts/abtest.mjs 4000 --seeds 3 --opt overtakeMinGain=0.10
   ========================================================================= */
import {
  freshHand, assignPartner, applyPlay, resolveTrick,
  handStrength, aiBuryAndCall, aiChooseCard, scoreHand,
} from "../src/engine.js";

/* -------- deterministic RNG so both arms see the identical shuffle -------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// freshHand deals off makeDeck()'s own shuffle, so to replay a deal we shuffle
// the hands ourselves from a seeded stream and overwrite what it produced.
function dealWith(rand, dealer) {
  const g = freshHand(dealer, [0, 0, 0, 0, 0], 1);
  const deck = [...g.hands.flat(), ...g.blind];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const hands = [0, 1, 2, 3, 4].map((p) => deck.slice(p * 6, p * 6 + 6));
  return { ...g, hands, blind: deck.slice(30, 32) };
}

/* ------------------------------ one playout ------------------------------ */
// `optsFor(seat)` returns the tuning options that seat plays with.
function playHand(start, optsFor) {
  let g = start;

  while (g.phase === "picking" && g.passes < 5) {
    const idx = g.pickTurn;
    const wants = handStrength(g.hands[idx]) >= 10 || (g.passes === 4 && handStrength(g.hands[idx]) >= 8);
    if (!wants) { g = { ...g, passes: g.passes + 1, pickTurn: (idx + 1) % 5 }; continue; }
    const eight = [...g.hands[idx], ...g.blind];
    const { buried, call, hand } = aiBuryAndCall(eight);
    g = assignPartner({
      ...g, picker: idx, buried, calledSuit: call,
      hands: g.hands.map((h, i) => (i === idx ? hand : h)),
      phase: "playing", trick: [], turn: g.leader,
    });
  }
  if (g.phase !== "playing") return null;   // thrown in — no score to compare

  let guard = 0;
  while (g.phase === "playing" && guard++ < 60) {
    const idx = g.turn;
    if (idx < 0) { g = resolveTrick(g); continue; }
    g = applyPlay(g, idx, aiChooseCard(g, idx, optsFor(idx)));
    if (g.trick.length === 5) g = resolveTrick(g);
  }
  if (g.phase !== "handEnd") return null;
  return scoreHand(g).result.handDelta;
}

/* --------------------------------- main ---------------------------------- */
const args = process.argv.slice(2);
const hands = parseInt(args[0] || "2000", 10);
const seedArg = args.indexOf("--seeds");
const seeds = seedArg >= 0 ? parseInt(args[seedArg + 1], 10) : 3;

const variant = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--opt") continue;
  const [k, v] = args[i + 1].split("=");
  variant[k] = v === "true" ? true : v === "false" ? false : Number(v);
}

const NONE = () => ({});
console.log(`variant: ${JSON.stringify(variant)}`);
console.log(`${hands} hands x ${seeds} seeds, variant in one seat against four unchanged\n`);

const perSeed = [];
for (let seed = 1; seed <= seeds; seed++) {
  const rand = mulberry32(seed * 7919);
  let deltaSum = 0, counted = 0, skipped = 0;
  for (let h = 0; h < hands; h++) {
    const dealer = h % 5;
    const seat = h % 5;                       // rotate which seat carries it
    const start = dealWith(rand, dealer);
    const control = playHand(start, NONE);
    const test = playHand(start, (p) => (p === seat ? variant : {}));
    if (!control || !test) { skipped++; continue; }
    deltaSum += test[seat] - control[seat];
    counted++;
  }
  const per = deltaSum / counted;
  perSeed.push(per);
  console.log(`  seed ${seed}: ${per >= 0 ? "+" : ""}${per.toFixed(4)} per seat per hand   (${counted} scored, ${skipped} skipped)`);
}

const mean = perSeed.reduce((a, b) => a + b, 0) / perSeed.length;
const ahead = perSeed.filter((d) => d > 0).length;
console.log(`\n  mean ${mean >= 0 ? "+" : ""}${mean.toFixed(4)}/seat/hand, ahead in ${ahead} of ${perSeed.length} seeds`);
