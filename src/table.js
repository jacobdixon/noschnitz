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
import { HOUSE_RULES } from "./rules.js";

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
  const taken = [
    ...table.seats.filter((s) => s.name).map((s) => s.name),
    // Watchers count as taken too. They are named on the table's announcement
    // line before they ever sit down — "Dave will take Gus's seat after this
    // hand" — and two of those saying the same thing is exactly the confusion
    // the seat check above exists to prevent, just one step earlier.
    ...(table.pendingJoins || []).filter((p) => p.name).map((p) => p.name),
  ];
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
  return {
    ...table,
    // The running total lives on the engine state — freshHand seeds g.scores
    // and the hand-end scoring adds each hand's delta to it — while the
    // table's own copy is what the scores modal and every client reads.
    // Nothing kept the two in step, so table.scores stayed at its initial
    // zeros for the life of the table, and startHand below dealt every hand
    // seeded from those zeros. The felt showed one hand's result and then
    // forgot it; the scores modal showed +0 for everyone, forever.
    //
    // Synced here rather than at each call site because this is the one place
    // every mutation already passes through, which is the property that makes
    // it impossible for a future path to forget.
    scores: table.g?.scores ? [...table.g.scores] : table.scores,
    version: table.version + 1,
    updatedAt: now,
  };
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
    // Copied onto the table rather than read from the constant when rendering,
    // which is the whole point of them being state: a guest arriving from a
    // link is told what this table agreed on rather than assuming. The copy is
    // deliberate — sharing the array reference would let one table's future
    // change leak into every other table in the same isolate.
    rules: [...HOUSE_RULES],
    dealer: 0,
    scores: [0, 0, 0, 0, 0],
    handNum: 0,
    g: null,
  };
}

/* -------------------------------- Queries -------------------------------- */

// Three seat kinds:
//   "human" — claimed, the player is present, they play their own cards
//   "away"  — claimed, the player is absent, AI covers (COM-3.1/3.3)
//   "ai"    — unclaimed house AI, and the only kind a newcomer may take
export const isClaimed = (seat) => seat.kind === "human" || seat.kind === "away";

// Matches "away" seats as well as "human" ones: a seat you stepped away from is
// still YOUR seat, and this is what lets you reclaim it (COM-3.2) rather than
// being handed whatever is free.
export const seatOf = (table, playerId) =>
  playerId == null ? -1 : table.seats.findIndex((s) => isClaimed(s) && s.playerId === playerId);

// How long a seat goes unheard-from before the AI covers it. Long enough to
// survive a tunnel or a phone locking during someone else's turn, short enough
// that a table doesn't sit dead while everyone waits on a player who left.
export const AWAY_AFTER_MS = 90_000;

export const humanSeats = (table) => table.seats.filter((s) => s.kind === "human").length;
// Only unclaimed seats. An "away" seat is reserved for the player who holds it,
// so a newcomer must never be dropped into it.
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

// How many people may be waiting on a seat at one table at once.
//
// A watcher costs almost nothing — a name in an array — but the queue is
// writable by anyone holding the link, and the link circulates in group texts,
// so it needs a ceiling somewhere. Eight comes from how this group actually
// plays: the get61 era topped out at six or seven wanting in on a good night,
// and five of them are in seats.
export const MAX_WATCHERS = 8;

// MP-3.1 / MP-3.2 / MP-2.3. Three distinct outcomes, and which one you get
// depends on whether there is a free seat AND whether a hand is in progress:
//
//   "seated"  — took a seat right now (a free AI seat at a hand boundary, or
//               a returning player reclaiming the seat they already hold)
//   "pending" — in, watching the table, and queued for the next seat that
//               opens. Either the hand is mid-flight (so seating them now
//               would corrupt it) or every seat is held by a person.
//   "full"    — nobody can even watch, because MAX_WATCHERS are already
//               waiting. The genuinely degenerate case, not "the table has
//               five players".
//
// A full table used to be refused outright, which was the wrong answer to the
// question being asked. Somebody who taps a link their friend texted them has
// not asked for a seat, they have asked to be at the table — and the table
// wants them there, because five humans and a queue is how a games night
// rotates people through five chairs. So arriving always gets you in; what
// varies is whether you are holding cards yet.
//
// A returning guest on the same device (same playerId) always short-circuits
// to "seated": they're not taking a new seat, they still have theirs.
export function joinTable(table, { playerId, name, now }) {
  const existing = seatOf(table, playerId);
  if (existing >= 0) {
    // COM-3.2 — reclaiming. If the AI has been covering this seat, take it back;
    // otherwise this is just a presence refresh on a seat already held.
    const seats = table.seats.map((s, i) =>
      i === existing ? { ...s, kind: "human", lastSeen: now } : s
    );
    return { table: commit({ ...table, seats }, now), seat: existing, status: "seated" };
  }

  const alreadyPending = table.pendingJoins.some((p) => p.playerId === playerId);
  if (alreadyPending) {
    return { table, seat: -1, status: "pending" };
  }

  const open = aiSeatIndexes(table);
  const finalName = uniqueName(table, name);

  if (open.length > 0 && atHandBoundary(table)) {
    const idx = open[0];
    const seats = table.seats.map((s, i) =>
      i === idx ? { kind: "human", name: finalName, playerId, lastSeen: now } : s
    );
    return { table: commit({ ...table, seats }, now), seat: idx, status: "seated" };
  }

  if (table.pendingJoins.length >= MAX_WATCHERS) {
    return { table, seat: -1, status: "full" };
  }

  // Watching, and queued. The name is resolved now because it is announced to
  // the table immediately — see watcherNotice — rather than only appearing
  // when they sit down.
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

/* ------------------------------- Watching --------------------------------- */

// Which seat each queued watcher is slated to take, in arrival order. -1 for a
// watcher with nothing to point at: every seat is held by a person, so they are
// waiting on somebody leaving rather than on the hand ending.
//
// Derived rather than stored, and that is the whole point. applyPendingJoins
// hands out whatever is open AT THE DEAL, so a seat recorded at join time would
// be a promise the deal need not keep — the AI seat can be claimed by someone
// else first, or a fifth human can leave and open a different one. Reading it
// off current state means the announcement always describes the seat this
// person would genuinely take if the hand ended right now.
export function watcherSeats(table) {
  const open = aiSeatIndexes(table);
  return (table.pendingJoins || []).map((_, i) => (i < open.length ? open[i] : -1));
}

// What the table is told when somebody arrives.
//
// Third person on purpose: this is an announcement to the room, not a message
// to the arrival. They are watching the same felt as everyone else, so they
// read the same line — and it answers the only question they actually have,
// which is when they are in.
export function watcherNotice(name, aiName) {
  return aiName
    ? `${name} will take ${aiName}'s seat after this hand.`
    : `${name} is watching and will take next available seat.`;
}

// One announcement per watcher, ready to render.
//
// Reads only fields that survive redaction (a seat's kind and name, a queued
// player's name and `isYou`), so the client can call it on the view it already
// holds. The alternative — a server-computed line shipped alongside the table —
// is a second copy of this rule that can fall out of step with the seats it
// describes.
export function watcherNotices(table) {
  const targets = watcherSeats(table);
  return (table.pendingJoins || []).map((p, i) => ({
    name: p.name,
    seat: targets[i],
    isYou: Boolean(p.isYou),
    text: watcherNotice(p.name, targets[i] >= 0 ? table.seats[targets[i]].name : null),
  }));
}

/* -------------------------------------------------------------------------- */

// A human leaving hands their seat back to the AI under the same name they
// were using, so the table keeps playing without a gap. Full COM-3 behavior
// (grace period, reclaiming your seat after a dropped connection) builds on
// this; for now it's the explicit "I'm leaving" path.
// How long a seat has been unheard-from. Callers pass `now` from the same clock
// the table was written with (server time) — see the note on skew in
// TableScreen, which corrects for it before displaying this.
export function idleMs(table, seat, now) {
  const s = table.seats[seat];
  if (!s || !isClaimed(s)) return 0;
  return Math.max(0, now - (s.lastSeen ?? table.updatedAt ?? now));
}

// Can this seat be booted right now? Separate from `coverIdleSeats`, which only
// covers the seat that is BLOCKING play: a player can be long gone without ever
// having been the one holding things up, and the table should still be able to
// reclaim their seat.
export function isBootable(table, seat, now, awayAfterMs = AWAY_AFTER_MS) {
  const s = table.seats[seat];
  if (!s || !isClaimed(s)) return false;
  return idleMs(table, seat, now) > awayAfterMs;
}

// Releasing a seat outright, as opposed to covering it. Cover keeps the seat
// for its owner; boot hands it back to the house AI so somebody else can sit
// down. The booted player isn't banned — the table code is still the only
// credential — they'd simply rejoin as a newcomer taking a free seat.
export function bootSeat(table, { seat, now }) {
  const s = table.seats[seat];
  if (!s || !isClaimed(s)) return table;
  const seats = table.seats.map((x, i) =>
    i === seat ? aiSeat(AI_NAMES[i - 1] || `Seat ${i + 1}`) : x
  );
  return commit({ ...table, seats }, now);
}

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

/* --------------------------- Stepping away (COM-3) ------------------------- */

// COM-3.1 — one action to hand your seat to the AI without giving it up. The
// difference from leaveTable is the whole point: the seat stays yours, keeps
// your name, and is not offered to anyone else.
export function stepAway(table, { playerId, now }) {
  const idx = seatOf(table, playerId);
  if (idx < 0 || table.seats[idx].kind === "away") return table;
  const seats = table.seats.map((s, i) => (i === idx ? { ...s, kind: "away" } : s));
  return commit({ ...table, seats }, now);
}

// COM-3.2 — taking your seat back from the AI.
//
// The counterpart to stepAway, and it was missing entirely: joinTable reclaims
// an away seat, but nothing in the client ever called it for a player who
// still HELD a seat — the presence ping only touches lastSeen, and the join
// gate sends an already-seated player straight through without joining. So
// once the AI covered a seat, its owner had no way back at all.
//
// Deliberately explicit rather than automatic. A tab that wakes in somebody's
// pocket and resumes pinging is weak evidence a human is at the table, and
// auto-reclaiming on that would hand the seat back to nobody and stall the
// hand all over again. Coming back is a thing you do, not a thing that happens
// to you.
export function resumeSeat(table, { playerId, now }) {
  const idx = seatOf(table, playerId);
  if (idx < 0) return table;
  if (table.seats[idx].kind === "human") return table;
  const seats = table.seats.map((s, i) =>
    i === idx ? { ...s, kind: "human", lastSeen: now } : s
  );
  return commit({ ...table, seats }, now);
}

// COM-3.4 — the table must never stall on somebody who stopped responding.
// Anyone unheard-from for longer than `awayAfterMs` gets covered by the AI so
// play continues; they reclaim their seat by simply coming back (see joinTable).
//
// This depends entirely on `lastSeen` being refreshed while a player is merely
// WATCHING, not just when they act — otherwise everyone at the table gets
// covered mid-hand while paying perfect attention. The stream heartbeat is what
// keeps it current; see api/tables/[id]/events.js.
export function coverIdleSeats(table, now, awayAfterMs = AWAY_AFTER_MS) {
  // The last human present is never covered, however quiet they have gone.
  //
  // Cover exists for one reason: to stop a table full of people from stalling on
  // somebody who left. With one human at the table there is nobody to un-stall —
  // the only party inconvenienced by waiting is the player being waited on, and
  // the only party harmed by covering is the same person. So the entire upside
  // is gone and the downside is the worst one this system has: you put your
  // phone down between tricks, come back, and the AI has picked, buried, called
  // and played out your hand. That is indistinguishable from losing your game.
  //
  // Presence is the weak link that makes it concrete. lastSeen depends on a
  // client ping that a backgrounded tab stops sending — see the note on `active`
  // in api/tables/[id]/state.js — so "gone quiet" routinely means "locked their
  // screen", not "left". Everywhere else that weakness costs at most one covered
  // seat on a table that keeps playing; here it costs the whole session.
  //
  // Stepping away deliberately (stepAway) is untouched: asking the AI to cover
  // for you is a choice, and the solo-vs-AI table is exactly where you might
  // want it. This only refuses to make that choice FOR you.
  //
  // A queued joiner counts as company, and has to. They clicked the link
  // mid-hand and are waiting on a hand boundary that only arrives if the hand
  // is played out (applyPendingJoins runs in startHand) — so protecting the
  // last SEATED human here would strand a real person on a frozen table with no
  // way in. They are not "nobody waiting"; they are the one case where covering
  // still does its job. A stale queue entry can't disable the rule for long:
  // the joiner is seated at the next boundary and becomes a seat of their own.
  if (humanSeats(table) <= 1 && table.pendingJoins.length === 0) return table;

  // Only ever cover the seat the table is actually WAITING ON. Covering a quiet
  // player whose turn it isn't achieves nothing — the hand wasn't blocked on
  // them — and turns any weakness in presence tracking into players being
  // replaced by AI mid-game. That is precisely what happened when presence was
  // starved on a busy table: this swept up everyone at once instead of the one
  // seat holding things up. Blast radius is now at most one seat at a time, and
  // only when it is genuinely stalling play. If a second player has also gone,
  // the next pass covers them once the turn reaches them.
  const blocking = seatOwedDecision(table);
  if (blocking < 0) return table;

  const s = table.seats[blocking];
  if (!s || s.kind !== "human") return table;

  // A seat that has never reported in gets the benefit of the doubt until it
  // has had a full window to do so.
  const since = s.lastSeen ?? table.updatedAt ?? now;
  if (now - since <= awayAfterMs) return table;

  const seats = table.seats.map((x, i) => (i === blocking ? { ...x, kind: "away" } : x));
  return commit({ ...table, seats }, now);
}

// Which seat, if any, the table cannot proceed without. -1 when nothing is
// waiting on a particular player (no hand dealt, hand over, trick mid-resolve).
export function seatOwedDecision(table) {
  const g = table.g;
  if (!g) return -1;
  if (g.phase === "picking") return g.passes >= SEATS ? -1 : g.pickTurn;
  if (g.phase === "bury" || g.phase === "call") return g.picker ?? -1;
  if (g.phase === "playing") return g.trick.length >= SEATS ? -1 : g.turn;
  return -1;
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
  // Carries the running total forward. seated.scores is the previous hand's
  // final total because commit() syncs it from the engine state.
  const g = freshHand(dealer, seated.scores, handNum);
  // Drop the previous hand's AI log with the hand it belonged to. `aiLogHand`
  // already stops anyone READING a stale log, but the entries themselves rode
  // along in the table until some AI seat next acted — so the first frame of a
  // new hand shipped every client a list of cards played in the last one, and
  // anything that reached for the log before checking the hand number saw them.
  // The log is per-hand; it should not outlive its hand.
  return commit(
    { ...seated, phase: "playing", dealer, handNum, g, aiLog: [], aiLogHand: handNum },
    now
  );
}
