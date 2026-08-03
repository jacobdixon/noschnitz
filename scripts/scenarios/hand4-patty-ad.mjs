// Hand 4 recap (screenshot, 2026-08-03, v0.48.0): "Defenders win — Patty & You
// took 40 points, defenders 80." Buried A♥ 10♣. Transcribed trick-by-trick from
// the recap grid; only the prefix up through `decision` is used by runPimc(),
// everything after it is forgotten to respect what Patty could see.
//
// Debate: on trick 2 the partner (You, seat 0) led K♦ and Fonzie sloughed 7♥.
// Patty (picker) is third of five with only trump legal — A♦, J♦ or 7♦ — and
// played the A♦, hanging 11 points in front of two unplayed defenders. Bernie
// took it with Q♥ for a 21-point trick. Should Patty have overtaken with J♦ or
// ducked with 7♦ instead?
//
// Score check (A=11,10=10,K=4,Q=3,J=2): T1 You 9, T2 Bernie 21, T3 Miller 15,
// T4 Bernie 21, T5 Bernie 23, T6 Patty 10, bury 21 → picker side 40, defenders
// 80. Matches the app's score line exactly.
import { card } from "../pimc.mjs";

const t = (...pairs) => pairs.map(([player, c]) => ({ player, card: card(c) }));

export default {
  names: ["You", "Fonzie", "Patty", "Miller", "Bernie"],
  picker: 2,
  calledSuit: "C",
  calledRank: "A",
  calledUnder: false,
  underCard: null,
  buried: [card("AH"), card("10C")],
  trickHistory: [
    { trick: t([2, "JH"], [3, "JS"], [4, "JC"], [0, "QC"], [1, "8D"]) },
    { trick: t([0, "KD"], [1, "7H"], [2, "AD"], [3, "QD"], [4, "QH"]) },
    { trick: t([4, "7C"], [0, "AC"], [1, "8C"], [2, "KC"], [3, "9D"]) },
    { trick: t([3, "8S"], [4, "AS"], [0, "10S"], [1, "8H"], [2, "7S"]) },
    { trick: t([4, "QS"], [0, "9S"], [1, "10H"], [2, "7D"], [3, "10D"]) },
    { trick: t([4, "9H"], [0, "KS"], [1, "9C"], [2, "JD"], [3, "KH"]) },
  ],
  decision: { trickIdx: 1, player: 2 }, // Patty (picker), trick 2
  samples: 3000,
};
