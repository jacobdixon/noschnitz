/* ============================================================================
   POST /api/tables/[id]/name — change your display name.

   Body: { playerId, name }
   200:  { you, table: <redacted> }
   400:  the name is empty
   403:  you aren't seated
   404:  no such table

   Names were previously set once, silently, and never again: the host got the
   literal string "Host" because the create flow never asked, and a returning
   guest was auto-joined with whatever localStorage held. "Remembered" was
   implemented as "never asked again", which is not the same thing.

   Runs through uniqueName() exactly like joining does, so renaming can't
   sidestep the collision rule that joining enforces — including collisions
   with the AI names, since "Gus" sitting next to Gus is the confusion that
   rule exists to prevent.
   ========================================================================= */
import { seatOf, uniqueName, commit, markSeen } from "../../../src/table.js";
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

  const wanted = typeof body.name === "string" ? body.name.trim() : "";
  if (!wanted) return fail(res, 400, "bad-request", "A name is required.");

  const store = getStore();
  const out = await mutate(store, id, (table) => {
    const seat = seatOf(table, playerId);
    if (seat < 0) return { table, denied: "not-seated" };

    const now = Date.now();
    // Collisions are checked against everyone EXCEPT yourself — otherwise
    // re-saving your own name would keep appending suffixes to it.
    const others = { ...table, seats: table.seats.filter((_, i) => i !== seat) };
    const finalName = uniqueName(others, wanted);
    if (finalName === table.seats[seat].name) return { table: markSeen(table, { playerId, now }), seat };

    const seats = table.seats.map((s, i) => (i === seat ? { ...s, name: finalName, lastSeen: now } : s));
    return { table: commit({ ...table, seats }, now), seat };
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
