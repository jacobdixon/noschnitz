/* ============================================================================
   POST /api/tables/[id]/seat — every action that changes who holds a seat.

   Body: { playerId, action, ...args }

     action: "away"   — hand my seat to the AI, keep it reserved (COM-3.1)
     action: "back"   — take my seat back from the AI (COM-3.2)
     action: "boot"   — release someone else's abandoned seat  { seat }
     action: "leave"  — give up my seat entirely
     action: "rename" — change my display name                 { name }

   These were five separate route files. They are one now because Vercel's
   Hobby plan caps a deployment at twelve Serverless Functions and the table
   API had reached thirteen — a limit that only shows up at deploy time, so the
   build passes locally and the deployment errors out. Consolidating the seat
   actions takes it back to nine and leaves headroom for spectators and the
   group home.

   They also belong together: every one is "resolve the caller's seat, mutate
   the roster, hand back a redacted table", and they share the same guards. The
   split was per-URL tidiness, not a real separation.

   Semantics preserved exactly from the routes this replaces, including error
   codes, because the client branches on them.
   ========================================================================= */
import {
  seatOf, stepAway, resumeSeat, leaveTable, bootSeat, isBootable,
  isClaimed, uniqueName, markSeen, commit, idleMs,
} from "../../../src/table.js";
import { advanceTable } from "../../../src/ai-runner.js";
import { mutate } from "../../../src/store/mutate.js";
import { getStore } from "../../_lib/store.js";
import { readJson, sendJson, fail, methodGuard } from "../../_lib/http.js";
import { requireMultiplayer } from "../../_lib/flags.js";
import { tableViewFor } from "../../_lib/redact.js";

const ACTIONS = ["away", "back", "boot", "leave", "rename"];

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;
  if (!requireMultiplayer(res)) return;

  const { id } = req.query || {};
  if (!id) return fail(res, 400, "bad-request", "Missing table id.");

  const body = (await readJson(req)) || {};
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!playerId) return fail(res, 400, "bad-request", "playerId is required.");

  const action = body.action;
  if (!ACTIONS.includes(action)) {
    return fail(res, 400, "bad-request", `action must be one of ${ACTIONS.join(", ")}.`);
  }

  // Per-action argument validation, before touching the store.
  let targetSeat = null;
  if (action === "boot") {
    targetSeat = Number(body.seat);
    if (!Number.isInteger(targetSeat) || targetSeat < 0 || targetSeat > 4) {
      return fail(res, 400, "bad-request", "seat must be 0-4.");
    }
  }
  let wantedName = null;
  if (action === "rename") {
    wantedName = typeof body.name === "string" ? body.name.trim() : "";
    if (!wantedName) return fail(res, 400, "bad-request", "A name is required.");
  }

  const store = getStore();
  const out = await mutate(store, id, (table) => {
    const now = Date.now();
    // Acting is the strongest evidence of presence, for every action here.
    table = markSeen(table, { playerId, now });

    const seat = seatOf(table, playerId);

    if (action === "leave") {
      // The one action that doesn't require you to still hold a seat: leaving
      // also withdraws a queued join.
      return { table: leaveTable(table, { playerId, now }), seat: -1 };
    }

    if (seat < 0) return { table, denied: "not-seated" };

    switch (action) {
      case "away": {
        const away = stepAway(table, { playerId, now });
        if (away === table) return { table, seat };
        // If the table was waiting on this seat, it can move again now.
        return { table: advanceTable(away, now), seat };
      }

      case "back": {
        // Deliberately no advanceTable: the AI must stop playing this seat,
        // not get one more move in on the way out.
        return { table: resumeSeat(table, { playerId, now }), seat };
      }

      case "boot": {
        if (targetSeat === seat) return { table, denied: "self" };
        if (!isClaimed(table.seats[targetSeat])) return { table, denied: "not-claimed" };
        // Re-checked against stored state, so a client rendering the button
        // early can't remove somebody who is present.
        if (!isBootable(table, targetSeat, now)) {
          return { table, denied: "still-present", idle: idleMs(table, targetSeat, now) };
        }
        return { table: advanceTable(bootSeat(table, { seat: targetSeat, now }), now), seat };
      }

      case "rename": {
        // Collisions are checked against everyone EXCEPT yourself, or
        // re-saving your own name would keep appending suffixes.
        const others = { ...table, seats: table.seats.filter((_, i) => i !== seat) };
        const finalName = uniqueName(others, wantedName);
        if (finalName === table.seats[seat].name) return { table, seat };
        const seats = table.seats.map((s, i) =>
          i === seat ? { ...s, name: finalName, lastSeen: now } : s
        );
        return { table: commit({ ...table, seats }, now), seat };
      }

      default:
        return { table, denied: "bad-action" };
    }
  });

  if (!out.ok) {
    if (out.error === "no-such-table") return fail(res, 404, "no-such-table", "That table doesn't exist.");
    return fail(res, 409, "conflict", "Someone else acted first. Try again.");
  }

  switch (out.denied) {
    case "not-seated":
      return fail(res, 403, "not-seated", "You aren't seated at this table.");
    case "self":
      return fail(res, 403, "cannot-boot-self", "Use Leave if you want to give up your own seat.");
    case "not-claimed":
      return fail(res, 409, "not-claimed", "Nobody is sitting there.");
    case "still-present":
      return fail(res, 400, "still-present", "They're still here — give them a moment.");
    case "bad-action":
      return fail(res, 400, "bad-request", "Unknown action.");
    default:
      break;
  }

  return sendJson(res, 200, { you: out.seat, table: tableViewFor(out.table, out.seat, playerId) });
}
