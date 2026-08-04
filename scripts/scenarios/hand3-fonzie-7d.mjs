// Hand 3 recap (noschnitz v0.48.0, 2026-08-03): "Fonzie & Gus took 43,
// defenders 77." Seating order clockwise: You, Gus, Kopps, Fonzie, Miller.
//
// Debate: on trick 3, Kopps leads 10S and Fonzie (the picker) is void in
// spades holding only trump — 7D, 8D, QH, QS. He trumped with the lowest,
// 7D, and Miller overtrumped with JH to take 22 points. Was 7D right?
import { card } from "../pimc.mjs";

const t = (...pairs) => pairs.map(([player, c]) => ({ player, card: card(c) }));

export default {
  names: ["You", "Gus", "Kopps", "Fonzie", "Miller"],
  picker: 3,
  calledSuit: "S",
  calledRank: "A",
  calledUnder: false,
  underCard: null,
  buried: [card("AC"), card("7C")],
  trickHistory: [
    { trick: t([2, "9S"], [3, "7S"], [4, "KD"], [0, "KS"], [1, "AS"]) },
    { trick: t([4, "7H"], [0, "8H"], [1, "10H"], [2, "AH"], [3, "9H"]) },
    { trick: t([2, "10S"], [3, "7D"], [4, "JH"], [0, "10C"], [1, "8S"]) },
    { trick: t([4, "KC"], [0, "9C"], [1, "8C"], [2, "AD"], [3, "QH"]) },
    { trick: t([3, "8D"], [4, "QC"], [0, "10D"], [1, "9D"], [2, "JD"]) },
    { trick: t([4, "KH"], [0, "QD"], [1, "JS"], [2, "JC"], [3, "QS"]) },
  ],
  decision: { trickIdx: 2, player: 3 }, // Fonzie, trick 3
  samples: 3000,
};
