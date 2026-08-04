#!/usr/bin/env node
/* ============================================================================
   Conditional-on-firing A/B harness.

   `abtest.mjs` measures a variant over EVERY hand, which is the right
   instrument for a rule that touches most hands and the wrong one for a rule
   that touches few. A guard that fires on half a percent of hands and is worth
   five points when it does moves the whole-hand aggregate by about 0.03 — a
   number indistinguishable from noise at any sample size this project runs, so
   `abtest` reports "no effect" for a change that is plainly correct. That is
   not a close call being missed; it is the wrong denominator. Two rules in
   engine.js were already tuned this way (see the notes above the fat-trump
   press guard in aiskilltest.mjs), each time with a throwaway script rebuilt
   from scratch. This is that script, kept.

   It plays each deal twice from an identical shuffle, exactly like abtest —
   control with every seat on the current engine, variant with ONE seat carrying
   the option — but it also asks, at every decision that seat makes in the
   control arm, whether the variant option would have chosen a different card.
   That flag is what splits the population:

     firing rate   share of hands where the option changed at least one card
     per firing    mean point delta over only those hands
     overall       the abtest number, printed alongside so the two can be
                   compared rather than confused

   Read the per-firing column with the firing rate next to it: a large per-firing
   delta on a rule that fires twice in ten thousand hands is still a rounding
   error in the game, and a small one that fires constantly is not.

   Detection runs against the CONTROL line of play, so it counts the decisions
   the seat would actually have faced. Once the variant diverges the two arms
   see different positions and "would it differ here" stops being a question
   about the same hand.

   Null-tests to exactly +0.0000 with a zero firing rate, which is what makes a
   small result trustworthy; `npm test` asserts it.

   Usage: node scripts/firingtest.mjs <hands> [--seeds n] --opt key=value ...
     node scripts/firingtest.mjs 20000 --seeds 4 --opt guardFatTrumpBleed=false
   ========================================================================= */
import {
  ALL_CARDS, freshHand, assignPartner, applyPlay, resolveTrick, cid,
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

// Shuffles from ALL_CARDS, a fixed canonical order, NOT from the cards as
// freshHand left them — see the long note on dealWith in abtest.mjs. Shuffling
// an already-shuffled array composes with the unseeded shuffle underneath
// instead of replacing it, which left every "seed" naming a fresh population.
function dealWith(rand, dealer) {
  const g = freshHand(dealer, [0, 0, 0, 0, 0], 1);
  const deck = [...ALL_CARDS];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const hands = [0, 1, 2, 3, 4].map((p) => deck.slice(p * 6, p * 6 + 6));
  return { ...g, hands, blind: deck.slice(30, 32) };
}

// Identical to abtest's, except for `watch`: when set to {seat, opts} it
// records whether those opts would ever have changed that seat's card. The
// probe is read-only — the hand still plays on the card actually chosen.
function playHand(start, optsFor, watch = null) {
  let g = start;
  let fired = false;

  while (g.phase === "picking" && g.passes < 5) {
    const idx = g.pickTurn;
    const wants = handStrength(g.hands[idx]) >= 10 || (g.passes === 4 && handStrength(g.hands[idx]) >= 8);
    if (!wants) { g = { ...g, passes: g.passes + 1, pickTurn: (idx + 1) % 5 }; continue; }
    const eight = [...g.hands[idx], ...g.blind];
    const { buried, call, callRank, callKind, underCard, hand } = aiBuryAndCall(eight);
    g = assignPartner({
      ...g, picker: idx, buried, calledSuit: call,
      calledRank: call === null ? null : callRank,
      calledUnder: callKind === "under",
      underCard: underCard ?? null,
      hands: g.hands.map((h, i) => (i === idx ? hand : h)),
      phase: "playing", trick: [], turn: g.leader,
    });
  }
  if (g.phase !== "playing") return null;

  let guard = 0;
  while (g.phase === "playing" && guard++ < 60) {
    const idx = g.turn;
    if (idx < 0) { g = resolveTrick(g); continue; }
    const chosen = aiChooseCard(g, idx, optsFor(idx));
    if (watch && idx === watch.seat && !fired) {
      if (cid(aiChooseCard(g, idx, watch.opts)) !== cid(chosen)) fired = true;
    }
    g = applyPlay(g, idx, chosen);
    if (g.trick.length === 5) g = resolveTrick(g);
  }
  if (g.phase !== "handEnd") return null;
  return { delta: scoreHand(g).result.handDelta, fired };
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

const perSeedFiring = [];
const perSeedOverall = [];
const perSeedRate = [];
for (let seed = 1; seed <= seeds; seed++) {
  const rand = mulberry32(seed * 7919);
  let firedSum = 0, firedN = 0, allSum = 0, allN = 0, skipped = 0;
  for (let h = 0; h < hands; h++) {
    const dealer = h % 5;
    const seat = h % 5;
    const start = dealWith(rand, dealer);
    const control = playHand(start, NONE, { seat, opts: variant });
    const test = playHand(start, (p) => (p === seat ? variant : {}));
    if (!control || !test) { skipped++; continue; }
    const d = test.delta[seat] - control.delta[seat];
    allSum += d; allN++;
    if (control.fired) { firedSum += d; firedN++; }
  }
  const rate = firedN / allN;
  const perFiring = firedN ? firedSum / firedN : 0;
  const overall = allSum / allN;
  perSeedFiring.push(perFiring); perSeedOverall.push(overall); perSeedRate.push(rate);
  console.log(
    `  seed ${seed}: fired on ${(100 * rate).toFixed(2).padStart(5)}% of hands` +
    `   ${perFiring >= 0 ? "+" : ""}${perFiring.toFixed(3).padStart(7)} per firing` +
    `   (${overall >= 0 ? "+" : ""}${overall.toFixed(4)} overall, ${allN} scored, ${skipped} skipped)`
  );
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const mf = avg(perSeedFiring);
const ahead = perSeedFiring.filter((d) => d > 0).length;
console.log(
  `\n  fires on ${(100 * avg(perSeedRate)).toFixed(2)}% of hands;` +
  ` mean ${mf >= 0 ? "+" : ""}${mf.toFixed(3)}/firing, ahead in ${ahead} of ${perSeedFiring.length} seeds` +
  `\n  (whole-hand aggregate: ${avg(perSeedOverall) >= 0 ? "+" : ""}${avg(perSeedOverall).toFixed(4)}/seat/hand — the abtest number)`
);

// Run with no --opt, this is the null control, and it has to come back exactly
// zero on both columns: an empty variant cannot change a card, so nothing may
// fire and no hand may differ. A harness that drifts off zero here is measuring
// its own nondeterminism, and every small result it has ever reported is void.
// Same contract as coalitiontest's, and `npm test` runs it for the same reason.
//
// And for the same reason it runs only 500 hands: the assertion is exact
// identity, so a larger sample adds precision to a number that must be 0.0000
// either way. 103s at 3000x2 against 18s at 500x2, for the same yes/no.
// Verified passing identically at 200, 500, 1000 and 3000 hands. The breadth
// the bigger sample bought — more deals, more chance of tripping a rare
// nondeterministic branch — moved to .github/workflows/harness-nulls.yml, which
// runs this at full width nightly. Read coalitiontest's note on the same block;
// the reasoning is identical and is written out at greater length there.
if (!Object.keys(variant).length) {
  const clean = avg(perSeedRate) === 0 && perSeedOverall.every((d) => d === 0);
  console.log(clean
    ? "\nPASS — null control is exactly zero and nothing fired; the harness is paired."
    : "\nFAIL — null control moved. The arms are not paired; do not trust any result from this.");
  if (!clean) process.exit(1);
}
