/* ============================================================================
   Live table stream (Server-Sent Events).

   This is how a browser finds out that somebody else played a card. It is a
   GET that stays open and pushes redacted table state whenever the table's
   `version` moves.

   Three platform facts shaped this design, and none of them are negotiable:

   1. Upstash speaks HTTP, not a socket. A serverless function cannot hold a
      long-lived Redis SUBSCRIBE — there is no connection to subscribe on. So
      this endpoint POLLS the store and pushes only on change. Pub/sub is not
      an option here; don't reach for it.

   2. Serverless invocations have a hard execution cap. A "long-lived" SSE
      connection WILL be killed by the platform mid-flight, and the browser
      reports that as a network error. So the stream has a deliberate, bounded
      lifetime that ends well inside the cap, and it closes ITSELF with an
      explicit `reconnect` event — a clean, expected end-of-shift handoff
      rather than a failure the client has to guess about.

   3. Polling costs Redis commands, and the table is idle most of the time
      (five players thinking). So a tick reads only the version — one small
      value — and pays for the full state only when the version actually moved.
      See POLL_INTERVAL_MS for the arithmetic.

   The reconnect protocol, in full:

     event: state      id: <version>   the redacted table. Sent on connect
                                       (unless the client is already current)
                                       and on every version change.
     event: reconnect  data {reason}   the lifetime cap was reached, or the
                                       store errored. Expected, not an error:
                                       reopen immediately with
                                       ?since=<lastVersion>.
     event: gone       data {reason}   the table expired or was deleted. Do
                                       NOT reconnect.
     : ping <ts>                       comment heartbeat, keeps intermediaries
                                       from reaping an idle connection.

   Every `state` carries `id:` set to the table version, so a browser that
   drops the connection on its own sends `Last-Event-ID` when EventSource
   reconnects; that header is honored as the fallback for `since`. Between
   `since`/`Last-Event-ID` and the monotonic version, a reconnect can never
   silently skip an update: the client tells us what it has, and anything newer
   is sent immediately on connect.

   Usage: GET /api/tables/:id/events?playerId=...&since=12

   NOTE for anything driving this handler headlessly: unlike the JSON routes it
   returns a promise that resolves only when the STREAM closes — that's the
   point, the invocation has to outlive the handler body. A bare
   `await handler(req, res)` therefore blocks until the lifetime cap or a
   `close` on the request. Hold the promise, drive the clock, then await it
   (scripts/streamtest.mjs shows the pattern).
   ========================================================================= */
import { seatOf, markSeen, coverIdleSeats } from "../../../src/table.js";
import { advanceTable } from "../../../src/ai-runner.js";
import { mutate } from "../../../src/store/mutate.js";
import { redisFromEnv } from "../../../src/store/upstash.js";
import { getStore } from "../../_lib/store.js";
import { tableViewFor } from "../../_lib/redact.js";
import { fail, methodGuard } from "../../_lib/http.js";

// How often a tick checks the version.
//
// The tradeoff: one open stream costs (lifetime / interval) Redis commands per
// connection-shift, whether or not anything happened. At 1000ms and a 50s
// shift that's ~50 version reads per player per minute — five players at one
// table is ~250/min, ~15k/hour of *idle* table. That is affordable on Upstash's
// per-command pricing and buys sub-second feel on a card game where the whole
// point is watching someone else play. Raising this to 2000ms halves the bill
// and is the first knob to turn if command volume becomes the problem; lowering
// it below ~500ms buys nothing a human can perceive and multiplies cost
// linearly. Full state is fetched only when the version actually moved, so an
// idle table never pays for state transfer at all.
export const POLL_INTERVAL_MS = 1000;

// How long one connection lives before handing off. Vercel's Node functions
// cap execution (60s on the default plan, and gateways in front can be
// stricter), and being killed mid-stream surfaces to the browser as an error.
// 50s leaves headroom to send the `reconnect` event and close cleanly.
export const STREAM_LIFETIME_MS = 50_000;

// Comment line cadence for an idle stream. Proxies and mobile radios drop
// connections that go quiet; anything under ~30s is safe.
export const HEARTBEAT_MS = 15_000;

// How often a connected player is recorded as present. Independent of the
// heartbeat: a busy table must not starve presence (see the presence pass).
// Comfortably inside AWAY_AFTER_MS so a player gets several chances before the
// AI covers them.
export const PRESENCE_MS = 20_000;

// The `retry:` hint that seeds EventSource's own reconnect delay. Our client
// manages backoff itself, but a browser-initiated reconnect (tab wake, network
// flap) should come back fast — the table is live.
export const CLIENT_RETRY_MS = 500;

/* ------------------------------ Request parsing --------------------------- */

// Vercel populates req.query for dynamic segments, but a direct invocation
// (tests, a local node server) only has a URL. Accept either.
function paramsOf(req) {
  const out = { ...(req.query || {}) };
  if (req.url) {
    const url = new URL(req.url, "http://localhost");
    for (const [k, v] of url.searchParams) if (out[k] === undefined) out[k] = v;
    if (out.id === undefined) {
      // /api/tables/<id>/events
      const m = url.pathname.match(/\/tables\/([^/]+)\/events\/?$/);
      if (m) out.id = decodeURIComponent(m[1]);
    }
  }
  return out;
}

// `since` is advisory and comes from a client, so anything that isn't a
// non-negative integer is treated as "I have nothing" rather than trusted.
function parseSince(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/* ------------------------------ Version reads ----------------------------- */

// The store contract (src/store/memory.js) has no "read just the version" call,
// and get() hands back the whole table. For the poll loop that's the wrong
// shape: it moves a few KB of hand state across the wire once a second to look
// at one integer.
//
// So when Redis credentials are present this reads the version field directly.
// It duplicates the key layout from src/store/upstash.js (which doesn't export
// it) — a real coupling, and the right fix is a `version(id)` method on the
// store contract, implemented by both adapters. Until then the coupling is made
// safe rather than merely noted: a miss falls back to a full get() permanently
// for this connection, so a changed key layout degrades to "correct but
// chattier", never to "silently stops seeing updates".
const REDIS_KEY_PREFIX = "table:";

let sharedRedis;
let redisUnavailable = false;

function redisOrNull(env) {
  if (redisUnavailable) return null;
  if (!sharedRedis) {
    try {
      sharedRedis = redisFromEnv(env);
    } catch {
      redisUnavailable = true; // no creds — memory store, dev, or tests
      return null;
    }
  }
  return sharedRedis;
}

function makeVersionReader(store, id, env) {
  let redis = redisOrNull(env);

  return async () => {
    if (redis) {
      const raw = await redis.hget(`${REDIS_KEY_PREFIX}${id}`, "version");
      if (raw !== null && raw !== undefined) return Number(raw);
      redis = null; // key gone, or the layout moved — stop guessing.
    }
    const table = await store.get(id);
    return table ? table.version : null;
  };
}

/* -------------------------------- The handler ----------------------------- */

// Everything time- and store-shaped is injectable so scripts/streamtest.mjs can
// drive the whole lifecycle — connect, poll, change, heartbeat, lifetime
// expiry, disconnect — on a fake clock against the in-memory store, with no
// browser, no deployment and no credentials.
export function createEventsHandler(options = {}) {
  const {
    store: injectedStore = null,
    readVersion: injectedReadVersion = null,
    pollMs = POLL_INTERVAL_MS,
    lifetimeMs = STREAM_LIFETIME_MS,
    heartbeatMs = HEARTBEAT_MS,
    presenceMs = PRESENCE_MS,
    env = process.env,
    now = () => Date.now(),
    setInterval: setIntervalFn = setInterval,
    clearInterval: clearIntervalFn = clearInterval,
    setTimeout: setTimeoutFn = setTimeout,
    clearTimeout: clearTimeoutFn = clearTimeout,
  } = options;

  return async function eventsHandler(req, res) {
    if (!methodGuard(req, res, "GET")) return;

    const q = paramsOf(req);
    const id = q.id;
    const playerId = q.playerId;

    if (!id) return fail(res, 400, "missing-table", "No table id in the path");
    if (!playerId) return fail(res, 400, "missing-player", "playerId is required");

    const store = injectedStore || getStore(env);

    const table = await store.get(id);
    if (!table) return fail(res, 404, "no-such-table", "That table has expired or never existed");

    // The table code is the credential (see src/table.js) — an unrecognized
    // playerId isn't rejected, it just watches from seat -1, which is the
    // maximally-redacted view. That's deliberate: a player queued to join next
    // hand holds no seat yet and still needs the stream to learn when they get
    // one.
    //
    // Resolved per frame, NOT cached for the life of the connection. A seat is
    // a property of the table at a moment in time, not of the connection, and
    // it changes under a live stream in two ordinary cases: joining a lobby you
    // were already watching, and being seated at the hand boundary after
    // queueing mid-hand (MP-2.3). Pinning it at connect time meant the stream
    // kept redacting against the seat you used to hold, so a player who got
    // seated never saw it — refreshing was the only way out. It's a findIndex
    // over five entries; there is nothing to save by caching it.
    const seatIn = (t) => seatOf(t, playerId);

    // `since` wins over Last-Event-ID: our client tracks the version it has
    // applied, which is more accurate than the last id the browser happened to
    // observe. The header is the fallback for a browser-initiated reconnect.
    const since = parseSince(q.since ?? req.headers?.["last-event-id"]);

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    // no-transform matters as much as no-cache: a compressing proxy will buffer
    // the stream to fill a compression window and the events arrive in clumps.
    res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    // nginx-family proxies buffer responses by default, which turns a live
    // stream into "nothing, then everything at once, at close".
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let closed = false;
    let busy = false;
    let lastWriteAt = now();
    // Separate from lastWriteAt on purpose: presence must not be suppressed by
    // the table being busy. See the note at the presence pass below.
    let lastPresenceAt = now();
    let lastVersion = -1;

    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });

    const write = (chunk) => {
      if (closed) return;
      res.write(chunk);
      lastWriteAt = now();
    };

    const sendEvent = (event, data, eventId) => {
      const idLine = eventId === undefined ? "" : `id: ${eventId}\n`;
      // JSON.stringify escapes newlines, so a payload can never accidentally
      // terminate its own frame.
      write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // THE redaction point. Nothing else in this file writes table state, and
    // what goes out is never the stored table: hands belonging to other seats
    // and every other player's playerId are stripped by tableViewFor.
    const sendState = (t) => {
      lastVersion = t.version;
      sendEvent("state", { version: t.version, table: tableViewFor(t, seatIn(t), playerId) }, t.version);
    };

    const close = () => {
      if (closed) return;
      closed = true;
      clearIntervalFn(poll);
      clearTimeoutFn(life);
      res.end();
      resolveDone();
    };

    write(`retry: ${CLIENT_RETRY_MS}\n\n`);

    if (since === null || since < table.version) {
      sendState(table);
    } else {
      // The client is already current. Say nothing but a comment, and track
      // what's actually stored rather than what the client claimed — a client
      // can't be legitimately ahead of the store, and believing it would mute
      // the stream.
      lastVersion = table.version;
      write(`: current ${table.version}\n\n`);
    }

    const readVersion = injectedReadVersion || makeVersionReader(store, id, env);

    const tick = async () => {
      // A slow store read must not stack ticks on top of each other.
      if (closed || busy) return;
      busy = true;
      try {
        const version = await readVersion();
        if (closed) return;

        if (version === null) {
          sendEvent("gone", { reason: "no-such-table" });
          close();
          return;
        }

        // Presence, on its OWN clock — deliberately before the version check.
        //
        // This used to ride the SSE heartbeat, which was a real bug: sendState()
        // writes, writing resets the heartbeat timer, and the version-changed
        // branch below returns early. So presence was only ever recorded while
        // the table was SILENT. The busier the table, the less often a player
        // was marked present — exactly backwards. Two humans plus AI left quiet
        // gaps; a third made state changes near-continuous, the heartbeat never
        // fired, and after 90s the auto-cover flipped active players to AI
        // mid-game because nothing had refreshed lastSeen since they joined.
        //
        // Watching a table is participation, and how much is happening on it
        // has nothing to do with whether you are still there.
        if (now() - lastPresenceAt >= presenceMs) {
          lastPresenceAt = now();
          await mutate(store, id, (t) => {
            const seen = markSeen(t, { playerId, now: now() });
            const covered = coverIdleSeats(seen, now());
            return covered === seen ? seen : advanceTable(covered, now());
          });
          if (closed) return;
        }

        // Not `>`: a table that expired and was recreated under the same code
        // restarts at version 0, and a client stuck on a higher number would
        // never hear from us again.
        if (version !== lastVersion) {
          const current = await store.get(id);
          if (closed) return;
          if (!current) {
            sendEvent("gone", { reason: "no-such-table" });
            close();
            return;
          }
          sendState(current);
          return;
        }

        if (now() - lastWriteAt >= heartbeatMs) write(`: ping ${now()}\n\n`);
      } catch {
        // A transient store failure isn't the client's problem to interpret —
        // hand off exactly like a lifetime expiry and let it come back.
        sendEvent("reconnect", { reason: "store-error", since: lastVersion });
        close();
      } finally {
        busy = false;
      }
    };

    const poll = setIntervalFn(tick, pollMs);

    const life = setTimeoutFn(() => {
      if (closed) return;
      // The distinct event is the whole point: without it the client can't
      // tell a scheduled handoff from a dropped connection, and would back off
      // exponentially on a completely healthy stream.
      sendEvent("reconnect", { reason: "lifetime", since: lastVersion });
      close();
    }, lifetimeMs);

    // Client hung up (tab closed, navigated away, network dropped). Nothing
    // ends the invocation on its own, so the interval would keep billing Redis
    // commands for a connection nobody is reading.
    req.on?.("close", close);

    // Resolving only when the stream ends keeps the invocation alive for as
    // long as the response is open, and gives tests a teardown to await.
    return done;
  };
}

export default createEventsHandler();
