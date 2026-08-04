#!/usr/bin/env node
/* ============================================================================
   useTableStream — the reconnect loop.

   CLAUDE.md has said for a long time that src/useTableStream.js "has no
   automated coverage at all", and named it the file most likely to ruin a games
   night: a backgrounded phone loses its connection and its timers at the same
   moment, so the code that has to notice is the code that has been put to
   sleep. The flight recorder in src/streamLog.js exists precisely because this
   class of bug cannot be found by staring at the file.

   It went untested because it is a React hook whose entire body is one
   useEffect — there is nothing to import and call. That is a tooling problem,
   not a reason, and scripts/lib/domharness.mjs is the tooling: jsdom, a clock
   you can move, and an EventSource that answers.

   WHAT IS ASSERTED, and why each one is here rather than being a plausible
   thing to check. Every case below is a behaviour the hook's own header claims,
   and several are ones it says were found the hard way on a real table:

     since=      a reopen carries the newest version, so the server can replay
                 the gap. This is the entire reason the hook manages its own
                 reconnect instead of letting EventSource do it.
     rewind      a frame at or below the held version is dropped. A reconnect
                 can race a redelivery, and applying an older state would rewind
                 the table under somebody's fingers mid-trick.
     handoff     the scheduled ~50s hangup reopens immediately, with no backoff
                 and no visible disconnect. Treating it as an error would put a
                 stall into every healthy connection.
     backoff     a real failure backs off, doubles, and caps.
     recovery    a frame resets the backoff — but connecting does NOT, so a
                 server that accepts connections and then fails still backs off.
     gone        a deleted table stops the loop for good. Retrying can only
                 produce 404s forever.
     watchdogs   a connection that opens and says nothing is dead, not idle.
                 Taken from a real trace: conn=7 opened, never delivered a
                 frame, and sat there for THREE AND A HALF HOURS.
     visibility  returning to the tab reconnects, because a backgrounded tab's
                 timers do not run and nothing inside the connection can notice.
                 A stray `visible` without a preceding hide must NOT reconnect.
     presence    merges into the held table without disturbing the version.
     teardown    unmount closes the stream and stops reopening.

   Usage: node scripts/tablestreamtest.mjs
   ========================================================================= */
import { installDom, installClock, installEventSource, setVisibility } from "./lib/domharness.mjs";

const dom = installDom();
const ES = installEventSource();
const clock = installClock();

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  useTableStream, BACKOFF_START_MS, BACKOFF_MAX_MS, BACKOFF_FACTOR,
  CONNECT_TIMEOUT_MS, SILENCE_TIMEOUT_MS,
} = await import("../src/useTableStream.js");

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

/* ---------------------------------------------------------------------------
   Mount the hook and hand back a handle. `latest` is the hook's return value as
   of the last render, which is what a component would actually be looking at.
   ------------------------------------------------------------------------ */
async function mount(tableId = "abcd1234", playerId = "player-1") {
  ES.reset();
  const state = { latest: null, renders: 0 };
  function Probe() {
    state.latest = useTableStream(tableId, playerId);
    state.renders++;
    return null;
  }
  const host = dom.window.document.createElement("div");
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Probe)); });
  return {
    state,
    get table() { return state.latest.table; },
    get connected() { return state.latest.connected; },
    get error() { return state.latest.error; },
    get lastVersion() { return state.latest.lastVersion; },
    advance: (ms) => clock.advance(ms, act),
    act: (fn) => act(fn),
    unmount: async () => { await act(async () => { root.unmount(); }); },
  };
}

// A `state` frame as the server sends it. The table body is deliberately thin —
// this file is about the transport, not about what the table contains.
const frame = (version, extra = {}) => ({
  version,
  table: { code: "abcd1234", seats: [{ name: "Gus", lastSeen: 0, kind: "ai" }], ...extra },
});

/* ======================================================================
   1. The opening connection, and what `since` carries
   ==================================================================== */
{
  const h = await mount();
  check("mounting opens exactly one stream", ES.count === 1, `opened ${ES.count}`);
  check("the first connection sends no `since` (nothing is held yet)",
    ES.last.since === null, `since=${ES.last.since}`);
  check("the connection carries the playerId, which is how a seat is proven",
    ES.last.params.get("playerId") === "player-1", ES.last.url);

  await h.act(async () => { ES.last.fireOpen(); });
  check("opening marks the hook connected", h.connected === true);

  await h.act(async () => { ES.last.emit("state", frame(4)); });
  check("a state frame is surfaced", h.lastVersion === 4, `lastVersion=${h.lastVersion}`);
  check("the table body reaches the caller", h.table?.code === "abcd1234");
  check("a frame clears any error", h.error === null, String(h.error));

  await h.unmount();
}

/* ======================================================================
   2. The scheduled handoff — the case that must be invisible

   The server hangs up every ~50s by design, so this is the normal path, not
   the error path. It must reopen immediately, carry `since`, and never show
   the player a disconnect.
   ==================================================================== */
{
  const h = await mount();
  await h.act(async () => { ES.last.fireOpen(); ES.last.emit("state", frame(11)); });
  const before = ES.count;

  await h.act(async () => { ES.last.emit("reconnect", { reason: "lifetime" }); });
  await h.advance(0);

  check("a handoff reopens the stream", ES.count === before + 1, `${before} -> ${ES.count}`);
  check("the reopen carries since=<newest version>", ES.last.since === 11, `since=${ES.last.since}`);
  check("a handoff is not reported to the player as an error", h.error === null, String(h.error));

  // The reopened connection must be the live one: a frame on it has to land.
  await h.act(async () => { ES.last.fireOpen(); ES.last.emit("state", frame(12)); });
  check("the reopened stream is the one being listened to", h.lastVersion === 12, `lastVersion=${h.lastVersion}`);

  await h.unmount();
}

/* ======================================================================
   3. Stale and redelivered frames are dropped

   The server may resend a version already held after a reconnect. Applying it
   would rewind the table mid-trick, which is the single most visible way this
   hook could break.
   ==================================================================== */
{
  const h = await mount();
  await h.act(async () => { ES.last.fireOpen(); ES.last.emit("state", frame(20)); });

  await h.act(async () => { ES.last.emit("state", frame(19)); });
  check("an OLDER frame is dropped", h.lastVersion === 20, `lastVersion=${h.lastVersion}`);

  await h.act(async () => { ES.last.emit("state", frame(20)); });
  check("a REDELIVERED frame at the held version is dropped", h.lastVersion === 20, `lastVersion=${h.lastVersion}`);

  await h.act(async () => { ES.last.emit("state", frame(21)); });
  check("a NEWER frame is applied", h.lastVersion === 21, `lastVersion=${h.lastVersion}`);

  // Malformed frames must not tear the connection down.
  const conns = ES.count;
  await h.act(async () => {
    ES.last.emit("state", "{ not json");
    ES.last.emit("state", { table: {} });          // no version
    ES.last.emit("state", { version: "7", table: {} }); // version not a number
  });
  check("unparseable and malformed frames are ignored, not fatal",
    h.lastVersion === 21 && ES.count === conns, `lastVersion=${h.lastVersion} conns=${ES.count}`);

  await h.unmount();
}

/* ======================================================================
   4. Backoff on real failure — doubling, capped, and reset by a frame
   ==================================================================== */
{
  const h = await mount();
  await h.act(async () => { ES.last.fireOpen(); ES.last.emit("state", frame(1)); });

  // First failure waits BACKOFF_START_MS and not a millisecond less.
  let conns = ES.count;
  await h.act(async () => { ES.last.fireError(); });
  check("an error is reported to the caller", h.error === "disconnected", String(h.error));
  check("an error marks the hook disconnected", h.connected === false);

  await h.advance(BACKOFF_START_MS - 1);
  check("no reopen before the backoff elapses", ES.count === conns, `${conns} -> ${ES.count}`);
  await h.advance(1);
  check("reopen once the backoff elapses", ES.count === conns + 1, `${conns} -> ${ES.count}`);
  check("the retry still carries since", ES.last.since === 1, `since=${ES.last.since}`);

  // Second failure without an intervening frame doubles the wait. Connecting
  // must NOT reset it — only a delivered frame counts as recovery.
  conns = ES.count;
  await h.act(async () => { ES.last.fireOpen(); });
  await h.act(async () => { ES.last.fireError(); });
  await h.advance(BACKOFF_START_MS * BACKOFF_FACTOR - 1);
  check("opening alone does not reset the backoff", ES.count === conns, `reopened after ${BACKOFF_START_MS * BACKOFF_FACTOR - 1}ms`);
  await h.advance(1);
  check("the second backoff is the first doubled", ES.count === conns + 1);

  // Drive it to the ceiling.
  for (let i = 0; i < 12; i++) {
    await h.act(async () => { ES.last.fireError(); });
    await h.advance(BACKOFF_MAX_MS);
  }
  conns = ES.count;
  await h.act(async () => { ES.last.fireError(); });
  await h.advance(BACKOFF_MAX_MS - 1);
  check("backoff never exceeds the cap", ES.count === conns, `reopened before ${BACKOFF_MAX_MS}ms`);
  await h.advance(1);
  check("backoff reaches the cap and stays there", ES.count === conns + 1);

  // A delivered frame is what recovery means.
  await h.act(async () => { ES.last.fireOpen(); ES.last.emit("state", frame(2)); });
  conns = ES.count;
  await h.act(async () => { ES.last.fireError(); });
  await h.advance(BACKOFF_START_MS);
  check("a delivered frame resets the backoff to the start",
    ES.count === conns + 1, `still ${ES.count} after ${BACKOFF_START_MS}ms`);

  await h.unmount();
}

/* ======================================================================
   5. The watchdogs — silence is not idleness

   This is the three-and-a-half-hour bug. EventSource has no timeout, so a
   connection that opens and then says nothing looks exactly like a quiet
   table.
   ==================================================================== */
{
  // A stream that never delivers its first frame.
  const h = await mount();
  const conns = ES.count;
  await h.advance(CONNECT_TIMEOUT_MS - 1);
  check("a silent-but-young connection is left alone", ES.count === conns, `${conns} -> ${ES.count}`);
  await h.advance(1);
  check("a connection that never delivers a frame is torn down and reopened",
    ES.count === conns + 1, `${conns} -> ${ES.count}`);
  check("the stalled connection was actually closed, not leaked",
    ES.instances[conns - 1].closed === true);
  await h.unmount();
}
{
  // A stream that delivered, then went quiet past the silence bound.
  const h = await mount();
  await h.act(async () => { ES.last.fireOpen(); ES.last.emit("state", frame(5)); });
  const conns = ES.count;

  // Well past the connect timeout: having delivered a frame, the longer
  // silence bound applies, not the shorter connect one.
  await h.advance(CONNECT_TIMEOUT_MS * 2);
  check("a connection that delivered is held to the silence bound, not the connect bound",
    ES.count === conns, `reopened after ${CONNECT_TIMEOUT_MS * 2}ms`);

  await h.advance(SILENCE_TIMEOUT_MS - CONNECT_TIMEOUT_MS * 2 - 1);
  check("no reopen just before the silence bound", ES.count === conns);
  await h.advance(1);
  check("a stalled stream is reopened at the silence bound", ES.count === conns + 1);
  check("the stall reopen carries since", ES.last.since === 5, `since=${ES.last.since}`);

  await h.unmount();
}

/* ======================================================================
   6. Coming back to the tab

   The hook's header calls this "the one event that is guaranteed to arrive at
   the right moment", because a backgrounded tab's timers are throttled and its
   socket dropped — so no watchdog can cover it.
   ==================================================================== */
{
  const h = await mount();
  await h.act(async () => { ES.last.fireOpen(); ES.last.emit("state", frame(9)); });
  let conns = ES.count;

  // A stray `visible` with no preceding hide. Browsers do fire these, and
  // reconnecting on every one would reopen the stream for no reason.
  await h.act(async () => { setVisibility(dom, "visible"); });
  await h.advance(0);
  check("a stray `visible` without a preceding hide does NOT reconnect",
    ES.count === conns, `${conns} -> ${ES.count}`);

  await h.act(async () => { setVisibility(dom, "hidden"); });
  await h.advance(0);
  check("going hidden does not itself reconnect", ES.count === conns, `${conns} -> ${ES.count}`);

  await h.act(async () => { setVisibility(dom, "visible"); });
  await h.advance(0);
  check("returning to the tab reconnects immediately", ES.count === conns + 1, `${conns} -> ${ES.count}`);
  check("the resume carries since, so the gap is replayed", ES.last.since === 9, `since=${ES.last.since}`);

  // A resume is not a failure and must not inherit a backoff. Fail first so
  // the backoff is raised, then resume and check the reopen is immediate.
  await h.act(async () => { ES.last.fireOpen(); ES.last.emit("state", frame(10)); });
  await h.act(async () => { ES.last.fireError(); });
  await h.advance(BACKOFF_START_MS * BACKOFF_FACTOR * BACKOFF_FACTOR);
  await h.act(async () => { ES.last.fireError(); });   // raise it again
  conns = ES.count;
  await h.act(async () => { setVisibility(dom, "hidden"); });
  await h.act(async () => { setVisibility(dom, "visible"); });
  await h.advance(0);
  check("a resume reconnects at once rather than serving out a pending backoff",
    ES.count === conns + 1, `${conns} -> ${ES.count}`);

  await h.unmount();
}

/* ======================================================================
   7. `gone` — the one case that must stop trying
   ==================================================================== */
{
  const h = await mount();
  await h.act(async () => { ES.last.fireOpen(); ES.last.emit("state", frame(3)); });
  const conns = ES.count;

  await h.act(async () => { ES.last.emit("gone"); });
  check("`gone` surfaces as an error the UI can act on", h.error === "gone", String(h.error));
  check("`gone` marks the hook disconnected", h.connected === false);
  check("`gone` closes the stream", ES.instances[conns - 1].closed === true);

  // The important half: it must stay stopped, through every path that would
  // otherwise reopen.
  await h.advance(SILENCE_TIMEOUT_MS * 3);
  check("`gone` stops the reconnect loop for good", ES.count === conns, `${conns} -> ${ES.count}`);

  await h.act(async () => { setVisibility(dom, "hidden"); });
  await h.act(async () => { setVisibility(dom, "visible"); });
  await h.advance(0);
  check("returning to the tab does not revive a gone table", ES.count === conns, `${conns} -> ${ES.count}`);

  await h.unmount();
}

/* ======================================================================
   8. Presence merges without disturbing the version

   Presence is written WITHOUT a version bump, so it arrives on its own frame.
   It must not touch the version, or the paced trick cursor would re-run.
   ==================================================================== */
{
  const h = await mount();
  await h.act(async () => {
    ES.last.fireOpen();
    ES.last.emit("state", { version: 30, table: { code: "abcd1234", seats: [
      { name: "Gus", lastSeen: 100, kind: "ai" },
      { name: "Bunny", lastSeen: 100, kind: "human" },
    ] } });
  });

  await h.act(async () => {
    ES.last.emit("presence", { at: 5000, lastSeen: [777, 888], kinds: ["human", "human"] });
  });

  check("presence does not move the version", h.lastVersion === 30, `lastVersion=${h.lastVersion}`);
  check("presence updates lastSeen per seat", h.table.seats[0].lastSeen === 777 && h.table.seats[1].lastSeen === 888,
    JSON.stringify(h.table.seats.map((s) => s.lastSeen)));
  check("presence updates seat kind", h.table.seats[0].kind === "human", h.table.seats[0].kind);
  check("presence carries the server clock for skew correction", h.table.serverAt === 5000, String(h.table.serverAt));
  check("presence leaves the rest of the table alone", h.table.code === "abcd1234" && h.table.seats[0].name === "Gus");

  // A presence frame is a sign of life and must re-arm the silence watchdog,
  // or a table where nothing happens but people are present would be torn
  // down every 75 seconds.
  const conns = ES.count;
  await h.advance(SILENCE_TIMEOUT_MS - 1);
  check("presence re-arms the silence watchdog", ES.count === conns, `${conns} -> ${ES.count}`);

  // Malformed presence must not blank the table.
  await h.act(async () => { ES.last.emit("presence", "{ bad"); ES.last.emit("presence", { at: 1 }); });
  check("malformed presence is ignored rather than clearing seats",
    h.table.seats.length === 2 && h.table.seats[0].lastSeen === 777);

  await h.unmount();
}

/* ======================================================================
   9. Teardown — nothing keeps running after unmount

   Five phones in a room means five of these being created and destroyed as
   people navigate. A leaked stream or timer is a table that keeps polling
   after its screen is gone.
   ==================================================================== */
{
  const h = await mount();
  await h.act(async () => { ES.last.fireOpen(); ES.last.emit("state", frame(2)); });
  const conns = ES.count;
  const live = ES.last;

  await h.unmount();
  check("unmount closes the live stream", live.closed === true);

  await h.advance(SILENCE_TIMEOUT_MS * 3);
  check("no timer survives unmount to reopen anything", ES.count === conns, `${conns} -> ${ES.count}`);

  // The visibility listener is on `document`, which outlives the component —
  // if it were not removed it would fire forever, on every table ever opened.
  await act(async () => { setVisibility(dom, "hidden"); });
  await act(async () => { setVisibility(dom, "visible"); });
  await clock.advance(0, act);
  check("the visibilitychange listener is removed on unmount", ES.count === conns, `${conns} -> ${ES.count}`);
  check("no timers are left pending after unmount", clock.pending === 0, `${clock.pending} pending`);
}

/* -------------------------------- report -------------------------------- */
if (failures.length) {
  console.error(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`  FAIL: ${f}`);
  console.error("FAIL — the table stream does not reconnect the way it claims to.");
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
console.log("PASS — reconnects carry `since`, stale frames are dropped, and nothing outlives unmount.");
