#!/usr/bin/env node
/* ============================================================================
   Table + seat lifecycle tests.

   One case per user story in ROADMAP.md's Now bucket, referenced by ID so a
   failure points straight at the story it breaks. Plus the concurrency cases,
   which are the reason the CAS loop exists and the thing least likely to be
   caught by playing the game manually.

   Usage: node scripts/tabletest.mjs
   ========================================================================= */
import {
  createTable, joinTable, leaveTable, applyPendingJoins, startHand,
  markSeen, seatOf, humanSeats, aiSeatIndexes, uniqueName, makeTableCode,
  atHandBoundary, AI_NAMES, stepAway, coverIdleSeats, AWAY_AFTER_MS,
  idleMs, isBootable, bootSeat, resumeSeat, commit,
  MAX_WATCHERS, watcherSeats, watcherNotice, watcherNotices,
} from "../src/table.js";
import { createMemoryStore } from "../src/store/memory.js";
import { mutate } from "../src/store/mutate.js";

let passed = 0;
const failures = [];

function check(label, cond, detail = "") {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

const T0 = 1_700_000_000_000;
const host = { hostPlayerId: "p-host", hostName: "Jacob", now: T0 };

/* ------------------------------ MP-1: tables ------------------------------ */

{
  const t = createTable(host);
  check("MP-1.1 host is seated immediately", t.seats[0]?.kind === "human" && t.seats[0]?.playerId === "p-host");
  check("MP-2.1 the other four seats are AI", aiSeatIndexes(t).length === 4);
  check("MP-2.1 table is playable with one human", humanSeats(t) === 1);
  check("MP-1.2 table has a code", typeof t.id === "string" && t.id.length === 8, `got "${t.id}"`);
  check("MP-1.4 roster is inspectable", t.seats.every((s) => typeof s.name === "string" && s.name.length > 0));
  check("new table starts in lobby", t.phase === "lobby" && t.g === null);
}

{
  // Codes must not collide in practice, and must avoid glyphs that get
  // misread when someone reads a link aloud.
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(makeTableCode());
  check("MP-1.2 codes are unique across 5000 draws", seen.size === 5000, `got ${seen.size}`);
  const all = [...seen].join("");
  check("MP-1.2 codes avoid ambiguous glyphs", !/[01ilo]/i.test(all));
}

/* ------------------------------ MP-3: guests ------------------------------ */

{
  const t = createTable(host);
  const r = joinTable(t, { playerId: "p-dave", name: "Dave", now: T0 + 1000 });
  check("MP-3.1 guest is seated with just a name", r.status === "seated" && r.seat > 0);
  check("MP-3.1 guest needs no account", r.table.seats[r.seat]?.playerId === "p-dave");
  check("MP-2.2 taken seat is now human", r.table.seats[r.seat]?.kind === "human");
  check("MP-2.2 remaining seats still AI", aiSeatIndexes(r.table).length === 3);
}

{
  // MP-3.2 — same device, same playerId. Must reclaim the existing seat, not
  // consume a second one.
  const t = createTable(host);
  const first = joinTable(t, { playerId: "p-dave", name: "Dave", now: T0 + 1000 });
  const again = joinTable(first.table, { playerId: "p-dave", name: "Dave", now: T0 + 2000 });
  check("MP-3.2 returning guest reclaims the same seat", again.seat === first.seat);
  check("MP-3.2 returning guest doesn't consume a second seat", humanSeats(again.table) === 2);
  check("MP-3.2 rejoin refreshes presence", again.table.seats[again.seat]?.lastSeen === T0 + 2000);
}

{
  // MP-3.4 — against other humans AND against the AI names, since "Gus" the
  // guest sitting next to Gus the AI is exactly the confusion to avoid.
  const t = createTable(host);
  const a = joinTable(t, { playerId: "p1", name: "Dave", now: T0 });
  const b = joinTable(a.table, { playerId: "p2", name: "dave", now: T0 });
  // Collision detection is case-insensitive, but the suffix is appended to
  // what the player actually typed — we disambiguate their name, we don't
  // restyle it to match someone else's capitalization.
  check("MP-3.4 duplicate human name is disambiguated", b.table.seats[b.seat]?.name === "dave 2",
    `got "${b.table.seats[b.seat]?.name}"`);
  check("MP-3.4 collision check is case-insensitive", b.status === "seated" && b.seat !== a.seat);

  const c = joinTable(t, { playerId: "p3", name: "Gus", now: T0 });
  check("MP-3.4 collision with an AI name is disambiguated", c.table.seats[c.seat]?.name === "Gus 2",
    `got "${c.table.seats[c.seat]?.name}"`);

  check("MP-3.3 blank name falls back rather than seating an empty label",
    uniqueName(t, "   ") === "Guest");
}

{
  const t = createTable(host);
  let cur = t;
  for (const [i, p] of [["p1", "A"], ["p2", "B"], ["p3", "C"], ["p4", "D"]].entries()) {
    cur = joinTable(cur, { playerId: p[0], name: p[1], now: T0 + i }).table;
  }
  check("MP-2.4 five humans fills the table", humanSeats(cur) === 5);

  // A sixth person is not turned away — they watch and queue. Five chairs and
  // a queue is how a games night rotates seven people through them.
  const sixth = joinTable(cur, { playerId: "p5", name: "E", now: T0 });
  check("a sixth player watches rather than being refused", sixth.status === "pending");
  check("...and is on the table's queue", sixth.table.pendingJoins.length === 1);
  check("...without taking a seat", humanSeats(sixth.table) === 5);
  check("...and is announced as waiting for a seat, since there is no AI to name",
    watcherNotices(sixth.table)[0].text === "E is watching and will take next available seat.",
    watcherNotices(sixth.table)[0].text);

  // The ceiling, which is the only thing left that can refuse anybody.
  let crowded = sixth.table;
  for (let i = 1; i < MAX_WATCHERS; i++) {
    crowded = joinTable(crowded, { playerId: `w${i}`, name: `W${i}`, now: T0 + i }).table;
  }
  check("the queue fills at MAX_WATCHERS", crowded.pendingJoins.length === MAX_WATCHERS);
  const overflow = joinTable(crowded, { playerId: "w-last", name: "Last", now: T0 });
  check("past the ceiling a join is refused", overflow.status === "full");
  check("rejected join doesn't mutate the table", overflow.table === crowded);
}

/* ------------------- MP-3.5: watching while you wait ---------------------- */

{
  // The two sentences, pinned literally. They are what the table reads, so
  // they are a contract rather than an implementation detail — and the second
  // one is the case nobody hits until a games night is genuinely full.
  check("the announcement names the seat being taken",
    watcherNotice("Dave", "Gus") === "Dave will take Gus's seat after this hand.",
    watcherNotice("Dave", "Gus"));
  check("with no AI seated it promises the next one instead",
    watcherNotice("Dave", null) === "Dave is watching and will take next available seat.",
    watcherNotice("Dave", null));
}

{
  // The announcement is the whole feature: an arrival mid-hand is told when
  // they are in, and the table is told whose seat is changing hands.
  const t = startHand(createTable(host), T0);
  const r = joinTable(t, { playerId: "p-dave", name: "Dave", now: T0 + 500 });
  check("a mid-hand arrival watches", r.status === "pending");

  const [notice] = watcherNotices(r.table);
  const target = watcherSeats(r.table)[0];
  check("the watcher is pointed at the first free AI seat", target === aiSeatIndexes(t)[0]);
  check("the table is told whose seat it is",
    notice.text === `Dave will take ${r.table.seats[target].name}'s seat after this hand.`,
    notice.text);
  check("the notice names the arrival", notice.name === "Dave");

  // Derived, not stored. If that AI seat is taken by somebody else before the
  // deal, the announcement has to follow — applyPendingJoins hands out
  // whatever is open AT THE DEAL, so a seat pinned at join time would be a
  // promise the deal need not keep.
  const stolen = {
    ...r.table,
    seats: r.table.seats.map((s, i) =>
      i === target ? { kind: "human", name: "Erin", playerId: "p-erin", lastSeen: T0 } : s
    ),
  };
  check("the announcement follows the seats, not the moment of joining",
    watcherSeats(stolen)[0] === aiSeatIndexes(stolen)[0] && watcherSeats(stolen)[0] !== target);

  // Two watchers queue for two different seats, in arrival order.
  const second = joinTable(r.table, { playerId: "p-fran", name: "Fran", now: T0 + 600 });
  const seats = watcherSeats(second.table);
  check("two watchers are slated for different seats", seats[0] !== seats[1] && seats[1] >= 0);
  check("...in arrival order", seats[0] === aiSeatIndexes(t)[0] && seats[1] === aiSeatIndexes(t)[1]);
  const drained = startHand({ ...second.table, g: { ...second.table.g, phase: "handEnd" } }, T0 + 2000);
  check("...and the deal seats them exactly where they were promised",
    seatOf(drained, "p-dave") === seats[0] && seatOf(drained, "p-fran") === seats[1]);

  // Names are deduped against the queue too, or the announcement says the same
  // thing twice about two different people.
  const twin = joinTable(second.table, { playerId: "p-dave2", name: "Dave", now: T0 + 700 });
  check("a second Dave in the queue is renamed", twin.table.pendingJoins[2].name !== "Dave");
}

/* --------------------- MP-2.3: joining mid-hand ---------------------- */

{
  const t = startHand(createTable(host), T0);
  check("startHand deals", t.phase === "playing" && t.g !== null && t.g.hands.length === 5);
  check("mid-hand is not a boundary", !atHandBoundary(t));

  const gBefore = t.g;
  const r = joinTable(t, { playerId: "p-late", name: "Late", now: T0 + 500 });
  check("MP-2.3 mid-hand join is queued, not seated", r.status === "pending" && r.seat === -1);
  check("MP-2.3 queued join does not disturb the hand in progress", r.table.g === gBefore);
  check("MP-2.3 queued join takes no seat yet", humanSeats(r.table) === 1);
  check("MP-2.3 queued player is visible on the roster", r.table.pendingJoins[0]?.name === "Late");

  const dup = joinTable(r.table, { playerId: "p-late", name: "Late", now: T0 + 600 });
  check("MP-2.3 re-requesting while queued doesn't double-queue", dup.table.pendingJoins.length === 1);

  // Hand ends -> the queued player takes a seat on the next deal.
  const ended = { ...r.table, g: { ...r.table.g, phase: "handEnd" } };
  check("hand end is a boundary", atHandBoundary(ended));
  const next = startHand(ended, T0 + 1000);
  check("MP-2.3 queued player is seated at the boundary", seatOf(next, "p-late") > 0);
  check("MP-2.3 queue is drained", next.pendingJoins.length === 0);
  check("MP-2.3 a fresh hand was dealt", next.handNum === 2 && next.g.handNum === 2);
  check("dealer advances between hands", next.dealer === (t.dealer + 1) % 5);
}

/* --------------------------- MP-2.4: any mix ---------------------------- */

{
  // 1 human + 4 AI through 5 humans + 0 AI must all deal a valid hand.
  for (let humans = 1; humans <= 5; humans++) {
    let t = createTable(host);
    for (let i = 1; i < humans; i++) {
      t = joinTable(t, { playerId: `p${i}`, name: `P${i}`, now: T0 }).table;
    }
    t = startHand(t, T0);
    const cards = t.g.hands.reduce((n, h) => n + h.length, 0);
    check(`MP-2.4 deals correctly with ${humans} human(s)`,
      humanSeats(t) === humans && cards === 30 && t.g.blind.length === 2,
      `humans=${humanSeats(t)} cards=${cards}`);
  }
}

/* ------------------------------ Leaving --------------------------------- */

{
  const t = createTable(host);
  const j = joinTable(t, { playerId: "p-dave", name: "Dave", now: T0 });
  const left = leaveTable(j.table, { playerId: "p-dave", now: T0 + 1 });
  check("leaving hands the seat back to an AI", left.seats[j.seat]?.kind === "ai");
  check("leaving keeps the table playable", humanSeats(left) === 1 && aiSeatIndexes(left).length === 4);
  check("AI resumes its usual name", AI_NAMES.includes(left.seats[j.seat]?.name));

  const queued = joinTable(startHand(t, T0), { playerId: "p-q", name: "Q", now: T0 });
  const unqueued = leaveTable(queued.table, { playerId: "p-q", now: T0 + 1 });
  check("leaving while queued removes you from the queue", unqueued.pendingJoins.length === 0);
}

{
  const t = joinTable(createTable(host), { playerId: "p-dave", name: "Dave", now: T0 }).table;
  const seen = markSeen(t, { playerId: "p-dave", now: T0 + 5000 });
  check("presence ping records lastSeen", seen.seats[seatOf(seen, "p-dave")]?.lastSeen === T0 + 5000);
  check("presence ping does NOT bump the CAS version", seen.version === t.version);
  check("presence ping still refreshes TTL clock", seen.updatedAt === T0 + 5000);
}


/* ------------------- Thrown-in hand: the deadlock case ------------------- */

{
  // All five passing used to wedge the table permanently: advanceAI stops at
  // five passes and defers the redeal, startHand refused because this wasn't
  // considered a boundary, and no UI offered a way out. The table sat in
  // "picking" forever reporting that somebody was still deciding.
  let t = startHand(createTable(host), T0);
  check("a dealt hand is not a boundary", !atHandBoundary(t));

  const passed = { ...t, g: { ...t.g, passes: 5 } };
  check("a thrown-in hand IS a boundary", atHandBoundary(passed));

  const redealt = startHand(passed, T0 + 1000);
  check("a thrown-in hand can be redealt", redealt.g !== null && redealt.g.passes === 0);
  check("redealing advances the hand number", redealt.handNum === t.handNum + 1);
  check("redealing rotates the dealer", redealt.dealer === (t.dealer + 1) % 5);
  check("a redealt hand is freshly dealt",
    redealt.g.hands.reduce((n, h) => n + h.length, 0) === 30 && redealt.g.blind.length === 2);

  // A player who queued while the dead hand was being passed around must be
  // seated by the redeal, not left waiting on a hand nobody will ever play.
  const queued = joinTable(t, { playerId: "p-queued", name: "Q", now: T0 });
  const queuedThenPassed = { ...queued.table, g: { ...queued.table.g, passes: 5 } };
  check("a mid-hand joiner is queued while the dead hand runs",
    queued.status === "pending");
  const afterRedeal = startHand(queuedThenPassed, T0 + 2000);
  check("the redeal seats anyone who was queued", seatOf(afterRedeal, "p-queued") > 0);
  check("the redeal drains the queue", afterRedeal.pendingJoins.length === 0);
}


/* --------------------- COM-3: stepping away and cover --------------------- */

{
  // COM-3.1 — the seat stays yours. That's the whole difference from leaving.
  let t = joinTable(createTable(host), { playerId: "p-dave", name: "Dave", now: T0 }).table;
  const seat = seatOf(t, "p-dave");
  const away = stepAway(t, { playerId: "p-dave", now: T0 + 10 });

  check("stepping away marks the seat away", away.seats[seat]?.kind === "away");
  check("stepping away keeps your name on the seat", away.seats[seat]?.name === "Dave");
  check("stepping away keeps the seat yours", seatOf(away, "p-dave") === seat);
  check("an away seat is NOT offered to newcomers", !aiSeatIndexes(away).includes(seat));
  check("leaving, by contrast, releases the seat",
    leaveTable(t, { playerId: "p-dave", now: T0 + 10 }).seats[seat]?.kind === "ai");
  check("stepping away twice is a no-op",
    stepAway(away, { playerId: "p-dave", now: T0 + 20 }) === away);

  // COM-3.2 — coming back is enough; there is no separate "return" action.
  const back = joinTable(away, { playerId: "p-dave", name: "Dave", now: T0 + 100 });
  check("returning reclaims your own seat", back.seat === seat && back.status === "seated");
  check("returning restores you to present", back.table.seats[seat]?.kind === "human");
  check("returning doesn't consume another seat", humanSeats(back.table) === 2);
}

{
  // COM-3.4 — a table must never sit forever on somebody who stopped responding.
  // But it must ALSO never cover a player it isn't waiting on: that turns any
  // weakness in presence tracking into people being replaced mid-game, which is
  // exactly what happened on a live three-player table.
  // Three humans, because cover stops at the last one (see the block below) —
  // with two, the second half of this would be testing that rule instead of
  // this one.
  let t = joinTable(createTable(host), { playerId: "p-dave", name: "Dave", now: T0 }).table;
  t = joinTable(t, { playerId: "p-erin", name: "Erin", now: T0 }).table;
  t = startHand(t, T0);
  const daveSeat = seatOf(t, "p-dave");
  const hostSeat = seatOf(t, "p-host");

  // Dave owes the decision and has gone quiet.
  const daveBlocking = { ...t, g: { ...t.g, phase: "picking", pickTurn: daveSeat, passes: 0 } };
  const covered = coverIdleSeats(daveBlocking, T0 + AWAY_AFTER_MS + 1);
  check("the blocking player who has gone quiet gets covered",
    covered.seats[daveSeat]?.kind === "away");
  check("covering keeps the seat theirs to reclaim", seatOf(covered, "p-dave") === daveSeat);
  check("covering bumps the version like any other mutation", covered.version > daveBlocking.version);

  // THE regression: the host is equally quiet, but the table isn't waiting on
  // them. Covering them would accomplish nothing and cost them their seat.
  check("a quiet player the table is NOT waiting on is left alone",
    covered.seats[hostSeat]?.kind === "human",
    `host kind=${covered.seats[hostSeat]?.kind}`);
  check("at most one seat is ever covered in a pass",
    covered.seats.filter((x) => x.kind === "away").length === 1);

  // Recently seen, still blocking: left alone.
  const seen = markSeen(daveBlocking, { playerId: "p-dave", now: T0 + AWAY_AFTER_MS });
  check("a blocking player who is still checking in is left alone",
    coverIdleSeats(seen, T0 + AWAY_AFTER_MS + 1).seats[daveSeat]?.kind === "human");

  // Nothing owed: nobody covered, however long it has been.
  const lobby = joinTable(createTable(host), { playerId: "p-x", name: "X", now: T0 }).table;
  check("a table with no hand dealt covers nobody",
    coverIdleSeats(lobby, T0 + AWAY_AFTER_MS * 10) === lobby);

  const ended = { ...t, g: { ...t.g, phase: "handEnd" } };
  check("a finished hand covers nobody", coverIdleSeats(ended, T0 + AWAY_AFTER_MS * 10) === ended);

  // Two absent players get covered one at a time, as the turn reaches them —
  // never in a single sweep.
  let progressive = coverIdleSeats(daveBlocking, T0 + AWAY_AFTER_MS + 1);
  const nowBlockingHost = { ...progressive, g: { ...progressive.g, pickTurn: hostSeat } };
  progressive = coverIdleSeats(nowBlockingHost, T0 + AWAY_AFTER_MS + 2);
  check("a second absent player is covered once the turn reaches them",
    progressive.seats[hostSeat]?.kind === "away");
}

{
  // The point of all of it: an away seat is AI-driven, so play continues. With
  // cover now scoped to the blocking seat, a table where everyone has gone
  // quiet clears one seat per pass rather than all at once — so this walks it
  // forward the way advanceTable would, and checks it always terminates.
  //
  // It stops one seat short of empty, and that is the rule below: the last
  // human at the table is never covered.
  let t = joinTable(createTable(host), { playerId: "p-dave", name: "Dave", now: T0 }).table;
  t = joinTable(t, { playerId: "p-erin", name: "Erin", now: T0 }).table;
  t = startHand(t, T0);

  // The turn keeps moving whether or not a seat was covered — an AI seat simply
  // isn't a candidate — so this advances every iteration rather than stopping
  // the first time a pass changes nothing.
  let cur = t;
  for (let i = 0; i < 15; i++) {
    cur = coverIdleSeats(cur, T0 + AWAY_AFTER_MS * (i + 2));
    cur = { ...cur, g: { ...cur.g, pickTurn: (cur.g.pickTurn + 1) % 5 } };
  }
  check("repeated passes cover every absent player but one",
    cur.seats.filter((x) => x.kind === "human").length === 1,
    `still present: ${cur.seats.filter((x) => x.kind === "human").length}`);
  check("every claimed seat still has an owner",
    cur.seats.filter((x) => x.playerId).length === 3);
  check("no seat is covered twice",
    cur.seats.filter((x) => x.kind === "away").length === 2,
    `away=${cur.seats.filter((x) => x.kind === "away").length}`);
}

{
  // THE rule: the AI never takes the last human's seat away from them.
  //
  // Cover exists to stop a table stalling on somebody who left. With one human
  // there is nobody else waiting, so the entire benefit is gone — and the cost
  // is the worst outcome in the system: you put your phone down between tricks
  // and come back to find the AI picked, called and played out your hand.
  //
  // Presence is why this is not hypothetical. A backgrounded tab stops pinging,
  // so "gone quiet" routinely means "locked their screen".
  let t = createTable(host);
  t = startHand(t, T0);
  const hostSeat = seatOf(t, "p-host");
  const solo = { ...t, g: { ...t.g, phase: "picking", pickTurn: hostSeat, passes: 0 } };

  check("the only human is not covered, however long they are quiet",
    coverIdleSeats(solo, T0 + AWAY_AFTER_MS * 100) === solo);

  // Negative control: the identical table with a second human present covers
  // exactly as it always did, so this is a rule about being LAST, not a blanket
  // disabling of cover.
  let pair = joinTable(createTable(host), { playerId: "p-dave", name: "Dave", now: T0 }).table;
  pair = startHand(pair, T0);
  const pairHostSeat = seatOf(pair, "p-host");
  const pairBlocking = { ...pair, g: { ...pair.g, phase: "picking", pickTurn: pairHostSeat, passes: 0 } };
  const pairCovered = coverIdleSeats(pairBlocking, T0 + AWAY_AFTER_MS + 1);
  check("with a second human present the blocking seat is still covered",
    pairCovered.seats[pairHostSeat]?.kind === "away");

  // ...and once that cover has run, the survivor is now the last human, so the
  // next pass leaves them alone. This is the path a real two-player table takes.
  const daveSeat = seatOf(pairCovered, "p-dave");
  const nowBlockingDave = { ...pairCovered, g: { ...pairCovered.g, pickTurn: daveSeat } };
  check("the survivor of a cover is not covered in turn",
    coverIdleSeats(nowBlockingDave, T0 + AWAY_AFTER_MS * 3) === nowBlockingDave);

  // A player who chose to hand their seat over is not "present" for this count,
  // and must not keep the last real human protected... nor lose their own away
  // status. Stepping away stays a choice you can make alone at the table.
  let chosen = joinTable(createTable(host), { playerId: "p-dave", name: "Dave", now: T0 }).table;
  chosen = startHand(chosen, T0);
  const awaySeat = seatOf(chosen, "p-dave");
  const stepped = stepAway(chosen, { playerId: "p-dave", now: T0 });
  const alone = startHand(createTable(host), T0);
  check("stepping away still works when you are the only human",
    stepAway(alone, { playerId: "p-host", now: T0 }).seats[seatOf(alone, "p-host")]?.kind === "away");
  const lastReal = seatOf(stepped, "p-host");
  const blockingLastReal = { ...stepped, g: { ...stepped.g, phase: "picking", pickTurn: lastReal, passes: 0 } };
  check("an away seat doesn't count as company — the last present human is safe",
    coverIdleSeats(blockingLastReal, T0 + AWAY_AFTER_MS * 100) === blockingLastReal,
    `host kind=${coverIdleSeats(blockingLastReal, T0 + AWAY_AFTER_MS * 100).seats[lastReal]?.kind}`);
  check("and the seat that stepped away stays away", stepped.seats[awaySeat]?.kind === "away");

  // The one exception, and it is somebody else's problem being solved, not the
  // absent player's: a guest who clicked the link mid-hand is queued until the
  // hand ends, and the hand only ends if it is played. Protecting the last
  // seated human here would freeze a real person out of the table entirely.
  const queued = joinTable(solo, { playerId: "p-guest", name: "Guest", now: T0 });
  check("a mid-hand guest is queued, not seated", queued.status === "pending");
  check("the last human IS covered when a guest is waiting to get in",
    coverIdleSeats(queued.table, T0 + AWAY_AFTER_MS + 1).seats[hostSeat]?.kind === "away");
  check("the covered seat is still theirs to reclaim",
    seatOf(coverIdleSeats(queued.table, T0 + AWAY_AFTER_MS + 1), "p-host") === hostSeat);
}


/* ------------------------- Booting an absent player ----------------------- */
{
  // Distinct from both leaving and stepping away: the TABLE reclaims somebody
  // else's seat. Cover keeps a seat for its owner; boot releases it so another
  // person can sit down.
  let t = joinTable(createTable(host), { playerId: "p-dave", name: "Dave", now: T0 }).table;
  const daveSeat = seatOf(t, "p-dave");

  check("a player just seen is not bootable", !isBootable(t, daveSeat, T0 + 1000));
  check("idle time is measured from lastSeen", idleMs(t, daveSeat, T0 + 5000) === 5000);
  check("a long-absent player is bootable", isBootable(t, daveSeat, T0 + AWAY_AFTER_MS + 1));

  // Bootable regardless of whether they were the one holding play up — which is
  // the difference from coverIdleSeats, and the reason both exist.
  const started = startHand(t, T0);
  const notBlocking = { ...started, g: { ...started.g, pickTurn: seatOf(started, "p-host") } };
  check("bootable even when not the blocking seat",
    isBootable(notBlocking, daveSeat, T0 + AWAY_AFTER_MS + 1));

  const booted = bootSeat(t, { seat: daveSeat, now: T0 + AWAY_AFTER_MS + 1 });
  check("booting hands the seat back to the house AI", booted.seats[daveSeat]?.kind === "ai");
  check("booting releases the claim", seatOf(booted, "p-dave") === -1);
  check("the freed seat is offered to newcomers", aiSeatIndexes(booted).includes(daveSeat));
  check("the seat gets its AI name back", AI_NAMES.includes(booted.seats[daveSeat]?.name));
  check("booting bumps the version", booted.version > t.version);

  // Booting is not a ban: the table code is still the only credential.
  const returned = joinTable(booted, { playerId: "p-dave", name: "Dave", now: T0 + 99999 });
  check("a booted player can rejoin", returned.status === "seated");

  // An away seat is still claimed, so it is still bootable — a player who
  // stepped away and never came back shouldn't hold a seat forever.
  const away = stepAway(t, { playerId: "p-dave", now: T0 });
  check("an away seat is still bootable once idle",
    isBootable(away, daveSeat, T0 + AWAY_AFTER_MS + 1));
  check("booting an away seat releases it",
    bootSeat(away, { seat: daveSeat, now: T0 }).seats[daveSeat]?.kind === "ai");

  // Nothing to reclaim from an unclaimed seat.
  const aiSeat0 = aiSeatIndexes(t)[0];
  check("a house AI seat is never bootable", !isBootable(t, aiSeat0, T0 + AWAY_AFTER_MS * 10));
  check("booting an AI seat is a no-op", bootSeat(t, { seat: aiSeat0, now: T0 }) === t);
}


/* ------------------- COM-3.2: taking your seat back ----------------------- */
{
  // The gap this closes: joinTable reclaims an away seat, but nothing in the
  // client ever reached it for a player who still HELD a seat. The presence
  // ping only touches lastSeen and the join gate sends an already-seated
  // player straight through, so once the AI covered a seat its owner had no
  // route back at all.
  let t = joinTable(createTable(host), { playerId: "p-dave", name: "Dave", now: T0 }).table;
  const seat = seatOf(t, "p-dave");

  // Deliberate step away, then back.
  const away = stepAway(t, { playerId: "p-dave", now: T0 + 10 });
  check("stepping away hands the seat to the AI", away.seats[seat]?.kind === "away");
  const back = resumeSeat(away, { playerId: "p-dave", now: T0 + 20 });
  check("taking it back restores control", back.seats[seat]?.kind === "human");
  check("taking it back refreshes presence", back.seats[seat]?.lastSeen === T0 + 20);
  check("taking it back keeps the same seat", seatOf(back, "p-dave") === seat);
  check("taking it back bumps the version", back.version > away.version);

  // The accidental path — covered for going quiet — must be reversible too.
  const started = startHand(t, T0);
  const blocking = { ...started, g: { ...started.g, phase: "picking", pickTurn: seat, passes: 0 } };
  const covered = coverIdleSeats(blocking, T0 + AWAY_AFTER_MS + 1);
  check("going quiet gets you covered", covered.seats[seat]?.kind === "away");
  const recovered = resumeSeat(covered, { playerId: "p-dave", now: T0 + AWAY_AFTER_MS + 2 });
  check("a player covered for going quiet can also take it back",
    recovered.seats[seat]?.kind === "human");
  check("and is no longer eligible to be covered again immediately",
    coverIdleSeats(recovered, T0 + AWAY_AFTER_MS + 3).seats[seat]?.kind === "human");

  // Nothing to do, and nothing to steal.
  check("taking back a seat you already control is a no-op",
    resumeSeat(t, { playerId: "p-dave", now: T0 + 50 }) === t);
  check("a stranger cannot take back a seat",
    resumeSeat(away, { playerId: "p-nobody", now: T0 + 50 }) === away);
  const hostSeat = seatOf(away, "p-host");
  check("taking your seat back doesn't disturb anyone else's",
    resumeSeat(away, { playerId: "p-dave", now: T0 + 50 }).seats[hostSeat]?.kind === "human");
}

/* ------------------------- Versioning + CAS store ------------------------- */

{
  const t = createTable(host);
  const j = joinTable(t, { playerId: "p1", name: "A", now: T0 });
  check("every mutation bumps the version", j.table.version === t.version + 1);
  check("mutations are immutable", t.seats[1]?.kind === "ai");
}

const asyncTests = async () => {
  {
    const store = createMemoryStore({ now: () => T0 });
    const t = createTable(host);
    await store.create(t);
    check("store.create then get round-trips", (await store.get(t.id)).id === t.id);
    const dup = await store.create(t);
    check("store.create refuses to overwrite", dup.ok === false && dup.error === "exists");

    const res = await mutate(store, t.id, (cur) => joinTable(cur, { playerId: "p1", name: "A", now: T0 }));
    check("mutate applies and persists", res.ok && res.wrote && humanSeats(await store.get(t.id)) === 2);
    check("mutate passes through extra return values", res.status === "seated" && res.seat > 0);

    const noop = await mutate(store, t.id, (cur) => joinTable(cur, { playerId: "zz", name: "Z", now: T0 }).table === cur
      ? cur : cur);
    check("mutate skips the write when nothing changed", noop.ok && noop.wrote === false);

    const missing = await mutate(store, "nope1234", (cur) => cur);
    check("mutate reports a missing table", missing.ok === false && missing.error === "no-such-table");
  }

  {
    // The case the CAS loop exists for: two players join at the same instant,
    // on different serverless instances. A competing write is injected between
    // this mutate's read and its write. Both players must end up seated, in
    // different seats — not one silently clobbering the other.
    const store = createMemoryStore({ now: () => T0 });
    const t = createTable(host);
    await store.create(t);

    let injected = false;
    const racing = {
      ...store,
      async get(id) {
        const cur = await store.get(id);
        if (!injected && cur) {
          injected = true;
          // Another instance seats a different player first.
          const other = joinTable(cur, { playerId: "p-fast", name: "Fast", now: T0 });
          await store.put(other.table, cur.version);
        }
        return cur;
      },
    };

    const res = await mutate(racing, t.id, (cur) => joinTable(cur, { playerId: "p-slow", name: "Slow", now: T0 }));
    const final = await store.get(t.id);
    check("CAS: the losing write retried rather than failing", res.ok && res.attempts === 2, `attempts=${res.attempts}`);
    check("CAS: both concurrent joins landed", seatOf(final, "p-fast") > 0 && seatOf(final, "p-slow") > 0);
    check("CAS: they took different seats", seatOf(final, "p-fast") !== seatOf(final, "p-slow"));
    check("CAS: no seat was lost", humanSeats(final) === 3);
  }

  {
    // A permanently-contended table must surface rather than spin forever.
    const store = createMemoryStore({ now: () => T0 });
    const t = createTable(host);
    await store.create(t);
    let n = 0;
    const hostile = {
      ...store,
      async get(id) {
        const cur = await store.get(id);
        // Always bump the stored version after every read, so no write can win.
        await store.put({ ...cur, version: cur.version + 1 }, cur.version);
        n++;
        return cur;
      },
    };
    const res = await mutate(hostile, t.id, (cur) => joinTable(cur, { playerId: `p${n}`, name: "X", now: T0 }));
    check("CAS: gives up after bounded retries", res.ok === false && res.error === "conflict");
    check("CAS: retry count is bounded", n <= 10, `reads=${n}`);
  }

  {
    // Tables are ephemeral by design; expiry is the cleanup story.
    let clock = T0;
    const store = createMemoryStore({ ttlMs: 1000, now: () => clock });
    const t = createTable(host);
    await store.create(t);
    clock = T0 + 500;
    check("TTL: table is live before expiry", (await store.get(t.id)) !== null);
    await store.touch(t.id);
    clock = T0 + 1400;
    check("TTL: touch extends the lease", (await store.get(t.id)) !== null);
    clock = T0 + 3000;
    check("TTL: table expires once idle", (await store.get(t.id)) === null);
  }
};

await asyncTests();

/* --------------------------- the running score ---------------------------- */
{
  // The table kept its own copy of the scores and nothing ever wrote to it, so
  // it sat at its initial zeros for the life of the table. startHand seeds each
  // new hand from that copy, so every hand began from nothing: the felt showed
  // one hand's result and then forgot it, and the scores modal showed +0 for
  // everyone forever. Two hands is the smallest case that shows it.
  let t = createTable(host);
  t = startHand(t, T0);
  check("a dealt hand starts level", t.scores.every((n) => n === 0));

  // Finish the hand the way the engine does: the running total lives on
  // g.scores, and hand-end scoring adds the hand's delta to it.
  const settled = [2, -1, -1, -1, 1];
  t = commit({ ...t, g: { ...t.g, phase: "handEnd", scores: [...settled] } }, T0 + 1000);

  check("the table picks up the finished hand's totals",
    JSON.stringify(t.scores) === JSON.stringify(settled),
    `table.scores = ${JSON.stringify(t.scores)}`);

  // The actual complaint: deal again and see whether the score survives.
  t = startHand(t, T0 + 2000);
  check("the next hand carries the running score forward",
    JSON.stringify(t.g.scores) === JSON.stringify(settled),
    `hand 2 opened on ${JSON.stringify(t.g.scores)}`);
  check("...and the table's copy agrees with the engine's",
    JSON.stringify(t.scores) === JSON.stringify(t.g.scores),
    `${JSON.stringify(t.scores)} vs ${JSON.stringify(t.g.scores)}`);

  // And it keeps accumulating rather than only remembering the last hand.
  const after2 = [4, -2, 0, -2, 0];
  t = commit({ ...t, g: { ...t.g, phase: "handEnd", scores: [...after2] } }, T0 + 3000);
  t = startHand(t, T0 + 4000);
  check("a third hand carries the accumulated total",
    JSON.stringify(t.g.scores) === JSON.stringify(after2),
    `hand 3 opened on ${JSON.stringify(t.g.scores)}`);

  // A table with no hand dealt yet must not have its zeros clobbered by a
  // missing g.
  const fresh = commit(createTable(host), T0);
  check("a table with no game keeps its zeroed scores",
    JSON.stringify(fresh.scores) === JSON.stringify([0, 0, 0, 0, 0]));
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — table + seat lifecycle behaves per ROADMAP Now bucket.");
