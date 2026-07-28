/* ============================================================================
   What the felt should draw right now.

   Plain .js, not .jsx, for the same reason fan.js is: this is the rule that
   decides what a player is allowed to know yet, and it has to be testable
   headlessly rather than by playing a hand and watching carefully.

   The table's felt is deliberately NOT a render of the server's latest state.
   The server resolves every AI seat inside a single request, so its trick
   jumps four cards at once and is usually cleared again before the client sees
   it; and the card you just played needs to be on the table before the server
   has confirmed it. This synthesises the state to draw instead, so the felt
   component itself stays a plain renderer.
   ========================================================================= */
import { cid } from "./engine.js";

// The state to draw, which is deliberately not what the
// server most recently said.
//
// Two differences, both about time. The trick shown is the paced frame rather
// than g.trick — the server resolves every AI seat inside one request, so its
// trick jumps by four cards at once and has usually been cleared again before
// the client sees it. And the card you just played is on the table before the
// server has confirmed it.
//
// Synthesising a state keeps Felt ignorant of both: it renders a game, and this
// decides which game that is. Masking `turn` while the reveal catches up also
// stops the active-seat glow racing ahead of the cards.
export function displayState(g, frame, optimistic, caughtUp, narrating = false) {
  // Your own card goes down the instant you tap it, before the server has
  // confirmed anything. The only reason to leave it off is that the real one is
  // already there.
  //
  // It used to also be suppressed whenever the frame was `cleared` — the beat
  // after a completed trick sweeps off the felt. But that is exactly when you
  // LEAD the next trick, and leading is the most common way to play a card: tap
  // it, and nothing happened until the server answered and the pacer moved on.
  // Measured at 3,565ms on beta. The clear flag says the previous trick is
  // gone, which is no reason to hide the first card of the next one.
  // Nothing can be on the table while the hand is still being dealt. The
  // pacers are each rewound on a new hand, but they are two cursors moving
  // independently and one of them arriving late showed three cards under a
  // felt that was still narrating the pick — a table mid-trick and mid-deal at
  // the same time.
  //
  // Rather than chase which cursor was late, this states the rule: until the
  // bury has been shown, the trick is empty. It cannot be wrong, because a
  // card genuinely played before the bury is not a state the game has.
  const trick = narrating ? [] : [
    ...frame.cards,
    ...(optimistic && !frame.cards.some((p) => cid(p.card) === cid(optimistic.card))
      ? [optimistic]
      : []),
  ];

  // Nothing about the outcome may reach the felt before the cards do.
  //
  // The server resolves a whole hand inside one request, so g.scores is
  // already the final total and g.trickCounts already counts the last trick
  // while the client is still dealing out that trick one card at a time. The
  // summary is held back until caughtUp — but the seat line under every avatar
  // was not, so it announced the result several seconds early. You watched the
  // scores move and then got shown the hand that moved them.
  //
  // Both are rewound to what the player has actually seen: scores to before
  // this hand was scored, trick counts to the tricks that have finished on
  // screen.
  const seenTricks = frame.trickIndex + (frame.complete ? 1 : 0);
  const rewind = !caughtUp && (g.trickHistory || []).length > seenTricks;

  const scores =
    !caughtUp && g.phase === "handEnd" && g.result
      ? g.scores.map((n, i) => n - (g.result.handDelta[i] ?? 0))
      : g.scores;

  let trickCounts = g.trickCounts;
  if (rewind) {
    trickCounts = g.trickCounts.map(() => 0);
    for (const th of g.trickHistory.slice(0, seenTricks)) trickCounts[th.winner]++;
  }

  // The partner is revealed by the called ace hitting the table, and the server
  // knows the instant it is played. The client must not, until it has actually
  // SHOWN that card: the server resolves several plays in one request, so the
  // PARTNER badge would appear on a seat while the trick that exposed them was
  // still two tricks away on screen. Same spoiler as the scores, different
  // tell — and this one gives away the hand's most guarded secret.
  //
  // revealedIds is what the player has watched land, so the badge waits for it.
  // If the ace is never played the engine never sets partnerRevealed at all,
  // and nobody is named.
  const calledAceId = g.calledSuit ? `A${g.calledSuit}` : null;
  const partnerRevealed =
    g.partnerRevealed && (!calledAceId || frame.revealedIds.has(calledAceId));

  return {
    ...g,
    trick,
    scores,
    trickCounts,
    partnerRevealed,
    turn: caughtUp ? g.turn : -1,
    pickTurn: caughtUp ? g.pickTurn : -1,
  };
}
