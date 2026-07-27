/* ============================================================================
   Layout fingerprint — paste into the browser console on either UI.

   Converging the multiplayer table onto the solo components only counts if the
   result renders the same, and "looks the same" is an opinion. This reduces a
   rendered screen to numbers that can be diffed: where the seats are, where
   played cards land, how the hand fans, how tall the chrome is.

   Used two ways:

     Solo, at each phase        the target being converged onto
     Multiplayer, before/after  proof the swap changed nothing it shouldn't,
                                and that the paced reveal and optimistic play
                                — the parts hardest to get right and easiest to
                                break — still behave

   Positions are rounded to whole pixels and reported relative to the felt
   rather than the viewport, so the two UIs stay comparable even though their
   chrome differs in height.
   ========================================================================= */
(() => {
  const round = (n) => Math.round(n);

  // Seat columns are the fixed-width absolutely-positioned stacks.
  const seatEls = [...document.querySelectorAll("div")].filter(
    (d) => d.style.position === "absolute" && d.style.width === "84px"
  );

  // The felt is the positioning context everything else is measured against,
  // and it has to be the seats' own offsetParent rather than a guess. Picking
  // "the first relative div with an absolute child" found a DIFFERENT element
  // on the two screens — an outer full-bleed wrapper on one, the felt itself
  // on the other — which silently shifted every number and made a solo capture
  // look like a match for multiplayer.
  const feltEl = seatEls[0]?.offsetParent;
  const felt = feltEl?.getBoundingClientRect();
  const rel = (r) => (felt ? { x: round(r.x - felt.x), y: round(r.y - felt.y) } : null);

  const seats = seatEls
    .map((d) => ({ ...rel(d.getBoundingClientRect()), text: d.innerText.replace(/\n/g, "|") }))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  // Played cards carry zIndex 2 in both implementations.
  const trick = [...document.querySelectorAll("div")]
    .filter((d) => d.style.position === "absolute" && d.style.zIndex === "2")
    .map((d) => ({ ...rel(d.getBoundingClientRect()), card: d.innerText.replace(/\n/g, "") }))
    .sort((a, b) => a.x - b.x);

  // Card faces: rounded corners plus an explicit width.
  const cards = [...document.querySelectorAll("div")].filter(
    (d) => d.style.borderRadius === "7px" && d.style.width
  );
  const handRow = cards.length
    ? cards[cards.length - 1].parentElement?.parentElement?.getBoundingClientRect()
    : null;

  const header = document.querySelector('div[style*="border-bottom"]')?.getBoundingClientRect();

  return JSON.stringify(
    {
      viewport: [innerWidth, innerHeight],
      headerHeight: header ? round(header.height) : null,
      feltHeight: felt ? round(felt.height) : null,
      // Seat positions are percentages of this, so two screens can share the
      // felt component exactly and still report different seat pixels. Without
      // the width the diff is unreadable: solo insets the felt 6px a side
      // (363), multiplayer runs it full-bleed (375), and that alone accounts
      // for 73/206/7/272 vs 75/216/8/284.
      feltWidth: felt ? round(felt.width) : null,
      feltTop: felt ? round(felt.y) : null,
      seats,
      trickCards: trick,
      hand: {
        count: cards.length,
        cardWidth: cards[0] ? round(cards[0].getBoundingClientRect().width) : null,
        rowHeight: handRow ? round(handRow.height) : null,
        overflow: handRow
          ? round(cards[cards.length - 1].getBoundingClientRect().right - handRow.right)
          : null,
      },
      docOverflowX: document.documentElement.scrollWidth - innerWidth,
    },
    null,
    1
  );
})();
