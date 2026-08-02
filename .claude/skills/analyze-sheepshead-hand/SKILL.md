---
name: analyze-sheepshead-hand
description: Analyzes a specific card play from a noschnitz Sheepshead hand-recap screenshot using Monte Carlo simulation, to judge whether it was a good decision given only what the player could actually see at the time (not full hindsight). Use this whenever the user attaches or references a screenshot of the app's hand recap (the trick-by-trick grid with TRICK 1-6 columns, PICKER/PARTNER badges, BURIED cards, and a final score split) and asks to analyze, debate, second-guess, or run the numbers on a specific play — even if they just say "what about the Jh play" or "was this the right card" without naming Monte Carlo, PIMC, or simulation explicitly. Also use it if they ask to re-run, rerun, or redo an analysis on an existing scenario file under scripts/scenarios/.
---

# Analyze a Sheepshead hand decision

Two tools in this repo grade a card play, and they answer different
questions:

- **`gradeAllPlays`/`solveHandValue`** (`src/engine.js`, wrapped by
  `scripts/gradedecision.mjs`) solve the hand with every card face up. They
  answer "given everything, was this a mistake" — the same exact solver the
  app's own recap screen uses for its `!`/`?` markings.
- **`scripts/pimc.mjs`** answers the harder, more honest question: "given
  only what this player could actually see at the time, was this a good
  decision?" It forgets the future and the other hands, samples plausible
  worlds consistent with what was public, and rolls each one forward with
  the AI's own play policy. This is a genuine Monte Carlo estimate (not
  exact), so it reports a standard error, not just a mean.

One seat isn't dealt uniformly at random, and the reason is worth
understanding before reading any number this produces. When the picker's
hand is being sampled (i.e. the decision-maker isn't the picker), two
things about that seat are not random at all, because a person made them
happen:

- **They chose to pick**, so the six cards dealt before the blind cleared
  the app's own bar (`PICK_STRENGTH` in `ai-runner.js`). Note the test
  belongs on the pre-blind six — `aiWantsToPick` reads the hand before
  `aiTakeBlind` merges the blind in — not on all eight, which is a
  strictly weaker bar.
- **They chose which two cards to bury**, keeping their trump and banking
  points. Splitting the eight at random instead buries about 1.3 trump a
  hand, which no player would ever do, and it cripples the picker for the
  remaining tricks. `aiBuryAndCall` is the engine's own answer, so PIMC
  calls it rather than approximating.

The picker's *identity* is never sampled, and neither is the partner's
once it is known — either because the decision-maker holds the called ace
themselves, or because it has already been played in front of everyone.
Only a genuinely unknown partner gets sampled, and even then the called
ace is placed only where the rules allow it: never with the picker, and
never in the bury, since `callOptions` treats a buried ace as held.

All of these were found by the check worth repeating whenever a number
looks wrong, and it is the single most valuable habit in this workflow:
**build a forward-simulation baseline from `simulate.mjs`-style fresh
deals, filtered to hands matching the position, and see whether it agrees
with PIMC.** It shares no code with the sampler, so when the two land on
the same number the model is doing its job, and when they don't there is
a real defect to find. On the reference hand PIMC gives 51.3 average /
30% win rate and the independent baseline gives 48.8 / 26.9% — agreement,
after three separate bugs the same check had already exposed.

That baseline also explains the objection this analysis will keep
provoking, which is worth having ready. A mean near 50 looks impossible
when the hand visibly ended 68 and a win. Filtering the baseline to a
picker as strong as the real one (strength 15+ rather than the 13.4 a
pick-worthy hand averages) moves it to 61.1 with a 51% win rate. Both
numbers are correct and they answer different questions: the low one is
what the seat should have expected, the high one is what a seat who could
see the picker's three Queens would expect. PIMC is deliberately the
former, so **report the win rate next to the mean** — people reason about
this game in wins, and a mean alone invites exactly this objection.

**Known contamination, and it matters for how you report a result.** The
rollout inherits a real bug in `heuristicCard`: when a teammate already
has the trick secured, the shed branch picks the lowest-*point* card,
which in a trump-heavy hand is a Queen. Measured on the reference hand,
the picker sheds a Queen or Jack 64.8% of the time after the partner
trumps in, against 7.3% when a defender still holds the trick. So any
candidate whose effect is to SECURE a trick for its own side is scored
too harshly. Until that is fixed, treat the gap between such a candidate
and its alternatives as an upper bound, and say so rather than reporting
the number flat.

These can disagree, and when they do it's not a bug — it's information. The
J♥ hand this skill was built from is the reference case: the exact solver
said the trick-2 trump-in was completely irrelevant (nobody else happened to
be holding a higher trump in the *true* deal), while PIMC said it scored
~1.5 points worse on average than banking a big card into a trick the team
was already very likely to win, because the player couldn't know in advance
that no one behind them held a Queen. Run both when you can — the contrast
is usually the most useful part of the answer.

## Step 1 — Transcribe the screenshot into a scenario file

Read the screenshot with the Read tool, then transcribe it into a file
under `scripts/scenarios/`, in the exact shape of
`scripts/scenarios/hand1-jh.mjs` (read that file first — it's the working
template, not just documentation of one).

A few things about the transcription that are easy to get subtly wrong:

- **Seat index = row position, top to bottom, 0-indexed.** Don't hardcode
  "You" as seat 0 from habit — derive it from wherever the rows actually
  fall in this screenshot, since a multiplayer recap can have any names in
  any order. Whatever row is on top is player 0 in every `[player, card]`
  pair and in `decision.player`.
- **Card notation is `rank + suit letter`**: `"10D"`, `"JH"`, `"QC"`, `"7S"`.
  Ranks: `A K Q J 10 9 8 7`. Suits: `C S H D`. This is exactly what
  `card()` (exported from `scripts/pimc.mjs`) parses.
- **`picker`** is the seat with the PICKER badge. **`buried`** are the two
  cards shown at the top of the recap.
- **`calledSuit` / `calledRank`** aren't printed as text in the recap grid —
  derive them. Find the PARTNER-badged seat (if the hand shows one) and look
  for the Ace of a plain suit (clubs/spades/hearts — never diamonds, those
  are always trump) among their played cards. That suit is `calledSuit`,
  its rank is `calledRank` (almost always `"A"`; only `"10"` if you have
  independent reason to believe the picker held all three fail aces and
  called a ten instead — don't guess this, ask the user if it's ambiguous).
  If there's no PARTNER badge at all, the picker went alone: `calledSuit:
  null`.
- **`calledUnder`** — leave `false` unless the user tells you the picker
  called under (it isn't visually detectable from a played-cards recap).
  If they do say so, ask which suit and which of the picker's own cards was
  the stand-in rather than guessing.
- **Trick winners and leaders**: the recap marks underline = led, shaded =
  won. Don't just eyeball these — *derive* the winner from the actual cards
  and cross-check against the marking, because misreading a shaded cell is
  the single most likely way to get a transcription wrong. Trump = every
  Queen, every Jack, and every diamond. Trump order, highest to lowest:
  `Q♣ Q♠ Q♥ Q♦ J♣ J♠ J♥ J♦ A♦ 10♦ K♦ 9♦ 8♦ 7♦`. Within a plain (non-trump)
  suit: `A 10 K 9 8 7`. The winner of a trick is whoever played the
  highest trump if any trump was played, else whoever played the highest
  card of the suit that was led.

## Step 2 — Verify before trusting the transcription (mandatory)

Sum the points of every trick by its winner (`A=11, 10=10, K=4, Q=3, J=2,
9=8=7=0`) and add the buried cards' points to the picker+partner side. This
must equal the score line the app prints ("X & Y took N points, defenders
M") *exactly*. If it doesn't, you misread a card or a winner — go back and
recheck before running anything. This single check is what catches a bad
transcription; skipping it is the main way this analysis goes wrong
silently. (It caught zero errors the one time it was skipped and checked
retroactively — not because transcription is easy, but because checking it
is what makes it reliable.)

## Step 3 — Locate the decision

Figure out which trick number and which seat the user is asking about (they
may name a card, a player, or both — "the J♥ Kopps played on trick 2", "was
Patty's lead in trick 1 right", etc.), find that card in your transcription,
and set:

```js
decision: { trickIdx: <trickNumber - 1>, player: <seatIndex> }
```

`samples: 3000` is a good default — stable results (~0.35-0.4 standard
error) in well under 5 seconds for a mid-hand decision.

## Step 4 — Run the analysis

From the repo root:

```
node scripts/pimc.mjs scripts/scenarios/<name>.mjs
node scripts/gradedecision.mjs scripts/scenarios/<name>.mjs
```

Both scripts read the *same* scenario file — `gradedecision.mjs` just
ignores the imperfect-information framing and grades the one true deal.
Run both unless the user only wants one.

If the top two or three PIMC candidates land within about one standard
error of each other, that's a real result too (a genuine toss-up) — but if
the user wants more confidence than that, rerun at a higher `samples`
(8000-10000) rather than trusting a single close call. This project's own
convention (see `CLAUDE.md`) is to read the sign and the sample count, not
one number, and the same logic applies here.

## Step 5 — Report

Give the user:

1. The PIMC ranking — mean ± SE per legal card, with the actually-played
   card marked.
2. The hindsight grade, for contrast, if you ran it.
3. A plain-English verdict that keeps the two questions separate: was this
   defensible given real uncertainty, versus was it actually optimal once
   everyone's cards are known. State the gap between the two whenever it's
   there — it's usually the interesting part of the answer, not a footnote.
