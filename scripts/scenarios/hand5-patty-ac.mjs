// Hand 5 recap (screenshot, 2026-08-05, v0.59.0): "Pickers win — No Schneider!
// You & Bernie took 112 points, defenders 8." Transcribed trick-by-trick from
// the recap grid. Only the prefix up through the `decision` pointer is used by
// runPimc() — everything after it is forgotten, to respect what the deciding
// player could actually see at the time.
//
// Debate: on trick 3, Patty (a defender, on lead after winning trick 2 with
// Q♥) led the A♣ into a picker-side that had already shown enormous trump.
// Bernie ruffed with 9♦ and the trick handed 30 points to the pickers. Was
// leading the bare fail ace defensible, or should Patty have led something
// else?
//
// Seats are row order in the recap, top to bottom:
//   0 You (PICKER), 1 Kopps, 2 Patty, 3 Bunny, 4 Bernie (PARTNER)
//
// Called suit derives from the PARTNER-badged seat: Bernie shows A♠ on trick
// 6, and the picker holds 7♠ as their only spade, so the call was spades.
//
// Verified: pickers 12 + 30 + 23 + 6 + 21 = 92, plus buried 10♣ + 10♥ = 20,
// total 112; defenders take only trick 2 for 8. Matches the app exactly.
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
  decision: { trickIdx: 2, player: 2 }, // Patty leading trick 3
  samples: 3000,
};
