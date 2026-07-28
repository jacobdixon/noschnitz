/* ============================================================================
   Watching the hand start.

   Solo shows you the table waking up: one player at a time decides, the picker
   takes the blind, buries, calls — each with a beat. It gets that for free,
   because it drives its own AI on timers.

   A table gets none of it. The server resolves every AI seat inside the single
   request that deals the hand, so the first state a browser sees already has
   the picking finished, the blind buried, a suit called, and often two or three
   cards played. The hand is painted mid-flight, and the part that makes the
   game feel like a game has already happened.

   Nothing is missing from the state, though — it can be reconstructed exactly:

     picking order  starts left of the dealer and goes round
     who passed     the first `passes` seats in that order
     who picked     `picker`, immediately after them
     the bury       once the phase has moved past it

   So this replays the opening from the state itself, one beat at a time, with
   no extra field on the wire and no second request. It runs only when a hand
   is NEW to this client: joining a table mid-hand still snaps to live, because
   replaying decisions you weren't there for is a fifteen-second freeze, not
   atmosphere.
   ========================================================================= */
import { useState, useEffect, useRef } from "react";

export const SEATS = 5;

// How long each beat holds. A decision is quick — it is one word. Taking the
// blind and burying is the biggest moment before play starts, so it gets
// longer; it is also when the called suit appears, which people read.
export const DECISION_MS = 850;
export const BURY_MS = 1300;

/**
 * The opening of the hand, as beats, derived entirely from the game state.
 *
 * @returns {{type: "pass"|"pick"|"bury", seat: number, calledSuit?: string}[]}
 */
export function buildDecisionSequence(g) {
  if (!g || g.dealer === undefined || g.dealer === null) return [];

  const out = [];
  const first = (g.dealer + 1) % SEATS;
  const passes = g.passes ?? 0;

  // Everyone who passed, in the order they were asked.
  for (let i = 0; i < passes; i++) {
    out.push({ type: "pass", seat: (first + i) % SEATS });
  }

  // A hand where all five passed has no picker and no bury — it is a throw-in,
  // and the passes are the whole story.
  if (g.picker === null || g.picker === undefined) return out;

  out.push({ type: "pick", seat: g.picker });

  // The bury and the call are one beat: at a real table they are one motion,
  // and the suit is what everyone is waiting to hear. Only once it has actually
  // happened — while the picker is still choosing, there is nothing to show.
  if (g.phase === "playing" || g.phase === "handEnd") {
    out.push({ type: "bury", seat: g.picker, calledSuit: g.calledSuit ?? null });
  }

  return out;
}

/**
 * Walks the opening beats for a hand this client hasn't seen before.
 *
 * Returns { shown, done } — `shown` is the beats revealed so far, for drawing,
 * and `done` says the table may start dealing cards.
 */
export function useDealNarration(g, { decisionMs = DECISION_MS, buryMs = BURY_MS } = {}) {
  const sequence = buildDecisionSequence(g);
  const [shown, setShown] = useState(0);
  const handRef = useRef(null);
  const initialised = useRef(false);

  // Derived during RENDER, not left to the effect below. Effects run after the
  // browser has already painted, so for one frame the new hand was drawn with
  // the previous cursor — which was at the end. That frame showed the picker's
  // badge and "Someone's play…" before the narration had started, which is
  // precisely the flash this whole file exists to remove.
  const newHand = initialised.current && g && g.handNum !== handRef.current;
  const at = newHand ? 0 : Math.min(shown, sequence.length);

  // Same rule the card pacer learned the hard way: the FIRST state we ever see
  // snaps to live, because we weren't watching. Only a hand that starts while
  // we're here gets narrated.
  useEffect(() => {
    // Note the ordering: this must initialise even when there is no game yet.
    // Sitting in the lobby IS watching, and bailing on a null g meant the first
    // dealt hand looked like the first state we had ever seen — so it snapped
    // to live and the whole opening was skipped, which is the bug this file
    // exists to fix, reintroduced one layer up.
    if (!initialised.current) {
      initialised.current = true;
      handRef.current = g ? g.handNum : null;
      setShown(g ? buildDecisionSequence(g).length : 0);
      return;
    }

    if (!g) return;

    if (g.handNum !== handRef.current) {
      handRef.current = g.handNum;
      setShown(0);
    }
  }, [g]);

  // Never run backwards, and never sit past the end: a redeal can shorten the
  // sequence under us.
  useEffect(() => {
    if (shown > sequence.length) setShown(sequence.length);
  }, [sequence.length, shown]);

  useEffect(() => {
    if (at >= sequence.length) return;
    const next = sequence[at];
    const t = setTimeout(
      () => setShown((n) => Math.min(n + 1, sequence.length)),
      next?.type === "bury" ? buryMs : decisionMs
    );
    return () => clearTimeout(t);
  }, [at, shown, sequence.length, sequence, decisionMs, buryMs]);

  return {
    shown: sequence.slice(0, at),
    done: at >= sequence.length,
    pending: sequence.length - at,
  };
}
