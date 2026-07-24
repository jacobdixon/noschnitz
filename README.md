# Sheepshead — Call an Ace

A mobile-friendly Sheepshead game (5-handed, call-an-ace variant) — you vs. four AI players. Built with React + Vite, no other dependencies.

## Rules implemented

- 32-card deck, 6 cards per player, 2-card blind
- Pick/pass starting left of the dealer; all-pass hands are thrown in and redealt
- Picker takes the blind, buries two (points count for the picker's team), then calls a fail-suit ace they don't hold (and didn't bury) — or goes alone if no suit qualifies
- Secret partner: holder of the called ace must play it the first time the suit is led, and may not lead that suit except with the ace; the picker must retain a called-suit card until the suit is led
- Trump: Q♣ Q♠ Q♥ Q♦ · J♣ J♠ J♥ J♦ · A♦ 10♦ K♦ 9♦ 8♦ 7♦
- Scoring to 61 of 120; picker ±2 / partner ±1 / defenders ∓1, doubled on schneider, tripled on a no-tricker, ×4 alone

## Run it

```bash
npm install
npm run dev
```

Then open the printed localhost URL. `npm run build` produces a static bundle in `dist/` you can host anywhere.

## Tuning the AI

- Pick aggressiveness: `handStrength()` threshold in `src/Sheepshead.jsx` (currently 10; lower = picks more often)
- Play style: `aiChooseCard()` — leading, schmearing, and trick-taking heuristics live here
