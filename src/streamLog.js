/* ============================================================================
   A flight recorder for the live table connection.

   This exists because the stream stalls intermittently — the server reports
   your turn while the browser sits inert, and a reload fixes it — and watching
   for it live doesn't work. A 55-second soak across a handoff caught nothing.
   So instead of guessing at a fix in the code path that decides whether the
   game keeps working, record what actually happened and read it afterwards.

   Design constraints, all of them from how the bug actually presents:

     Survives the stall.   The whole point is to read it after something went
                           wrong, including after the reload that fixes it —
                           hence sessionStorage, which outlives a reload but
                           not the tab, so it can't accumulate forever.

     Survives no devtools. It shows up on phones, where opening a console is
                           not realistic. The log is readable from the menu and
                           copyable in one tap.

     Costs nothing.        A handful of entries per 50-second connection shift.
                           Bounded ring buffer, no timers of its own, and it
                           never throws into the caller — a broken recorder
                           must not be able to break the game it is watching.

   NEVER records a playerId. It is a bearer token: possession of it IS the
   authorization to play that seat. A diagnostic gets pasted into a chat or an
   issue, which is exactly how a credential escapes. The table code is kept —
   a log you can't tie to a table is hard to act on, and the code is
   short-lived and already the user's own to share.
   ========================================================================= */

const KEY = "noschnitz.streamlog";
const MAX = 300;

// In memory as well as in storage: reads are frequent while rendering the
// viewer, and storage is the durable copy rather than the working one.
let entries = [];
let loaded = false;

const now = () => Date.now();

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw) entries = JSON.parse(raw) || [];
  } catch {
    entries = []; // private mode, quota, corrupt JSON — all the same to us
  }
}

function persist() {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Storage full or blocked. The in-memory log still works for this tab,
    // which is better than throwing on the way out of an error handler.
  }
}

/**
 * Record one event.
 *
 * @param {string} type  short tag, e.g. "open" | "state" | "error"
 * @param {object} data  small, JSON-safe, and never a playerId
 */
export function logStream(type, data = {}) {
  try {
    load();
    entries.push({ t: now(), type, ...data });
    if (entries.length > MAX) entries = entries.slice(-MAX);
    persist();
  } catch {
    // A recorder that can throw is worse than no recorder.
  }
}

export function readStreamLog() {
  load();
  return entries.slice();
}

export function clearStreamLog() {
  entries = [];
  try {
    window.sessionStorage.removeItem(KEY);
  } catch { /* nothing to do */ }
}

/**
 * The log as text, for pasting into a bug report.
 *
 * Times are relative to the first entry, because what matters is the shape —
 * how long the gap was, whether a reopen followed an error, whether anything
 * arrived after it — not the wall clock.
 */
export function formatStreamLog(list = readStreamLog()) {
  if (!list.length) return "(no stream events recorded)";
  const t0 = list[0].t;
  const lines = list.map((e) => {
    const { t, type, ...rest } = e;
    const secs = ((t - t0) / 1000).toFixed(1).padStart(7, " ");
    const detail = Object.entries(rest)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    return `${secs}s  ${type.padEnd(12)} ${detail}`;
  });
  return [
    `noschnitz stream log — ${list.length} events, ${((list[list.length - 1].t - t0) / 1000 / 60).toFixed(1)} min`,
    `build v${__APP_VERSION__}`,
    "",
    ...lines,
  ].join("\n");
}
