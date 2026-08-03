#!/usr/bin/env node
/* ============================================================================
   Paired A/B restricted to the decisions a rule ACTUALLY CHANGES.

   `abtest.mjs` scores every hand, which is right when a change touches most of
   them. It goes blind when a rule fires rarely: divide a real per-firing effect
   by the ~99% of decisions where nothing happened and it lands under the noise
   floor, so the harness reports "no effect" for "effect I cannot see". CLAUDE.md
   already says a cluster must be measured "on the decisions it changes — never
   on a whole-hand aggregate, which is too coarse to see a rule that fires on
   under 1% of decisions"; this is that measurement.

   Built for OVERTAKE_SPEND_SECURITY in 0.49.0, which fires on 0.83% of
   contested decisions. abtest read it as +0.0009 in 4 of 4 seeds, then +0.0002
   in 4 of 8 on a re-run — indistinguishable from zero. Restricted to firings it
   reads +0.0666 +/- 0.0317 over 3,629 of them, and the two agree once the
   dilution is undone: 0.0666 x 0.0057 firings/hand = +0.00038/seat/hand.

   HOW THE RESTRICTION STAYS HONEST. Both arms get the identical deal, and the
   condition is "did the seat's play diverge", which is settled at the decision
   point by the position alone — not by how the hand turned out. Conditioning on
   an OUTCOME (say, hands the variant seat won) would be circular; this is not
   that. Divergence is read by comparing the seat's play sequence between arms,
   so no engine instrumentation is needed and the rule under test needs only an
   `opts` switch.

   Usage:
     node scripts/firingtest.mjs [hands] [seeds] [--opt key=value ...]
     node scripts/firingtest.mjs 30000 22 --opt spendFatSecurity=0.5

   The control arm plays with every listed opt forced OFF (numeric opts to 0,
   boolean to false), so the result does not depend on what the shipped default
   happens to be — run it before and after changing a constant and it measures
   the same thing.

   Null control: pass a variant that cannot fire (e.g. spendFatSecurity=0) and
   it must report 0 firings and exactly +0.0000.
   ========================================================================= */
import {
  ALL_CARDS, freshHand, assignPartner, applyPlay, resolveTrick,
  handStrength, aiBuryAndCall, aiChooseCard, scoreHand, cid,
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
// freshHand left them — see the long note on dealWith in abtest.mjs for what
// that distinction cost.
function dealWith(rand, dealer) {
  const g = freshHand(dealer, [0, 0, 0, 0, 0], 1);
  const deck = [...ALL_CARDS];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return {
    ...g,
    hands: [0, 1, 2, 3, 4].map((p) => deck.slice(p * 6, p * 6 + 6)),
    blind: deck.slice(30, 32),
  };
}

// Returns {delta, cards}; `cards` is watchSeat's play sequence, which is what
// the two arms are compared on to detect a firing.
function playHand(start, optsFor, watchSeat) {
  let g = start;
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

  const cards = [];
  let guard = 0;
  while (g.phase === "playing" && guard++ < 60) {
    const idx = g.turn;
    if (idx < 0) { g = resolveTrick(g); continue; }
    const c = aiChooseCard(g, idx, optsFor(idx));
    if (idx === watchSeat) cards.push(cid(c));
    g = applyPlay(g, idx, c);
    if (g.trick.length === 5) g = resolveTrick(g);
  }
  if (g.phase !== "handEnd") return null;
  return { delta: scoreHand(g).result.handDelta, cards };
}

/* --------------------------------- main ---------------------------------- */
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--") && !/=/.test(a));
const HANDS = parseInt(positional[0] || "20000", 10);
const SEEDS = parseInt(positional[1] || "8", 10);

const variant = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--opt") continue;
  const [k, v] = args[i + 1].split("=");
  variant[k] = v === "true" ? true : v === "false" ? false : Number(v);
}
if (!Object.keys(variant).length) {
  console.error("nothing to test — pass at least one --opt key=value");
  process.exit(1);
}
// Same keys, forced off, so the control does not inherit the shipped default.
const offVariant = Object.fromEntries(
  Object.entries(variant).map(([k, v]) => [k, typeof v === "boolean" ? false : 0]),
);
const NONE = () => offVariant;

console.log(`variant: ${JSON.stringify(variant)}   control: ${JSON.stringify(offVariant)}`);
console.log(`${HANDS} hands x ${SEEDS} seeds, scored ONLY where the variant changed a card\n`);

const perSeed = [];
let totalFired = 0, totalScored = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  const rand = mulberry32(seed * 7919);
  let sum = 0, fired = 0, scored = 0;
  for (let h = 0; h < HANDS; h++) {
    const seat = h % 5;
    const start = dealWith(rand, h % 5);
    const control = playHand(start, NONE, seat);
    const test = playHand(start, (p) => (p === seat ? variant : offVariant), seat);
    if (!control || !test) continue;
    scored++;
    const diverged = control.cards.length !== test.cards.length
      || control.cards.some((c, i) => c !== test.cards[i]);
    if (!diverged) continue;
    fired++;
    sum += test.delta[seat] - control.delta[seat];
  }
  const per = fired ? sum / fired : 0;
  perSeed.push(per);
  totalFired += fired; totalScored += scored;
  console.log(`  seed ${seed}: ${per >= 0 ? "+" : ""}${per.toFixed(4)} per firing   (${fired} firings in ${scored} hands, ${(100 * fired / scored).toFixed(2)}%)`);
}

const mean = perSeed.reduce((a, b) => a + b, 0) / perSeed.length;
const sd = Math.sqrt(perSeed.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, perSeed.length - 1));
const se = sd / Math.sqrt(perSeed.length);
const ahead = perSeed.filter((d) => d > 0).length;
const behind = perSeed.filter((d) => d < 0).length;

console.log(`\n  mean ${mean >= 0 ? "+" : ""}${mean.toFixed(4)} per firing +/- ${se.toFixed(4)} SE  (${se > 0 ? (mean / se).toFixed(2) : "n/a"} SE from zero)`);
console.log(`  ahead in ${ahead} of ${perSeed.length} seeds, behind in ${behind}`);
console.log(`  ${totalFired} firings (${(100 * totalFired / totalScored).toFixed(2)}% of hands)`);
console.log(`  implied whole-hand effect ${(mean * totalFired / totalScored).toFixed(5)}/seat/hand`);
if (!totalFired) console.log("\n  no firings — null control, or the variant never applies to these deals.");
