/* ============================================================================
   GET /api/tables/[id]/state?playerId=... — the polling endpoint.

   200: { you, table: <redacted>, version }
   404: no such table (or it expired)

   This is the hot path — every client hits it on an interval — so it does the
   cheapest possible thing that keeps presence honest:

   markSeen() deliberately does NOT bump the CAS version (see src/table.js): if
   it did, five clients polling would collide with each other and with real
   plays continuously, for a field nobody makes a decision on. It still returns
   a new table with a fresh updatedAt, so the write refreshes the store TTL.
   Because the version is unchanged, the CAS compare still guards it correctly
   — a poll that races a real play loses, retries, and re-stamps lastSeen onto
   the winner's state rather than reverting it.

   A caller who isn't seated (spectator, or queued to join next hand) gets the
   table too, redacted to seat -1. markSeen() no-ops for them, so nothing is
   written and the TTL is refreshed directly instead.
   ========================================================================= */
import { markSeen, seatOf } from "../../../src/table.js";
import { mutate } from "../../../src/store/mutate.js";
import { getStore } from "../../_lib/store.js";
import { sendJson, fail, methodGuard } from "../../_lib/http.js";
import { requireMultiplayer } from "../../_lib/flags.js";
import { tableViewFor } from "../../_lib/redact.js";

export default async function handler(req, res) {
  if (!methodGuard(req, res, "GET")) return;
  if (!requireMultiplayer(res)) return;

  const { id, playerId: rawPlayerId } = req.query || {};
  if (!id) return fail(res, 400, "bad-request", "Missing table id.");
  const playerId = typeof rawPlayerId === "string" ? rawPlayerId.trim() : "";

  const store = getStore();
  const out = await mutate(store, id, (table) => markSeen(table, { playerId, now: Date.now() }));

  if (!out.ok) {
    if (out.error === "no-such-table") return fail(res, 404, "no-such-table", "That table doesn't exist.");
    return fail(res, 409, "conflict", "The table is being written to. Try again.");
  }

  // Nothing was written (unseated caller, or the seat's lastSeen was already
  // current), so keep the table alive explicitly. touch() moves the TTL only —
  // no version, no state.
  if (!out.wrote) await store.touch(id, Date.now());

  const seat = seatOf(out.table, playerId);
  return sendJson(res, 200, {
    you: seat,
    version: out.table.version,
    table: tableViewFor(out.table, seat, playerId),
  });
}
