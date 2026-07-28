/* ============================================================================
   The call step.

   Its own component because it is about to grow. Today the picker calls an ace;
   next comes calling a TEN (when they hold every callable ace) and calling
   UNDER. Those are different calls of the same suit, so anything that renders
   "a list of suits" has to be rewritten to show them — and there were two such
   lists, one per screen, written slightly differently.

   This renders a list of OPTIONS instead. Adding a kind is then a rule in
   engine.callOptions() and a phrase in status.callLabel(), and both screens
   pick it up without being touched.

   Kept as buttons that wrap rather than a row that scrolls, because six of
   them is the realistic upper bound once ten-calling lands and a horizontal
   scroller hides choices you did not know you had.
   ========================================================================= */
import React from "react";
import { SUIT_SYM, SUIT_NAME } from "./engine.js";
import { btnGold } from "./ui.jsx";

// Hearts is the only callable red suit — diamonds are trump — and the gold
// button is light, so the glyph takes the dark red that reads on it rather
// than felt.red, which is tuned for the felt.
const glyph = (suit) => (
  <span style={{ color: suit === "H" ? "#7A1E14" : "#1c1a14" }}>{SUIT_SYM[suit]}</span>
);

/**
 * @param {object[]} options   from engine.callOptions()
 * @param {Function} onCall    (option | null) => void; null means going alone
 * @param {boolean}  disabled
 */
export function CallButtons({ options = [], onCall, disabled }) {
  if (options.length === 0) {
    return (
      <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
        <button style={btnGold} disabled={disabled} onClick={() => onCall(null)}>
          Go alone
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
      {options.map((opt) => (
        <button
          key={`${opt.kind}-${opt.suit}`}
          style={btnGold}
          disabled={disabled}
          onClick={() => onCall(opt)}
        >
          {opt.kind === "ten" ? "Call the " : "Call "}
          {glyph(opt.suit)} {SUIT_NAME[opt.suit]}
          {opt.kind === "ten" ? " ten" : opt.kind === "under" ? " under" : ""}
        </button>
      ))}
    </div>
  );
}
