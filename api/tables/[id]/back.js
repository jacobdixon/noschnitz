/* ============================================================================
   POST /api/tables/[id]/back — take your seat back from the AI.

   Body: { playerId }
   200:  { you, table: <redacted> }
   403:  you aren't seated at this table
   404:  no such table

   The counterpart to away.js, and it was missing. joinTable reclaims an away
   seat, but nothing in the client ever reached it for a player who still HELD
   a seat: the presence ping only touches lastSeen, and the join gate sends an
   already-seated player straight through without joining. So once the AI
   covered a seat — whether its owner stepped away deliberately or simply went
   quiet long enough — there was no route back.

   Explicit rather than automatic, on purpose. A phone waking in a pocket and
   resuming its presence pings is weak evidence that a human is at the table;
   reclaiming on that basis would hand the seat back to nobody and stall the
   hand again. Coming back is a thing you do.

   Safe at any point in a hand. The seat's cards were never touched — the AI
   was only choosing plays for it — so control simply returns at the next
   decision that seat owes.
   ========================================================================= */
import { seatOf, resumeSeat, markSeen } from "../../../src/table.js";
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
    const now = Date.now();
    const seat = seatOf(table, playerId);
    if (seat < 0) return { table, denied: "not-seated" };

    // Deliberately NOT calling advanceTable afterwards. The AI must stop
    // playing this seat, not get one more move in on the way out.
    const resumed = resumeSeat(table, { playerId, now });
    return { table: markSeen(resumed, { playerId, now }), seat };
  });

  if (!out.ok) {
    if (out.error === "no-such-table") return fail(res, 404, "no-such-table", "That table doesn't exist.");
    return fail(res, 409, "conflict", "Someone else acted first. Try again.");
  }
  if (out.denied === "not-seated") {
    return fail(res, 403, "not-seated", "You aren't seated at this table.");
  }

  return sendJson(res, 200, { you: out.seat, table: tableViewFor(out.table, out.seat, playerId) });
}
