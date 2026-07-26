/* ============================================================================
   POST /api/tables/[id]/away — hand your seat to the AI without giving it up.

   Body: { playerId }
   200:  { you, table: <redacted> }
   403:  you aren't seated
   404:  no such table

   COM-3.1. Distinct from leave.js, and the distinction is the point: leaving
   releases the seat to the next person who follows the link, while stepping
   away keeps it yours — your name stays on it, nobody else can take it, and
   you get it back by simply reopening the table (COM-3.2, handled by
   joinTable's reclaim path).

   Deliberately not a toggle. Coming back is not an explicit action a player
   should have to find; it happens because they showed up.
   ========================================================================= */
import { seatOf, stepAway } from "../../../src/table.js";
import { advanceTable } from "../../../src/ai-runner.js";
import { mutate } from "../../../src/store/mutate.js";
import { getStore } from "../../_lib/store.js";
import { readJson, sendJson, fail, methodGuard } from "../../_lib/http.js";
import { tableViewFor } from "../../_lib/redact.js";

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;

  const { id } = req.query || {};
  if (!id) return fail(res, 400, "bad-request", "Missing table id.");

  const body = (await readJson(req)) || {};
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!playerId) return fail(res, 400, "bad-request", "playerId is required.");

  const store = getStore();
  const out = await mutate(store, id, (table) => {
    const seat = seatOf(table, playerId);
    if (seat < 0) return { table, denied: "not-seated" };

    const now = Date.now();
    const away = stepAway(table, { playerId, now });
    if (away === table) return { table, seat };
    // If the table was waiting on this seat, it can move again immediately.
    return { table: advanceTable(away, now), seat };
  });

  if (!out.ok) {
    if (out.error === "no-such-table") return fail(res, 404, "no-such-table", "That table doesn't exist.");
    return fail(res, 409, "conflict", "Someone else acted first. Try again.");
  }
  if (out.denied === "not-seated") {
    return fail(res, 403, "not-seated", "You aren't seated at this table.");
  }

  return sendJson(res, 200, { you: out.seat, table: tableViewFor(out.table, out.seat) });
}
