#!/usr/bin/env node
/* ============================================================================
   Live table stream (SSE) tests.

   The endpoint's hard parts are all invisible from a browser: what it *doesn't*
   send while a table is idle, what it strips out of every payload, and whether
   it hangs up cleanly before the platform kills it. So this drives the handler
   directly with mock req/res objects and a fake clock, against the in-memory
   store — no browser, no deployment, no credentials, no waiting 50 real
   seconds to test the 50-second lifetime.

   The mock res just accumulates written chunks, which is exactly what an SSE
   client sees; the assertions parse those chunks back into frames rather than
   trusting anything the handler reports about itself.

   Usage: node scripts/streamtest.mjs
   ========================================================================= */
import { EventEmitter } from "node:events";
import { createEventsHandler, STREAM_LIFETIME_MS, POLL_INTERVAL_MS, HEARTBEAT_MS }
  from "../api/tables/[id]/events.js";
import { createTable, joinTable, startHand, seatOf } from "../src/table.js";
import { createMemoryStore } from "../src/store/memory.js";
import { cid } from "../src/engine.js";

let passed = 0;
const failures = [];

function check(label, cond, detail = "") {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

const T0 = 1_700_000_000_000;

/* ------------------------------- Test harness ----------------------------- */

// Lets pending promise chains inside the handler run to completion. Every await
// in the handler resolves against the in-memory store (already-resolved
// promises), so one macrotask turn drains all of them.
const settle = () => new Promise((r) => setImmediate(r));

// A controllable clock. The handler takes its timer functions as options
// precisely so this can exist: the lifetime cap, the poll cadence and the
// heartbeat are all tested at full speed and deterministically.
function fakeClock(start = T0) {
  let t = start;
  let seq = 1;
  const timers = new Map();

  return {
    now: () => t,
    setInterval(fn, ms) {
      const h = seq++;
      timers.set(h, { fn, ms, at: t + ms, repeat: true });
      return h;
    },
    setTimeout(fn, ms) {
      const h = seq++;
      timers.set(h, { fn, ms, at: t + ms, repeat: false });
      return h;
    },
    clearInterval(h) { timers.delete(h); },
    clearTimeout(h) { timers.delete(h); },
    pending: () => timers.size,

    async advance(ms) {
      const target = t + ms;
      for (;;) {
        let due = null;
        for (const entry of timers) if (!due || entry[1].at < due[1].at) due = entry;
        if (!due || due[1].at > target) break;
        t = due[1].at;
        if (due[1].repeat) due[1].at = t + due[1].ms;
        else timers.delete(due[0]);
        await due[1].fn();
        await settle();
      }
      t = target;
    },
  };
}

function mockReq({ id, playerId, since, lastEventId, method = "GET" }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = `/api/tables/${id}/events`;
  req.query = { id };
  if (playerId !== undefined) req.query.playerId = playerId;
  if (since !== undefined) req.query.since = String(since);
  req.headers = lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) };
  return req;
}

function mockRes() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    ended: false,
    chunks,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    flushHeaders() { this.flushed = true; },
    write(chunk) { chunks.push(String(chunk)); return true; },
    end(body) { if (body) chunks.push(String(body)); this.ended = true; },
    get text() { return chunks.join(""); },
  };
}

// Parses the raw stream back into SSE frames. Comments (`: ping`) and the
// `retry:` hint are kept distinct from real events so "nothing was sent" can
// mean "no events", not "no bytes" — a heartbeat is bytes but not an update.
function parseFrames(text) {
  return text.split("\n\n").filter((f) => f.trim() !== "").map((frame) => {
    const out = { event: null, id: null, data: null, comment: null, retry: null, raw: frame };
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) out.comment = line.slice(1).trim();
      else if (line.startsWith("event:")) out.event = line.slice(6).trim();
      else if (line.startsWith("id:")) out.id = line.slice(3).trim();
      else if (line.startsWith("retry:")) out.retry = Number(line.slice(6).trim());
      else if (line.startsWith("data:")) {
        try { out.data = JSON.parse(line.slice(5).trim()); } catch { out.data = line.slice(5); }
      }
    }
    return out;
  });
}

const eventsOf = (res, name) => parseFrames(res.text).filter((f) => f.event === (name ?? f.event) && f.event);
const statesOf = (res) => parseFrames(res.text).filter((f) => f.event === "state");

// A mid-hand table: host at seat 0, a guest at seat 1, three AI, cards dealt.
// Mid-hand matters for the redaction cases — viewFor deliberately reveals every
// hand once the phase is "handEnd", so a finished hand would prove nothing.
async function seed() {
  const store = createMemoryStore({ now: () => T0 });
  let table = createTable({ hostPlayerId: "p-host", hostName: "Jacob", now: T0, id: "tbl12345" });
  table = joinTable(table, { playerId: "p-dave", name: "Dave", now: T0 }).table;
  table = startHand(table, T0);
  await store.create(table);
  return { store, table };
}

// Opens a stream and returns everything a case needs to poke at it. `gets`
// counts full-state reads so the "only fetch state when the version moved"
// property can be asserted rather than assumed.
function open(store, reqOpts, handlerOpts = {}) {
  const clock = fakeClock();
  const counted = { ...store, gets: 0, async get(id) { counted.gets++; return store.get(id); } };
  const handler = createEventsHandler({
    store: counted,
    env: {}, // no Redis credentials -> the reader falls back to the store
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...handlerOpts,
  });
  const req = mockReq(reqOpts);
  const res = mockRes();
  const done = handler(req, res);
  return { clock, req, res, done, counted };
}

/* ---------------------------- Connect + initial send ---------------------- */

{
  const { store, table } = await seed();
  const { res, clock } = open(store, { id: table.id, playerId: "p-dave" });
  await settle();

  check("SSE content type", String(res.headers["content-type"]).startsWith("text/event-stream"),
    `got ${res.headers["content-type"]}`);
  check("response is not cached", /no-cache/.test(res.headers["cache-control"]),
    `got ${res.headers["cache-control"]}`);
  check("connection is kept alive", res.headers.connection === "keep-alive");
  check("proxy buffering is disabled", res.headers["x-accel-buffering"] === "no");
  check("status is 200", res.statusCode === 200);

  const states = statesOf(res);
  check("initial state is sent on connect", states.length === 1, `got ${states.length} state events`);
  check("initial state carries the stored version", states[0]?.data?.version === table.version,
    `sent ${states[0]?.data?.version}, stored ${table.version}`);
  check("state frames set id: to the version", states[0]?.id === String(table.version),
    `id=${states[0]?.id}`);
  check("client is given a retry hint", parseFrames(res.text).some((f) => f.retry > 0));
  check("stream stays open after the initial send", res.ended === false);
  check("poll and lifetime timers are armed", clock.pending() === 2, `pending=${clock.pending()}`);
}

/* ------------------------------- Redaction -------------------------------- */

{
  // Seat 1 is Dave. Everything below is asserted against the parsed payload,
  // not against what the handler claims to have done.
  const { store, table } = await seed();
  const seat = seatOf(table, "p-dave");
  const { res } = open(store, { id: table.id, playerId: "p-dave" });
  await settle();

  const payload = statesOf(res)[0]?.data?.table;
  check("payload is present", Boolean(payload));

  const hands = payload?.g?.hands || [];
  check("payload holds five hand slots", hands.length === 5, `got ${hands.length}`);
  check("own hand is present", Array.isArray(hands[seat]) && hands[seat].length === 6,
    `seat ${seat} got ${JSON.stringify(hands[seat])?.slice(0, 40)}`);
  check("no other seat's cards are in the payload",
    hands.every((h, i) => i === seat || h === null),
    `visible seats: ${hands.map((h, i) => (h ? i : null)).filter((i) => i !== null).join(",")}`);
  check("card counts still cross the wire", (payload?.g?.handCounts || []).length === 5);

  // Byte-level backstop for the same property: a specific card that belongs to
  // another seat must not appear anywhere in the stream, whatever shape it was
  // smuggled out in.
  const otherSeat = seat === 0 ? 1 : 0;
  const secretCard = table.g.hands[otherSeat][0];
  check("another seat's card is absent from the raw stream",
    !res.text.includes(JSON.stringify(secretCard)),
    `leaked ${cid(secretCard)} from seat ${otherSeat}`);
  check("the blind is withheld from a non-picker", payload?.g?.blind === null,
    `got ${JSON.stringify(payload?.g?.blind)}`);

  // playerIds are bearer tokens (see api/_lib/redact.js) — leaking one lets a
  // player play somebody else's cards.
  check("another player's playerId is absent from the raw stream", !res.text.includes("p-host"));
  check("other seats report a null playerId",
    (payload?.seats || []).every((s, i) => i === seat || s.playerId === null));
  check("your own playerId comes back to you", payload?.seats?.[seat]?.playerId === "p-dave");
  check("hostPlayerId is not serialized", payload?.hostPlayerId === undefined);
  check("host is identified by seat instead", payload?.hostSeat === 0 && payload?.youAreHost === false);
  check("the view knows whose it is", payload?.you === seat);
}

{
  // Someone holding the link who isn't seated (queued to join, or watching)
  // gets the maximally-redacted view: no hand at all, no tokens.
  const { store, table } = await seed();
  const { res } = open(store, { id: table.id, playerId: "p-nobody" });
  await settle();
  const payload = statesOf(res)[0]?.data?.table;
  check("a non-seated viewer sees no hands at all",
    (payload?.g?.hands || []).every((h) => h === null));
  check("a non-seated viewer gets seat -1", payload?.you === -1);
  check("a non-seated viewer gets no playerIds",
    (payload?.seats || []).every((s) => s.playerId === null));
}

/* --------------------------- Silence while unchanged ---------------------- */

{
  const { store, table } = await seed();
  const { res, clock, counted } = open(store, { id: table.id, playerId: "p-dave" });
  await settle();
  const getsAfterConnect = counted.gets;

  await clock.advance(POLL_INTERVAL_MS * 5);
  check("nothing is re-sent while the version is unchanged", statesOf(res).length === 1,
    `got ${statesOf(res).length} state events after 5 polls`);
  check("an unchanged table costs no full-state reads",
    counted.gets === getsAfterConnect + 5, // the fallback reader IS store.get here
    `gets went ${getsAfterConnect} -> ${counted.gets}`);
  check("the stream is still open", res.ended === false);
}

{
  // With a cheap version reader wired up (the deployed shape: one HGET of the
  // version field), an idle table must not fetch full state at all.
  const { store, table } = await seed();
  const { res, clock, counted } = open(store, { id: table.id, playerId: "p-dave" }, {
    readVersion: async () => (await store.get(table.id))?.version ?? null,
  });
  await settle();
  const getsAfterConnect = counted.gets;
  await clock.advance(POLL_INTERVAL_MS * 5);
  check("an idle table never re-fetches full state", counted.gets === getsAfterConnect,
    `gets went ${getsAfterConnect} -> ${counted.gets}`);
  check("...and sends nothing", statesOf(res).length === 1);
}

{
  // Heartbeats are the exception: bytes, but not an update.
  const { store, table } = await seed();
  const { res, clock } = open(store, { id: table.id, playerId: "p-dave" });
  await settle();
  const before = parseFrames(res.text).filter((f) => f.comment?.startsWith("ping")).length;
  await clock.advance(HEARTBEAT_MS + POLL_INTERVAL_MS);
  const after = parseFrames(res.text).filter((f) => f.comment?.startsWith("ping")).length;
  check("an idle stream gets a heartbeat", after > before, `pings ${before} -> ${after}`);
  check("the heartbeat is a comment, not an event", statesOf(res).length === 1);
}

/* ---------------------------- Change detection ---------------------------- */

{
  const { store, table } = await seed();
  const { res, clock } = open(store, { id: table.id, playerId: "p-dave" });
  await settle();

  // Somebody else acts: a third player asks to join mid-hand, which queues them
  // and bumps the version.
  const joined = joinTable(table, { playerId: "p-late", name: "Late", now: T0 + 1 });
  await store.put(joined.table, table.version);
  check("the test's own write advanced the version", joined.table.version === table.version + 1);

  await clock.advance(POLL_INTERVAL_MS);
  const states = statesOf(res);
  check("a version bump produces a new event", states.length === 2, `got ${states.length}`);
  check("the new event carries the new state",
    states[1]?.data?.version === joined.table.version,
    `sent ${states[1]?.data?.version}, expected ${joined.table.version}`);
  check("the new event's id: is the new version", states[1]?.id === String(joined.table.version));
  check("the change is visible in the payload",
    states[1]?.data?.table?.pendingJoins?.[0]?.name === "Late");
  check("the queued player's token is still redacted", !res.text.includes("p-late"));

  // ...and then goes quiet again.
  await clock.advance(POLL_INTERVAL_MS * 3);
  check("one change produces exactly one event", statesOf(res).length === 2,
    `got ${statesOf(res).length}`);
}

{
  // A presence ping deliberately does not bump the CAS version (see markSeen in
  // src/table.js), so it must not wake every connected stream either.
  const { store, table } = await seed();
  const { res, clock } = open(store, { id: table.id, playerId: "p-dave" });
  await settle();
  const touched = { ...table, updatedAt: T0 + 50 };
  await store.put(touched, table.version);
  await clock.advance(POLL_INTERVAL_MS * 2);
  check("a write that doesn't bump the version sends nothing", statesOf(res).length === 1,
    `got ${statesOf(res).length}`);
}

/* ------------------------------ since / resume ---------------------------- */

{
  const { store, table } = await seed();

  const equal = open(store, { id: table.id, playerId: "p-dave", since: table.version });
  await settle();
  check("since == stored version suppresses the initial send",
    statesOf(equal.res).length === 0, `got ${statesOf(equal.res).length}`);
  check("a caught-up client is still told it's connected",
    parseFrames(equal.res.text).some((f) => f.comment?.startsWith("current")));

  const ahead = open(store, { id: table.id, playerId: "p-dave", since: table.version + 5 });
  await settle();
  check("since ahead of the stored version suppresses the initial send",
    statesOf(ahead.res).length === 0, `got ${statesOf(ahead.res).length}`);

  const behind = open(store, { id: table.id, playerId: "p-dave", since: table.version - 1 });
  await settle();
  check("since behind the stored version replays current state",
    statesOf(behind.res).length === 1 && statesOf(behind.res)[0].data.version === table.version);

  const junk = open(store, { id: table.id, playerId: "p-dave", since: "not-a-number" });
  await settle();
  check("an unparseable since is treated as 'I have nothing'",
    statesOf(junk.res).length === 1);
}

{
  // The browser's own reconnect can't carry a query param, so Last-Event-ID is
  // the fallback — and `since` wins when both are present.
  const { store, table } = await seed();

  const header = open(store, { id: table.id, playerId: "p-dave", lastEventId: table.version });
  await settle();
  check("Last-Event-ID stands in for since", statesOf(header.res).length === 0,
    `got ${statesOf(header.res).length}`);

  const both = open(store, {
    id: table.id, playerId: "p-dave", since: table.version - 1, lastEventId: table.version,
  });
  await settle();
  check("an explicit since beats Last-Event-ID", statesOf(both.res).length === 1);
}

{
  // The resume path end to end: a stream ends at the cap, the table moves while
  // nobody is connected, and the client reconnects with the version it holds.
  const { store, table } = await seed();
  const first = open(store, { id: table.id, playerId: "p-dave" });
  await settle();
  await first.clock.advance(STREAM_LIFETIME_MS);
  const handoff = parseFrames(first.res.text).filter((f) => f.event === "reconnect")[0];
  const resumeFrom = handoff?.data?.since;

  const missed = joinTable(table, { playerId: "p-late", name: "Late", now: T0 + 1 });
  await store.put(missed.table, table.version);

  const second = open(store, { id: table.id, playerId: "p-dave", since: resumeFrom });
  await settle();
  const states = statesOf(second.res);
  check("a resumed stream immediately replays what was missed",
    states.length === 1 && states[0].data.version === missed.table.version,
    `got version ${states[0]?.data?.version}, expected ${missed.table.version}`);
}

/* ----------------------------- Lifetime handoff --------------------------- */

{
  const { store, table } = await seed();
  const { res, clock, done } = open(store, { id: table.id, playerId: "p-dave" });
  await settle();

  await clock.advance(STREAM_LIFETIME_MS - POLL_INTERVAL_MS);
  check("the stream survives right up to the cap", res.ended === false);

  await clock.advance(POLL_INTERVAL_MS);
  const frames = parseFrames(res.text).filter((f) => f.event);
  const last = frames[frames.length - 1];
  check("the stream closes with a distinct reconnect event", last?.event === "reconnect",
    `last event was ${last?.event}`);
  check("the reconnect event says why", last?.data?.reason === "lifetime");
  check("the reconnect event says where to resume from", last?.data?.since === table.version);
  check("the response is actually ended", res.ended === true);
  check("all timers are cleared at the cap", clock.pending() === 0, `pending=${clock.pending()}`);

  await done; // the handler's promise resolves when the stream closes
  check("the handler resolves once the stream ends", true);

  const framesAfter = parseFrames(res.text).length;
  await clock.advance(STREAM_LIFETIME_MS);
  check("nothing is written after close", parseFrames(res.text).length === framesAfter);
}

/* --------------------------- Disconnect + cleanup ------------------------- */

{
  const { store, table } = await seed();
  const { res, req, clock, done } = open(store, { id: table.id, playerId: "p-dave" });
  await settle();
  check("timers are armed while connected", clock.pending() === 2, `pending=${clock.pending()}`);

  req.emit("close");
  await settle();
  check("the poll interval is cleared on client disconnect", clock.pending() === 0,
    `pending=${clock.pending()}`);
  check("the response is ended on client disconnect", res.ended === true);
  await done;

  // The real cost of leaking the interval: it would keep polling Redis forever
  // for a connection nobody is reading.
  const framesAfter = parseFrames(res.text).length;
  const bumped = joinTable(table, { playerId: "p-late", name: "Late", now: T0 + 1 });
  await store.put(bumped.table, table.version);
  await clock.advance(POLL_INTERVAL_MS * 10);
  check("a disconnected stream stops polling entirely",
    parseFrames(res.text).length === framesAfter,
    `${framesAfter} -> ${parseFrames(res.text).length} frames`);
}

{
  // A table that expires mid-stream is terminal — the client must be told not
  // to reconnect, rather than being left to retry a 404 forever.
  const { store, table } = await seed();
  const { res, clock } = open(store, { id: table.id, playerId: "p-dave" });
  await settle();
  await store.del(table.id);
  await clock.advance(POLL_INTERVAL_MS);

  const frames = parseFrames(res.text).filter((f) => f.event);
  const last = frames[frames.length - 1];
  check("an expired table closes the stream with `gone`", last?.event === "gone",
    `last event was ${last?.event}`);
  check("`gone` is distinct from `reconnect`", last?.event !== "reconnect");
  check("timers are cleared when the table disappears", clock.pending() === 0);
}

/* ------------------------------ Request guards ---------------------------- */

{
  const { store, table } = await seed();

  const noPlayer = open(store, { id: table.id });
  await noPlayer.done;
  check("playerId is required", noPlayer.res.statusCode === 400,
    `got ${noPlayer.res.statusCode}`);
  check("a rejected request opens no stream", noPlayer.clock.pending() === 0);

  const missing = open(store, { id: "nope1234", playerId: "p-dave" });
  await missing.done;
  check("an unknown table is a 404", missing.res.statusCode === 404,
    `got ${missing.res.statusCode}`);

  const posted = open(store, { id: table.id, playerId: "p-dave", method: "POST" });
  await posted.done;
  check("only GET is allowed", posted.res.statusCode === 405, `got ${posted.res.statusCode}`);
}

/* -------------------------------- Constants ------------------------------- */

{
  // The lifetime cap only works if it's comfortably inside the platform's
  // execution limit — 60s on Vercel's default plan.
  check("the stream lifetime stays inside the serverless execution cap",
    STREAM_LIFETIME_MS <= 55_000, `${STREAM_LIFETIME_MS}ms`);
  check("the heartbeat fires at least twice per connection shift",
    HEARTBEAT_MS * 2 < STREAM_LIFETIME_MS, `${HEARTBEAT_MS}ms`);
  check("the poll interval is fast enough to feel live", POLL_INTERVAL_MS <= 2000,
    `${POLL_INTERVAL_MS}ms`);
}


/* ------------- A seat that changes while the stream is open --------------- */
{
  // The bug this exists for: the handler resolved seatOf(playerId) ONCE at
  // connect time and reused it for every frame. A seat is a property of the
  // table at a moment in time, not of the connection, and it changes under a
  // live stream in two ordinary cases — joining a lobby you were already
  // watching, and being seated at the hand boundary after queueing mid-hand
  // (MP-2.3). With the seat pinned, a player who got seated kept receiving the
  // maximally-redacted seat -1 view forever and had to refresh to escape.
  const store = createMemoryStore({ now: () => T0 });
  let table = createTable({ hostPlayerId: "p-host", hostName: "Jacob", now: T0, id: "seatchg1" });
  await store.create(table);

  // Watching before holding a seat.
  const { res, clock, counted } = open(store, { id: table.id, playerId: "p-late" });
  await settle();

  const first = parseFrames(res.text).filter((f) => f.event === "state").pop();
  check("an unseated watcher starts at seat -1", first?.data?.table?.you === -1,
    `you=${first?.data?.table?.you}`);
  check("an unseated watcher sees no hand",
    !first?.data?.table?.g || first.data.table.g.hands.every((h) => h === null));

  // Now they take a seat, exactly as api/tables/[id]/join.js would.
  const joined = joinTable(await store.get(table.id), { playerId: "p-late", name: "Late", now: T0 });
  await store.put(joined.table, (await store.get(table.id)).version);
  const seated = joined.seat;

  clock.advance(1200);
  await settle();

  const latest = parseFrames(res.text).filter((f) => f.event === "state").pop();
  check("the stream reports the new seat without reconnecting",
    latest?.data?.table?.you === seated, `you=${latest?.data?.table?.you} expected=${seated}`);
  check("the newly seated player is flagged as themselves",
    latest?.data?.table?.seats?.[seated]?.isYou === true);
  check("their own playerId comes back to them",
    latest?.data?.table?.seats?.[seated]?.playerId === "p-late");
  check("nobody else's token leaks in the same frame",
    !JSON.stringify(latest?.data?.table?.seats?.filter((_, i) => i !== seated)).includes("p-host"));
}


/* --------- Presence must survive a BUSY table (the 3-player bug) ---------- */
{
  // The failure, from a live three-player game: presence used to ride the SSE
  // heartbeat. sendState() writes, writing resets the heartbeat timer, and the
  // version-changed branch returns early — so presence was only ever recorded
  // while the table was SILENT. Two humans plus AI left quiet gaps; a third
  // made state changes near-continuous, presence was never written, and after
  // 90s the auto-cover replaced active players with AI mid-game.
  //
  // So: hold a stream open over a table that changes constantly, and assert
  // the watcher is still marked present.
  const store = createMemoryStore({ now: () => T0 });
  let table = createTable({ hostPlayerId: "p-host", hostName: "Jacob", now: T0, id: "busy1234" });
  table = joinTable(table, { playerId: "p-dave", name: "Dave", now: T0 }).table;
  await store.create(table);

  const before = (await store.get("busy1234")).seats.find((x) => x.playerId === "p-dave").lastSeen;

  const { clock } = open(store, { id: "busy1234", playerId: "p-dave" });
  await settle();

  // Churn the table the way an active game does, advancing time past several
  // presence windows while never letting it fall quiet.
  for (let i = 0; i < 12; i++) {
    const cur = await store.get("busy1234");
    await store.put({ ...cur, version: cur.version + 1, updatedAt: T0 + i * 5000 }, cur.version);
    clock.advance(5000);
    await settle();
  }

  const after = (await store.get("busy1234")).seats.find((x) => x.playerId === "p-dave").lastSeen;
  check("a watcher on a BUSY table is still recorded as present",
    after > before, `lastSeen ${before} -> ${after}`);
  // Not asserting it tracks the clock all the way out: the stream closes at its
  // 50s lifetime (the client reconnects), and the fake clock coalesces ticks.
  // What matters is that presence advanced by a full window under continuous
  // churn — i.e. it is not just a one-off recorded at connect time.
  check("presence advances under churn, not just once at connect",
    after >= T0 + 20000, `lastSeen advanced to ${after - T0}ms`);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — the table stream pushes on change, redacts per seat, and hands off cleanly.");
