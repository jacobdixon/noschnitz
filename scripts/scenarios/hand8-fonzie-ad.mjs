// Hand 8 recap (screenshot, 2026-08-02, v0.46.0): "Defenders win — Patty took
// 33 points, defenders 87." Patty picked and went ALONE, so there is no
// partner and no called suit.
//
// Debate: on trick 3 Fonzie, holding nothing but trump (A♦ J♦ J♠ J♣), led the
// A♦ — the lowest of the four and the one carrying 11 points. Patty took it
// with the J♥. Should Fonzie have led a Jack instead to pull the picker's
// trump first and keep the Ace protected?
//
// Score check (A=11 10=10 K=4 Q=3 J=2):
//   T1 6 Patty · T2 32 Fonzie · T3 17 Patty · T4 27 Fonzie · T5 6 Fonzie
//   T6 22 Fonzie · buried 10♠+9♣ = 10 Patty
//   Patty 6+17+10 = 33 ✓   defenders 32+27+6+22 = 87 ✓
import { card } from "../pimc.mjs";

const t = (...pairs) => pairs.map(([player, c]) => ({ player, card: card(c) }));

export default {
  names: ["You", "Miller", "Gus", "Patty", "Fonzie"],
  picker: 3,
  calledSuit: null,
  calledRank: null,
  calledUnder: false,
  underCard: null,
  buried: [card("10S"), card("9C")],
  trickHistory: [
    { trick: t([0, "9H"], [1, "7H"], [2, "QH"], [3, "QC"], [4, "9D"]) },
    { trick: t([3, "QD"], [4, "QS"], [0, "KD"], [1, "AH"], [2, "AS"]) },
    { trick: t([4, "AD"], [0, "7S"], [1, "7C"], [2, "KC"], [3, "JH"]) },
    { trick: t([3, "7D"], [4, "JD"], [0, "AC"], [1, "10C"], [2, "KS"]) },
    { trick: t([4, "JS"], [0, "8H"], [1, "KH"], [2, "8S"], [3, "8D"]) },
    { trick: t([4, "JC"], [0, "10H"], [1, "8C"], [2, "9S"], [3, "10D"]) },
  ],
  decision: { trickIdx: 2, player: 4 }, // Fonzie leads trick 3
  samples: 3000,
};
