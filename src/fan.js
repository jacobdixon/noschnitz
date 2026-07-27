/* ============================================================================
   Hand fan geometry.

   Plain .js, not .jsx, so the arithmetic can be unit tested — this has now been
   the source of two separate clipping bugs and guessing at constants is what
   caused both.

   The awkward number here is CARD_W. `Card` declares width: 56, but it predates
   box-sizing and adds padding and a border on top, so a card actually occupies
   ~67px. Six cards laid out flat overflow a 375px phone by 39px, which was the
   first bug. The second was the picker's 8-card bury view: a fixed overlap that
   fits six cards does not fit eight, and the last two hang off the screen.

   So the overlap isn't a constant — it's derived from how many cards there are
   and how much room exists.
   ========================================================================= */

// Card's box, kept here rather than in ui.jsx so this file stays plain JS and
// node-testable. ui.jsx imports these to build the card, so there is exactly
// one source of truth and the fan arithmetic cannot disagree with what renders.
//
// It did disagree, for as long as this constant has existed. CARD_W was 67 on
// the belief that a card carried "~8 horizontal padding"; it carries 12. Four
// pixels per card is 24 across a six-card fan, which is why both screens
// overhung their row — solo by 7px a side, and the table by the same, since it
// has been using this same function all along.
//
// fantest could never have caught it: it computes a width with CARD_W and then
// asserts that width fits, so it is consistent with itself whatever the value
// is. Only measuring a rendered card finds this, which is what happened.
export const CARD_FACE_W = 56;   // Card's declared width at scale 1
export const CARD_PAD_X = 6;     // horizontal padding, each side
export const CARD_BORDER = 1.5;  // border, each side

export const CARD_W = CARD_FACE_W + 2 * CARD_PAD_X + 2 * CARD_BORDER; // 71

// Below this the fan stops looking like a fan and starts looking like a stack.
export const MIN_OVERLAP = 14;

// Past this the rank/suit glyph in the card's top-left corner starts getting
// covered, which is the one part that has to stay readable.
export const MAX_OVERLAP = 38;

/**
 * How much each card should be pulled left over its neighbour so that `count`
 * cards fit inside `avail` pixels.
 *
 * Total width of a fan is CARD_W + (count - 1) * (CARD_W - overlap). Solving
 * that for overlap against the available width gives the tightest fan that
 * still fits; clamped so it neither looks silly at small hand sizes nor hides
 * the corner glyphs at large ones.
 *
 * @param {number} count  cards in hand (6 normally, 8 while burying)
 * @param {number} avail  usable width in px
 */
export function fanOverlap(count, avail) {
  if (count <= 1) return 0;
  const needed = CARD_W - (avail - CARD_W) / (count - 1);
  return Math.min(MAX_OVERLAP, Math.max(MIN_OVERLAP, Math.ceil(needed)));
}

/** Total rendered width of a fan, for asserting it actually fits. */
export function fanWidth(count, overlap) {
  if (count <= 0) return 0;
  return CARD_W + (count - 1) * (CARD_W - overlap);
}
