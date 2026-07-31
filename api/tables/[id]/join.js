/* ============================================================================
   POST /api/tables/[id]/join — take a seat, or queue for one (MP-3).

   Body: { playerId, name }
   200:  { status: "seated" | "pending", you, table: <redacted> }
   404:  no such table (or it expired)
   409:  MAX_WATCHERS are already waiting for a seat

   joinTable() decides all three outcomes; this route only translates them to
   HTTP. Rejoining with a playerId that already holds a seat is the reconnect
   path and short-circuits to "seated" — the client can call this
   unconditionally on load without needing to know whether it's a first join.

   "pending" is a 200 and carries the table, because a watcher is AT the table:
   they see the hand play out and the table sees their announcement. A table
   with five people in it is no longer a refusal — see joinTable. The 409 is
   now only the degenerate case where even the queue is full.
   ========================================================================= */
import { joinTable } from "../../../src/table.js";
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
  const out = await mutate(store, id, (table) =>
    joinTable(table, { playerId, name: body.name, now: Date.now() })
  );

  if (!out.ok) {
    if (out.error === "no-such-table") return fail(res, 404, "no-such-table", "That table doesn't exist.");
    return fail(res, 409, "conflict", "The table changed while joining. Try again.");
  }

  if (out.status === "full") {
    // No table body here: the error shape is the contract for every non-2xx,
    // and a would-be joiner can still poll api/tables/[id]/state.js with their
    // playerId to watch the table from the outside (seat -1, fully redacted).
    return fail(res, 409, "table-full", "That table has as many people waiting as it can hold.");
  }

  return sendJson(res, 200, {
    status: out.status,
    you: out.seat,
    table: tableViewFor(out.table, out.seat, playerId),
  });
}
