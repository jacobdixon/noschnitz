#!/usr/bin/env node
/* ============================================================================
   Information-leak regression check for `viewFor`.

   The multiplayer server sends each seat `viewFor(g, seat)` and nothing else,
   so that function is the single thing standing between a live table and a
   player reading the other four hands out of devtools. This harness plays full
   AI-vs-AI hands and, at every decision point, asserts the invariant:

     every card reachable anywhere in viewFor(g, seat) is a card that seat is
     entitled to know about

   where "entitled" means: it's in their own hand, it has already been played
   face-up, or they're the picker looking at the blind/bury they handled
   themselves. Plus the two non-card secrets — partner identity and whether the
   picker is actually alone.

   Walking the object graph rather than checking named fields is deliberate:
   the point is to catch a *future* field that quietly carries cards along with
   it, which is exactly how this class of bug gets reintroduced.

   Usage: node scripts/leaktest.mjs [numHands]
   ========================================================================= */
import {
  freshHand, assignPartner, applyPlay, resolveTrick,
  handStrength, aiBuryAndCall, aiChooseCard, viewFor, cid,
} from "../src/engine.js";

const failures = [];
let checks = 0;

const isCard = (v) => v && typeof v === "object" && typeof v.rank === "string" && typeof v.suit === "string";

// Every card anywhere in the view, with the path we found it at, so a failure
// report says which field leaked rather than just "something leaked".
function collectCards(node, path = "", out = []) {
  if (isCard(node)) {
    out.push({ id: cid(node), path });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectCards(v, `${path}[${i}]`, out));
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) collectCards(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

function entitledCards(g, seat) {
  const ok = new Set();
  const add = (c) => c && ok.add(cid(c));

  // Public: everything already played face-up this hand. `played` is a flat
  // card list; `trick`/`lastTrick.trick`/`trickHistory[].trick` hold
  // { player, card } records.
  (g.played || []).forEach(add);
  (g.trick || []).forEach((p) => add(p.card));
  (g.lastTrick?.trick || []).forEach((p) => add(p.card));
  (g.trickHistory || []).forEach((h) => (h.trick || []).forEach((p) => add(p.card)));

  // Your own hand.
  (g.hands[seat] || []).forEach(add);

  // The picker handled the blind and chose the bury, so those are theirs to know.
  if (seat === g.picker) {
    (g.blind || []).forEach(add);
    (g.buried || []).forEach(add);
  }

  // At hand end everything is revealed for the recap.
  if (g.phase === "handEnd") {
    g.hands.forEach((h) => (h || []).forEach(add));
    (g.blind || []).forEach(add);
    (g.buried || []).forEach(add);
  }
  return ok;
}

function checkState(g, label) {
  for (let seat = 0; seat < 5; seat++) {
    checks++;
    const view = viewFor(g, seat);
    const allowed = entitledCards(g, seat);

    for (const { id, path } of collectCards(view)) {
      if (!allowed.has(id)) {
        failures.push(`${label} seat ${seat}: leaked card ${id} at view.${path}`);
      }
    }

    // Partner identity: known to the partner from the call, to everyone else
    // only once the called ace has fallen.
    if (g.phase !== "handEnd" && !g.partnerRevealed && g.partner !== null && seat !== g.partner) {
      if (view.partner !== null) {
        failures.push(`${label} seat ${seat}: learned partner ${view.partner} before the reveal`);
      }
    }

    // "Alone" is public only when no suit was called. When a suit *was* called
    // but the ace turned out to be buried or in the blind, nobody may know.
    if (g.phase !== "handEnd" && g.calledSuit !== null && view.alone) {
      failures.push(`${label} seat ${seat}: learned the picker is alone despite a called suit`);
    }
  }
}

function playHand(dealer, scores, handNum) {
  let g = freshHand(dealer, scores, handNum);
  checkState(g, `hand ${handNum} deal`);

  while (g.phase === "picking" && g.passes < 5) {
    const idx = g.pickTurn;
    const wants = handStrength(g.hands[idx]) >= 10 || (g.passes === 4 && handStrength(g.hands[idx]) >= 8);
    if (!wants) {
      g = { ...g, passes: g.passes + 1, pickTurn: (idx + 1) % 5 };
      checkState(g, `hand ${handNum} pass ${g.passes}`);
      continue;
    }
    const eight = [...g.hands[idx], ...g.blind];
    const { buried, call, hand } = aiBuryAndCall(eight);
    const hands = g.hands.map((h, i) => (i === idx ? hand : h));
    g = { ...g, picker: idx, hands, buried, calledSuit: call, phase: "playing", trick: [], turn: g.leader };
    g = assignPartner(g);
    checkState(g, `hand ${handNum} after call`);
    break;
  }
  if (g.phase !== "playing") return g.scores;

  while (g.phase === "playing" && g.tricksDone < 6) {
    while (g.trick.length < 5) {
      g = applyPlay(g, g.turn, aiChooseCard(g, g.turn));
      checkState(g, `hand ${handNum} trick ${g.tricksDone + 1} card ${g.trick.length}`);
    }
    g = resolveTrick(g);
    checkState(g, `hand ${handNum} trick ${g.tricksDone} resolved`);
  }
  return g.scores;
}

// The AI never reaches the orphaned-ace case: aiBuryAndCall only calls a suit
// whose ace it neither holds nor buried, so a called suit always finds a
// partner (measured: 0 of 3377 called hands). Simulation therefore can't
// exercise the `alone` redaction at all — but a human picker choosing their own
// bury and call CAN produce it, which is exactly what MP-1 introduces. Covered
// synthetically so the rule is actually tested rather than assumed.
function checkSynthetic() {
  const base = freshHand(0, [0, 0, 0, 0, 0], 1);

  // Called a suit, but the ace isn't in anyone's hand (picker buried it).
  // Nobody at the table may learn there's no partner.
  const orphaned = { ...base, phase: "playing", picker: 0, calledSuit: "H", partner: null, alone: true };
  for (let seat = 0; seat < 5; seat++) {
    checks++;
    if (viewFor(orphaned, seat).alone) {
      failures.push(`synthetic orphaned-ace seat ${seat}: learned the picker is alone despite a called suit`);
    }
  }

  // Picker declared alone — no suit called at all. That IS public.
  const declared = { ...base, phase: "playing", picker: 0, calledSuit: null, partner: null, alone: true };
  for (let seat = 0; seat < 5; seat++) {
    checks++;
    if (!viewFor(declared, seat).alone) {
      failures.push(`synthetic declared-alone seat ${seat}: public "going alone" was hidden`);
    }
  }
}

const n = parseInt(process.argv[2] || "200", 10);
let scores = [0, 0, 0, 0, 0];
const t0 = Date.now();
for (let i = 0; i < n; i++) scores = playHand(i % 5, scores, i + 1);
checkSynthetic();
const ms = Date.now() - t0;

console.log(`Checked ${checks} seat-views across ${n} hands in ${ms}ms`);
if (failures.length) {
  const shown = failures.slice(0, 20);
  console.error(`\nFAIL — ${failures.length} leak(s):`);
  shown.forEach((f) => console.error(`  ${f}`));
  if (failures.length > shown.length) console.error(`  ...and ${failures.length - shown.length} more`);
  process.exit(1);
}
console.log("PASS — no seat saw a card, partner, or alone-status it wasn't entitled to.");
