/* A local record of finished solo hands, for working out where a human plays
 * better than the AI does.
 *
 * Two decisions worth stating, because both were deliberate:
 *
 * Nothing leaves the browser. Solo runs entirely client-side and this keeps it
 * that way — the log lives in localStorage and only moves when you export it
 * by hand. Collecting play from anyone else is a different thing needing their
 * consent, and is not what this is.
 *
 * It stores the hand, not the analysis. Grading is ~800ms a hand and the
 * grader keeps improving, so re-deriving costs offline is both cheap and
 * better than freezing today's verdict into the record. What is kept is the
 * minimum needed to rebuild the deal exactly: `trickHistory` contains every
 * card every seat played, which is enough to reconstruct all five starting
 * hands, and the rest is the call and the burial.
 */

const KEY = "noschnitz.handlog.v1";
const INSTALL_KEY = "noschnitz.install";
const OPTOUT_KEY = "noschnitz.sharehands";
const ENDPOINT = "/api/hands";
// Small batches, sent as you play. Waiting for a round 100 before sending
// anything would mean a cleared browser loses the lot, and the threshold is
// about when there is enough to analyse — not about when to start keeping it.
const BATCH = 5;
// ~3KB a hand against a ~5MB localStorage budget, so this is a long way from
// the limit while still being months of play.
const MAX_HANDS = 300;

const canStore = () => {
  try { return typeof localStorage !== "undefined"; } catch { return false; }
};

// A random id for this browser, minted here and used for nothing else. It is
// deliberately NOT the multiplayer playerId, which is joined to a name: this
// one exists only so one device's hands can be grouped, which is what makes
// "does this player beat the engine" answerable at all.
export function installId() {
  if (!canStore()) return null;
  try {
    let id = localStorage.getItem(INSTALL_KEY);
    if (!id) {
      id = "i-" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(INSTALL_KEY, id);
    }
    return id;
  } catch { return null; }
}

export const isSharing = () => {
  if (!canStore()) return false;
  try { return localStorage.getItem(OPTOUT_KEY) !== "off"; } catch { return false; }
};

export function setSharing(on) {
  if (!canStore()) return;
  try {
    if (on) localStorage.removeItem(OPTOUT_KEY);
    else localStorage.setItem(OPTOUT_KEY, "off");
  } catch { /* nothing to do */ }
}

export function readHandLog() {
  if (!canStore()) return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// The version is the point of recording it: the recap already stamps the build
// into the shared image, and a hand is only attributable to an AI change if
// the log agrees with it.
export function recordHand(g, version, humanSeat = 0) {
  if (!canStore() || !g || g.phase !== "handEnd") return;
  if (!g.trickHistory || g.trickHistory.length < 6) return;
  try {
    const log = readHandLog();
    const rec = {
      at: Date.now(),
      version,
      humanSeat,
      handNum: g.handNum,
      picker: g.picker,
      partner: g.partner,
      alone: Boolean(g.alone),
      calledSuit: g.calledSuit ?? null,
      calledRank: g.calledRank ?? null,
      calledUnder: Boolean(g.calledUnder),
      underCard: g.underCard ?? null,
      buried: g.buried ?? [],
      leader: g.trickHistory[0].trick[0].player,
      // Order matters and is the whole record: play order per trick, tricks in
      // order. Starting hands are recoverable from it.
      tricks: g.trickHistory.map((th) => th.trick.map((p) => [p.player, p.card])),
    };
    // Dedupe on replay/StrictMode double-invoke: same hand number and same
    // final trick means we already have it.
    const last = log[log.length - 1];
    if (last && last.handNum === rec.handNum && JSON.stringify(last.tricks) === JSON.stringify(rec.tricks)) return;
    log.push(rec);
    while (log.length > MAX_HANDS) log.shift();
    localStorage.setItem(KEY, JSON.stringify(log));
    // Fire and forget: a failed upload must never affect the game.
    flushHands();
  } catch {
    // A full or disabled localStorage must never take the game down with it.
  }
}

// Sends anything not yet sent, oldest first, and marks it. Failure is silent
// and non-destructive: unsent records stay unsent and go out with the next
// hand, so playing on a train loses nothing.
//
// Environments without a store answer 503 and that is a permanent no, not a
// retry — production has no Redis, so a browser there would otherwise queue
// forever and re-send on every hand.
let sharingOff = false;
export async function flushHands() {
  if (!canStore() || sharingOff || !isSharing()) return;
  let log = readHandLog();
  const pending = log.filter((r) => !r.sent);
  if (pending.length < BATCH) return;

  const batch = pending.slice(0, BATCH);
  const install = installId();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hands: batch.map(({ sent, ...h }) => ({ ...h, install })) }),
    });
    if (res.status === 503 || res.status === 404) { sharingOff = true; return; }
    if (!res.ok) return;
    const keys = new Set(batch.map((b) => `${b.at}`));
    log = readHandLog().map((r) => (keys.has(`${r.at}`) ? { ...r, sent: true } : r));
    localStorage.setItem(KEY, JSON.stringify(log));
  } catch { /* offline; try again after the next hand */ }
}

export function clearHandLog() {
  if (!canStore()) return;
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
}

/* No UI for this on purpose. It is an analysis tool for whoever is tuning the
 * AI, not a feature, and a menu entry would have to be designed, translated
 * into the recap's visual language and maintained. A documented global that
 * downloads a file costs nothing and does the same job:
 *
 *     noschnitzExportHands()      in the browser console, then
 *     node scripts/minehands.mjs <the downloaded file>
 */
export function installExportGlobal() {
  if (typeof window === "undefined") return;
  window.noschnitzExportHands = () => {
    const log = readHandLog();
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `noschnitz-hands-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    return `${log.length} hands exported`;
  };
  window.noschnitzClearHands = () => { clearHandLog(); return "cleared"; };
}
