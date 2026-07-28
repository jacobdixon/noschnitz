# Changelog

All notable changes to this project are logged here, newest first. Versions
follow [semver](https://semver.org/) loosely: MAJOR for breaking rule/UI
changes, MINOR for new features or AI behavior changes, PATCH for small
fixes/tweaks. The version shown in the app (bottom of the top info strip)
corresponds to the entries below.

## [0.20.0] - 2026-07-28 (`eafab0b`)
- **The picker's side now leads trump whenever it holds any**, instead of only
  with three or more. Worth **+0.019/seat/hand, ahead in 5 of 5 seeds**
  (20,000 hands per split, z 8.5-11.9), measured with `npm run abtest`.
  - The old bar was `trumps.length >= 3` — "real depth" — and depth was the
    wrong quantity. Pulling trump works because the defenders must *follow* it:
    even a trump that cannot win the trick still strips two trump from the
    defense and shortens the suit protecting their fail points. Three low
    diamonds bleed as well as three Queens; they simply don't win while doing
    it. The conventional wisdom — partner leads trump — turns out to hold
    further down into weak holdings than the engine believed.
  - **Every attempt to tighten the gate measured worse, monotonically.**
    Requiring 4+ trump costs 0.019/seat/hand; deleting the rule outright costs
    0.035; gating on the top trump's `cardEquity` costs between 0.008 and 0.034
    depending on threshold. This was originally investigated on the *suspicion*
    that the gate was too loose — that a hand of 9-8-7 of diamonds would lead
    into eleven higher trumps. It does, and it should.
  - **Which trump to lead is a separate question from whether to lead one.**
    Lead the top trump when it can plausibly hold the trick (a Queen or Jack, or
    at most one unaccounted-for card beats it); otherwise the lead is purely a
    bleed and shouldn't also donate points, so the weakest goes instead. Worth
    +0.019 against +0.012 for always leading the top trump and +0.007 for
    always leading the weakest.
  - **Side effect, measured and kept:** the picker's "call for the ace" lead is
    now reachable only with a hand of pure fail. A version that kept it
    available while holding trump measured worse on every seed
    (+0.013/+0.017/+0.015 against +0.016/+0.020/+0.019).
  - Note this branch is picker-side only, so it widens the AI's picker/defender
    asymmetry: in self-play the picker win rate moves 63.4% -> 65.4% and average
    picker-team points 70.6 -> 72.0. Defending against the AI is now harder.

## [0.19.0] - 2026-07-28 (`3bcb4a3`)
- **The AI now always takes a trick with the cheapest card that wins it.** The
  "secure with strength" rule — reach for the strongest winner when the trick is
  fat (10+ points) or late (trick 4+) — is deleted outright rather than refined.
  Worth **+0.089/seat/hand, ahead in 5 of 5 seeds** (20,000 hands per split,
  z ~ 19). For scale, 0.18.0 was +0.013 on the identical harness, so this is
  roughly seven times that gain and the largest single play change to date.
  - The premise of the old rule was wrong. A trick won by one rank scores
    exactly what a trick won by eight scores, and the surplus rank is a later
    trick you no longer win. There is essentially nothing for "reach for
    strength" to buy, so no amount of tuning around it could pay.
  - 0.18.0 softened the same rule with a sufficiency filter instead of removing
    it, which is why it measured as a real but small win at the time. It was
    mitigating a bad heuristic, not fixing one.
  - **Reported from a real hand** (v0.18.0, hand 1): with a fail club led, the
    picker held Q-clubs Q-hearts J-spades J-hearts and took a 13-point trick
    with Q-hearts where J-hearts took the identical 13. The sufficiency filter
    could not certify the Jack, because `trickSecurity` counts beaters the one
    seat left to act could not legally play — that seat was following a fail
    suit and could not trump in — so the code fell through to strength and
    burned a Queen for nothing.
  - **A plausible-sounding fix measured worse and was discarded.** Making the
    sufficiency test legality-aware by pricing the security gain the way the
    overtake branch does lands between -0.005/seat/hand (tight threshold, and
    significantly *negative*) and +0.016 (loose threshold) — the whole curve is
    dominated by simply playing the cheapest winner. Recorded so the idea isn't
    retried: the conservatism in `trickSecurity` is not the problem, the rule
    consuming it was.
  - `lastToPlay` and `trickPts` are gone from `aiChooseCard`; both existed only
    to gate the deleted branch, and the last-to-play case now falls out of the
    general rule for free.

## [0.18.0] - 2026-07-28
- Once the AI is winning a trick, it takes it with the cheapest card that is
  actually sufficient rather than the strongest card it holds. Item 2 of the
  play brief, and its second-largest single error at 24 points: the picker took
  a trick with Q-clubs where Q-hearts took the identical 18 — the one seat left
  held no Queen at all — then, boss gone, led Q-hearts into a live Q-spades and
  lost 15 more. Same shape in a second hand, Q-clubs where J-diamonds sufficed.
  - "Try to secure with strength" was right about *when* (a fat trick, or late
    in the hand) and wrong about *what*. When a provably sufficient winner
    exists, anything stronger buys nothing and spends a card that wins a later
    trick. When none exists, strength really is the best of the options left, so
    that branch stays exactly as it was.
  - **Two wrong versions preceded this one, both caught by measurement, both
    worth recording.** The first applied the filter before the fat-trick test
    and so also hit the branch that already played the *cheapest* winner.
    `sufficient` is `winners` with the weak cards removed, so taking the
    cheapest of it there plays a *stronger* card than before — the rule
    silently inverted. That cost **0.045/seat/hand** and read exactly like the
    brief's idea failing.
  - The second replaced `securityAfterPlay` with a stricter test — nothing
    outstanding beats this card at all, whoever holds it — on the theory that
    `opponentsYetToAct` is too loose because knowsTeammate() calls every
    unrevealed seat a teammate. That reasoning is wrong here, and the
    measurement said so: strict came in at **-0.002/seat/hand, ahead in 2 of 5
    splits**, i.e. indistinguishable from making no change. The exclusion is the
    point. If a seat we take for a teammate overtakes our cheap winner the trick
    stays with our side and nothing was wasted, so refusing to certify those
    cases just burns the boss card for nothing.
  - **Measured head to head, 200,000 hands per split, three replicates.** The
    shipped version is **+0.008 to +0.013 per seat per hand, ahead in 19 of 20
    splits.** Small — it fires only when a provably sufficient winner exists in
    a fat or late trick — but consistent in sign across every replicate.
    Cumulative against 0.16.4, items 1 through 3 together: **+0.033/seat/hand,
    ahead in 5 of 5.**
  - `npm run aiskilltest` grows to 48 assertions. The new position fails against
    0.17.0 and passes here. (`baa9270`)
- The bump-multiplier recalibration flagged in 0.17.0 is still open and this
  moves the same direction, since the change again helps whoever holds it and
  the defenders outnumber the picker. Still deliberately untouched.

## [0.17.0] - 2026-07-28
- The AI stops shedding by card points alone. Six hands were reconstructed
  card-for-card from result screens and every decision solved double dummy;
  nearly every large error traced to one question the engine never asked —
  *which of these cards can still win a later trick, and whose trick am I
  shedding into.* Both halves of that turn out to be the same computation, so
  they land together.
  - **Equity classes.** Legal cards are bucketed by how many unaccounted-for
    cards can still beat them, and points are allocated only *inside* the
    weakest bucket, never across buckets. A bare minimum-points shed gets this
    exactly backwards whenever the cheap card is the valuable one: reported from
    a hand where a defender under an unbeatable Queen held J-spades — with both
    higher Queens just played, provably the highest trump left — and threw it to
    keep a dead A-diamonds. Two tricks later the picker swept 44 on a trick
    J-spades wins outright. Ranking by points saw a 2 and an 11; ranking by
    class sees a boss card and a dead one.
  - **Ownership survives the control flow.** `mateWinning` was already computed
    and already correct — it just didn't reach the code that needed it. A seat
    whose own side held the trick, holding nothing able to overtake, with the
    trick below the schmear-confidence bar, fell out of the teammate branch
    entirely and landed in the generic can't-win shed, which minimises points.
    So it donated its *cheapest* card to a trick its own side was taking. The
    ownership signal is hoisted above the branch and carried into every shed
    path, which is a plumbing fix rather than a new input.
  - **`trickSecurity` read as a direction, not a gate.** The sign of a shed is
    just "is our side more likely than not to still hold this at the end", which
    breaks even at one half. `SCHMEAR_CONFIDENCE` stays at 0.85 and keeps its
    own job: schmearing is *choosing* to spend a valuable card and its error is
    asymmetric, so it wants confidence well above even money. Shedding is
    forced — a card is going regardless — so the honest breakeven is different.
    One number, read two ways, which is what lets both branches share one
    function.
  - **Overtaking your own side's trick is now priced, not gated.** A flat
    threshold is cleared most easily by exactly the card it is most expensive to
    spend: whoever holds the boss trump can always take the trick's security to
    1.0. Reported from a real hand — a defender's Q-hearts already owned trick 1
    and their partner over-trumped with Q-clubs, the boss card of the game, on a
    trick their own side already had, letting a lone picker out for 7-diamonds.
    The old gate permitted it *because* Q-clubs was unbeatable. The bar now
    scales with the card's own equity: unbeatable pays 4x, near-boss 2x. It
    stays a price and not a prohibition, since holding the lead is sometimes the
    whole plan — the existing "still overtakes when it converts the trick to a
    certainty" assertion passes unchanged.
  - **The picker counts their own burial.** Every "what could still beat this"
    question resolves through one `unaccountedFor()` list, and the picker knows
    two cards nobody else does. On its own this is worth nothing measurable
    (+0.0004/seat/hand, ahead in 3 of 5 splits — inside the noise) and it is
    kept because it is information the seat genuinely has and it sharpens the
    "provably boss" judgements the class rule depends on, not because the
    aggregate could see it.
  - **Measured head to head, old policy against new, assigned per seat.** The
    game is zero-sum across five seats, so the new-policy seats' average score
    *is* the effect size — no comparing two separately-run populations. At
    100,000 hands per split across seven different seat splits the new policy is
    ahead in **7 of 7**, by +0.018 to +0.032 points per seat per hand. Layered:
    ownership + equity carries +0.016, the overtake price adds the rest.
    Picking and the last two tricks are identical in both engines (untouched
    `aiBuryAndCall`, same exact endgame solver), so this isolates tricks 1-4.
  - **Both sides get it, and the defenders gain more.** Self-play over 3x100,000
    hands: picker win rate **61.5-61.8% -> 60.8-60.9%**, schneider rate
    23.0% -> 21.9%, no-tricker rate 7.2% -> 5.2%, avg picker-team points
    70.2 -> 69.0. Ranges don't overlap. That direction is expected — two of the
    three reported symptoms are defender plays, and there are four defenders.
  - **This opens a calibration question it does not close.** 0.14.0 set the bump
    multiplier so picking sits near neutral, and at 200,000 hands picker EV has
    moved from **+0.22 alone / +0.03 partnered to -0.11 / -0.06**. Picking is now
    slightly negative rather than slightly positive. That wants the bump
    multiplier re-derived and the `handStrength >= 10` pick threshold re-swept —
    deliberately left alone here so the play change is measured on its own.
  - `npm run aiskilltest` grows to 45 assertions with three positions isolating
    the symptoms above. Four of the new behavioural assertions fail against the
    previous engine and pass against this one. (`8f3a7f7`)
- Strips six committed merge-conflict markers out of `CHANGELOG.md`, left behind
  when the 0.16.2-0.16.4 entries landed. No entry text changed. (`6528232`)

## [0.16.4] - 2026-07-27
- The header moves into `src/header.jsx`: title, build stamp, house-rules line,
  doubler badge and the menu. No visual or behavioural change — the second half
  of the same groundwork as 0.16.3.
  - `rules` arrives as a prop, which is the point of doing this separately from
    the felt. Solo's rules are a module constant so every player necessarily
    agrees; at a table they have to be state, because everyone sitting down has
    to be playing the same game. Threading that through afterwards would mean
    touching this markup twice.
  - Menu entries are passed as data rather than rendered fixed, because that is
    where the two halves genuinely differ — a table adds Invite and later a
    profile. Nothing conditional lives in the header; it never learns what a
    "host" is.
  - Verified behaviour-identical by measurement against the unextracted build:
    same header text, same 61px height, same menu items, no overflow. The
    doubler branch was exercised separately by forcing a stake — badge renders,
    header wraps to 84px as designed. `Sheepshead.jsx` drops to 587 lines,
    from 800 before this pair of extractions. (`de15a0b`)

## [0.16.3] - 2026-07-27
- The felt moves into `src/felt.jsx`: seat ring, played trick, trick-winner
  banner, blind marker and hand fan. No visual or behavioural change — this is
  groundwork so the multiplayer table renders from these components instead of
  a second copy that drifts, which is what happened over the past week.
  - Two props carry everything that differs between the halves: `names` (solo
    passes its fixed cast, a table passes whoever sat down) and `mySeat` (solo
    is always 0; at a table you get whichever seat was free and still expect to
    be at the bottom of your own screen). At `mySeat` 0 the rotation is the
    identity, so solo renders exactly as before.
  - `rules` deliberately stays out: the house-rules line and the doubler chip
    both live in the header, so that prop belongs to the header extraction.
  - Nothing in the felt reads another player's hand — seat lines show score and
    trick count, not cards held — which is what lets a table feed it a view
    where the other four hands are absent.
  - Verified behaviour-identical by measuring the rendered result against
    unmodified master rather than by inspection. `Sheepshead.jsx` drops from
    800 to 676 lines. (`848c7d4`)

## [0.16.2] - 2026-07-27
- "Play with friends" moved into the menu, alongside Trump order and Scores.
  It had been sitting beside Last Trick since the menu didn't exist yet — the
  header couldn't fit a third button without clipping the title. The menu is
  the proper answer to that, so the hand row is back to carrying one control.
  - Only rendered when a host supplies the handler, so the solo game keeps no
    dependency on the networked half and still works with no server at all.
  - Labelled for what it does today: it starts a fresh table, leaving the hand
    in progress behind. Once a table can be seeded with the running score this
    becomes "Invite others" and the game carries over instead. (`cb0130f`)

## [0.16.1] - 2026-07-27
- Shared presentational pieces move into `src/ui.jsx`, matching the multiplayer
  branch. No behaviour change to the solo game beyond the two mobile fixes noted
  below; this is groundwork for bringing the two versions together.
  - The two branches had been fighting over one file. `v2` was +27 commits, but
    almost all of it is additive — 22 new files that can't collide. Measured
    against the merge base, `v2`'s own changes to `Sheepshead.jsx` were
    **+19 / -121**, and the -121 was entirely lifting `felt`, `Card`, `Badge`,
    `Modal` and the button styles into `ui.jsx`. It had made essentially no
    behavioural change to the solo screen. `engine.js` was +57 with zero
    deletions, which is why engine merges have always resolved themselves and
    only `Sheepshead.jsx` ever conflicted.
  - So the whole merge tax came from one structural refactor that master didn't
    have. Master now has it, byte-identical.
  - Measured with a trial merge into `v2` before and after: the conflict in
    `Sheepshead.jsx` goes from **one 85-line hunk to two hunks totalling 12
    lines** — and changes character, from "reconcile a refactor" to "master
    added a constant, keep it". Getting from 25 lines to 12 meant adopting
    `v2`'s exact comment text and blank lines where the two files overlap;
    divergence there is divergence, even when it's only prose.
  - It does not reach zero, and can't while `v2` is four commits behind: master
    keeps adding content next to a region `v2` also edited. Once `v2` takes this
    merge, both sides share the structure and later solo changes land in
    disjoint regions.
  - `Sheepshead.jsx` also gains the optional `onPlayWithFriends` prop and its
    Friends button. Inert here — nothing passes it — but present so the file
    matches its counterpart rather than differing by a feature.
  - Carries across two mobile fixes that only existed on `v2`: `touchAction:
    "manipulation"` on cards, removing the ~300ms double-tap delay browsers add
    to undeclared touch targets, and `WebkitTouchCallout: "none"`, which stops
    the "save image" callout firing when a thumb rests on a card.
  - Bundle 56.48 -> 56.54 kB gzipped, which is the two touch properties and the
    unused button. `npm test` 75/75 unchanged. (`8a9663d`)

## [0.16.0] - 2026-07-27
- The play-area header is gone, and everything it carried moved to the thing it
  describes.
  - The dealer wears a poker-style **D button** beside their avatar; seat 0 has
    no avatar on the table, so it sits in the YOUR HAND row instead. The called
    suit rides on the **picker's badge stack**, where it belongs — they chose
    it. "picked" and "alone" were already duplicated by those same badges, so
    the strip was restating three things and owning one.
  - That hands ~38px back to the table, which is the part of the screen you
    actually look at.
  - The Doubler badge moves up into the header, beside the house rules. It was
    briefly at the table's top centre, and that collides: the seats sit at 4% of
    the table's height, so on a 667px-tall phone they start at y=14 while the
    badge reaches y=19, overlapping two of them. There is no room between the
    two top seats either — that gap is ~50px and the badge is ~95px. In the
    header it is fixed chrome that cannot collide with anything the game draws,
    and it sits next to the rule that explains what doubling means. The row
    wraps rather than squeezing the rules line, since the two together need
    356px against a phone's 339 — and that height change is only safe because a
    doubler is set when the hand is dealt, never mid-hand.
- The recap now stamps **the build number inside the shared screenshot**:
  "Hand 3 · v0.16.0". That image is the format hands actually get reported in,
  and a reported hand is evidence about a specific AI build — without the
  version in the picture, "the AI misplayed this" can't be matched against what
  the AI was at the time. Hand number moved inside the capture region with it;
  only the Share button stays outside.
- Two long-standing wording bugs, both noticed in passing and held for this
  pass:
  - The status line said "You takes the trick" — seat 0 is named "You", and it
    was being interpolated into a third-person sentence.
  - The hand-end and recap headings said "Pickers win" even when the picker went
    alone, which is wrong on exactly the hands where the win is most impressive.
    Now "Picker wins". Both call sites fixed together.
- Verified in the browser at 375px: contract strip gone (the root is down to
  four children), table grew to 507px, exactly one dealer button renders, all
  four seat columns sit inside the table edge with no horizontal overflow, and
  the recap capture region contains the version while the Share button stays
  out of it. (`e21ef8c`)

## [0.15.0] - 2026-07-27
- The header now states the house rules, and the two buttons that lived up
  there have moved into a menu.
  - "Called Ace · No Leasters · Double on the Bump" sits under the title, above
    the rail, and stays there all game. Two of those three were already true and
    unstated; the third arrived in 0.14.0 and changes what a hand is worth, so
    it needed saying somewhere permanent rather than being discovered when a set
    picker paid double.
  - Held as a list rather than one sentence. The planned version of that line
    lets you change the rules, and a rule you can toggle has to be an
    addressable thing rather than a substring. It is deliberately *not* a button
    yet — a control that does nothing when pressed reads as broken, so it stays
    text until it has somewhere to go.
  - Trump and Scores become items under a hamburger. Two buttons was already
    most of the header's width, and the rules line needed room; the menu also
    gives the rules editor and anything after it a place to land that doesn't
    cost width. Menu closes on select and on any click outside, tracks
    `aria-expanded`, and its items carry `role="menuitem"`.
  - Verified in the browser at 375px and desktop: menu opens, selects, closes on
    outside click with no stray backdrop left behind, and sits inside the table
    edge (203-357px within a 375px root). The rules line measures 230px of text
    in 339px of space at phone width — one line, with room for a fourth rule.
    (`1ee2bb4`)

## [0.14.0] - 2026-07-27
- Two house scoring rules, both on by default: **double on the bump** and a
  **doubler after a passed-out hand**.
  - *Double on the bump* — a set picker pays twice. The reason it works out:
    the picking team wins about 61-62% of the hands it takes, which alone would
    argue for something milder, but it also wins them *bigger* than it loses
    them — average multiplier 1.49 winning against 1.17 losing, because it holds
    the blind and the burial. Feed that asymmetry in and the break-even win rate
    for picking lands at roughly 61%, right where the game actually runs.
  - Measured over 200,000 hands: picker EV falls from **+1.27 to +0.10** per
    picked hand overall (alone +2.04 -> +0.24, partnered +0.93 -> +0.04). What
    that buys isn't fairness between seats — the game was always zero-sum, and
    every seat picks about equally often. It's that at +1.27 picking was close
    to free, so loose picking paid about as well as good picking. At +0.10 it's
    a decision again.
  - The current AI pick threshold needs no retuning: swept it, and
    `handStrength >= 10` is the only setting where picking stays near neutral
    under the new rule (>= 11 goes back to +0.39, >= 12 to +0.71).
  - *Doubler* — nobody picks, the hand is thrown in, and the next one pays
    double. Stacks if it happens twice running, shown as `DOUBLER ×4` and so on.
    Carried on the game state rather than recomputed, since the hand that pays
    it isn't the hand that caused it.
  - Both stack with the existing multipliers, so a set no-schneider is 4x and a
    set no-tricker is 6x. Winning big is *not* doubled — the bump is a penalty
    on the picker, not a general multiplier.
  - Adds `npm run scoringtest` (folded into `npm test`): 38 assertions on
    constructed finished hands, kept in their own harness because "what is this
    hand worth" fails for entirely different reasons than "which card should the
    AI play". Every case also asserts the hand is zero-sum, which is the
    invariant most likely to break quietly if a stake is ever applied to one
    side only.
- Fixes a long-standing layout bug the Doubler badge exposed: the contract strip
  carried both `width: 100%` and 12px of horizontal padding under content-box
  sizing, making it 387px wide inside a 363px box. The root clips overflow, so
  the extra 24px was invisible for as long as nothing was right-aligned — the
  badge was the first thing to land in it, and rendered cut in half. (`0de4e84`)

## [0.13.0] - 2026-07-27
- Taking a trick off your own side now has to buy something. Reported from
  expert play: Gus picked, his partner Duane led Q-hearts, Gus overtook with
  Q-spades — and Bunny's Q-clubs took it anyway.
  - The number that settles it: from Gus's seat, Q-hearts and Q-spades were
    beaten by exactly the same one unaccounted-for card, Q-clubs. Q-spades was
    in his own hand, so it threatened nothing. Overtaking moved the trick from
    his partner's Queen onto his own better one without improving its odds by a
    single point — measured at 0.737 either way. Reaching the winners branch
    means "I can win", and the old code read that as "I should win".
  - `securityAfterPlay()` answers what the trick's security becomes if I play a
    given card. When a teammate is holding it, the AI now overtakes only if that
    difference clears `OVERTAKE_MIN_GAIN`; otherwise it lets the trick ride and
    sheds its weakest card. In the reported position Gus keeps both Queens and
    throws J-spades.
  - **The first version of this was a net loss and was scrapped.** Applied
    wherever `knowsTeammate()` was true, it cost defenders 0.6pp in partnered
    hands (picker win rate 62.0-62.2% -> 62.6-62.8%), and got worse the higher
    the threshold went. knowsTeammate() calls every unrevealed seat a teammate,
    so the brake was talking defenders out of taking tricks off the picker's
    hidden partner — the same 2:1 asymmetry that made speculative schmearing
    worth *keeping* in 0.9.0, pointing the other way. Gating it on the
    partnership actually being known reversed the result.
  - Measured over 3x200,000 hands with the gate in place. Picker win rate
    62.0-62.3% -> **61.4-61.5%** overall, and both halves improve on their own:
    alone 61.9-62.5% -> 61.4-61.5%, partnered 62.0-62.2% -> 61.4-61.5%. No
    range overlaps. Most of the partnered gain is post-reveal, where defenders
    stop spending power to overtake each other.
  - `OVERTAKE_MIN_GAIN` swept at 0.05 / 0.15 / 0.30 / 0.50. Set to 0.15: it
    wins on partnered hands, which are roughly 70% of picked hands, and on the
    overall rate. 0.30 is marginally better against loners and worse everywhere
    else.
  - `npm test` grows to 37 assertions, pinning the reported position from Gus's
    real hand (8S QS 7H QD JC JS) including the security-equality that makes the
    overtake pointless, plus a guard that the brake doesn't seize: with the top
    trump in hand and a coin-flip trick, it still takes it. Against the previous
    engine the two behavioural assertions fail. (`e1ca4e4`)

## [0.12.0] - 2026-07-27
- Schmearing is rebuilt around two questions the AI wasn't asking: *is this
  trick actually ours to win*, and *which card can I least afford to keep*.
  Reported from expert play — a loner led a trump, the trick was already
  unbeatable in a defender's hand, and Duane threw Q-diamonds while holding the
  10. "No points/power issue."
  - **Forced trump.** 0.8.0's "a schmear is paid in fail points only" was
    written for the free choice, where keeping trump beats paying with it. When
    trump is led there is no free choice — a trump is going regardless — and the
    old code fell through to "cheapest by card points", which is exactly
    backwards. Trump splits cleanly: Queens and Jacks are 3 and 2 points and all
    the power, while every point that lives in trump lives in the diamonds. So
    with no free choice the AI now spends the fattest diamond, which is better
    on both counts at once — seven more points banked AND the stronger card
    kept. Queens and Jacks are parted with only when they're all that's left,
    weakest first.
  - **Trick security.** The old safety test asked whether the winning card was
    a Jack or better. That's the wrong question: the danger isn't a card, it's a
    seat. `trickSecurity()` now returns the chance our side keeps the trick —
    certain when no opponent is left to act, certain when nothing unaccounted
    for beats the winner, and otherwise hypergeometric over the cards this seat
    can't see. Below `SCHMEAR_CONFIDENCE` the AI declines to pay in, which lets
    the two better options downstream fire on their own: overtake the teammate,
    or sit on the points and wait.
  - Measured over 3x200,000 hands. **Against a loner the picker's win rate falls
    67.4-67.6% -> 61.8-62.4%** — a 5.4pp swing, non-overlapping by a wide
    margin. The whole effect is defenders: a lone picker has no teammate, so the
    schmear branch never fires for them. Partnered hands are unchanged
    (61.9-62.1% -> 61.9-62.1%), which is the intended blast radius and doubles
    as a control. Schneider rate 23.5-23.7% -> 22.6%, as fewer loners run away
    with a hand.
  - `SCHMEAR_CONFIDENCE` is set on principle, not measurement: swept 0.50 to
    0.95 and the aggregate could not tell the values apart, every one landing
    inside the others' spread. Not because it's inert — 41.5% of security
    evaluations come back strictly between 0 and 1 — but because in most of
    those middle cases there's nothing pointy in hand and both branches play the
    same card. Set to 0.85 because the error is asymmetric: a bad schmear hands
    points to the picker, a missed one usually only defers them.
  - `npm test` grows to 31 assertions, including all three AI seats from the
    reported trick. Only Duane's play changes; Gus (holding two power trump,
    correctly shedding the Jack) and Bunny (shedding a worthless diamond over a
    Jack) were already right and are pinned so they stay that way. Against the
    old engine three behaviours fail. (`ea94790`)

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
    overflow. (`13a6ac2`)

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
