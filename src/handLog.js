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
// ~3KB a hand against a ~5MB localStorage budget, so this is a long way from
// the limit while still being months of play.
const MAX_HANDS = 300;

const canStore = () => {
  try { return typeof localStorage !== "undefined"; } catch { return false; }
};

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
  } catch {
    // A full or disabled localStorage must never take the game down with it.
  }
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
