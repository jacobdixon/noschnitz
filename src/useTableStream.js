/* ============================================================================
   Live table subscription for the browser.

   The client half of api/tables/[id]/events.js. Read that file's header for the
   protocol; the short version is that the server streams `state` events and
   then deliberately hangs up every ~50 seconds with a `reconnect` event,
   because a serverless function cannot hold a connection open indefinitely.

   That makes reconnecting the normal case rather than the error case, and this
   hook's whole job is to make it invisible:

     - Every `state` carries a version. The hook remembers the newest one and
       reopens with `?since=<version>`, so the server can tell instantly whether
       the client missed anything and replay it. Nothing is lost across a
       handoff.
     - A payload whose version is not newer than what's held is dropped. A
       reconnect can legitimately race a redelivery, and applying an older
       state would rewind the table under the player's fingers mid-trick.
     - A scheduled handoff reconnects immediately; a real failure backs off.
       Treating them the same would either hammer a broken server or add a
       visible stall to every healthy 50-second boundary.

   Deliberately not using EventSource's own reconnect: it can't change the URL,
   so it can't carry `since` forward, and it retries a hard 404 (a table that
   expired) forever. The connection is opened with no retry of its own and
   managed here instead.

   Returns { table, connected, error, lastVersion }, where `table` is the
   redacted per-seat view — `table.g` is already viewFor()'d for this player's
   seat and other players' ids are stripped. See api/_lib/redact.js.
   ========================================================================= */
import { useState, useEffect, useRef } from "react";
import { logStream } from "./streamLog.js";

// First retry is fast because the common failure is a blip, not an outage.
export const BACKOFF_START_MS = 500;
export const BACKOFF_MAX_MS = 15_000;
export const BACKOFF_FACTOR = 2;

// A connection that opens and then says nothing is the failure this could not
// see. From a flight recorder on a real table: conn=7 opened, never reached
// `opened`, and sat there for THREE AND A HALF HOURS while the tab was in the
// background — no error, no frame, nothing to react to. It recovered only when
// the tab came back and the browser finally errored the socket.
//
// EventSource has no timeout of its own, so silence is indistinguishable from
// a quiet table. These give it a clock:
//
//   CONNECT   a stream that hasn't delivered its first frame is broken. The
//             server sends state (or a comment) immediately on connect.
//   SILENCE   the server hands off every STREAM_LIFETIME_MS (50s) and
//             heartbeats every 15s, so a healthy connection is never quiet for
//             long. Past this, assume it is dead rather than idle.
export const CONNECT_TIMEOUT_MS = 10_000;
export const SILENCE_TIMEOUT_MS = 75_000;

export function useTableStream(tableId, playerId) {
  const [table, setTable] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [lastVersion, setLastVersion] = useState(-1);

  // Refs, not state: the reconnect loop reads these from inside callbacks that
  // closed over an old render, and a stale `since` would re-request state the
  // player already has (or, worse, skip past state they don't).
  const versionRef = useRef(-1);
  const backoffRef = useRef(BACKOFF_START_MS);

  useEffect(() => {
    if (!tableId || !playerId) return;

    // A fresh table or a fresh identity is a fresh subscription — anything
    // held from the previous one is about a different table.
    versionRef.current = -1;
    backoffRef.current = BACKOFF_START_MS;
    setTable(null);
    setLastVersion(-1);

    let source = null;
    let retryTimer = null;
    let cancelled = false;
    // Numbers the connections, so the log shows which one an event belongs to
    // and a reopen that never produced a frame is obvious at a glance.
    let seq = 0;

    logStream("subscribe", { table: tableId });

    let watchdog = null;
    // Set while the tab is away, so returning can tell a real resume from the
    // stray visibilitychange a browser fires without ever having hidden us.
    let wasHidden = false;

    const closeSource = () => {
      clearTimeout(watchdog);
      watchdog = null;
      if (!source) return;
      source.close();
      source = null;
    };

    // Reconnect after `delay` ms. Every path that ends a connection routes
    // through here so there is exactly one place a connection can be reopened
    // — two racing reconnects would double every subsequent one.
    const scheduleReopen = (delay) => {
      if (cancelled) return;
      closeSource();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(open, delay);
    };

    // Coming back to the app IS the signal. This was the strongest suspect all
    // along and the handler only logged it: a backgrounded tab has its timers
    // throttled and its connection dropped by the OS, so nothing inside the
    // connection can notice. The flight recorder caught one that opened, never
    // delivered a frame, and sat there for THREE AND A HALF HOURS — recovering
    // only when the tab returned and the browser eventually errored the socket.
    //
    // Waiting on that error is the bug. The watchdog cannot cover it either,
    // because the watchdog is a timer and timers are exactly what a backgrounded
    // tab does not get. So the reconnect is driven from the one event that is
    // guaranteed to arrive at the right moment.
    //
    // Reopening a connection that turns out to be healthy costs almost nothing:
    // the server already hangs up every 50 seconds by design, so reconnecting is
    // the normal case rather than the error case, and `since` means the resync
    // is lossless. Cheap and certain beats clever and conditional — this runs on
    // five phones in a room, every one of which is going to sleep in a pocket.
    const onVisibility = () => {
      logStream("visibility", { state: document.visibilityState });
      if (cancelled) return;
      if (document.visibilityState !== "visible") {
        wasHidden = true;
        return;
      }
      if (!wasHidden) return;
      wasHidden = false;
      logStream("resume", { since: versionRef.current });
      // Not a failure, so it does not earn a backoff.
      backoffRef.current = BACKOFF_START_MS;
      scheduleReopen(0);
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Restarted on every sign of life. If it ever fires, the connection went
    // quiet in a way EventSource will not report, so it is torn down and
    // reopened rather than waited on.
    const armWatchdog = (ms, why, conn) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (cancelled) return;
        logStream("stalled", { conn, after: why });
        setConnected(false);
        // Deliberately not backed off: this is a stall, not a server that is
        // refusing us, and the reconnect carries `since` so nothing is missed.
        scheduleReopen(0);
      }, ms);
    };

    function open() {
      if (cancelled) return;

      const params = new URLSearchParams({ playerId });
      // -1 means "I have nothing" — omit it entirely rather than sending a
      // number the server has to special-case.
      if (versionRef.current >= 0) params.set("since", String(versionRef.current));

      const es = new EventSource(`/api/tables/${encodeURIComponent(tableId)}/events?${params}`);
      source = es;
      const n = ++seq;
      logStream("open", { conn: n, since: versionRef.current });
      armWatchdog(CONNECT_TIMEOUT_MS, "connect", n);

      es.addEventListener("state", (ev) => {
        if (cancelled || source !== es) return;
        let payload;
        try {
          payload = JSON.parse(ev.data);
        } catch {
          return; // A frame we can't parse is not a reason to tear down.
        }

        // Out-of-order / redelivered state. Dropping it is what makes the
        // reconnect safe: the server may resend the version we already have.
        if (!payload || typeof payload.version !== "number") return;
        if (payload.version <= versionRef.current) return;

        logStream("state", { conn: n, version: payload.version });
        armWatchdog(SILENCE_TIMEOUT_MS, "silence", n);
        versionRef.current = payload.version;
        // A frame arrived, so whatever went wrong before is over. Resetting
        // here rather than on `open` means a server that accepts connections
        // and then fails still backs off.
        backoffRef.current = BACKOFF_START_MS;

        setTable(payload.table);
        setLastVersion(payload.version);
        setConnected(true);
        setError(null);
      });

      // The scheduled end-of-shift handoff. Expected, so: no error, no
      // backoff, no flicker in the UI — reopen straight away carrying the
      // version we hold.
      // Presence arrives on its own frame because it is written WITHOUT a
      // version bump (see the note in the events endpoint). Merged into the
      // held table rather than replacing it: this must not disturb the version,
      // the game state, or anything the paced trick cursor is tracking.
      es.addEventListener("presence", (ev) => {
        armWatchdog(SILENCE_TIMEOUT_MS, "silence", n);
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        if (!data || !Array.isArray(data.lastSeen)) return;
        setTable((prev) => {
          if (!prev?.seats) return prev;
          return {
            ...prev,
            // A fresh server clock reading every heartbeat, which is what the
            // idle display corrects its skew against.
            serverAt: data.at,
            seats: prev.seats.map((s, i) => ({
              ...s,
              lastSeen: data.lastSeen[i] ?? s.lastSeen,
              kind: data.kinds?.[i] ?? s.kind,
            })),
          };
        });
      });

      es.addEventListener("reconnect", (ev) => {
        if (cancelled || source !== es) return;
        let reason = "?";
        try { reason = JSON.parse(ev.data)?.reason ?? "?"; } catch { /* keep "?" */ }
        logStream("handoff", { conn: n, reason });
        scheduleReopen(0);
      });

      // The table expired or was deleted. Reconnecting can only produce 404s
      // forever, so this is where the loop stops.
      es.addEventListener("gone", () => {
        if (cancelled || source !== es) return;
        logStream("gone", { conn: n });
        cancelled = true;
        closeSource();
        clearTimeout(retryTimer);
        setConnected(false);
        setError("gone");
      });

      es.onopen = () => {
        if (cancelled || source !== es) return;
        logStream("opened", { conn: n });
        armWatchdog(SILENCE_TIMEOUT_MS, "silence", n);
        setConnected(true);
        setError(null);
      };

      // EventSource reports every failure the same way — a dead network, a
      // 404, a mid-stream kill — so the only safe response is to back off and
      // try again. `gone` above is the one case the server tells us not to.
      es.onerror = () => {
        if (cancelled || source !== es) return;
        setConnected(false);
        setError("disconnected");
        const delay = backoffRef.current;
        // readyState distinguishes the two failures that look identical from
        // here: 2 (CLOSED) is a connection that will never come back on its
        // own, 0 (CONNECTING) is one the browser is already retrying — and
        // reopening on top of that is how you end up with two streams.
        logStream("error", { conn: n, backoffMs: delay, readyState: es.readyState });
        backoffRef.current = Math.min(delay * BACKOFF_FACTOR, BACKOFF_MAX_MS);
        scheduleReopen(delay);
      };
    }

    open();

    return () => {
      logStream("unsubscribe", { table: tableId });
      cancelled = true;
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      closeSource();
      setConnected(false);
    };
  }, [tableId, playerId]);

  return { table, connected, error, lastVersion };
}

export default useTableStream;
