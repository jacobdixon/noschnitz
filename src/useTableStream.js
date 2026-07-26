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

// First retry is fast because the common failure is a blip, not an outage.
export const BACKOFF_START_MS = 500;
export const BACKOFF_MAX_MS = 15_000;
export const BACKOFF_FACTOR = 2;

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

    const closeSource = () => {
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

    function open() {
      if (cancelled) return;

      const params = new URLSearchParams({ playerId });
      // -1 means "I have nothing" — omit it entirely rather than sending a
      // number the server has to special-case.
      if (versionRef.current >= 0) params.set("since", String(versionRef.current));

      const es = new EventSource(`/api/tables/${encodeURIComponent(tableId)}/events?${params}`);
      source = es;

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
      es.addEventListener("reconnect", () => {
        if (cancelled || source !== es) return;
        scheduleReopen(0);
      });

      // The table expired or was deleted. Reconnecting can only produce 404s
      // forever, so this is where the loop stops.
      es.addEventListener("gone", () => {
        if (cancelled || source !== es) return;
        cancelled = true;
        closeSource();
        clearTimeout(retryTimer);
        setConnected(false);
        setError("gone");
      });

      es.onopen = () => {
        if (cancelled || source !== es) return;
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
        backoffRef.current = Math.min(delay * BACKOFF_FACTOR, BACKOFF_MAX_MS);
        scheduleReopen(delay);
      };
    }

    open();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      closeSource();
      setConnected(false);
    };
  }, [tableId, playerId]);

  return { table, connected, error, lastVersion };
}

export default useTableStream;
