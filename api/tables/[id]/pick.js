/* ============================================================================
   POST /api/tables/[id]/pick — take the blind, or pass.

   Body: { playerId, action: "pick" | "pass" }
   200:  { you, table: <redacted> }
   403:  you aren't seated
   404:  no such table
   409:  the hand isn't in the picking phase, or it isn't your turn to decide

   A dealt hand starts in "picking", not "playing", so without this endpoint a
   table with a human first-to-act can never begin — the play route correctly
   refuses (phase isn't "playing") and nothing advances. That's exactly the
   integration gap the end-to-end test caught.

   Passing may end the hand outright: five passes means it's thrown in and
   redealt. That, and every AI decision that follows this one, is left to
   advanceAI so the pick/pass sequence has a single implementation rather than
   one here and one in the AI driver.

   Same hostile-client posture as play.js: the seat comes from seatOf(playerId),
   never from the body, and the phase and turn are re-checked server-side.
   ========================================================================= */
import { seatOf, commit } from "../../../src/table.js";
import { sortHand } from "../../../src/engine.js";
import { advanceAI } from "../../../src/ai-runner.js";
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

  const action = body.action;
  if (action !== "pick" && action !== "pass") {
    return fail(res, 400, "bad-request", 'action must be "pick" or "pass".');
  }

  const store = getStore();
  const out = await mutate(store, id, (table) => {
    const seat = seatOf(table, playerId);
    if (seat < 0) return { table, denied: "not-seated" };

    const g = table.g;
    if (!g || g.phase !== "picking") return { table, denied: "not-picking", seat };
    if (g.pickTurn !== seat) return { table, denied: "not-your-turn", seat };

    const now = Date.now();

    if (action === "pass") {
      const passes = g.passes + 1;
      const next = commit(
        { ...table, g: { ...g, passes, pickTurn: (seat + 1) % 5 } },
        now
      );
      // advanceAI carries on through the remaining AI decisions and handles
      // the all-passed redeal.
      return { table: advanceAI(next, now), seat };
    }

    // Taking the blind: the two blind cards join this seat's hand, and the
    // picker then owes a bury + a call (see bury.js). The blind pile is left
    // in place rather than cleared — viewFor() hides it from everyone except
    // the picker, who is holding those cards anyway.
    const hands = g.hands.map((h, i) => (i === seat ? sortHand([...h, ...g.blind]) : h));
    const next = commit(
      { ...table, g: { ...g, picker: seat, hands, phase: "bury", selected: [] } },
      now
    );
    // Nothing for the AI to do while a human is burying, but calling it keeps
    // every mutation on the same path.
    return { table: advanceAI(next, now), seat };
  });

  if (!out.ok) {
    if (out.error === "no-such-table") return fail(res, 404, "no-such-table", "That table doesn't exist.");
    return fail(res, 409, "conflict", "Someone else acted first. Try again.");
  }

  switch (out.denied) {
    case "not-seated":
      return fail(res, 403, "not-seated", "You aren't seated at this table.");
    case "not-picking":
      return fail(res, 409, "not-picking", "Nobody is picking right now.");
    case "not-your-turn":
      return fail(res, 409, "not-your-turn", "It isn't your decision.");
    default:
      break;
  }

  return sendJson(res, 200, { you: out.seat, table: tableViewFor(out.table, out.seat) });
}
