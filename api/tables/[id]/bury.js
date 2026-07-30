/* ============================================================================
   POST /api/tables/[id]/bury — bury two cards and call an ace (or go alone).

   Body: { playerId, cards: [...], calledSuit, calledRank }
         calledSuit is "C" | "S" | "H", or null to go alone.
         calledRank is "A" normally, or "10" when the picker holds all three
         fail aces and calls a ten instead. Validated as a pair.
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

   The reverse is NOT a rejection: a null calledSuit is always legal, whether
   or not something was callable. Going alone for the 4x is a decision the
   picker is entitled to make on any hand, and this endpoint used to be the
   thing stopping them — `opts.length > 0` with a null call fell through to
   `bad-call`, which read as "you can't call that suit" about a suit the
   player had deliberately not called.

   The client only OFFERS that below-the-bar (see `ALONE_OFFER_STRENGTH` in
   engine.js), and this endpoint deliberately does not enforce the bar. It is
   an affordance, not a rule: alone is legal at any strength, the AI's own bar
   sits a point lower, and a tampered client that goes alone on a weak hand is
   only hurting itself. Validation here is for things that would corrupt the
   hand for everyone else, which this is not.
   ========================================================================= */
import { seatOf, commit, markSeen } from "../../../src/table.js";
import { cid, assignPartner, callOptions } from "../../../src/engine.js";
import { advanceTable } from "../../../src/ai-runner.js";
import { mutate } from "../../../src/store/mutate.js";
import { getStore } from "../../_lib/store.js";
import { readJson, sendJson, fail, methodGuard } from "../../_lib/http.js";
import { requireMultiplayer } from "../../_lib/flags.js";
import { tableViewFor } from "../../_lib/redact.js";

// Mirrors the option list the single-player UI builds, kept in one place here
// so the server is the authority on what's callable.
// The rule itself lives in the engine — this endpoint is still the authority,
// it just stops being a separate transcription of it. It was one of five, and
// the only one a tampered client is checked against, so it is the worst one to
// let drift.
export const callableSuits = (hand, buried) => callOptions(hand, buried);

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;
  if (!requireMultiplayer(res)) return;

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
  // Which card names the partner: the ace normally, the ten when the picker
  // held all three aces. Validated as a PAIR below — a client may not mix a
  // suit it is allowed to call with a rank it is not.
  const calledRank = body.calledRank ?? "A";
  if (calledSuit !== null && !["A", "10"].includes(calledRank)) {
    return fail(res, 400, "bad-request", "calledRank must be A or 10.");
  }

  // The card that stands in for the called suit when going under. A lookup key
  // like the buried cards, resolved against the server's own hand below.
  const underWanted = typeof body.underCard === "string" ? body.underCard : null;

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

    // Declining to call is always allowed; the checks below are about naming a
    // partner you are not entitled to name.
    const chosen = calledSuit === null
      ? null
      : opts.find((o) => o.suit === calledSuit && o.rank === calledRank);
    if (calledSuit !== null) {
      if (opts.length === 0) return { table, denied: "no-callable-suit", seat };
      if (!chosen) return { table, denied: "bad-call", seat };
    }

    // Under is only a call once a card carries it. Reject the call outright
    // rather than storing a half-made one: a picker with `calledUnder` and no
    // designated card is exempt from their own call, which is strictly better
    // than playing the hand straight.
    const goingUnder = chosen?.kind === "under";
    let underCard = null;
    if (goingUnder) {
      if (!underWanted) return { table, denied: "no-under-card", seat };
      underCard = hand.find((c) => cid(c) === underWanted);
      // Must be one of the six kept. Naming a buried card, or a card that was
      // never theirs, would put a card on the table that is not in play.
      if (!underCard) return { table, denied: "bad-under-card", seat };
    } else if (underWanted) {
      return { table, denied: "not-going-under", seat };
    }

    const now = Date.now();
    const hands = g.hands.map((h, i) => (i === seat ? hand : h));
    let ng = {
      ...g,
      hands,
      buried: held,
      calledSuit,
      calledRank: calledSuit === null ? null : calledRank,
      // Public, because it is announced at the table and it changes how the
      // hand plays for everyone: the picker can neither lead nor follow the
      // suit they called.
      calledUnder: goingUnder,
      // Redacted by viewFor to everyone but the picker: which card was spent is
      // the whole point of the call.
      underCard,
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
    case "no-under-card":
      return fail(res, 400, "illegal-call", "Calling under needs a card to play under.");
    case "bad-under-card":
      return fail(res, 400, "illegal-call", "Play a card you kept, not one you buried.");
    case "not-going-under":
      return fail(res, 400, "illegal-call", "That call doesn't go under.");
    default:
      break;
  }

  return sendJson(res, 200, { you: out.seat, table: tableViewFor(out.table, out.seat, playerId) });
}
