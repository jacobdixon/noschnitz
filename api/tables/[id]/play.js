/* ============================================================================
   POST /api/tables/[id]/play — play one card.

   Body: { playerId, card: { rank, suit } }
   200:  { you, table: <redacted> }
   400:  the card isn't in your hand, or isn't legal
   403:  you aren't seated at this table
   404:  no such table
   409:  it isn't your turn

   This is the authoritative move endpoint, so it is written on the assumption
   that the client is hostile:

   - Identity comes from seatOf(playerId), never from a seat index in the body.
     A client cannot name the seat it's playing for.
   - The card is matched against the server's copy of the hand and the card
     object stored server-side is the one passed to applyPlay — the client's
     { rank, suit } is only ever used as a lookup key. A body carrying extra
     fields on `card` can't smuggle anything into the engine state.
   - Legality is recomputed with legalPlays() on every request. The UI computes
     the same set to grey out cards, but that's a convenience, not a control;
     nothing about the client's opinion is trusted here.

   All of it — seat lookup, turn check, legality, applyPlay and advanceTable —
   happens inside ONE mutate callback, so the whole move is a single
   compare-and-swap. Splitting the validation from the write would let two
   requests both validate against version N and both write: a card played
   twice, or a trick resolved against a stale hand.

   Version bookkeeping: applyPlay() is an engine function and knows nothing
   about the table's CAS counter, so the human's own card is wrapped in
   table.js's commit() to bump `version` the same way every other table
   mutation does. advanceTable() then bumps it once more if it had anything to do.
   ========================================================================= */
import { seatOf, commit, markSeen } from "../../../src/table.js";
import { legalPlays, applyPlay, cid } from "../../../src/engine.js";
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

  const card = body.card;
  if (!card || typeof card.rank !== "string" || typeof card.suit !== "string") {
    return fail(res, 400, "bad-request", "card must be { rank, suit }.");
  }
  const wanted = cid(card);

  const store = getStore();
  const out = await mutate(store, id, (table) => {
    // Acting is the strongest possible evidence of presence. Without this, a
    // player could be taking their turn and still be covered by COM-3.4 if the
    // stream's presence pass had been starved — which is exactly the failure
    // that hit a live three-player table.
    table = markSeen(table, { playerId, now: Date.now() });

    const seat = seatOf(table, playerId);
    if (seat < 0) return { table, denied: "not-seated" };

    const g = table.g;
    // No hand dealt, still picking, or the hand is over: there is no play to
    // make. Checked before the turn test because g.turn is already populated
    // during picking and would otherwise let a play slip through.
    if (!g || g.phase !== "playing") return { table, denied: "not-playing", seat };

    // turn === -1 means five cards are down and the trick is awaiting
    // resolution — nobody's turn, not just "not yours".
    if (g.turn !== seat || g.trick.length >= 5) return { table, denied: "not-your-turn", seat };

    const held = g.hands[seat].find((c) => cid(c) === wanted);
    if (!held) return { table, denied: "not-in-hand", seat };
    if (!legalPlays(g, seat).some((c) => cid(c) === wanted)) {
      return { table, denied: "illegal-play", seat };
    }

    const now = Date.now();
    const played = commit({ ...table, g: applyPlay(g, seat, held) }, now);
    // Resolves the completed trick and runs every AI seat that follows, so one
    // human request produces the full visible consequence of that card.
    return { table: advanceTable(played, now), seat };
  });

  if (!out.ok) {
    if (out.error === "no-such-table") return fail(res, 404, "no-such-table", "That table doesn't exist.");
    return fail(res, 409, "conflict", "Someone else played first. Try again.");
  }

  switch (out.denied) {
    case "not-seated":
      return fail(res, 403, "not-seated", "You aren't seated at this table.");
    case "not-playing":
      return fail(res, 409, "not-playing", "No hand is in progress.");
    case "not-your-turn":
      return fail(res, 409, "not-your-turn", "It isn't your turn.");
    case "not-in-hand":
      return fail(res, 400, "illegal-play", "That card isn't in your hand.");
    case "illegal-play":
      return fail(res, 400, "illegal-play", "That card isn't a legal play.");
    default:
      break;
  }

  return sendJson(res, 200, { you: out.seat, table: tableViewFor(out.table, out.seat, playerId) });
}
