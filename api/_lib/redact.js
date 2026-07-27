/* ============================================================================
   Per-player table redaction — the single exit point for table state.

   `viewFor(g, seat)` in src/engine.js handles the hard half of this problem
   (hands, blind, bury, partner identity) and scripts/leaktest.mjs guards it.
   But the engine state is only *part* of what a route sends: the table wrapper
   around it carries seats, names, presence and — critically — playerIds.

   Two things must never cross the wire, and both are wrapper-level:

   1. `table.g` — the raw engine state holds all five hands. Every response
      substitutes `viewFor(g, seat)` for the requesting seat, and only that
      seat. Anything shipped to a browser is readable in devtools, so "the
      client just won't look" is not a control.

   2. Other players' `playerId` values — these are bearer tokens, not names.
      There is no session, no password and no signature anywhere in this
      design: possession of a playerId IS the authorization to act as that
      seat (see seatOf() in src/table.js, which is how every route resolves
      identity). A player who learns another player's playerId can play that
      player's cards. So a seat's playerId is echoed back only to the player
      it belongs to; everyone else sees null. Same for queued joiners in
      `pendingJoins`.

      `hostPlayerId` is the same kind of secret and gets the same treatment —
      it is dropped entirely and replaced by `hostSeat` (a public, useless-to-
      steal seat index) plus `youAreHost`. That is everything a client needs to
      decide whether to render a "Start hand" button, with nothing it could
      replay against api/tables/[id]/start.js.

   A route that serializes a raw table — even "just the seats" — reintroduces
   both leaks. Every route returns tables through this function, without
   exception.
   ========================================================================= */
import { viewFor } from "../../src/engine.js";
import { seatOf } from "../../src/table.js";

// `seat` is the requesting player's seat index, or -1 for someone who holds
// the link but isn't seated (a spectator, or someone queued to join next
// hand). -1 is the maximally-redacted view and is the safe default: it matches
// no seat, so no hand and no playerId is disclosed.
//
// `viewerPlayerId` is optional and is used for exactly one thing: flagging the
// caller's own entry in the join queue, which is the one case where the viewer
// has no seat to be identified by. It is never echoed back.
export function tableViewFor(table, seat = -1, viewerPlayerId = null) {
  if (!table) return null;

  const me = Number.isInteger(seat) && seat >= 0 ? seat : -1;
  const hostSeat = seatOf(table, table.hostPlayerId);

  // Destructured out rather than deleted so a field added to the table later
  // has to be consciously re-listed below to become visible. Everything else
  // on a table (phase, dealer, scores, handNum, version, timestamps) is public
  // at a real table and passes through.
  const { g, seats, pendingJoins, hostPlayerId, ...rest } = table;

  return {
    ...rest,

    seats: seats.map((s, i) => ({
      kind: s.kind,
      name: s.name,
      lastSeen: s.lastSeen,
      // Your own token comes back to you (it's already yours); nobody else's
      // ever does. `isYou` is the flag clients should render from.
      playerId: i === me && s.kind === "human" ? s.playerId : null,
      isYou: i === me,
    })),

    // Queued joiners are visible by name so the roster can show
    // "Dave (joining next hand)", but their tokens are not.
    pendingJoins: (pendingJoins || []).map((p) => ({
      name: p.name,
      requestedAt: p.requestedAt,
      isYou: viewerPlayerId != null && p.playerId === viewerPlayerId,
    })),

    hostSeat,
    youAreHost: me >= 0 && hostSeat === me,

    you: me,
    g: g ? viewFor(g, me) : null,
  };
}
