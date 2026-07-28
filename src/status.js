/* ============================================================================
   The line under the table, and the one under the buttons.

   Plain .js so it can be tested without rendering anything, and shared so the
   two halves of the game stop describing the same moment differently. They had
   drifted badly: solo said "Blind's yours if you want it." where the table said
   "Pick or pass?", solo counted your buried cards as you picked them and the
   table did not, and the table had no branch for the call phase at all — so
   while you were choosing an ace it fell through to the play branch and, with
   no turn set, announced "Someone's play…".

   Solo's copy wins throughout. It is the one that reads like a person talking
   about a card game rather than a state machine reporting its state.
   ========================================================================= */
import { SUIT_SYM, SUIT_NAME, trickWinner } from "./engine.js";

// Seat 0 in solo is literally called "You", and a table has to derive it.
// Getting this wrong reads as a stranger sitting in your chair — or, worse,
// as "You takes the trick".
const who = (names, mySeat, seat) => (seat === mySeat ? "You" : names[seat] ?? "Someone");

/** How a call option is written on a button and in the prompt. */
export function callLabel({ kind, suit }) {
  const suited = `${SUIT_SYM[suit]} ${SUIT_NAME[suit]}`;
  // Only "ace" exists today. The other two are the next rules to land, and are
  // spelled here so adding them is a label rather than a layout.
  if (kind === "ten") return `Call the ${suited} ten`;
  if (kind === "under") return `Call ${suited} under`;
  return `Call ${suited}`;
}

/** The prompt above the call buttons. */
export function callPrompt(options) {
  if (!options || options.length === 0) return "No callable suit. You're going alone.";
  if (options.some((o) => o.kind !== "ace")) return "Call your partner.";
  return "Call an ace — your partner holds it.";
}

/**
 * @param {object}   g            game state as DRAWN, not as the server holds it
 * @param {string[]} names        display name per seat
 * @param {number}   mySeat
 * @param {boolean}  isMyTurn     already accounts for the paced reveal
 * @param {number}   selected     cards picked for the bury so far
 * @param {object[]} options      call options, when it is your call
 */
export function statusLine({ g, names, mySeat = 0, isMyTurn, selected = 0, options }) {
  if (!g) return "";
  const name = (seat) => who(names, mySeat, seat);

  if (g.phase === "handEnd") {
    if (!g.result) return "Hand over.";
    const headline = g.result.pickerWins
      ? (g.alone || g.partner === null ? "Picker wins" : "Pickers win")
      : "Defenders win";
    return `${headline}${g.result.label ? ` — ${g.result.label}` : ""}`;
  }

  if (g.phase === "picking") {
    if (g.passes >= names.length) return "Everyone passed — redealing…";
    return g.pickTurn === mySeat
      ? "Blind's yours if you want it."
      : `${name(g.pickTurn)} is thinking…`;
  }

  // The count is the point: it tells you how many more to tap without you
  // having to look back at the button.
  if (g.phase === "bury") {
    return g.picker === mySeat
      ? `Bury two cards (${selected}/2)`
      : `${name(g.picker)} is burying…`;
  }

  if (g.phase === "call") {
    return g.picker === mySeat ? callPrompt(options) : `${name(g.picker)} is calling…`;
  }

  if (g.phase === "playing") {
    // A finished trick is worth naming before it sweeps — it is the one moment
    // the table tells you something you might have missed.
    if (g.trick?.length === 5) {
      const winner = trickWinner(g.trick);
      return winner === mySeat ? "You take the trick" : `${name(winner)} takes the trick`;
    }
    return isMyTurn ? "Your play." : `${name(g.turn)}'s play…`;
  }

  return "";
}

/**
 * The quieter line under the buttons: where you are in the hand, and how you're
 * doing. Solo has always had it; the table never did, which left you with no
 * sense of progress through six tricks.
 */
export function progressLine({ g, mySeat = 0 }) {
  if (!g || g.phase !== "playing" || !g.tricksDone) return null;
  const pts = g.ptsTaken?.[mySeat] ?? 0;
  return `Trick ${g.tricksDone + 1} of 6 · You've taken ${pts} pts`;
}
