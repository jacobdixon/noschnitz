---
name: hand-analysis
description: Analyze a played Sheepshead hand — whether a card was the right play, what a mistake cost, or why a seat did something. Use this whenever the user asks about a specific hand, trick, or card, posts a recap screenshot, asks "was that right", "should I have led X", "what did that cost", "why did the AI play Y", or asks to grade or review play. Also use it before changing engine heuristics on the strength of a hand somebody reported, because the measurement discipline here is what separates a real finding from a plausible one.
---

# Analyzing a hand

The engine already grades hands, and its grade answers a **different question**
from the one people ask. Getting these two confused is the single failure mode
this skill exists to prevent, so start here.

- `gradeAllPlays` / the recap solves the **one deal that happened**, with every
  hand visible. It answers "did this seat find the card that was best given the
  actual layout".
- `scripts/pimc.mjs` samples deals consistent with **what the seat could know**
  and averages the exact solve over them. It answers "was this right given the
  information available" — which is what a player means by "was that a mistake".

They disagree constantly, in both directions. Measured over 425 decisions:
double-dummy called **15%** of decisions clean that cost ≥1 point, and **9%**
mistakes that cost under 0.5. Within a single trick of one reported hand it
scored a 4.3-point error at zero and a 0.9-point error at six.

So: **never report a double-dummy cost as "how bad the play was."** Report the
PIMC number, and show the DD one beside it when the gap is the story.

## The workflow

### 1. Reconstruct the hand into a spec

Hands live in `scripts/hands/<date>-hand<N>.json`. A recap screenshot is enough:
30 played cards plus 2 buried is the whole 32-card deck, so every hand is
recoverable exactly.

```json
{
  "label": "2026-08-02 hand 1 (v0.46.0) — pickers win, no schneider, 115-5",
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

`plays` is **by seat, in trick order** — the recap grid, read across each row.
Play order within a trick is derived from who won the previous one, so it is
never stored.

Always include `expectedWinners` (from the shaded cells). It costs nothing and
it catches a misread card immediately, which is the most common way this goes
wrong. `passers` is the seats that had a pick decision and passed — real
information the sampler uses, and safe to omit if unknown.

### 2. Run it, and check the verify line

```
npm run pimc -- scripts/hands/<file>.json --trick 3 --seat You --worlds 1200 --seed 1
```

The output prints `verify: DD costs match gradeAllPlays on all N cards`. **If
that line is missing or the run throws, stop.** It means the position being
analyzed is not the position that was played, and every number below it is
confidently wrong in a way nothing else would reveal.

Run **3–4 seeds**. Read the sign and how many seeds agree, not one number — a
result worth reporting is consistent across seeds. Quote the paired `vs played`
column with its ±, never two raw means subtracted: every card is scored on the
same sampled worlds, so the paired spread is far tighter and is the honest one.

### 3. Read the table

| column | what it tells you |
|---|---|
| `PIMC pts` | picker-team points, averaged over sampled worlds |
| `vs played` | paired difference against the card actually played, ± SE |
| `win% / schn%` | where the cost lives — see below |
| `stake` | the deciding seat's own hand delta under house rules |
| `DD(actual)` | the exact solve of the real deal — the recap's answer |

Orientation flips with the side: a defender's best card **minimises**
picker-team points. The tool handles this; your prose has to as well.

**Check `win%` against `schn%` before writing a conclusion.** Often the win rate
is flat across every legal card and the whole cost is the schneider line — the
seat isn't choosing whether to lose, it's choosing whether to lose double. That
is a materially different thing to tell someone than "you threw the hand away."

### 4. Price a read with `--partner NAME`

When a seat could have deduced who the partner is, `--partner` restricts
sampling to worlds where that seat holds the called card. Run it both ways: the
gap **is** the value of the inference. On the reported hand, a defender's 10♠
went from 0.9 points behind the best card to 5.9 once the read was pinned — the
read was worth six times the error it exposed, which was the more useful finding.

## Traps that have already cost time

**Tricks 5–6 are not analyzable as mistakes.** `aiChooseCard` dispatches them to
`solveEndgameCard`, which solves the real deal — the AI plays those tricks with
perfect information (`npm run clairvoyancetest` demonstrates it). Their DD cost
is 0 by construction, and their PIMC "cost" measures the value of that
information, not an error. `pimcmine` excludes them; a single-decision analysis
has to exclude them by hand.

**Regret is a max over noisy means, so it is biased upward.** `pimcmine`
cross-fits to remove this; `pimc.mjs` on a single decision does not. At low
`--worlds` treat the magnitude as an upper bound, and raise the world count
before quoting a number that matters.

**A defender's information set is not the picker's.** They cannot see the bury,
and worlds that put the called ace in the picker's hand or in the bury are
impossible — the call could not have been made. The sampler enforces this via
`callOptions`; it rejects ~74% of worlds for a defender seat, so acceptance
rates that look alarming are usually correct.

## Before changing the engine because of a hand

One hand is a **detector, not evidence**. Every AI fix that has actually landed
started from one reported hand, and several correct-looking diagnoses from one
hand measured as pure noise. The sequence that works:

1. **Reproduce against the engine first** — does `aiChooseCard` actually make
   this mistake, and through which branch? Print the intermediate values. Often
   the play code is fine and something upstream is feeding it a bad input.
2. **Pin it as a constructed assertion with a negative control** in
   `scripts/aitest.mjs` — the control is what makes the test mean something.
3. **Measure it**: `npm run abtest` for a one-seat change, and
   `npm run coalitiontest` as well for anything about co-operating with
   teammates, which a one-seat A/B structurally cannot see. Both null-test to
   exactly zero; if your null isn't exactly zero, the harness is wrong, not the
   result. Read seeds-ahead-of, not the mean alone.
4. If it touches the partner belief, calibrate in `npm run belieftest` **before**
   any play code acts on it — an uncalibrated belief is a lie the play code will
   act on.

**A strong inference can be worth nothing, and that is a normal outcome.** The
schmear tell calibrated at 8.3:1 and passed every calibration bucket, then
changed 10 decisions in 92,970 and shipped off. Being able to read a table is
not the same as being able to do anything about it. When that happens, record it
as `MEASURED AND NOT SHIPPED` with the funnel that shows why, so the next person
doesn't rediscover it — that is a real deliverable, not a failure.

## Going wider than one hand

`npm run pimcmine -- <hands.json>` prices every decision in a corpus and ranks
decision *shapes* by total cost. `--selfplay N` generates clean engine-vs-engine
hands and needs no corpus at all, which is the only option from a session: the
egress proxy answers 403 to CONNECT for both noschnitz hosts, so the real corpus
is reachable only from CI, via **Actions → "Mine hands" → `analysis:
cost-ranking`**.
