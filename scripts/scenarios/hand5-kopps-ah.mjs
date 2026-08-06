// Hand 5 recap (screenshot, v0.59.0): "Pickers win — No Schneider! You & Bernie
// took 112 points · defenders 8." Transcribed trick-by-trick from the recap grid.
//
// Debate: on trick 3 Patty led A♣, Bernie (the picker's partner) trumped it with
// 9♦, and Kopps — void in clubs and last to act — discarded A♥, handing the
// picking side 11 points into a trick they had already won. Was there any case
// for it over a blank 8♥/9♥, or is it a straight schmear to the wrong team?
//
// Left UNCONDITIONED deliberately, which is what makes it a useful case: run as
// it stands, the sampler spreads the called A♠ over Patty/Bunny/Bernie evenly,
// two worlds in three have Bernie ruffing for the DEFENCE, and the A♥ scores
// second of four because in those worlds it is a schmear onto Kopps's own
// trick. Add `assumePartner: 4` and the ranking inverts — the A♥ goes last,
// 3.63 behind a blank heart with the win rate more than halved (6.9% against
// 15.9%). The gap between those two runs is the whole point of the hand: it is
// the price of the read, not of the card.
//
// The read was available and the engine's own numbers say so. Bernie opened
// trick 2 with the 8♦ — a non-picker leading trump — which engine.js measures
// at 60.4% partner against a 25% base rate, and then declines to act on
// (PLAIN_TRUMP_LEAD_ODDS = 1, "MEASURED AND NOT SHIPPED"). So
// teammateProbability hands Kopps a flat 66.7% for all three seats here. This
// is the spot that comment reserves — "the day something else consults the
// belief in a spot a losing lead still matters" — since Bernie's low trump lead
// duly lost to Patty's Q♥ and mattered anyway, two tricks later.
import { card } from "../pimc.mjs";

const t = (...pairs) => pairs.map(([player, c]) => ({ player, card: card(c) }));

export default {
  names: ["You", "Kopps", "Patty", "Bunny", "Bernie"],
  picker: 0,
  calledSuit: "S",
  calledRank: "A",
  calledUnder: false,
  underCard: null,
  buried: [card("10C"), card("10H")],
  trickHistory: [
    { trick: t([0, "JD"], [1, "QS"], [2, "KD"], [3, "7D"], [4, "QC"]) },
    { trick: t([4, "8D"], [0, "QD"], [1, "8C"], [2, "QH"], [3, "JC"]) },
    { trick: t([2, "AC"], [3, "KC"], [4, "9D"], [0, "KH"], [1, "AH"]) },
    { trick: t([4, "AD"], [0, "JS"], [1, "8H"], [2, "10D"], [3, "8S"]) },
    { trick: t([0, "JH"], [1, "9H"], [2, "7C"], [3, "9S"], [4, "KS"]) },
    { trick: t([0, "7S"], [1, "10S"], [2, "9C"], [3, "7H"], [4, "AS"]) },
  ],
  decision: { trickIdx: 2, player: 1 }, // Kopps, trick 3
  samples: 3000,
};
