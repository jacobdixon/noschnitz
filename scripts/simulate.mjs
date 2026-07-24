#!/usr/bin/env node
/* ============================================================================
   Headless AI-vs-AI simulation harness.

   Plays out full Sheepshead hands with all five seats driven by the AI
   (handStrength / aiBuryAndCall / aiChooseCard from src/engine.js) and
   reports aggregate stats. This is the repeatable regression check we run
   before/after each AI tuning pass — no browser needed.

   Usage: node scripts/simulate.mjs [numHands]
   ========================================================================= */
import {
  freshHand, assignPartner, applyPlay, resolveTrick,
  handStrength, aiBuryAndCall, aiChooseCard,
} from "../src/engine.js";

function playPicking(g) {
  // Mirrors the picking loop in Sheepshead.jsx's effect, but every seat
  // (including seat 0) decides via the same AI heuristic.
  while (g.phase === "picking" && g.passes < 5) {
    const idx = g.pickTurn;
    const wants = handStrength(g.hands[idx]) >= 10 || (g.passes === 4 && handStrength(g.hands[idx]) >= 8);
    if (!wants) {
      g = { ...g, passes: g.passes + 1, pickTurn: (idx + 1) % 5 };
      continue;
    }
    const eight = [...g.hands[idx], ...g.blind];
    const { buried, call, hand } = aiBuryAndCall(eight);
    const hands = g.hands.map((h, i) => (i === idx ? hand : h));
    let ns = { ...g, picker: idx, hands, buried, calledSuit: call, phase: "playing", trick: [], turn: g.leader };
    ns = assignPartner(ns);
    return ns;
  }
  return g; // all passed — thrown in
}

function playTrick(g) {
  while (g.trick.length < 5) {
    const card = aiChooseCard(g, g.turn);
    g = applyPlay(g, g.turn, card);
  }
  return resolveTrick(g);
}

function playHand(dealer, scores, handNum) {
  let g = freshHand(dealer, scores, handNum);
  g = playPicking(g);
  if (g.phase !== "playing") return { thrownIn: true, scores: g.scores };
  while (g.phase === "playing" && g.tricksDone < 6) {
    g = playTrick(g);
  }
  return { thrownIn: false, g };
}

function simulate(numHands) {
  let scores = [0, 0, 0, 0, 0];
  let dealer = 0;
  let handNum = 1;
  let picked = 0, thrownIn = 0, pickerWins = 0, alone = 0, schneider = 0, noTricker = 0;
  const teamPtsHist = [];

  for (let i = 0; i < numHands; i++) {
    const res = playHand(dealer, scores, handNum);
    if (res.thrownIn) {
      thrownIn++;
    } else {
      picked++;
      const { result, alone: wentAlone } = res.g;
      scores = res.g.scores;
      if (result.pickerWins) pickerWins++;
      if (wentAlone) alone++;
      if (result.label === "Schneider!") schneider++;
      if (result.label === "No-tricker!") noTricker++;
      teamPtsHist.push(result.teamPts);
    }
    dealer = (dealer + 1) % 5;
    handNum++;
  }

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
  return {
    numHands, picked, thrownIn,
    pickRate: picked / numHands,
    pickerWinRate: pickerWins / (picked || 1),
    aloneRate: alone / (picked || 1),
    schneiderRate: schneider / (picked || 1),
    noTrickerRate: noTricker / (picked || 1),
    avgTeamPts: avg(teamPtsHist),
    finalScoreSpread: Math.max(...scores) - Math.min(...scores),
  };
}

const n = parseInt(process.argv[2] || "3000", 10);
const t0 = Date.now();
const stats = simulate(n);
const ms = Date.now() - t0;

console.log(`Simulated ${stats.numHands} hands in ${ms}ms`);
console.log(`  picked:            ${stats.picked} (${(stats.pickRate * 100).toFixed(1)}%)`);
console.log(`  thrown in:         ${stats.thrownIn}`);
console.log(`  picker win rate:   ${(stats.pickerWinRate * 100).toFixed(1)}%`);
console.log(`  went alone:        ${(stats.aloneRate * 100).toFixed(1)}%`);
console.log(`  schneider rate:    ${(stats.schneiderRate * 100).toFixed(1)}%`);
console.log(`  no-tricker rate:   ${(stats.noTrickerRate * 100).toFixed(1)}%`);
console.log(`  avg picker-team pts: ${stats.avgTeamPts.toFixed(1)} / 120`);
