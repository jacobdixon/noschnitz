/* ============================================================================
   POST /api/tables — create a table (MP-1.1).

   Body: { hostName, playerId }
   201:  { table: <redacted>, you: <seat index> }

   The caller generates its own playerId (a random string kept in localStorage)
   and the server takes it on trust — the link is the credential, per the
   design note in src/table.js. Nothing here mints identity; it just records
   which token owns seat 0.
   ========================================================================= */
import { createTable, seatOf } from "../../src/table.js";
import { getStore } from "../_lib/store.js";
import { readJson, sendJson, fail, methodGuard } from "../_lib/http.js";
import { tableViewFor } from "../_lib/redact.js";

// 31^8 codes makes a collision essentially impossible, but store.create() is
// the only thing that can actually tell us — so honor its answer rather than
// assuming, and re-roll the code instead of failing the request.
const CREATE_ATTEMPTS = 3;

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;

  const body = (await readJson(req)) || {};
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!playerId) return fail(res, 400, "bad-request", "playerId is required.");

  const store = getStore();

  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    const now = Date.now();
    const table = createTable({ hostPlayerId: playerId, hostName: body.hostName, now });
    const created = await store.create(table);
    if (created.ok) {
      const seat = seatOf(created.table, playerId);
      return sendJson(res, 201, { table: tableViewFor(created.table, seat, playerId), you: seat });
    }
  }

  return fail(res, 500, "create-failed", "Could not allocate a table code. Try again.");
}
