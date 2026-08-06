// Hand 5 recap (screenshot, v0.59.0): "Pickers win — No Schneider! You & Bernie
// took 112 points · defenders 8." Transcribed trick-by-trick from the recap grid.
//
// Debate: on trick 3 Patty led A♣, Bernie (the picker's partner) trumped it with
// 9♦, and Kopps — void in clubs and last to act — discarded A♥, handing the
// picking side 11 points into a trick they had already won. Was there any case
// for it over a blank 8♥/9♥, or is it a straight schmear to the wrong team?
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
