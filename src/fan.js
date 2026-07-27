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

// Measured in the browser, not derived from the style: 56 declared + ~8
// horizontal padding + 3 border.
export const CARD_W = 67;

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
