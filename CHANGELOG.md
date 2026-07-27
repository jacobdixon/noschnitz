# Changelog

All notable changes to this project are logged here, newest first. Versions
follow [semver](https://semver.org/) loosely: MAJOR for breaking rule/UI
changes, MINOR for new features or AI behavior changes, PATCH for small
fixes/tweaks. The version shown in the app (bottom of the top info strip)
corresponds to the entries below.

## [0.11.2] - 2026-07-27
- The buried pair in the recap is shown as rank-and-suit glyphs rather than two
  card faces — the same shorthand the grid below already uses.
  - 0.11.0 rendered them as full cards, which made the two cards nobody played
    the largest thing on a screen whose subject is the 30 cards that were. The
    whole recap now reads in one visual language.
  - The buried row goes from 132px to 18px, which pulls the trick grid back up
    into view without scrolling on a phone.
  - Verified at 375px on a finished hand: renders "BURIED A♥ 10♣", red suits in
    the same red the grid uses, no card elements left in the row, no page
    overflow. (`PENDING`)

## [0.11.1] - 2026-07-27
- The recap grid labels its columns once: "TRICK" now sits in the name column
  as a row header, and each heading is just its number.
  - Repeating the word six times spent width in the one place the grid is
    tightest. At 375px every heading wrapped onto two lines, so the header row
    was twice as tall as it needed to be and the numbers — the part you
    actually read — were the smaller half of each cell.
  - Numbers move to 12px semibold now that they stand alone; "TRICK" keeps the
    11px uppercase treatment the headings had.
  - Measured at 375px with a finished hand: the header row is a single 23px
    line, all seven cells one line each, table 318px inside a 318px scroller —
    no sideways scroll on the grid and no page overflow. (`c9ed246`)

## [0.11.0] - 2026-07-27
- The recap now opens with the hand-end summary — who won, the label, and the
  points both ways — instead of just the word "Recap", and shows the two
  buried cards in place of the old "(N buried)" count.
  - The buried pair is the one part of a hand nobody at the table ever gets to
    see. A count of their points was the least interesting thing about them;
    the recap is the only screen that can actually show them, so it does, as
    real cards rather than text.
  - The summary sits inside the shared-screenshot region, which the trick grid
    alone never did. A recap gets shared to argue about a hand, and the grid on
    its own doesn't say who won or by how much — so the image now carries the
    result with it. The Share button stays outside the capture, confirmed by
    reading the captured element's text.
  - "Hand N" and Share keep the top row; the summary and grid sit below.
  - Verified in the browser at 375px on a finished hand: header, points line,
    both buried cards, the six-trick grid and the legend all render inside the
    capture region with no horizontal overflow. (`4413ec0`)

## [0.10.1] - 2026-07-27
- The 90-point result now reads "No Schneider!" rather than "Schneider!" — the
  losing side failed to get out of schneider, so that's what it should say.
  Applies to both sides of the same event: picker team held to 30 or less, or
  defenders held to 30 or less.
  - The label is produced in `scoreHand`, so this is one string in the engine
    rather than a patch at the render site. `simulate.mjs` compared against the
    old label with exact equality to count its schneider rate, and was updated
    with it — left alone it would have silently reported 0.0% and quietly
    broken one of the three metrics used to judge every AI change.
  - Verified on constructed scoring positions: picker team 95/defenders 25 and
    defenders 95/picker team 25 both label "No Schneider!" at 2x, an ordinary
    70-50 win stays unlabelled at 1x, and a no-tricker still reads
    "No-tricker!" at 3x. Simulated schneider rate holds at 23.6% across 50,000
    hands, unchanged from before the rename.
  - Layout-neutral at 375px. The heading already wrapped to two lines for every
    labelled outcome before this change; measured against the modal's 299px
    inner width, all five strings still render at two lines and 55px with no
    horizontal overflow. (`5c9ac72`)

## [0.10.0] - 2026-07-27
- Each opponent's seat now shows their running score instead of how many cards
  they're holding — green when they're up, red when they're down.
  - The card count was dead weight: everyone still in the hand holds exactly as
    many cards as you do, so it only ever repeated what your own hand already
    told you. Where each player stands in the match is the thing you actually
    glance up for, and it previously meant opening the Scores modal mid-hand.
  - Score colours are a new pair in the theme rather than a reuse of the
    existing `red`/`brass`: `red` is tuned for card pips on a cream card face
    and goes muddy on dark felt. Zero is neutral cream, not green — nobody is
    winning before a hand has been scored.
  - Trick count stays, and now reads "1 trick" rather than "1 tricks". That
    was a pre-existing wart, fixed here because it sits in the same span.
  - Verified in the browser across a scored hand: +4 and +2 render green
    (`#5BBE72`), -2 red (`#E0685C`), 0 neutral cream. At 375px the strip adds
    no horizontal overflow — the widest seat text measures 63px inside the
    84px seat column. (`ad67d4b`)

## [0.9.1] - 2026-07-27
- The table no longer lurches when you play your last card. The hand fan holds
  its height whether or not it has cards in it, so the layout stays exactly as
  it was with cards in front of you.
  - The fan reserved no height of its own, and the table above it is
    `flex: 1 1 auto`. Playing the sixth card emptied the fan and handed the
    table 91px, so every seat and every card of the final trick jumped — right
    at the moment you're watching the last trick resolve, and just before the
    hand-end modal covers it.
  - 91px because a `Card` is content-box: the declared 80px height plus 2x4
    padding and 2x1.5 border. Pulled out as `CARD_ROW_H` next to the component
    that defines those numbers, rather than left as a magic constant.
  - Measured in the browser across a full auto-played hand. Before: the table
    area held 661px for six cards down to one, then jumped to 752px at zero.
    After: 661px at every card count including zero — one distinct value for
    the whole hand.
  - Also settles a smaller 8px shift nobody had reported, between the burying
    fan (8 cards at 0.9 scale, 83px) and normal play (91px). Both now measure
    101px including the row's padding. (`c6460fa`)

## [0.9.0] - 2026-07-27
- Defenders now gang up on a lone picker properly. Against someone who went
  alone, the AI defenders were refusing to schmear on the opening trick, so the
  loner got a free run at the trick that most often sets up the hand.
  - Root cause was the guard added in 0.8.0, which stops a defender paying
    points to a "teammate" who might turn out to be the picker's hidden partner.
    It keyed off `partnerRevealed`, and when the picker goes alone there is no
    called ace, so nothing ever reveals and the flag stays false all hand. The
    guard was written for uncertainty, but an alone hand is the one case with
    none: going alone is declared at pick time and shown all hand
    ("Picker · Alone"), so every defender knows the other three seats are
    teammates from the first card. Certainty now also comes from there being no
    partner to be wrong about, not only from the ace having fallen.
  - Measured over 5x200,000 simulated hands before and after. In alone hands the
    picker's win rate drops 68.2-69.1% -> 67.4-67.8%; ranges don't overlap, so
    it's a real shift rather than run-to-run noise. Partnered hands are
    untouched (61.7-62.0% -> 61.9-62.1%, overlapping), which is the intended
    blast radius and doubles as a control on the measurement.
- Also measured and deliberately *not* changed: the same guard leaves defenders
  free to schmear speculatively in partnered hands from trick 2 onward, where
  they may hand points to the picker's hidden partner. Extending the guard
  across the whole pre-reveal window looks like the same fix, and costs about
  0.8pp: partnered picker win rate goes 61.7-62.0% -> 62.4-62.8%, again
  non-overlapping. With the picker excluded, an unrevealed winner is a fellow
  defender two times in three and the partner only one in three, and an Ace held
  back gets trumped later often enough that pooling it beats hoarding it. The
  rejected variant is asserted in the test suite so it doesn't get "fixed" later.
- `npm test` grows to 21 assertions. Against the old engine exactly one fails —
  the opening-trick loner case — with the other 20 passing, so the new
  behaviour is pinned and the guards are confirmed to be guards. (`162ba87`)

## [0.8.0] - 2026-07-26
- AI now protects its trump power instead of throwing Queens away as schmear.
  Reported from a real hand: with a Jack led and Q-clubs already down and
  unbeatable, both Gus and Bunny threw Queens while holding lower trump.
  - Root cause: the schmear branch sorted every legal card by card points,
    highest first. When trump is led every legal card is trump, and among trump
    the highest-point card is a Queen (3) ahead of a Jack (2) — so the AI was
    giving up the strongest card in the game for one extra point. It wasn't
    valuing the Queen at all; it was counting pips.
  - A schmear is now paid in fail points only. Trump takes later tricks and no
    schmear is worth the trick a trump could win, so trump is never schmear
    material. When nothing is worth paying, the AI gets out of the way with its
    cheapest card by points — which makes a Queen the last trump it will ever
    part with — rather than falling through to the winning logic and overtaking
    its own teammate.
  - Also stops speculative schmearing on the opening trick. Before the called
    ace falls a defender's "teammate" is a guess, and the seat winning may well
    be the picker's partner; paying points to the wrong side is worse than
    holding on. Only fires now when the partnership is actually known.
  - Measured over 3x20,000 simulated hands before and after. Picker win rate
    63.1-63.6% -> 64.0-64.6%, schneider rate 21.8-22.3% -> 24.3-24.4%, avg
    picker-team points 70.8-71.1 -> 71.7-71.9. Ranges don't overlap, so it's a
    real shift rather than run-to-run noise. Pick and alone rates unchanged, as
    expected — nothing here touches the picking decision.
  - Adds `npm run aiskilltest` (also `npm test`): 13 assertions on constructed
    positions, including the reported hand replayed in true play order.
    Aggregate simulation can't catch this class of bug — a wasted Queen costs a
    few points against far larger run-to-run noise — so the behaviours players
    actually notice are asserted directly. Against the old engine 7 of them
    fail. (`aea4269`)

## [0.7.4] - 2026-07-25
- Recap modal now marks who picked and who was the partner, with `Picker` /
  `Partner` badges under the player names in the grid — the same badges the
  hand-end summary already uses, so the two modals speak one language.
  Reviewing a hand without knowing which team each player was on made the
  trick-by-trick grid much harder to read, and it's the piece most missed
  when a recap gets shared out of context.
  - The picker also gets a secondary (non-gold) `Alone` badge when they went
    alone, so an absent partner reads as "there wasn't one" rather than
    looking like the marker failed to render.
  - Badges stack under the name and use a new `compact` variant of `Badge`
    (9px, tighter tracking and padding). At full size the `Partner` badge
    widened the name column enough to push Trick 6 off-screen at 375px —
    measured 7px of overflow; compact brings it to 0.
  - Verified by playing a full hand in the browser at mobile (375px) and
    desktop widths, including temporarily forcing the alone case to check
    that layout. (`ae4b7ff`)

## [0.7.3] - 2026-07-25
- Added a Share button (industry-standard share icon) to the Recap modal so
  testers can send back hands they think the AI misplayed. Captures a
  screenshot of the recap grid (hand number, trick-by-trick grid, and the
  best/worst-play legend) and hands it to the OS share sheet via
  `navigator.share`, so it goes straight into Messages/Mail/etc. as an
  image.
  - Screenshotting uses `html2canvas`, loaded lazily from a CDN only when
    Share is tapped, so it doesn't add to the bundle for everyone else.
  - Falls back to `navigator.share` without the file if file-sharing isn't
    supported, and to a plain image download if `navigator.share` isn't
    available at all (e.g. most desktop browsers) -- the tester still ends
    up with the PNG either way.
  - Verified with a clean production build; bundle size essentially
    unchanged (172.76 kB) since html2canvas isn't bundled. (`3111138`)

## [0.7.2] - 2026-07-24
- Recap grid now flags the single best play (`!`) and single worst play
  (`?`) of the hand, chess-style, no explanation shown — just the glyph
  next to the card.
  - engine.js: added `rolloutValue(g)`, a deterministic single-path
    playout to hand-end using the built-in AI (`aiChooseCard`) for every
    remaining decision on both sides. Since `aiChooseCard` already
    switches to the exact minimax solver for the last two tricks, that
    precision folds automatically into the rollout — one consistent
    yardstick across all six tricks instead of blending two separate
    scoring systems.
  - `gradeHandPlays(g)` replays a finished hand from `trickHistory`
    (reconstructing each player's post-bury starting hand from the cards
    they're recorded as having played), and at every real decision
    (skipping forced single-legal-card plays) compares the actual card's
    rollout value against every legal alternative, from the mover's own
    team's perspective. Worst play = biggest point cost vs. the best
    available option. Best play = a decision that matched the best
    option (cost 0) with the largest gap between the best and worst
    available options, so a genuinely correct, high-stakes read gets
    picked over a trivial no-brainer.
  - Verified across 284 completed simulated hands: no exceptions, every
    flagged card matches what was actually played, best and worst never
    point at the same cell, ~3ms/hand grading cost. (`52d2073`)

## [0.7.1] - 2026-07-24
- Redesigned the "Last Trick" modal from a text list to a mini table view:
  all 5 seats laid out like the live play area (avatar, name, card played),
  with a gold ring on the leader's avatar and a glow on the trick-winner's,
  matching how a trick reads during actual play. (`4cae13b`)

## [0.7.0] - 2026-07-24
- Added a "Recap" button to the hand-end summary modal. Opens a
  replacement modal (summary hides while it's open) with a grid: players
  down the left, one column per trick (1-6), each cell showing the card
  that player played. The leading player's cell gets a gold underline,
  the trick-winner's cell gets a shaded background — a quick way to
  scan the whole hand. Has its own "Deal next hand" button so you can
  skip straight from recap to the next deal.
  - engine.js: added `g.trickHistory`, accumulating every resolved
    trick (not just the last one) for the current hand, reset each
    `freshHand`.
  - Modal component now takes an optional `maxWidth` (recap uses 480
    instead of the default 380 to fit the 7-column grid), with
    horizontal scroll as a fallback on narrow phones.
  - Verified trickHistory across 500 simulated hands: exactly 6 tricks
    per hand, all 5 players present in each, and the flattened card
    list matches the existing card-counting log exactly. (`a532ce1`)

## [0.6.1] - 2026-07-24
- Added "Hand N" to the hand-end summary modal (small label above the
  win/lose headline), so hand count is visible right after each hand, not
  just in the Scores modal. (`1d0a570`)

## [0.6.0] - 2026-07-24
- Added a "Hand" score column to the hand-end summary table, between
  "Pts" (points taken this hand) and "Total" (running score). Shows each
  player's score change for just this hand (e.g. picker +4 on an alone
  schneider). `scoreHand()` in engine.js now returns `result.handDelta`,
  computed from the pre/post score arrays. Added column headers to the
  table since it's now 3 numeric columns wide. Verified across 500
  simulated hands that every hand's deltas sum to zero and match the
  cumulative total on hand 1. (`d75f8a0`)

## [0.5.5] - 2026-07-24
- Shortened "Picker team wins" to "Pickers win" in the hand-end modal
  headline, to leave more horizontal room for the "— Schneider!" /
  "— No-tricker!" suffix on the same line. (`e54a970`)

## [0.5.4] - 2026-07-24
- Switched called-suit text to the classic icon + label pattern: "Called: A
  Clubs" -> "Called: ♣ Clubs" in the contract strip, "Call Ace of Clubs" ->
  "Call ♣ Clubs" on the call-phase buttons. Dropped "Ace of" since it's
  redundant while calling an ace is the only option (revisit if a
  call-a-ten rule gets added later). (`e9d81cd`)

## [0.5.3] - 2026-07-24
- Renamed two AI opponents to lean into the Wisconsin theme: Lorraine ->
  Bunny, Werner -> Duane. Both 5 characters, no avatar-initial collisions
  with You/Gus/Patty. (`ab8c259`)

## [0.5.2] - 2026-07-24
- Called-suit text now spells out the suit name instead of showing the
  symbol — "Called: Ace of Clubs" instead of "Called: A♣" in the contract
  strip, and "Call Ace of Clubs" instead of "Call A♣" on the call-phase
  buttons. Directly addresses the clubs/spades confusion; card faces
  themselves still use symbols. (`cc1361d`)

## [0.5.1] - 2026-07-24
- Fixed the contract strip wrapping onto two lines at the new font size:
  dropped "Hand N" from it (moved into the Scores modal instead) and moved
  the version badge up into the header row, centered between the
  SHEEPSHEAD title and the Trump/Scores buttons. The play-area header is
  now just "Dealer: X · Y picked · Called: A#" (plus "· Alone" when it
  applies), full width, one line. (`8a240a6`)

## [0.5.0] - 2026-07-24
- Added a "Last Trick" feature: the tricks/score text in the bottom-right of
  the hand area is now a button (styled like "Scores") that opens a modal
  listing the previous trick's cards by player, in the order they were
  played (leader first), with "led"/"won" tags and points taken. (`9c442a7`)

## [0.4.2] - 2026-07-24
- Bumped font sizes ~20% across the board (card ranks/suits, seat labels,
  status text, modals, buttons) for readability — feedback flagged clubs
  and spades as hard to tell apart at the old sizes. Card dimensions and
  the overall layout footprint are unchanged; a little padding was trimmed
  in the header/status areas to offset the larger text so the table area
  doesn't get cramped. (`7464f12`)
- Simplified the version badge to just `vX.Y.Z` (dropped the trailing
  commit-hash suffix, which had hex letters in it). Removed the now-unused
  git-hash injection from `vite.config.js`. (`7464f12`)

## [0.4.1] - 2026-07-24
- Fixed the leftmost card getting clipped off-screen during the bury phase
  (8 cards held) on narrower phones — confirmed via a real Pixel 9
  screenshot. The hand fan now shrinks ~10% (card size + overlap) whenever
  more than 6 cards are held; normal 6-card play is unaffected. (`83ac79f`)

## [0.4.0] - 2026-07-24
- Added a discreet version/commit badge to the UI (`v0.4.0·6b7ef41` style) so
  tester screenshots carry an exact build stamp. (`6b7ef41`)

## [0.3.1] - 2026-07-24
- Lengthened the post-trick pause from 1.5s to 2.625s (+75%) so there's more
  time to read the completed trick before it clears. (`5a34fe6`)

## [0.3.0] - 2026-07-24
AI overhaul — six targeted improvements, each tuned and verified against a
new headless simulation harness (`npm run simulate`) before shipping:
- Extracted game logic into `src/engine.js` and added
  `scripts/simulate.mjs`, which plays thousands of all-AI hands and reports
  pick rate, picker win rate, alone rate, schneider/no-tricker rate, and
  average points — the regression check used for everything below.
  (`02325bb`)
- Card-counting: track every played card so the AI can reason about what's
  still unaccounted for. (`3b4710e`)
- Trump-aware leading: run a suit safely when holding all remaining trump,
  press when opponents are nearly out of trump, instead of a fixed
  "3+ trumps or a queen" rule. (`27d1fae`)
- Defenders now lead a short called-suit holding to flush out the picker's
  partner early, instead of only passively avoiding that suit. (`1f72ed1`)
- Loosened schmear conditions so points get fed to a winning teammate more
  often instead of only on the literal last card of a trick. (`d5becab`)
- Exact minimax solve for the last two tricks, where the remaining game
  tree is small enough to brute-force optimal play instead of leaning on
  heuristics right when hands are usually decided. (`f056950`)
- Deliberate "go alone" for exceptional hands (handStrength >= 17), tuned
  empirically: alone rate rose from ~25% to ~30% at equal or better
  win rate/EV per hand (confirmed at n=20,000 simulated hands). (`68d3361`)

## [0.2.0] - 2026-07-24
- Fixed mobile layout: the app now locks to the real viewport height
  (`100dvh`, overflow hidden) instead of `min-height: 100vh`, so the hand no
  longer requires scrolling to see on phones. Added safe-area padding for
  notched devices. (`b79b9ea`)
- Ignored stray Vite temp config files. (`f9c9a4c`)

## [0.1.0] - 2026-07-24
- Initial version: Sheepshead (5-handed, call-an-ace variant) built with
  React + Vite, playable against four AI opponents. (`6d1a60d`)
