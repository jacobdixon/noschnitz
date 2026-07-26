/* ============================================================================
   Table + seat lifecycle — pure logic, no storage, no React, no network.

   Covers MP-1 (shareable tables), MP-2 (AI seat-fill) and MP-3 (guest join)
   from ROADMAP.md. Kept pure for the same reason engine.js is: it has to run
   identically inside a serverless function (where it's authoritative) and in
   the browser (where it's a prediction), and it has to be testable headlessly.

   Every mutating function returns a NEW table and bumps `version`. That
   counter is the compare-and-swap guard the store uses — a writer reads a
   table at version N, computes the next state, and the write only lands if
   the stored version is still N. Two players acting at the same instant
   means one wins and the other retries against fresh state, rather than
   silently clobbering. Nothing here may mutate in place, or that guarantee
   is gone.

   `g` (the engine game state) lives on the table but is untouched by this
   module beyond dealing a fresh hand — play itself stays in engine.js.
   ========================================================================= */
import { NAMES, freshHand } from "./engine.js";

export const SEATS = 5;

// The AI keep the names they already have in the solo game (MP-3.3 — the
// table should feel populated, not like "Player 2"). NAMES[0] is "You",
// which only makes sense from seat 0's perspective, so it's dropped here.
export const AI_NAMES = NAMES.slice(1);

// Deliberately excludes 0/O/1/I/L: table codes get read aloud and typed by
// hand when someone's link doesn't paste cleanly.
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const CODE_LENGTH = 8;

// The link IS the credential — anyone holding it can sit down — so the code
// space needs to be large enough that guessing your way into a friend's game
// isn't worth attempting. 31^8 is ~8.5e11.
export function makeTableCode(rand = defaultRand) {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  return out;
}

function defaultRand(n) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // Rejection-free enough for our purposes: the modulo bias across 2^32 vs 31
  // is ~1e-8, far below anything that matters for guessability here.
  return buf[0] % n;
}

const norm = (name) => String(name ?? "").trim().replace(/\s+/g, " ");
const sameName = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();

/* --------------------------------- Naming --------------------------------- */

// MP-3.4. Collides against AI names too, not just humans — a guest who types
// "Gus" while the AI Gus is still at the table is exactly the confusion this
// is meant to prevent.
export function uniqueName(table, desired) {
  const base = norm(desired) || "Guest";
  const taken = table.seats.filter((s) => s.name).map((s) => s.name);
  if (!taken.some((n) => sameName(n, base))) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.some((n) => sameName(n, candidate))) return candidate;
  }
  return `${base} ${Date.now() % 1000}`;
}

/* ------------------------------ Construction ------------------------------ */

function aiSeat(name) {
  return { kind: "ai", name, playerId: null, lastSeen: null };
}

// Bumps the CAS version. Every mutation goes through here so no path can
// forget and produce a write that silently overwrites a concurrent one.
// Exported because ai-runner.js is a mutation path too: it drives a whole
// burst of AI actions and must land as ONE version bump, which it gets by
// calling this exactly once at the end rather than reimplementing the rule.
export function commit(table, now) {
  return { ...table, version: table.version + 1, updatedAt: now };
}

// MP-1.1 / MP-2.1. A new table is immediately playable: the host sits at seat
// 0 and the other four are AI, so there's never a minimum headcount to reach
// before starting is worth it.
export function createTable({ hostPlayerId, hostName, now, rand, id } = {}) {
  return {
    id: id || makeTableCode(rand),
    createdAt: now,
    updatedAt: now,
    version: 0,
    phase: "lobby",
    hostPlayerId,
    // Seat 0 is the host; seats 1-4 are the AI roster in its usual order.
    seats: [
      { kind: "human", name: norm(hostName) || "Host", playerId: hostPlayerId, lastSeen: now },
      ...AI_NAMES.slice(0, SEATS - 1).map(aiSeat),
    ],
    pendingJoins: [],
    dealer: 0,
    scores: [0, 0, 0, 0, 0],
    handNum: 0,
    g: null,
  };
}

/* -------------------------------- Queries -------------------------------- */

export const seatOf = (table, playerId) =>
  playerId == null ? -1 : table.seats.findIndex((s) => s.kind === "human" && s.playerId === playerId);

export const humanSeats = (table) => table.seats.filter((s) => s.kind === "human").length;
export const aiSeatIndexes = (table) =>
  table.seats.map((s, i) => (s.kind === "ai" ? i : -1)).filter((i) => i >= 0);

// A hand is only interruptible between hands. Mid-hand the engine state holds
// six tricks of context per seat, and swapping a player into it would either
// hand them someone else's cards or corrupt the hand.
//
// A thrown-in hand (all five passed) counts as a boundary too: nobody picked,
// no cards were played, and the only legal next move is a redeal. Leaving it
// out was a deadlock — advanceAI stops at five passes and defers the redeal to
// its caller, but startHand refused because this said the hand was still in
// progress. The table then sat in `picking` forever, with a status line
// claiming someone was still deciding and no affordance to escape.
export const atHandBoundary = (table) =>
  table.phase === "lobby" ||
  table.g === null ||
  table.g.phase === "handEnd" ||
  (table.g.phase === "picking" && table.g.passes >= SEATS);

/* ------------------------------- Joining --------------------------------- */

// MP-3.1 / MP-3.2 / MP-2.3. Three distinct outcomes, and which one you get
// depends on whether a hand is in progress:
//
//   "seated"  — took a seat right now (lobby, or a returning player
//               reclaiming the seat they already hold)
//   "pending" — queued to take an AI seat at the next hand boundary, so
//               joining mid-hand never disrupts a hand in progress
//   "full"    — five humans are already seated
//
// A returning guest on the same device (same playerId) always short-circuits
// to "seated": they're not taking a new seat, they still have theirs.
export function joinTable(table, { playerId, name, now }) {
  const existing = seatOf(table, playerId);
  if (existing >= 0) {
    const seats = table.seats.map((s, i) => (i === existing ? { ...s, lastSeen: now } : s));
    return { table: commit({ ...table, seats }, now), seat: existing, status: "seated" };
  }

  const alreadyPending = table.pendingJoins.some((p) => p.playerId === playerId);
  if (alreadyPending) {
    return { table, seat: -1, status: "pending" };
  }

  const open = aiSeatIndexes(table);
  if (open.length === 0) {
    return { table, seat: -1, status: "full" };
  }

  const finalName = uniqueName(table, name);

  if (atHandBoundary(table)) {
    const idx = open[0];
    const seats = table.seats.map((s, i) =>
      i === idx ? { kind: "human", name: finalName, playerId, lastSeen: now } : s
    );
    return { table: commit({ ...table, seats }, now), seat: idx, status: "seated" };
  }

  // Mid-hand: hold them until the hand ends. The name is resolved now so the
  // roster can show "Dave (joining next hand)" rather than a blank.
  const pendingJoins = [...table.pendingJoins, { playerId, name: finalName, requestedAt: now }];
  return { table: commit({ ...table, pendingJoins }, now), seat: -1, status: "pending" };
}

// MP-2.3. Called at the hand boundary, before the next deal. Queued players
// take AI seats in arrival order; anyone who queued for a table that filled
// up in the meantime stays queued rather than being silently dropped.
export function applyPendingJoins(table, now) {
  if (table.pendingJoins.length === 0) return table;

  let seats = [...table.seats];
  const stillPending = [];
  let changed = false;

  for (const p of table.pendingJoins) {
    const open = seats.map((s, i) => (s.kind === "ai" ? i : -1)).filter((i) => i >= 0);
    if (open.length === 0) {
      stillPending.push(p);
      continue;
    }
    const idx = open[0];
    seats[idx] = { kind: "human", name: p.name, playerId: p.playerId, lastSeen: now };
    changed = true;
  }

  if (!changed) return table;
  return commit({ ...table, seats, pendingJoins: stillPending }, now);
}

// A human leaving hands their seat back to the AI under the same name they
// were using, so the table keeps playing without a gap. Full COM-3 behavior
// (grace period, reclaiming your seat after a dropped connection) builds on
// this; for now it's the explicit "I'm leaving" path.
export function leaveTable(table, { playerId, now }) {
  const idx = seatOf(table, playerId);
  if (idx < 0) {
    const pendingJoins = table.pendingJoins.filter((p) => p.playerId !== playerId);
    if (pendingJoins.length === table.pendingJoins.length) return table;
    return commit({ ...table, pendingJoins }, now);
  }
  const seats = table.seats.map((s, i) => (i === idx ? aiSeat(AI_NAMES[i - 1] || `Seat ${i + 1}`) : s));
  return commit({ ...table, seats }, now);
}

export function markSeen(table, { playerId, now }) {
  const idx = seatOf(table, playerId);
  if (idx < 0) return table;
  const seats = table.seats.map((s, i) => (i === idx ? { ...s, lastSeen: now } : s));
  // Presence pings must not bump the CAS version — they'd collide constantly
  // with real plays for no reason. updatedAt still moves so the store can
  // refresh the table's TTL.
  return { ...table, seats, updatedAt: now };
}

/* ------------------------------ Hand control ------------------------------ */

// MP-2.4. Deals the next hand at whatever human/AI mix is currently seated —
// the engine neither knows nor cares which seats are driven by a person, so
// 1 human + 4 AI through 5 humans + 0 AI all take the same path.
export function startHand(table, now) {
  if (!atHandBoundary(table)) return table;
  const seated = applyPendingJoins(table, now);
  const handNum = seated.handNum + 1;
  const dealer = seated.handNum === 0 ? seated.dealer : (seated.dealer + 1) % SEATS;
  const g = freshHand(dealer, seated.scores, handNum);
  return commit({ ...seated, phase: "playing", dealer, handNum, g }, now);
}
