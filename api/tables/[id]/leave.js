/* ============================================================================
   POST /api/tables/[id]/leave — give the seat back to the AI.

   Body: { playerId }
   200:  { you: -1, table: <redacted> }
   404:  no such table

   leaveTable() hands the seat to an AI under the same name, so a hand in
   progress keeps playing instead of stalling on someone who closed their tab.
   It also de-queues a pending joiner who never got seated, and no-ops for a
   playerId that was never here — leaving is idempotent, which matters because
   this is the kind of call a client fires from a beforeunload handler with no
   way to retry.

   The response is redacted to seat -1: the caller no longer holds a seat, so
   they're no longer entitled to a hand.
   ========================================================================= */
import { leaveTable } from "../../../src/table.js";
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
  const out = await mutate(store, id, (table) => leaveTable(table, { playerId, now: Date.now() }));

  if (!out.ok) {
    if (out.error === "no-such-table") return fail(res, 404, "no-such-table", "That table doesn't exist.");
    return fail(res, 409, "conflict", "The table changed while leaving. Try again.");
  }

  return sendJson(res, 200, { you: -1, table: tableViewFor(out.table, -1, playerId) });
}
