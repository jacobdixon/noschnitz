// Hand 1 recap (screenshot, 2026-08-02): "Pickers win, You & Kopps took 68,
// defenders 52." Transcribed trick-by-trick from the recap grid — same shape
// used for exact-solve grading, but here only the prefix up through the
// `decision` pointer is actually used; everything after it is forgotten by
// runPimc() to respect what the deciding player could see.
//
// Debate: was Kopps (partner) right to trump in with J♥ on trick 2, or
// should they have ducked (discarded) and let the picker's A♦ win instead?
import { card } from "../pimc.mjs";

const t = (...pairs) => pairs.map(([player, c]) => ({ player, card: card(c) }));

export default {
  names: ["You", "Bunny", "Gus", "Patty", "Kopps"],
  picker: 0,
  calledSuit: "S",
  calledRank: "A",
  calledUnder: false,
  underCard: null,
  buried: [card("9C"), card("7C")],
  trickHistory: [
    { trick: t([3, "8S"], [4, "AS"], [0, "KS"], [1, "10S"], [2, "9D"]) },
    { trick: t([2, "8C"], [3, "KC"], [4, "JH"], [0, "AD"], [1, "AC"]) },
    { trick: t([4, "7S"], [0, "QH"], [1, "8H"], [2, "9H"], [3, "9S"]) },
    { trick: t([0, "QC"], [1, "8D"], [2, "JD"], [3, "7D"], [4, "AH"]) },
    { trick: t([0, "QS"], [1, "JC"], [2, "JS"], [3, "KD"], [4, "10H"]) },
    { trick: t([0, "10D"], [1, "QD"], [2, "KH"], [3, "10C"], [4, "7H"]) },
  ],
  decision: { trickIdx: 1, player: 4 }, // Kopps, trick 2
  samples: 3000,
};
