/* ============================================================================
   POST /api/tables/[id]/bury — bury two cards and call an ace (or go alone).

   Body: { playerId, cards: [{ rank, suit }, { rank, suit }], calledSuit }
         calledSuit is "C" | "S" | "H", or null to go alone.
   200:  { you, table: <redacted> }
   400:  the bury or the call is illegal
   403:  you aren't the picker
   404:  no such table
   409:  the hand isn't in the bury phase

   Bury and call are one request rather than two. They're a single decision at
   a real table — what you bury determines which suits you may call — and
   splitting them would leave a table parked in a half-committed state if a
   player closed their phone between the two.

   The callable-suit rule is the subtle part, and it is recomputed here rather
   than trusted: a suit is callable only if the picker holds at least one card
   of that fail suit, does NOT hold its ace, and did not just bury its ace.
   That last clause is what keeps the secret-partner mechanic honest — burying
   the called ace would mean no partner exists while the defenders believe one
   does. (src/engine.js `viewFor` guards the resulting state from leaking that
   fact; this endpoint is what stops it arising in the first place. See the
   `alone` note in engine.js.)

   If no suit qualifies, the picker is genuinely alone and calledSuit must be
   null — a client claiming a suit anyway is rejected.
   ========================================================================= */
import { seatOf, commit, markSeen } from "../../../src/table.js";
import { isTrump, cid, assignPartner } from "../../../src/engine.js";
import { advanceTable } from "../../../src/ai-runner.js";
import { mutate } from "../../../src/store/mutate.js";
import { getStore } from "../../_lib/store.js";
import { readJson, sendJson, fail, methodGuard } from "../../_lib/http.js";
import { tableViewFor } from "../../_lib/redact.js";

// Mirrors the option list the single-player UI builds, kept in one place here
// so the server is the authority on what's callable.
export function callableSuits(hand, buried) {
  const failsBy = { C: [], S: [], H: [] };
  hand.filter((c) => !isTrump(c)).forEach((c) => failsBy[c.suit]?.push(c));
  return ["C", "S", "H"].filter(
    (su) =>
      failsBy[su].length > 0 &&
      !failsBy[su].some((c) => c.rank === "A") &&
      !buried.some((c) => c.suit === su && c.rank === "A" && !isTrump(c))
  );
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;

  const { id } = req.query || {};
  if (!id) return fail(res, 400, "bad-request", "Missing table id.");

  const body = (await readJson(req)) || {};
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!playerId) return fail(res, 400, "bad-request", "playerId is required.");

  const cards = Array.isArray(body.cards) ? body.cards : null;
  if (!cards || cards.length !== 2) {
    return fail(res, 400, "bad-request", "cards must be exactly two cards.");
  }
  if (!cards.every((c) => c && typeof c.rank === "string" && typeof c.suit === "string")) {
    return fail(res, 400, "bad-request", "each card must be { rank, suit }.");
  }
  const wanted = cards.map(cid);
  if (wanted[0] === wanted[1]) {
    return fail(res, 400, "illegal-bury", "You can't bury the same card twice.");
  }

  const calledSuit = body.calledSuit ?? null;
  if (calledSuit !== null && !["C", "S", "H"].includes(calledSuit)) {
    return fail(res, 400, "bad-request", "calledSuit must be C, S, H, or null.");
  }

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
    if (!g || g.phase !== "bury") return { table, denied: "not-burying", seat };
    if (g.picker !== seat) return { table, denied: "not-picker", seat };

    // Resolve against the server's copy; the client's objects are lookup keys
    // only, so extra fields can't ride along into the engine state.
    const held = wanted.map((w) => g.hands[seat].find((c) => cid(c) === w));
    if (held.some((c) => !c)) return { table, denied: "not-in-hand", seat };

    const hand = g.hands[seat].filter((c) => !wanted.includes(cid(c)));
    const opts = callableSuits(hand, held);

    if (opts.length === 0) {
      if (calledSuit !== null) return { table, denied: "no-callable-suit", seat };
    } else if (!opts.includes(calledSuit)) {
      return { table, denied: "bad-call", seat };
    }

    const now = Date.now();
    const hands = g.hands.map((h, i) => (i === seat ? hand : h));
    let ng = {
      ...g,
      hands,
      buried: held,
      calledSuit,
      selected: [],
      phase: "playing",
      trick: [],
      turn: g.leader,
    };
    ng = assignPartner(ng);

    const next = commit({ ...table, g: ng }, now);
    // Play begins immediately; if the leader is an AI seat it acts in this
    // same request rather than leaving the table apparently frozen.
    return { table: advanceTable(next, now), seat };
  });

  if (!out.ok) {
    if (out.error === "no-such-table") return fail(res, 404, "no-such-table", "That table doesn't exist.");
    return fail(res, 409, "conflict", "Someone else acted first. Try again.");
  }

  switch (out.denied) {
    case "not-seated":
      return fail(res, 403, "not-seated", "You aren't seated at this table.");
    case "not-picker":
      return fail(res, 403, "not-picker", "You aren't the picker.");
    case "not-burying":
      return fail(res, 409, "not-burying", "Nothing to bury right now.");
    case "not-in-hand":
      return fail(res, 400, "illegal-bury", "You can only bury cards from your hand.");
    case "no-callable-suit":
      return fail(res, 400, "illegal-call", "No suit is callable — you're going alone.");
    case "bad-call":
      return fail(res, 400, "illegal-call", "You can't call that suit.");
    default:
      break;
  }

  return sendJson(res, 200, { you: out.seat, table: tableViewFor(out.table, out.seat) });
}
