/* ============================================================================
   POST /api/tables/[id]/boot — release a seat whose player has gone.

   Body: { playerId, seat }
   200:  { you, table: <redacted> }
   400:  the seat isn't a real seat, or isn't idle enough to boot
   403:  you aren't seated at this table, or you're booting yourself
   404:  no such table
   409:  that seat isn't claimed by anybody

   Distinct from both leaving and stepping away:
     leave     — I give up my seat
     away      — I keep my seat, the AI covers it (COM-3.1)
     boot      — the TABLE reclaims somebody else's seat after they've gone

   Any seated player may boot, not just the host. On a real game night the
   person who wandered off may well be the host, and a host-only rule leaves
   the table stuck behind exactly the player it needs to remove. Griefing isn't
   a meaningful threat in a group that already shares the table link.

   The idle threshold is re-checked here against the stored table rather than
   trusted from the client, so a client that renders the button early — or a
   crafted request — still can't remove someone who is present.

   Booting is not a ban. The table code remains the only credential, so a
   booted player who comes back simply joins as a newcomer and takes a free
   seat. That's deliberate: this is for reclaiming a seat from someone who has
   left, not for excluding people.
   ========================================================================= */
import { seatOf, isBootable, bootSeat, isClaimed, markSeen, idleMs } from "../../../src/table.js";
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

  const seat = Number(body.seat);
  if (!Number.isInteger(seat) || seat < 0 || seat > 4) {
    return fail(res, 400, "bad-request", "seat must be 0-4.");
  }

  const store = getStore();
  const out = await mutate(store, id, (table) => {
    const now = Date.now();
    // Asking to boot someone is itself evidence you're here.
    table = markSeen(table, { playerId, now });

    const mine = seatOf(table, playerId);
    if (mine < 0) return { table, denied: "not-seated" };
    if (mine === seat) return { table, denied: "self" };
    if (!isClaimed(table.seats[seat])) return { table, denied: "not-claimed" };
    if (!isBootable(table, seat, now)) {
      return { table, denied: "still-present", idle: idleMs(table, seat, now) };
    }

    // Releasing a seat can unblock a hand that was waiting on it.
    return { table: advanceTable(bootSeat(table, { seat, now }), now), seat: mine };
  });

  if (!out.ok) {
    if (out.error === "no-such-table") return fail(res, 404, "no-such-table", "That table doesn't exist.");
    return fail(res, 409, "conflict", "Someone else acted first. Try again.");
  }

  switch (out.denied) {
    case "not-seated":
      return fail(res, 403, "not-seated", "Only someone at the table can do that.");
    case "self":
      return fail(res, 403, "cannot-boot-self", "Use Leave if you want to give up your own seat.");
    case "not-claimed":
      return fail(res, 409, "not-claimed", "Nobody is sitting there.");
    case "still-present":
      return fail(res, 400, "still-present", "They're still here — give them a moment.");
    default:
      break;
  }

  return sendJson(res, 200, { you: out.seat, table: tableViewFor(out.table, out.seat, playerId) });
}
