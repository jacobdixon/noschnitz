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

   Going alone is offered here ALWAYS, not only when the option list comes back
   empty. Those are two different things that happened to render the same:
   "nobody is callable, so you are alone" is an announcement, and "I would
   rather have the 4x than a partner" is a decision. The AI has been allowed to
   make that decision since ALONE_HANDSTRENGTH landed — `aiBuryAndCall` declines
   a perfectly good call on a strong enough hand — and the human simply had no
   button for it. The engine and the scoring never needed anything: a null call
   is a null call however it arose.
   ========================================================================= */
import React from "react";
import { SUIT_SYM, SUIT_NAME } from "./engine.js";
import { btnGold, btnPlain, felt } from "./ui.jsx";

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
  // Armed only in the case where going alone is a choice. Nothing about the
  // call step is undoable — the next thing that happens is the opening lead —
  // and the difference between a called partner and no partner is the whole
  // hand: 2x/1x across two people becomes 4x against four. A stray tap on a
  // 12-point hand is a worse outcome than an extra tap on a 20-point one.
  const [armed, setArmed] = React.useState(false);

  // Forced, not chosen: no partner exists to give up, so there is nothing to
  // confirm and a confirmation would just be a step in the way.
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
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
        {options.map((opt) => (
          <button
            key={`${opt.kind}-${opt.suit}`}
            style={btnGold}
            disabled={disabled}
            // Choosing a partner is also how you back out of an armed alone —
            // there is no separate cancel to find.
            onClick={() => onCall(opt)}
          >
            {opt.kind === "ten" ? "Call the " : "Call "}
            {glyph(opt.suit)} {SUIT_NAME[opt.suit]}
            {opt.kind === "ten" ? " ten" : opt.kind === "under" ? " under" : ""}
          </button>
        ))}
      </div>

      {/* Plain rather than gold, and on its own row: calling a partner is the
          ordinary move and should still look like it. This is the one you
          reach past the others for. */}
      <button
        style={armed
          ? { ...btnPlain, background: "#B3392F33", borderColor: felt.red, color: felt.cream }
          : btnPlain}
        disabled={disabled}
        onClick={() => (armed ? onCall(null) : setArmed(true))}
      >
        {armed ? "Tap again — no partner, 4×" : "Go alone"}
      </button>
    </div>
  );
}
