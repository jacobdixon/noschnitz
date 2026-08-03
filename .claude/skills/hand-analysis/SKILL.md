---
name: hand-analysis
description: Answer "was that the right play?" for a Sheepshead hand by simulating every legal alternative from what that seat could actually see, and reporting the average points and win rate each would have produced. Use whenever someone shares a hand, recap screenshot, or trick and asks whether a card was right, what it cost, what they should have played, or why a seat did something — including hands sent by friends for a quick verdict.
---

# What each play would likely have produced

Someone has sent a hand and wants a straight answer: *of the cards I could have
played there, which ones do best, and by how much?* Produce a short table of
every legal card with the average points and win rate it leads to — averaged
over many deals consistent with **what that seat could see at the time**.

`npm run pimcsolve` does the simulation. Your job is to get the hand in, check it
reconstructed correctly, and hand back something quotable.

## Answer the question and stop

The failure mode here is not getting it wrong, it is not stopping. A question
about one card opens onto genuinely interesting work — the engine picks that
card too, is that a bug, what would fixing it measure at — and following that
thread produces a research report when what was wanted was a reply to a friend.
Measured: an unscoped run on a single trick-1 card spent **22 minutes** and
finished by A/B testing a tuning constant over 10,000 hands. The same question
answered to scope takes about four.

So: price the cards, say which is best and by how much, say why in a sentence,
stop. Specifically, do not run `abtest`, `coalitiontest`, `simulate` or
`pimcmine` unless the person asked about the engine rather than about the hand.

Noticing something about the engine on the way is worth one line — "the engine
plays this card too, so it is not just you" — and that line is the whole
deliverable. If it deserves pursuing, say so and let them decide.

## Do this

**1. Write the hand to `scripts/hands/<date>-<name>.json`.** A recap screenshot
is enough — 30 played cards plus 2 buried is the whole 32-card deck, so the deal
is recoverable exactly.

```json
{
  "label": "2026-08-02 hand 1 — pickers win 115-5",
  "seats": ["You", "Bernie", "Bunny", "Gus", "Fonzie"],
  "picker": 0,
  "calledSuit": "S", "calledRank": "A",
  "buried": ["KH", "7H"],
  "firstLeader": 3,
  "passers": [3, 4],
  "plays": [["KD","QS","10D","8D","8S","JS"], ...],
  "expectedWinners": [0, 0, 2, 1, 2, 0]
}
```

`plays` is **by seat, in trick order** — read straight across each row of the
recap grid. Order within a trick is derived from who won the last one, so it is
never stored, and getting the rows transposed is the most common way this breaks.

`expectedWinners` comes from the shaded cells and is worth the ten seconds: it
catches a misread card immediately, which otherwise surfaces as numbers that
look plausible and are about a different hand. `passers` (seats that had a pick
decision and passed) is real information the sampler uses; omit it if unknown.

**2. Run it.**

```
npm run pimcsolve -- scripts/hands/<file>.json --trick 3 --seat Gus --worlds 1200 --seed 1
```

The output opens with the table to quote — every legal card, that seat's own
side's average points out of 120, and how often that side wins the hand.

**Stop if the `verify: DD costs match gradeAllPlays` line is missing.** It means
the position simulated is not the position played, and every number under it is
wrong in a way nothing else will reveal.

**3. Re-run on 2–3 seeds** (`--seed 2`, `--seed 3`) before quoting a gap. Report
it only if the sign holds across them. The `±` on the cost line is a paired
standard error — every card is scored on the same sampled deals, which is what
makes a sub-point difference meaningful.

## Reporting it

Lead with the table and the one-line cost. Then say **why** in a sentence of
plain Sheepshead — "the 10 is fat and can't win with five power trump still
out" — because that is the part that transfers to the next hand.

Two things worth calling out when they show up, because they change what the
answer *means*:

- **The win rate often doesn't move while the points do.** Then the choice was
  never about winning the hand, it was about the schneider line — losing once
  versus losing double. Say that; "you threw the hand away" would be wrong.
- **The in-app recap can disagree, and it is not a second opinion.** It grades
  against the deal as it actually was, with all five hands visible, so it
  forgives a bad card that got lucky and convicts a good one that didn't. If
  someone quotes their recap grade at you, that is the explanation.

## Tricks 5 and 6 have no answer

From `tricksDone >= 4`, `aiChooseCard` hands off to `solveEndgameCard`, which
solves the **real deal** — every AI seat plays the last two tricks seeing all
five hands. Two consequences, and this is the one thing here you will not find
written down anywhere else in the repo:

- The recap's cost for those tricks is 0 by construction, because the seat
  played the double-dummy card. It is not evidence of good play.
- A simulated cost there is not an error either. It measures how much the
  clairvoyant card differs from the best guess under uncertainty — but the seat
  was not guessing, so there is no mistake to report.

So for a trick-5 or trick-6 question, say there is no number to give and why.
Check `legalPlays` too: late in a hand a card is very often simply forced, and a
forced play looks identical to a choice on a replay.

## Two more things that will otherwise catch you out

**Small gaps at low `--worlds` are overstated.** The best card is picked as the
max over noisy averages, so it gets flattered. At 300–400 worlds treat a gap
under about a point as directional only; raise `--worlds` before quoting it.

**`--partner NAME` prices a read.** It restricts the simulation to deals where
that seat holds the called ace. Run it both ways and the difference is what
*knowing* is worth, which is frequently a bigger number — and a better story —
than the mistake itself.

---

If the question really does turn into "change the engine because of this", that
is a separate job, started deliberately and not drifted into. CLAUDE.md has the
rules — one hand is a detector, not evidence; reproduce, pin with a negative
control, measure on `abtest` and `coalitiontest`, calibrate a belief before any
play code acts on it. Point at that and let them start it. Do not start it
inside an answer about a hand.
