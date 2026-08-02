#!/usr/bin/env node
/* ============================================================================
   PIMC (Perfect Information Monte Carlo) — analyze one in-hand decision the
   way the player who made it actually experienced it, not with the recap's
   full hindsight.

   `gradeAllPlays`/`solveHandValue` (see engine.js) grade a finished hand with
   every card face up — the right question for "was this a mistake given
   perfect knowledge", the wrong one for "was this a good decision given what
   they could see at the time". This script answers the second question: it
   takes the same kind of full recap transcription, forgets everything the
   deciding player couldn't have known as of that decision (every other
   hand's contents, the picker's bury unless they ARE the picker, who the
   partner is unless the called ace has already fallen), deals many random
   worlds consistent with that public information, and rolls each one forward
   with the AI's own policy (`aiChooseCard`) to get an average outcome per
   legal card.

   One deal isn't dealt fully at random, though: when the picker's hand is
   being sampled (i.e. the deciding player isn't the picker), it's rejected
   and redealt unless it clears the app's own pick threshold
   (`PICK_STRENGTH`, `ai-runner.js` — the same bar the AI itself uses to
   decide whether to pick). A real opponent picked because they judged their
   hand worth it, and that judgment is itself public information the
   deciding player gets to use — a picker hand sampled uniformly at random
   would mostly be hands nobody would have picked with, which is not the
   population this decision is actually being made against. Every other
   seat's hand is dealt uniformly, since nothing else at the table carries
   an equivalent "I chose to do X" signal by this point in the hand.

   Reusable per screenshot: transcribe the recap the same way you would for
   an exact-solve grade (see e.g. scripts/scenarios/hand1-jh.mjs), point
   `decision` at the {trickIdx, player} you're debating, and run:

     node scripts/pimc.mjs scripts/scenarios/hand1-jh.mjs

   Caveats, so a result isn't over-trusted:
   - The rollout continuation is only as good as `aiChooseCard`. A weakness
     in the bot's policy after the decision point will bias every candidate
     equally-ish, but not perfectly — same caveat the old rollout-based
     grader had before it was replaced by the exact solver for full-hindsight
     grading (see engine.js's comment above gradeAllPlays).
   - Void inference from failing to follow suit is applied; the picker's
     "calling under" designated-card nuance is not modelled in the inference
     step (only in the real `applyPlay`/`legalPlays` used for the rollout
     itself), so a called-under hand's void reads may be slightly too loose.
   - Samples per candidate share the same dealt world (common random numbers)
     for a fair paired comparison, but this is still a Monte Carlo estimate —
     read the standard error, not just the mean, especially on tight calls.
   ========================================================================= */
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ALL_CARDS, SUIT_SYM, cid, isTrump, effSuit, effSuitFor, cardPts, handStrength,
  legalPlays, applyPlay, resolveTrick, aiChooseCard,
} from "../src/engine.js";
import { PICK_STRENGTH } from "../src/ai-runner.js";

const HAND_SIZE = 6;
export const fmt = (card) => `${card.rank}${SUIT_SYM[card.suit]}`;
// "10D" -> {rank:"10", suit:"D"}, "JH" -> {rank:"J", suit:"H"}
export const card = (s) => ({ rank: s.slice(0, -1), suit: s.slice(-1) });

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mean(xs) { return xs.reduce((s, x) => s + x, 0) / xs.length; }
function stderr(xs) {
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1);
  return Math.sqrt(variance / xs.length);
}

/**
 * Deal `unseen` cards into the given recipients, respecting each recipient's
 * known void suits (effective suit: "C"/"S"/"H"/"T"). Retries the whole
 * shuffle on a dead end rather than doing constraint propagation — voids are
 * sparse enough this converges fast — and falls back to ignoring voids after
 * too many failed attempts so a pathological scenario can't hang forever.
 */
function dealRespectingVoids(unseen, capacities, voidSuits) {
  const recipients = Object.keys(capacities).filter((k) => capacities[k] > 0);
  for (let attempt = 0; attempt < 300; attempt++) {
    const ignoreVoids = attempt >= 250;
    const pool = shuffled(unseen);
    const dealt = {};
    let ok = true;
    for (const r of recipients) dealt[r] = [];
    for (const r of recipients) {
      const voids = voidSuits[r] || new Set();
      let need = capacities[r];
      for (let i = 0; i < pool.length && need > 0; i++) {
        const c = pool[i];
        if (c === null) continue;
        if (!ignoreVoids && voids.has(effSuit(c))) continue;
        dealt[r].push(c);
        pool[i] = null;
        need--;
      }
      if (need > 0) { ok = false; break; }
    }
    if (ok) return dealt;
  }
  throw new Error("dealRespectingVoids: could not find a consistent deal after many retries");
}

function playedCardsOf(seat, plays) {
  return plays.filter((p) => p.player === seat).map((p) => p.card);
}

export function runPimc(scenario) {
  const {
    names = ["P0", "P1", "P2", "P3", "P4"],
    picker, calledSuit, calledRank = "A", calledUnder = false, underCard = null,
    buried, trickHistory, decision, samples = 400,
  } = scenario;
  const { trickIdx, player } = decision;

  // ---------- Split into "public so far" vs. "forgotten future" ----------
  const priorTricks = trickHistory.slice(0, trickIdx);
  const thisTrick = trickHistory[trickIdx].trick;
  const actorPos = thisTrick.findIndex((p) => p.player === player);
  if (actorPos === -1) throw new Error(`player ${player} does not act in trick ${trickIdx + 1}`);
  const thisTrickSoFar = thisTrick.slice(0, actorPos);
  const actualCard = thisTrick[actorPos].card;

  const publicPlays = [...priorTricks.flatMap((t) => t.trick), ...thisTrickSoFar];

  // Decision-maker's own hand — reconstructed from the FULL transcription
  // (fine: it's their own hand, they know every card of it, played or not).
  const fullHandOf = (seat) => trickHistory.flatMap((t) => t.trick).filter((p) => p.player === seat).map((p) => p.card);
  const myFullHand = fullHandOf(player);
  const myAlreadyPlayed = playedCardsOf(player, publicPlays);
  const myRemainingHand = myFullHand.filter((c) => !myAlreadyPlayed.some((p) => cid(p) === cid(c)));

  // What the decision-maker's own team is — always knowable to them even
  // before the ace falls: either they picked, they're holding the ace
  // (=partner), or neither, in which case they're certainly a defender.
  const calledAceIsMine = calledSuit && myFullHand.some((c) => c.suit === calledSuit && c.rank === calledRank && !isTrump(c));
  const iAmPicker = player === picker;
  const iAmOnPickerTeam = iAmPicker || calledAceIsMine;

  // Has the partner already been forced to reveal (ace already played,
  // publicly, before this decision)?
  const revealedAcePlay = calledSuit
    ? publicPlays.find((p) => p.card.suit === calledSuit && p.card.rank === calledRank && !isTrump(p.card))
    : null;
  const partnerKnownFixed = iAmOnPickerTeam
    ? (iAmPicker ? (calledAceIsMine ? player : null) : player) // I'm picker (partner unknown unless ace fell) or I hold the ace myself
    : (revealedAcePlay ? revealedAcePlay.player : null);
  // null here means "not yet fixed" and must be sampled — EXCEPT when I hold
  // the ace myself (then partner === me, always, regardless of reveal).
  const partnerFixed = calledAceIsMine ? player : (revealedAcePlay ? revealedAcePlay.player : (calledSuit ? null : null));
  const partnerMustBeSampled = calledSuit !== null && !calledAceIsMine && !revealedAcePlay;

  // ---------- Build the known/unseen card pools ----------
  const known = new Map(); // cid -> card, for uniqueness
  for (const c of myFullHand) known.set(cid(c), c);
  for (const p of publicPlays) known.set(cid(p.card), p.card);
  if (iAmPicker) for (const c of buried) known.set(cid(c), c);
  const unseen = ALL_CARDS.filter((c) => !known.has(cid(c)));

  const otherSeats = [0, 1, 2, 3, 4].filter((s) => s !== player);
  const capacities = {};
  for (const s of otherSeats) capacities[s] = HAND_SIZE - playedCardsOf(s, publicPlays).length;
  capacities.buried = iAmPicker ? 0 : 2;

  const totalCap = Object.values(capacities).reduce((a, b) => a + b, 0);
  if (totalCap !== unseen.length) {
    throw new Error(`scenario is inconsistent: ${unseen.length} unseen cards but capacities sum to ${totalCap} — check trickHistory/buried for duplicates or omissions`);
  }

  // ---------- Void inference from failing to follow suit, public info only ----------
  const gStub = { picker, calledSuit, underCard };
  const voidSuits = {};
  const noteTrick = (plays) => {
    if (!plays.length) return;
    const led = effSuitFor(gStub, plays[0].player, plays[0].card);
    for (const p of plays.slice(1)) {
      const s = effSuitFor(gStub, p.player, p.card);
      if (s !== led) (voidSuits[p.player] ??= new Set()).add(led);
    }
  };
  for (const t of priorTricks) noteTrick(t.trick);
  noteTrick(thisTrick.slice(0, actorPos + 1)); // include the leader of this trick too

  // ---------- The rollout base state, up to the decision point ----------
  function buildBaseState(hands, partner, buriedCards) {
    const leader = priorTricks.length ? priorTricks[0].trick[0].player : thisTrick[0].player;
    let g = {
      phase: "playing", picker, partner, calledSuit, calledRank, calledUnder, underCard,
      buried: buriedCards, alone: calledSuit === null || partner === null,
      hands, played: [], trick: [], leader, turn: leader,
      tricksDone: 0, trickCounts: [0, 0, 0, 0, 0], ptsTaken: [0, 0, 0, 0, 0],
      calledAcePlayed: false, calledSuitLed: false, partnerRevealed: false,
      scores: [0, 0, 0, 0, 0], doubler: 1, trickHistory: [], lastTrick: null,
    };
    for (const t of priorTricks) {
      for (const p of t.trick) g = applyPlay(g, p.player, p.card);
      g = resolveTrick(g);
    }
    for (const p of thisTrickSoFar) g = applyPlay(g, p.player, p.card);
    if (g.turn !== player) throw new Error(`reconstruction bug: expected turn ${player}, got ${g.turn}`);
    return g;
  }

  function rollout(g0, firstCard) {
    let g = applyPlay(g0, player, firstCard);
    while (g.tricksDone < 6) {
      if (g.trick.length === 5) { g = resolveTrick(g); continue; }
      const mover = g.turn;
      const c = aiChooseCard(g, mover, {});
      g = applyPlay(g, mover, c);
    }
    const pickerTeam = g.partner !== null ? [g.picker, g.partner] : [g.picker];
    const buriedPts = g.buried.reduce((s, c) => s + cardPts(c), 0);
    const pickerTeamPts = pickerTeam.reduce((s, p) => s + g.ptsTaken[p], 0) + buriedPts;
    return iAmOnPickerTeam ? pickerTeamPts : 120 - pickerTeamPts;
  }

  // ---------- Sample, deal, roll every legal card forward from the same world ----------
  let legalAtDecision = null;
  const totalsByCard = new Map(); // cid -> array of per-sample results
  const pickerAlreadyPlayed = playedCardsOf(picker, publicPlays);
  // The picker's hand only needs this treatment when it's actually being
  // sampled — i.e. the decision-maker isn't the picker. When they are, it's
  // their own known hand, already ground truth, nothing to redeal.
  const pickerHandIsSampled = picker !== player;
  const MAX_PICKER_REDEALS = 300;

  for (let s = 0; s < samples; s++) {
    let dealt;
    if (!pickerHandIsSampled) {
      dealt = dealRespectingVoids(unseen, capacities, voidSuits);
    } else {
      let attempts = 0;
      do {
        dealt = dealRespectingVoids(unseen, capacities, voidSuits);
        attempts++;
      } while (
        handStrength([...pickerAlreadyPlayed, ...dealt[picker], ...dealt.buried]) < PICK_STRENGTH
        && attempts < MAX_PICKER_REDEALS
      );
      // Past the cap: keep the last deal even if it's a sub-threshold picker
      // hand, rather than hang — this should be exceedingly rare (most
      // random 8-card hands need only a handful of tries to clear 10), and a
      // handful of under-strength samples among thousands won't move the
      // average enough to matter.
    }
    const hands = [[], [], [], [], []];
    hands[player] = [...myRemainingHand];
    for (const seat of otherSeats) {
      hands[seat] = [...playedCardsOf(seat, publicPlays), ...(dealt[seat] || [])];
    }
    const buriedCards = iAmPicker ? buried : (dealt.buried || []);

    let partner;
    if (!partnerMustBeSampled) {
      partner = partnerFixed;
    } else {
      partner = null;
      for (const seat of otherSeats) {
        if (hands[seat].some((c) => c.suit === calledSuit && c.rank === calledRank && !isTrump(c))) { partner = seat; break; }
      }
      // else: the called ace was buried this sample -> secretly alone.
    }

    const g0 = buildBaseState(hands, partner, buriedCards);
    if (!legalAtDecision) legalAtDecision = legalPlays(g0, player);

    for (const candidate of legalAtDecision) {
      const key = cid(candidate);
      if (!totalsByCard.has(key)) totalsByCard.set(key, { card: candidate, vals: [] });
      totalsByCard.get(key).vals.push(rollout(g0, candidate));
    }
  }

  const results = [...totalsByCard.values()].map(({ card, vals }) => ({
    card, mean: mean(vals), stderr: stderr(vals), n: vals.length,
  })).sort((a, b) => b.mean - a.mean);

  return {
    player, playerName: names[player], decisionTeam: iAmOnPickerTeam ? "picker team" : "defenders",
    actualCard, results, samples,
  };
}

export function printReport({ player, playerName, decisionTeam, actualCard, results, samples }) {
  console.log(`PIMC — ${playerName}'s decision (${decisionTeam}), ${samples} sampled worlds, common-random-numbers across candidates\n`);
  const best = results[0];
  for (const r of results) {
    const tag = cid(r.card) === cid(actualCard) ? "  <- actually played" : "";
    const gap = r.mean - best.mean;
    console.log(
      `  ${fmt(r.card).padEnd(5)} avg ${r.mean.toFixed(2).padStart(7)} pts` +
      `  (±${r.stderr.toFixed(2)} SE, ${gap === 0 ? "best" : gap.toFixed(2).padStart(6) + " vs best"})${tag}`
    );
  }
}

// ---------- CLI ----------
// Guarded so `import { fmt, card } from "./pimc.mjs"` (see gradedecision.mjs)
// doesn't also kick off a full PIMC run as a side effect of importing it.
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  // Deliberately NOT a top-level `await`: scenario files import `card` back
  // from this module (a circular import), and a real top-level await here
  // deadlocks Node's module loader — this module can't finish evaluating
  // until the await settles, and the await can't settle until the scenario
  // module's circular re-import of this (still-evaluating) module resolves.
  // An async IIFE keeps the await inside a function body, so this module
  // finishes evaluating synchronously and the circular import resolves fine.
  (async () => {
    const scenarioPath = process.argv[2];
    if (!scenarioPath) {
      console.error("Usage: node scripts/pimc.mjs <scenario-file.mjs>");
      process.exit(1);
    }
    const mod = await import(pathToFileURL(path.resolve(scenarioPath)).href);
    const result = runPimc(mod.default);
    printReport(result);
  })();
}
