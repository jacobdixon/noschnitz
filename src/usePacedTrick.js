/* ============================================================================
   Paced trick reveal.

   In the solo game the engine loop plays one AI card every 800ms, so you watch
   the trick build up card by card. The multiplayer server can't work that way:
   serverless has no background ticker, so advanceAI resolves every AI seat
   inside the one request that unblocked them and the client receives four new
   cards at once. Rendering that state directly makes cards teleport onto the
   table in a block, which loses the thing that makes a trick readable — seeing
   who played what, in order.

   So the pacing moves to the client. This module reconstructs the ordered list
   of plays from server state and hands the component a cursor that advances on
   a timer, catching up to wherever the server actually is.

   Why not use the aiLog sequence numbers: they only cover AI plays, and only
   the ones from the most recent advance. trickHistory + trick is the complete,
   ordered, always-present record of the hand — including human plays and
   anything that happened while you were disconnected.

   The subtlety that makes this necessary rather than cosmetic: the server
   RESOLVES a completed trick inside the same request, so `g.trick` is already
   back to [] by the time the client sees it. Without replaying from history
   the fifth card of every trick would never be rendered at all — you'd see
   four cards and then an empty table.
   ========================================================================= */
import { useEffect, useRef, useState } from "react";

export const CARD_MS = 700;      // between cards within a trick
export const TRICK_HOLD_MS = 1500; // lingering on a completed trick

// Every play this hand, in order, tagged with the trick it belongs to.
// Completed tricks come from trickHistory; the in-progress one from g.trick.
export function buildPlaySequence(g) {
  if (!g) return [];
  const out = [];
  (g.trickHistory || []).forEach((h, ti) => {
    (h.trick || []).forEach((p) => out.push({ player: p.player, card: p.card, trickIndex: ti, winner: h.winner }));
  });
  const ti = (g.trickHistory || []).length;
  (g.trick || []).forEach((p) => out.push({ player: p.player, card: p.card, trickIndex: ti, winner: null }));
  return out;
}

// What should be on the felt right now, given how far the cursor has advanced.
// Returns the cards of the trick currently being shown, plus the winner once
// that trick is complete (so the component can show the same "+points" banner
// the solo game does).
export function frameAt(sequence, revealed) {
  const shown = sequence.slice(0, revealed);
  if (shown.length === 0) return { cards: [], trickIndex: 0, winner: null, complete: false };

  const trickIndex = shown[shown.length - 1].trickIndex;
  const cards = shown.filter((p) => p.trickIndex === trickIndex);
  const complete = cards.length === 5;
  return { cards, trickIndex, winner: complete ? cards[0].winner : null, complete };
}

export function usePacedTrick(g, { cardMs = CARD_MS, trickHoldMs = TRICK_HOLD_MS } = {}) {
  const sequence = buildPlaySequence(g);
  const [revealed, setRevealed] = useState(sequence.length);
  const handRef = useRef(g?.handNum);
  const initialised = useRef(false);

  // Joining or reloading mid-hand must NOT replay the whole hand from the
  // first card — snap to live once, then animate only what arrives after.
  if (!initialised.current) {
    initialised.current = true;
    handRef.current = g?.handNum;
  }

  // A new hand resets the cursor; the sequence is empty at that point anyway,
  // so everything from the first card of the new hand animates normally.
  useEffect(() => {
    if (g?.handNum !== handRef.current) {
      handRef.current = g?.handNum;
      setRevealed(0);
    }
  }, [g?.handNum]);

  // Never run backwards: if the server somehow reports fewer plays than we've
  // shown (a redeal racing an update), clamp rather than rewinding the table.
  useEffect(() => {
    if (revealed > sequence.length) setRevealed(sequence.length);
  }, [sequence.length, revealed]);

  useEffect(() => {
    if (revealed >= sequence.length) return;

    // Linger on a completed trick before the next one starts, matching the
    // beat the solo game gets for free from its own timing loop.
    const justCompletedTrick =
      revealed > 0 &&
      revealed < sequence.length &&
      sequence[revealed - 1].trickIndex !== sequence[revealed].trickIndex;

    const t = setTimeout(
      () => setRevealed((n) => Math.min(n + 1, sequence.length)),
      justCompletedTrick ? trickHoldMs : cardMs
    );
    return () => clearTimeout(t);
  }, [revealed, sequence.length, cardMs, trickHoldMs]);

  return {
    ...frameAt(sequence, revealed),
    // True when the display has caught up with the server. The component uses
    // this to hold back your own legal-play affordances until the table has
    // finished showing what everyone else did — clicking into a half-rendered
    // trick is exactly as confusing as it sounds.
    caughtUp: revealed >= sequence.length,
    pending: sequence.length - revealed,
  };
}
