#!/usr/bin/env node
/* ============================================================================
   Does the endgame solver read cards the deciding seat cannot see?

   `aiChooseCard` hands tricks 5-6 to `solveEndgameCard`, which recurses over
   `g.hands` — all five of them. Reading that off the code is one thing;
   demonstrating it is another, and the demonstration is what belongs in a test.

   The probe: swap one card BETWEEN TWO OTHER SEATS. The deciding seat's hand,
   the cards already played, the called suit, the partner and every other public
   fact are untouched, so its information set is bit-for-bit identical. If the
   card it chooses changes, the choice depended on hidden state. There is no
   other explanation available.

   It was a CHARACTERISATION test until 0.54.0 — it asserted the dependence so
   that removing it would be a deliberate act rather than a quiet one. The
   clairvoyance is now gone, so the assertion is inverted: the choice must NOT
   move when cards are shuffled between seats the deciding seat cannot see.

   That makes this a leak detector, and it is the only one there can be. The
   endgame now samples deals from the seat's own information set, and the way
   that silently breaks is a constraint or a hand reference quietly reintroducing
   the real layout — which would not fail any other test, because playing better
   with more information looks exactly like playing better.

   Usage: node scripts/clairvoyancetest.mjs
   ========================================================================= */
import { freshHand, assignPartner, applyPlay, resolveTrick, handStrength, aiBuryAndCall,
         aiChooseCard, legalPlays, cid } from "../src/engine.js";
function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const rand = mulberry32(7);
let tested = 0, flipped = 0;
const examples = [];
for (let h = 0; h < 400 && tested < 250; h++) {
  let g = freshHand(h % 5, [0,0,0,0,0], 1);
  const deck = [...g.hands.flat(), ...g.blind];
  for (let i = deck.length-1; i>0; i--){const j=Math.floor(rand()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]];}
  g = { ...g, hands: [0,1,2,3,4].map(p=>deck.slice(p*6,p*6+6)), blind: deck.slice(30,32) };
  while (g.phase === "picking" && g.passes < 5) {
    const i = g.pickTurn;
    if (!(handStrength(g.hands[i]) >= 10 || (g.passes === 4 && handStrength(g.hands[i]) >= 8))) { g={...g,passes:g.passes+1,pickTurn:(i+1)%5}; continue; }
    const { buried, call, callRank, callKind, underCard, hand } = aiBuryAndCall([...g.hands[i], ...g.blind]);
    g = assignPartner({ ...g, picker:i, buried, calledSuit:call, calledRank: call===null?null:callRank,
      calledUnder: callKind==="under", underCard: underCard??null,
      hands: g.hands.map((hh,k)=>(k===i?hand:hh)), phase:"playing", trick:[], turn:g.leader });
  }
  if (g.phase !== "playing") continue;
  let guard = 0;
  while (g.phase === "playing" && guard++ < 60) {
    const idx = g.turn;
    if (idx < 0) { g = resolveTrick(g); continue; }
    // At trick 5 (tricksDone === 4) the dispatch switches to solveEndgameCard.
    if (g.tricksDone === 4 && legalPlays(g, idx).length > 1) {
      const base = aiChooseCard(g, idx);
      const others = [0,1,2,3,4].filter((p) => p !== idx && g.hands[p].length >= 1);
      outer:
      for (let a = 0; a < others.length; a++) for (let b = a+1; b < others.length; b++) {
        const A = others[a], B = others[b];
        for (let i = 0; i < g.hands[A].length; i++) for (let j = 0; j < g.hands[B].length; j++) {
          const hands = g.hands.map((hh) => [...hh]);
          [hands[A][i], hands[B][j]] = [hands[B][j], hands[A][i]];
          // Partner identity is part of the public-ish state; keep it fixed so
          // only the LOCATION of unseen cards differs.
          const alt = { ...g, hands };
          if (assignPartner(alt).partner !== g.partner) continue;
          if (legalPlays(alt, idx).length !== legalPlays(g, idx).length) continue;
          tested++;
          const other = aiChooseCard(alt, idx);
          if (cid(other) !== cid(base)) {
            flipped++;
            if (examples.length < 3) examples.push(`seat ${idx} plays ${cid(base)}; move ${cid(g.hands[A][i])} from seat ${A} to ${B} and it plays ${cid(other)} instead`);
            break outer;
          }
          break outer;
        }
      }
    }
    g = applyPlay(g, idx, aiChooseCard(g, idx));
    if (g.trick.length === 5) g = resolveTrick(g);
  }
}
console.log(`trick-5 decisions probed with one swap between two OTHER seats: ${tested}`);
console.log(`choice changed: ${flipped}  (${(100*flipped/Math.max(1,tested)).toFixed(1)}%)`);
examples.forEach((e) => console.log("  " + e));
// One swap per decision, so this is a floor on detection rather than a proof of
// absence — but any leak big enough to matter shows up across 250 probes.
const ok = tested > 100 && flipped === 0;
console.log(ok
  ? `\nPASS — the endgame choice does not depend on cards the seat cannot see (${tested} probes).`
  : `\nFAILED — the choice moved on ${flipped} of ${tested} probes, so hidden cards are reaching the decision.`);
process.exit(ok ? 0 : 1);
