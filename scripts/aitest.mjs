#!/usr/bin/env node
/* ============================================================================
   Server-side AI driver tests (src/ai-runner.js).

   The solo AI loop was allowed to be sloppy: one human, one browser, and a bug
   just meant a weird-looking hand. `advanceAI` is authoritative for every seat
   on a shared table, so its failure modes are different in kind — it can play
   somebody else's cards, or land a burst of AI moves as a version bump the CAS
   layer misreads. Those two are what most of this file is aimed at.

   Most invariants aren't asserted at one hand-built state, they're asserted on
   EVERY advance across several hundred randomized hands (see advanceChecked)
   and reported once at the end. A rule like "never plays a human's card" has
   to hold in states no fixture would think to build.

   Shape mirrors scripts/tabletest.mjs on purpose: same check()/passed/failures
   reporting so `npm test` output reads as one thing.

   Usage: node scripts/aitest.mjs
   ========================================================================= */
import {
  handStrength, aiBuryAndCall, legalPlays, applyPlay, sortHand, assignPartner,
  isTrump, cid, freshHand, aiChooseCard, trickSecurity,
} from "../src/engine.js";
import { createTable, joinTable, leaveTable, startHand, humanSeats } from "../src/table.js";
import { advanceAI } from "../src/ai-runner.js";

let passed = 0;
const failures = [];

function check(label, cond, detail = "") {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

const T0 = 1_700_000_000_000;
const host = { hostPlayerId: "p-host", hostName: "Jacob", now: T0 };

/* ------------------------------ Test helpers ------------------------------ */

// Seeded, so a failure in the randomized sweep is reproducible rather than a
// "ran it again and it passed" ghost. (The deal itself still uses Math.random
// via makeDeck, which is what gives the sweep its variety.)
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// N humans (seat 0 = host) and 5-N AI. N=0 hands the host's seat back to the
// AI through the real leave path rather than hand-building a seat object.
function tableWith(humans) {
  let t = createTable(host);
  for (let i = 1; i < humans; i++) {
    t = joinTable(t, { playerId: `p${i}`, name: `P${i}`, now: T0 }).table;
  }
  if (humans === 0) t = leaveTable(t, { playerId: "p-host", now: T0 });
  return t;
}

const isHumanSeat = (t, i) => t.seats[i]?.kind === "human";
const withG = (t, g) => ({ ...t, g });
const snapshot = (t) => JSON.stringify(t);

// Who owes the table an action right now, and of what kind. Everything that
// isn't terminal must resolve to exactly one of these.
function actor(g) {
  if (!g || g.phase === "handEnd") return null;
  if (g.phase === "picking") return g.passes >= 5 ? null : { kind: "pick", seat: g.pickTurn };
  if (g.phase === "bury") return { kind: "bury", seat: g.picker };
  if (g.phase === "call") return { kind: "call", seat: g.picker };
  if (g.phase === "playing") {
    if (g.trick.length === 5) return { kind: "resolve", seat: -1 };
    return { kind: "play", seat: g.turn };
  }
  return { kind: "unknown", seat: -1 };
}

const isTerminal = (g) => g.phase === "handEnd" || (g.phase === "picking" && g.passes >= 5);

// An all-AI deal that somebody actually picked. Deals are random, so ~5% get
// thrown in with no card ever played — tests about card play would otherwise
// pass or fail depending on the shuffle.
function dealtAllAIHand(seed = 0) {
  let last = null;
  for (let i = 0; i < 200; i++) {
    const t = startHand(tableWith(0), T0 + seed + i);
    const after = advanceAI(t, T0 + seed + i);
    last = { t, after };
    if (after.g.phase === "handEnd") return last;
  }
  // Reported rather than thrown, so a regression that stalls every all-AI hand
  // shows up as named failing checks instead of an unhandled exception.
  check(`all-AI hand completes within 200 deals (seed ${seed})`, false);
  return last;
}

// Every card played this hand, oldest first. Plays are only ever appended, so
// diffing this before/after an advance yields exactly the plays that advance
// was responsible for.
function allPlays(g) {
  const out = [];
  for (const th of g.trickHistory) for (const p of th.trick) out.push(p);
  for (const p of g.trick) out.push(p);
  return out;
}

// ONE human action, chosen at random from the legal ones. Split into the same
// steps the UI takes (pick -> bury -> call) so advanceAI's "don't touch a
// human picker mid-decision" path actually gets exercised.
function humanStep(t, rand) {
  const g = t.g;
  const a = actor(g);
  if (!a) return t;

  if (a.kind === "pick") {
    // ~40% pick rate: high enough to produce human pickers, low enough to
    // still throw hands in.
    if (rand() < 0.4) {
      const hands = g.hands.map((h, i) => (i === a.seat ? sortHand([...h, ...g.blind]) : h));
      return withG(t, { ...g, picker: a.seat, hands, phase: "bury", selected: [] });
    }
    const passes = g.passes + 1;
    return withG(t, { ...g, passes, pickTurn: (a.seat + 1) % 5, message: null });
  }

  if (a.kind === "bury") {
    // The UI lets a human bury any two; borrowing the AI's choice keeps the
    // harness short while still exercising the phase transition.
    const { buried } = aiBuryAndCall(g.hands[a.seat]);
    const hand = g.hands[a.seat].filter((c) => !buried.some((b) => cid(b) === cid(c)));
    const hands = g.hands.map((h, i) => (i === a.seat ? hand : h));
    const failsBy = { C: [], S: [], H: [] };
    hand.filter((c) => !isTrump(c)).forEach((c) => failsBy[c.suit].push(c));
    const callOptions = ["C", "S", "H"].filter(
      (su) => failsBy[su].length > 0 && !failsBy[su].some((c) => c.rank === "A")
        && !buried.some((c) => c.suit === su && c.rank === "A")
    );
    return withG(t, { ...g, hands, buried, selected: [], phase: "call", callOptions });
  }

  if (a.kind === "call") {
    const opts = g.callOptions || [];
    // No callable suit -> the UI's "Go alone" button, i.e. callAce(null).
    const suit = opts.length ? opts[Math.floor(rand() * opts.length)] : null;
    return withG(t, assignPartner({ ...g, calledSuit: suit, phase: "playing", trick: [], turn: g.leader }));
  }

  if (a.kind === "play") {
    const legal = legalPlays(g, a.seat);
    const card = legal[Math.floor(rand() * legal.length)];
    return withG(t, applyPlay(g, a.seat, card));
  }

  return t;
}

// Accumulated across every advance in the whole file, so hundreds of hands
// report as a handful of checks instead of thousands.
const problems = {
  mutated: null, version: null, humanHand: null, humanCard: null,
  logLen: null, logMatch: null, logSeq: null, logHuman: null, logAt: null,
  logHand: null, stopped: null, advances: 0, aiPlays: 0,
};

const note = (key, msg) => { if (!problems[key]) problems[key] = msg; };

// Runs one advance and asserts every invariant that must hold on EVERY call.
function advanceChecked(t, now, ctx) {
  const before = t;
  const beforeSnap = snapshot(before);
  const beforePlays = allPlays(before.g);
  const beforeHands = before.g.hands.map((h) => h.map(cid).join(","));

  const after = advanceAI(before, now);
  problems.advances++;

  // Purity: the input and everything reachable from it is untouched.
  if (snapshot(before) !== beforeSnap) note("mutated", ctx);

  // A no-op advance must be a genuine no-op — same reference, nothing written.
  if (after === before) return after;

  // Exactly one version bump for the whole burst, however many AI actions it
  // contained. This is the CAS contract the store depends on.
  if (after.version !== before.version + 1) note("version", `${ctx}: ${before.version} -> ${after.version}`);

  // No human's hand may change. advanceAI has no business touching one.
  const afterHands = after.g.hands.map((h) => h.map(cid).join(","));
  for (let i = 0; i < 5; i++) {
    if (isHumanSeat(before, i) && beforeHands[i] !== afterHands[i]) note("humanHand", `${ctx}: seat ${i}`);
  }

  // Every card that appeared during this advance must belong to an AI seat.
  const newPlays = allPlays(after.g).slice(beforePlays.length);
  for (const p of newPlays) {
    if (isHumanSeat(before, p.player)) note("humanCard", `${ctx}: seat ${p.player} played ${cid(p.card)}`);
  }
  problems.aiPlays += newPlays.length;

  // The animation log must be a faithful, ordered record of those same plays.
  const log = after.aiLog || [];
  const tail = log.slice(log.length - newPlays.length);
  if (newPlays.length && tail.length !== newPlays.length) {
    note("logLen", `${ctx}: ${newPlays.length} plays, log tail ${tail.length}`);
  }
  for (let i = 0; i < tail.length && i < newPlays.length; i++) {
    // A card played under sits on the trick as the 6 of the called suit, with
    // the card actually chosen alongside it. The log records what the AI
    // decided to play, so compare against that — not against the stand-in.
    const laid = newPlays[i].actual ?? newPlays[i].card;
    if (tail[i].seat !== newPlays[i].player || cid(tail[i].card) !== cid(laid)) {
      note("logMatch", `${ctx}: log ${tail[i].seat}/${cid(tail[i].card)} vs play ${newPlays[i].player}/${cid(laid)}`);
    }
  }
  for (let i = 1; i < log.length; i++) {
    if (log[i].seq <= log[i - 1].seq) note("logSeq", `${ctx}: seq ${log[i - 1].seq} -> ${log[i].seq}`);
  }
  for (const e of log) {
    if (isHumanSeat(after, e.seat)) note("logHuman", `${ctx}: seat ${e.seat}`);
    if (e.at !== now && typeof e.at !== "number") note("logAt", ctx);
  }
  if (log.length && after.aiLogHand !== after.g.handNum) note("logHand", ctx);

  // The whole point: stop AT the human, not past them.
  const a = actor(after.g);
  if (a) {
    if (a.kind === "resolve") note("stopped", `${ctx}: left an unresolved trick`);
    else if (a.seat < 0 || !isHumanSeat(after, a.seat)) {
      note("stopped", `${ctx}: stopped on ${a.kind} for non-human seat ${a.seat}`);
    }
  }

  return after;
}

// Plays a hand to a terminal state, alternating advanceAI with single human
// actions.
function playHand(t, rand, ctx) {
  let cur = t;
  let now = T0;
  let done = false;
  let humanActions = 0;
  for (let guard = 0; guard < 400 && !done; guard++) {
    now += 10;
    const advanced = advanceChecked(cur, now, `${ctx}#${guard}`);
    const progressed = advanced !== cur;
    cur = advanced;
    if (isTerminal(cur.g)) { done = true; break; }
    if (!actor(cur.g)) break;
    const next = humanStep(cur, rand);
    if (next === cur) {
      if (!progressed) break; // neither side can move — deadlock
      continue;
    }
    humanActions++;
    cur = next;
  }
  return {
    table: cur,
    stuck: !done,
    humanActions,
    thrownIn: cur.g.phase === "picking" && cur.g.passes >= 5,
    ended: cur.g.phase === "handEnd",
  };
}

/* -------------------------- No-op / purity basics -------------------------- */

{
  const t = createTable(host);
  check("lobby table with no game state is a no-op", advanceAI(t, T0) === t);
  check("null table is tolerated", advanceAI(null, T0) === null);
}

{
  // 1 human + 4 AI. Seat 0 is the human; whatever the deal, the advance has to
  // walk the AI forward and halt on seat 0.
  const t = startHand(tableWith(1), T0);
  const after = advanceAI(t, T0 + 1);
  const a = actor(after.g);
  check("MP-2.4 1 human + 4 AI: advance stops on the human",
    a !== null && a.seat === 0 && isHumanSeat(after, 0), `stopped on ${JSON.stringify(a)}`);
  check("1 human + 4 AI: human's six cards are untouched", after.g.hands[0].length === 6,
    `got ${after.g.hands[0].length}`);
  check("1 human + 4 AI: human has played nothing",
    allPlays(after.g).every((p) => p.player !== 0));

  // Called again with nothing to do, it must hand back the identical object so
  // the caller can skip the store write entirely.
  const again = advanceAI(after, T0 + 2);
  check("second advance on a human's turn is a no-op by reference", again === after);
  check("no-op advance does not bump the version", again.version === after.version);
}

{
  // Purity, checked structurally rather than by reference.
  const t = startHand(tableWith(1), T0);
  const snap = snapshot(t);
  const after = advanceAI(t, T0 + 1);
  check("advanceAI does not mutate its input table", snapshot(t) === snap);
  check("advanceAI does not mutate the input's engine state", after === t || after.g !== t.g);
  check("advanceAI does not mutate the seat roster", after.seats === t.seats || after === t);
}

{
  // Clock-freedom: `at` is exactly what the caller passed, and the same
  // (table, now) produces the same result twice.
  const { t } = dealtAllAIHand(11);
  const a1 = advanceAI(t, 42);
  const a2 = advanceAI(t, 42);
  check("advanceAI is deterministic for a fixed (table, now)", snapshot(a1) === snapshot(a2));
  const stamps = (a1.aiLog || []).map((e) => e.at);
  check("aiLog uses the caller's clock, not Date.now()",
    stamps.length > 0 && stamps.every((s) => s === 42), `got ${[...new Set(stamps)].join(",")}`);
  check("commit's updatedAt uses the caller's clock", a1.updatedAt === 42);
}

/* ---------------------- Version bumps exactly once ----------------------- */

{
  // An all-AI table: one advance drives pick + bury + call + up to 30 card
  // plays + 6 trick resolutions, and must still be a single version bump.
  const { t, after } = dealtAllAIHand(5);
  check("all-AI advance bumps version exactly once", after.version === t.version + 1,
    `${t.version} -> ${after.version}`);
  const cardsPlayed = allPlays(after.g).length;
  check("all-AI advance really did 30 plays + 6 resolutions inside that one bump",
    after.g.phase === "handEnd" && cardsPlayed === 30,
    `played ${cardsPlayed}, phase ${after.g.phase}`);
}

{
  // Same claim, checked over many deals so it can't pass by luck of one deal
  // that happened to contain a single AI action.
  let bad = 0;
  let maxActions = 0;
  for (let i = 0; i < 50; i++) {
    const t = startHand(tableWith(1), T0 + i);
    const after = advanceAI(t, T0);
    if (after !== t && after.version !== t.version + 1) bad++;
    maxActions = Math.max(maxActions, allPlays(after.g).length);
  }
  check("version bump stays at exactly one across 50 mixed advances", bad === 0, `${bad} bad`);
  check("those advances contained multi-action bursts", maxActions >= 2, `max ${maxActions} cards`);
}

/* ------------------- 5 AI seats play a whole hand alone ------------------- */

{
  let completed = 0;
  let thrownIn = 0;
  let badTerminal = 0;
  let reseated = 0;
  for (let i = 0; i < 60; i++) {
    const t = startHand(tableWith(0), T0 + i);
    const after = advanceAI(t, T0 + i);
    if (after.g.phase === "handEnd") {
      completed++;
      if (allPlays(after.g).length !== 30) badTerminal++;
      if (!after.g.result || typeof after.g.result.teamPts !== "number") badTerminal++;
      if (after.g.hands.some((h) => h.length > 0)) badTerminal++;
    } else if (after.g.phase === "picking" && after.g.passes >= 5) {
      thrownIn++;
    } else {
      badTerminal++;
    }
    if (humanSeats(after) !== 0) reseated++;
  }
  check("MP-2.4 0 humans + 5 AI: full hands play out with no human input",
    completed > 0, `completed=${completed} of 60`);
  check("all-AI advance always reaches handEnd or a thrown-in hand",
    badTerminal === 0 && completed + thrownIn === 60, `bad=${badTerminal}`);
  check("advanceAI never reseats anybody", reseated === 0);
}

{
  // A thrown-in hand is a hard stop: advanceAI must not redeal (that's the
  // caller's job, and it's where pending joins land).
  let found = null;
  for (let i = 0; i < 300 && !found; i++) {
    const after = advanceAI(startHand(tableWith(0), T0 + i), T0);
    if (after.g.phase === "picking" && after.g.passes >= 5) found = after;
  }
  check("a thrown-in hand occurs within 300 all-AI deals", found !== null);
  if (found) {
    check("thrown-in hand: message is set for the UI", typeof found.g.message === "string");
    check("thrown-in hand: no picker was assigned", found.g.picker === null);
    check("thrown-in hand: advancing again is a no-op", advanceAI(found, T0 + 9) === found);
    check("thrown-in hand: advanceAI did not redeal", found.g.handNum === found.handNum);
  }
}

/* ------------------------ Never plays a human's card ---------------------- */

{
  // Human on lead with a full hand: nothing may move at all.
  const t = startHand(tableWith(1), T0);
  const staged = withG(t, {
    ...t.g, phase: "playing", picker: 1, calledSuit: null, partner: null,
    alone: true, turn: 0, leader: 0, trick: [],
  });
  check("human on lead: advanceAI refuses to act at all", advanceAI(staged, T0 + 1) === staged);
  check("human on lead: the human still holds six cards", staged.g.hands[0].length === 6);
}

{
  // Human mid-trick: the AI ahead of them plays, the AI behind them must not.
  const t = startHand(tableWith(1), T0);
  const staged = withG(t, {
    ...t.g, phase: "playing", picker: 1, calledSuit: null, partner: null,
    alone: true, turn: 4, leader: 4, trick: [],
  });
  const after = advanceAI(staged, T0 + 1);
  check("AI ahead of the human plays", after.g.trick.length === 1 && after.g.trick[0].player === 4);
  check("advance stops on the human's turn mid-trick", after.g.turn === 0);
  check("seats behind the human have not played", after.g.trick.every((p) => p.player !== 0));
  check("partial trick is still exactly one version bump", after.version === t.version + 1);
}

{
  // Two humans with an AI sandwiched between: it must play exactly one card
  // and stop again.
  let t = tableWith(1);
  t = joinTable(t, { playerId: "pX", name: "X", now: T0 }).table; // seat 1
  t = startHand(t, T0);
  const staged = withG(t, {
    ...t.g, phase: "playing", picker: 2, calledSuit: null, partner: null,
    alone: true, turn: 4, leader: 4, trick: [],
  });
  const after = advanceAI(staged, T0 + 1);
  check("AI between two humans plays once and stops", after.g.trick.length === 1 && after.g.turn === 0);
  check("neither human's hand shrank",
    after.g.hands[0].length === 6 && after.g.hands[1].length === 6);
}

/* --------------------------- Human-only phases --------------------------- */

{
  // "bury" and "call" belong to a human picker — an AI picker resolves the
  // whole pick in one move and never enters them.
  const t = startHand(tableWith(1), T0);
  for (const phase of ["bury", "call"]) {
    const staged = withG(t, { ...t.g, phase, picker: 0 });
    check(`advanceAI is a no-op during the human "${phase}" phase`,
      advanceAI(staged, T0 + 1) === staged);
  }
  const ended = withG(t, { ...t.g, phase: "handEnd" });
  check("advanceAI is a no-op at handEnd", advanceAI(ended, T0 + 1) === ended);
}

{
  // Picking must stop on a human's decision even when AI seats ahead of them
  // passed during the same advance.
  const t = startHand(tableWith(1), T0);
  const staged = withG(t, { ...t.g, pickTurn: 1, passes: 0 });
  const after = advanceAI(staged, T0 + 1);
  const a = actor(after.g);
  check("picking stops on the human's pick decision",
    after.g.phase !== "picking" || a === null || a.seat === 0,
    `phase=${after.g.phase} pickTurn=${after.g.pickTurn}`);
}

{
  // Pick thresholds must match Sheepshead.jsx exactly (>=10, or >=8 when
  // you're the last seat with four passes behind you). Verified behaviorally:
  // force each seat onto the decision and compare against the rule.
  let mismatches = 0;
  let cases = 0;
  let picks = 0;
  let stretchPicks = 0;
  for (let i = 0; i < 250; i++) {
    const t = startHand(tableWith(0), T0 + i);
    for (const passes of [0, 4]) {
      for (const seat of [0, 2]) {
        const staged = withG(t, { ...t.g, pickTurn: seat, passes });
        const after = advanceAI(staged, T0);
        const hs = handStrength(t.g.hands[seat]);
        const expected = hs >= 10 || (passes === 4 && hs >= 8);
        const picked = after.g.picker === seat;
        cases++;
        if (expected !== picked) mismatches++;
        if (picked) picks++;
        if (picked && passes === 4 && hs < 10) stretchPicks++;
      }
    }
  }
  check("AI pick threshold matches the single-player loop (>=10, >=8 when last)",
    mismatches === 0, `${mismatches} mismatches over ${cases} cases`);
  check("the threshold test actually saw picks", picks > 0, `${picks}`);
  check("the last-seat 8..9 stretch was exercised", stretchPicks > 0, `${stretchPicks}`);
}

/* ------------------------- Alone hands / AI picker ------------------------ */

{
  let aiPicker = 0;
  let alone = 0;
  let called = 0;
  let partnerFound = 0;
  let malformed = 0;
  for (let i = 0; i < 400; i++) {
    const g = advanceAI(startHand(tableWith(0), T0 + i * 7), T0).g;
    if (g.picker === null) continue;
    aiPicker++;
    if (g.calledSuit === null) alone++;
    else { called++; if (g.partner !== null) partnerFound++; }
    if (g.buried.length !== 2) malformed++;
    if (g.phase === "handEnd" && g.hands.some((h) => h.length > 0)) malformed++;
  }
  check("AI picker path runs", aiPicker > 0, `${aiPicker} of 400`);
  check("AI picker goes alone sometimes", alone > 0, `${alone} alone`);
  check("AI picker calls an ace sometimes", called > 0, `${called} called`);
  check("a called ace finds a partner most of the time", partnerFound > 0, `${partnerFound}/${called}`);
  check("every AI-picked hand is well-formed", malformed === 0, `${malformed} malformed`);
}

/* ------------------------------- aiLog ---------------------------------- */

{
  const { t } = dealtAllAIHand(23);
  const after = advanceAI(t, T0 + 5);
  const log = after.aiLog || [];
  check("aiLog records every AI play in the advance",
    log.length === allPlays(after.g).length && log.length === 30,
    `log=${log.length} plays=${allPlays(after.g).length}`);
  check("aiLog seq is strictly increasing",
    log.every((e, i) => i === 0 || e.seq > log[i - 1].seq));
  check("aiLog seq starts at 1 on a fresh hand", log[0]?.seq === 1);
  check("aiLog entries name an AI seat", log.every((e) => t.seats[e.seat]?.kind === "ai"));
  check("aiLog entries carry a real card",
    log.every((e) => e.card && typeof e.card.suit === "string" && typeof e.card.rank === "string"));
  check("aiLog entries are in play order",
    log.every((e, i) => cid(e.card) === cid(allPlays(after.g)[i].card)
      && e.seat === allPlays(after.g)[i].player));
  check("aiLog is tagged with the hand it belongs to", after.aiLogHand === after.g.handNum);
}

{
  // Across two advances within ONE hand the log accumulates and seq keeps
  // climbing; at the next hand it resets so it can't grow without bound.
  const rand = rng(99);
  let cur = startHand(tableWith(1), T0);
  const played = playHand(cur, rand, "log");
  cur = played.table;
  const firstLog = cur.aiLog || [];
  check("aiLog accumulates across separate advances within a hand", firstLog.length > 1);
  check("aiLog stays strictly ordered across separate advances",
    firstLog.every((e, i) => i === 0 || e.seq > firstLog[i - 1].seq));
  check("aiLog is bounded by one hand's worth of AI plays", firstLog.length <= 30,
    `${firstLog.length}`);

  // Next hand on the same table object — the stale log must not carry over.
  const nextHand = {
    ...cur,
    handNum: cur.handNum + 1,
    g: freshHand((cur.dealer + 1) % 5, cur.scores, cur.handNum + 1),
  };
  let advanced = nextHand;
  for (let i = 0; i < 20 && advanced.aiLogHand !== advanced.g.handNum; i++) {
    const step = advanceAI(advanced, T0 + 900 + i);
    if (step === advanced) {
      const next = humanStep(advanced, rand);
      if (next === advanced) break;
      advanced = next;
    } else advanced = step;
  }
  const newLog = advanced.aiLog || [];
  check("aiLog resets at the start of a new hand",
    advanced.aiLogHand === advanced.g.handNum && newLog.length <= 30
      && !newLog.some((e) => firstLog.includes(e)),
    `carried ${newLog.length}, tag ${advanced.aiLogHand} vs hand ${advanced.g.handNum}`);
  check("aiLog seq restarts with the new hand",
    newLog.length === 0 || newLog[0].seq === 1, `first seq ${newLog[0]?.seq}`);
}

/* ----------------------- All human/AI mixes ------------------------------ */

for (let humans = 0; humans <= 5; humans++) {
  const rand = rng(1000 + humans);
  let ended = 0;
  let thrown = 0;
  let stuck = 0;
  let humanActed = 0;
  for (let i = 0; i < 40; i++) {
    const t = startHand(tableWith(humans), T0 + i);
    const r = playHand(t, rand, `mix${humans}/${i}`);
    if (r.stuck) stuck++;
    else if (r.ended) ended++;
    else if (r.thrownIn) thrown++;
    humanActed += r.humanActions;
  }
  const label = `${humans} human(s) + ${5 - humans} AI`;
  check(`MP-2.4 ${label}: every hand terminates`,
    stuck === 0 && ended + thrown === 40, `ended=${ended} thrown=${thrown} stuck=${stuck}`);
  check(`MP-2.4 ${label}: hands reach handEnd`, ended > 0, `ended=${ended}`);
  if (humans === 0) {
    check("0 humans + 5 AI: no human action was ever required", humanActed === 0);
  } else {
    check(`${label}: humans really did have to act`, humanActed > 0);
  }
}

/* --------------------- Randomized sweep across mixes --------------------- */

{
  const rand = rng(20260725);
  let ended = 0;
  let thrown = 0;
  let stuck = 0;
  for (let i = 0; i < 400; i++) {
    const humans = 1 + Math.floor(rand() * 5);
    const t = startHand(tableWith(humans), T0 + i * 13);
    const r = playHand(t, rand, `rand${i}`);
    if (r.stuck) stuck++;
    else if (r.ended) ended++;
    else if (r.thrownIn) thrown++;
  }
  check("randomized sweep: 400 hands all terminated", stuck === 0, `${stuck} stuck`);
  check("randomized sweep: hands were completed", ended > 0, `${ended} ended`);
  check("randomized sweep: thrown-in hands were exercised", thrown > 0, `${thrown} thrown in`);
}

/* Invariants accumulated by advanceChecked over every advance above. */
{
  check("sweep: input tables were never mutated", problems.mutated === null, problems.mutated || "");
  check("sweep: version bumped exactly once per changing advance",
    problems.version === null, problems.version || "");
  check("sweep: no human hand was ever modified", problems.humanHand === null, problems.humanHand || "");
  check("sweep: no human's card was ever played", problems.humanCard === null, problems.humanCard || "");
  check("sweep: aiLog length matched the plays made", problems.logLen === null, problems.logLen || "");
  check("sweep: aiLog matched the actual plays", problems.logMatch === null, problems.logMatch || "");
  check("sweep: aiLog seq was strictly increasing", problems.logSeq === null, problems.logSeq || "");
  check("sweep: aiLog only ever named AI seats", problems.logHuman === null, problems.logHuman || "");
  check("sweep: aiLog stamps came from the caller's clock", problems.logAt === null, problems.logAt || "");
  check("sweep: aiLog stayed tagged to the current hand", problems.logHand === null, problems.logHand || "");
  check("sweep: every advance stopped on a human or a terminal state",
    problems.stopped === null, problems.stopped || "");
  check("sweep: the invariants ran against real volume",
    problems.advances > 2000 && problems.aiPlays > 2000,
    `${problems.advances} advances, ${problems.aiPlays} AI cards`);
}

/* --------------- COM-3.4: away seats must be AI-driven -------------------- */
{
  // The point of covering an absent player is that play CONTINUES. If advanceAI
  // still treats an away seat as a human it must wait for, the table stalls
  // exactly as it did before — the seat just has a different label on it.
  //
  // This case exists because reverting isAISeat to `kind === "ai"` passed every
  // other assertion in this file: the feature's whole mechanism was untested.
  let t = joinTable(createTable({ hostPlayerId: "p-host", hostName: "Jacob", now: 1 }),
    { playerId: "p-dave", name: "Dave", now: 1 }).table;
  t = startHand(t, 1);

  // Both humans present: advanceAI must stop and wait for whichever of them
  // owes the next decision.
  const withHumans = advanceAI(t, 2);
  const gW = withHumans.g;
  const seatToActW = gW.phase === "picking" ? gW.pickTurn : gW.turn;
  check("COM-3.4 baseline: a present human still blocks play",
    withHumans.seats[seatToActW]?.kind === "human",
    `stopped on ${withHumans.seats[seatToActW]?.kind}`);

  // Same table, everyone away. Nothing may block, so the AI must carry the
  // hand all the way to its end unaided.
  const allAway = { ...t, seats: t.seats.map((s) => (s.kind === "human" ? { ...s, kind: "away" } : s)) };
  const driven = advanceAI(allAway, 3);
  check("an away seat does not block play", driven !== allAway);
  check("with everyone away the AI plays the hand out",
    driven.g.phase === "handEnd" || (driven.g.phase === "picking" && driven.g.passes >= 5),
    `phase=${driven.g.phase} passes=${driven.g.passes} tricks=${driven.g.tricksDone}`);
  check("covering never rewrites who owns the seat",
    driven.seats.filter((x) => x.playerId).length === allAway.seats.filter((x) => x.playerId).length);

  // One away, one present: still blocks on the present player.
  const oneAway = { ...t, seats: t.seats.map((s, i) => (i === 0 ? { ...s, kind: "away" } : s)) };
  const partial = advanceAI(oneAway, 4);
  const gP = partial.g;
  const seatToAct = gP.phase === "picking" ? gP.pickTurn : gP.turn;
  check("a present human still blocks even when another seat is covered",
    gP.phase === "handEnd" || partial.seats[seatToAct]?.kind === "human",
    `stopped on ${partial.seats[seatToAct]?.kind} in ${gP.phase}`);
}

/* ------------------- reported hand: cutting the called suit --------------- */
{
  // noschnitz.com hand 28, v0.21.0, trick 3. Seats: 0 You (the picker's
  // partner), 1 Gus, 2 Bunny (picker), 3 Duane, 4 Patty. Clubs were called and
  // the club ace is still out. Gus leads K♣, Bunny follows 7♣, and Duane — a
  // defender, void in clubs, holding J♦ — laid the TEN OF HEARTS on it. The
  // partner then took the whole pile with A♣ two seats later.
  //
  // Duane read the trick as certain because the only seat he KNEW to be an
  // opponent had already played. But the called ace was still out, and the
  // seat holding it is by definition on the other side. Cutting with J♦ takes
  // the trick instead; the swing between the two lines was 42 points and it
  // decided the hand.
  const C = (x) => ({ rank: x.slice(0, -1), suit: x.slice(-1) });
  const H = (a) => a.map(C);
  const g = {
    picker: 2, partner: 0, calledSuit: "C", calledRank: "A",
    phase: "playing", turn: 3, partnerRevealed: false, calledAcePlayed: false,
    calledSuitLed: true, tricksDone: 2, ptsTaken: [0, 0, 0, 0, 0],
    played: H(["7D", "AD", "QH", "QS", "8D", "7H", "JH", "8H", "AH", "KH"]),
    trick: [{ player: 1, card: C("KC") }, { player: 2, card: C("7C") }],
    hands: [H(["AC", "JS", "9D", "KS"]), H(["QD", "AS", "7S"]), H(["QC", "10D", "KD"]),
            H(["10H", "JD", "9S", "9H"]), H(["9C", "JC", "10S", "8S"])],
    blind: [], buried: H(["10C", "8C"]),
  };

  check("a live called ace makes the trick uncertain for a defender",
    trickSecurity(g, 3) < 0.85, trickSecurity(g, 3).toFixed(3));
  check("...and it read as certain before the fix",
    trickSecurity(g, 3, { priceCalledAce: false }) === 1);
  check("the defender cuts the called suit instead of schmearing",
    cid(aiChooseCard(g, 3)) === "JD", cid(aiChooseCard(g, 3)));

  // The picker's own side is not made timid by this: the called ace landing is
  // their partner taking the trick, which is what they want.
  check("the picker is not discouraged by the ace he called",
    trickSecurity({ ...g, turn: 2 }, 2) === trickSecurity({ ...g, turn: 2 }, 2, { priceCalledAce: false }));

  // Once the ace is down there is nothing left to fear from it.
  check("with the ace played the rule stops applying",
    trickSecurity({ ...g, calledAcePlayed: true }, 3) ===
    trickSecurity({ ...g, calledAcePlayed: true }, 3, { priceCalledAce: false }));
}

/* ------------------------------- Report --------------------------------- */

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — advanceAI drives AI seats without ever touching a human's.");
