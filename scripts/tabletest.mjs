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
  const overflow = joinTable(cur, { playerId: "p5", name: "E", now: T0 });
  check("full table rejects a sixth player", overflow.status === "full");
  check("rejected join doesn't mutate the table", overflow.table === cur);
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
  let t = joinTable(createTable(host), { playerId: "p-dave", name: "Dave", now: T0 }).table;
  const seat = seatOf(t, "p-dave");

  const soon = coverIdleSeats(t, T0 + 1000);
  check("a recently-seen player is left alone", soon === t);

  const later = coverIdleSeats(t, T0 + AWAY_AFTER_MS + 1);
  check("a player who has gone quiet gets covered", later.seats[seat]?.kind === "away");
  check("covering keeps the seat theirs to reclaim", seatOf(later, "p-dave") === seat);
  check("covering bumps the version like any other mutation", later.version > t.version);

  // Presence has to count WATCHING, not just acting — otherwise everyone at the
  // table gets covered mid-hand while paying perfect attention.
  // (The host IS covered in this scenario — they haven't been seen since the
  // table was created — so the assertion is about Dave's seat specifically,
  // not about the table being untouched.)
  const watched = markSeen(t, { playerId: "p-dave", now: T0 + AWAY_AFTER_MS - 1 });
  const afterWatching = coverIdleSeats(watched, T0 + AWAY_AFTER_MS + 1);
  check("a player who is merely watching is not covered",
    afterWatching.seats[seat]?.kind === "human",
    `kind=${afterWatching.seats[seat]?.kind}`);
  check("...while an idle player at the same table still is",
    afterWatching.seats[seatOf(afterWatching, "p-host")]?.kind === "away");

  // The host has never been seen since the table was created; they get the
  // benefit of a full window rather than being covered instantly.
  const fresh = createTable({ ...host, now: T0 });
  check("a brand-new table covers nobody", coverIdleSeats(fresh, T0 + 1000) === fresh);
}

{
  // The point of all of it: an away seat is AI-driven, so play continues.
  let t = joinTable(createTable(host), { playerId: "p-dave", name: "Dave", now: T0 }).table;
  t = startHand(t, T0);
  const idle = coverIdleSeats(t, T0 + AWAY_AFTER_MS + 1);
  const humansPresent = idle.seats.filter((s) => s.kind === "human").length;
  check("everyone idle means no seat blocks play", humansPresent === 0);
  check("but every claimed seat still has an owner",
    idle.seats.filter((s) => s.playerId).length === 2);
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

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — table + seat lifecycle behaves per ROADMAP Now bucket.");
