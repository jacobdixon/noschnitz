// Same Hand 1 as hand1-jh.mjs, but pointed at Patty's opening lead (the play
// the recap marks "!"). Patty is a defender leading to trick 1, so NOTHING is
// public yet and the partner's identity has to be sampled — which makes this
// the scenario that exercises the sampled-partner path.
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
  decision: { trickIdx: 0, player: 3 }, // Patty, opening lead
  samples: 2000,
};
