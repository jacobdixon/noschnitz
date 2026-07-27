/* ============================================================================
   The house rules.

   A list rather than a sentence, because each rule has to be an addressable
   thing for any of the planned work to be possible: letting a table change
   them, and adding leasters — which is a rule sitting in this list today,
   negated, waiting to become true.

   Solo reads this constant directly: one player, so agreement is free. A table
   copies it onto the table object at creation, because there the rules have to
   be STATE — five people sitting down have to be playing the same game, and a
   guest arriving from a link has no way to know what was agreed except by
   being told. Same list, different lifetime; the header renders either without
   knowing which it was handed.

   Lives in its own module so the solo game can import it without reaching into
   src/table.js, which is the networked half. Solo must keep working with no
   server at all.
   ========================================================================= */
export const HOUSE_RULES = ["Called Ace", "No Leasters", "Double on the Bump"];
