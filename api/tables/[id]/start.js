/* ============================================================================
   POST /api/tables/[id]/start — deal the next hand (MP-2.4).

   Body: { playerId }
   200:  { you, table: <redacted> }
   403:  not seated at this table
   404:  no such table
   409:  a hand is already in progress

   Anyone SEATED may deal, not just the host. It was host-only, and that made
   the host a single point of failure with no recovery: `hostPlayerId` is
   assigned once at createTable and never reassigned, and the COM-3.4 auto-cover
   cannot help here because it only ever covers the seat owed a decision — at
   handEnd `seatOwedDecision` returns -1, so nobody is owed one. A host whose
   phone died at the recap left four people looking at a modal with no way
   forward. Now any of them can move the table on.

   The check runs inside the mutate callback against freshly-read state rather
   than against a table read earlier in the request — a player could have been
   booted between the two, and the authorization decision has to be made on the
   same snapshot the write lands on.

   A seat is a seat whether or not the AI is currently covering it ("away"),
   which is what `seatOf` matches: someone coming back to a covered seat can
   deal on their way in.

   startHand() seats any pending joiners first, then deals. advanceTable() then
   runs the AI seats through picking (and the opening lead, if the AI leads)
   inside this same request, so the response the host gets back is already at
   the first decision a human owes.
   ========================================================================= */
import { startHand, atHandBoundary, seatOf, markSeen } from "../../../src/table.js";
import { advanceTable } from "../../../src/ai-runner.js";
import { mutate } from "../../../src/store/mutate.js";
import { getStore } from "../../_lib/store.js";
import { readJson, sendJson, fail, methodGuard } from "../../_lib/http.js";
import { requireMultiplayer } from "../../_lib/flags.js";
import { tableViewFor } from "../../_lib/redact.js";

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;
  if (!requireMultiplayer(res)) return;

  const { id } = req.query || {};
  if (!id) return fail(res, 400, "bad-request", "Missing table id.");

  const body = (await readJson(req)) || {};
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!playerId) return fail(res, 400, "bad-request", "playerId is required.");

  const store = getStore();
  const out = await mutate(store, id, (table) => {
    // Acting is the strongest possible evidence of presence. Without this, a
    // player could be taking their turn and still be covered by COM-3.4 if the
    // stream's presence pass had been starved — which is exactly the failure
    // that hit a live three-player table.
    table = markSeen(table, { playerId, now: Date.now() });

    if (seatOf(table, playerId) < 0) return { table, denied: "not-seated" };
    if (!atHandBoundary(table)) return { table, denied: "hand-in-progress" };

    const now = Date.now();
    const dealt = startHand(table, now);
    if (dealt === table) return { table, denied: "hand-in-progress" };
    return { table: advanceTable(dealt, now) };
  });

  if (!out.ok) {
    if (out.error === "no-such-table") return fail(res, 404, "no-such-table", "That table doesn't exist.");
    return fail(res, 409, "conflict", "The table changed while starting. Try again.");
  }

  if (out.denied === "not-seated") {
    return fail(res, 403, "not-seated", "Only someone at the table can deal.");
  }
  if (out.denied === "hand-in-progress") {
    return fail(res, 409, "hand-in-progress", "A hand is already in progress.");
  }

  const seat = seatOf(out.table, playerId);
  return sendJson(res, 200, { you: seat, table: tableViewFor(out.table, seat, playerId) });
}
