/* ============================================================================
   The header — title, build, house rules, stake, and the menu.

   The other half of the shared chrome (see felt.jsx). Presentational: it takes
   what to show and what the menu should do, and knows nothing about how either
   is decided. Solo hands it compile-time constants; a table hands it whatever
   that table agreed on.

   `rules` is the prop that matters here and the reason this extraction is
   worth doing separately from the felt. Solo's rules are a module constant, so
   every player necessarily agrees. At a table they have to be state — everyone
   sitting down has to be playing the same game — which means they arrive on
   the table object, ride through viewFor, and get displayed rather than
   compiled in. Threading that through afterwards would mean touching this
   markup twice.

   The menu takes items as data rather than rendering fixed entries, because
   the two halves genuinely differ: solo offers Trump order and Scores, a table
   adds Invite and eventually a profile. Anything conditional stays the
   caller's decision — this file should never learn what a "host" is.
   ========================================================================= */
import React, { useState } from "react";
import { felt, btnGhost } from "./ui.jsx";

/**
 * @param {string[]} rules      house rules, as data rather than a sentence
 * @param {number}   doubler    current stake multiplier; 1 hides the badge
 * @param {Array}    menuItems  [{ label, onSelect }] — order is as given
 * @param {node}     extra      optional chip in the rules row (a table code, say)
 * @param {string}   title
 */
export function TableHeader({ rules = [], doubler = 1, menuItems = [], extra, title = "SHEEPSHEAD" }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ flexShrink: 0, position: "relative", padding: "8px 12px", borderBottom: `2px solid ${felt.rail}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 900, letterSpacing: ".14em", fontSize: 19, color: felt.brass }}>
          {title}
        </div>
        <div style={{ fontSize: 8, opacity: 0.35, letterSpacing: ".02em", userSelect: "none" }}>
          v{__APP_VERSION__}
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Menu"
          aria-haspopup="menu"
          aria-expanded={open}
          style={{ ...btnGhost, display: "flex", alignItems: "center", padding: "5px 9px" }}
        >
          <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M1 1h14M1 6h14M1 11h14" />
          </svg>
        </button>
      </div>

      {/* The house rules, above the rail and there for the whole game. Kept as
          data rather than one sentence because a rule you can change has to be
          an addressable thing rather than a substring — and at a table they
          become exactly that.

          Wraps rather than squeezes. The rules and the badge together need
          356px and a 375px phone gives 339, so something has to give — and it
          must not be the rules line, which is the permanent thing. The badge
          drops to a second row instead. That changes the header's height, which
          is only safe because a doubler is set when the hand is dealt, never
          mid-hand: the layout settles before a card is played. */}
      <div style={{ marginTop: 4, display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 4, columnGap: 8 }}>
        <div style={{
          flexShrink: 0, fontSize: 11, letterSpacing: ".04em",
          color: felt.creamDim, opacity: 0.75, userSelect: "none", whiteSpace: "nowrap",
        }}>
          {rules.join(" · ")}
        </div>

        {/* The stake rides with the rules rather than on the table. It was
            briefly at the table's top centre, which collides: the seats sit at
            4% of the table's height, so on a 667px-tall phone they start at
            y=14 while the badge reaches y=19, and there is no room between the
            two top seats either — that gap is ~50px and the badge is ~95px. Up
            here it is fixed chrome, it cannot collide with anything the game
            draws, and it sits next to the rules that explain what doubling
            means. */}
        {doubler > 1 && (
          <span style={{
            marginLeft: "auto", flexShrink: 0,
            color: "#2A2108", background: felt.brass,
            fontWeight: 800, fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase",
            padding: "2px 7px", borderRadius: 4, whiteSpace: "nowrap",
          }}>
            Doubler{doubler > 2 ? ` ×${doubler}` : ""}
          </span>
        )}

        {extra}
      </div>

      {open && (
        <>
          {/* Catches the click that dismisses the menu. Sits under the menu but
              over everything else, so the next tap anywhere closes it instead
              of also hitting a card. */}
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 15 }} />
          <div role="menu" style={{
            position: "absolute", right: 12, top: "calc(100% - 4px)", zIndex: 16,
            background: felt.bgDeep, border: `2px solid ${felt.rail}`, borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,.5)", overflow: "hidden", minWidth: 150,
          }}>
            {menuItems.map(({ label, onSelect }, i) => (
              <button
                key={label}
                role="menuitem"
                onClick={() => { setOpen(false); onSelect(); }}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  background: "transparent", color: felt.cream,
                  border: "none", borderTop: i === 0 ? "none" : "1px solid #ffffff18",
                  padding: "11px 14px", fontSize: 15, fontWeight: 600, cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
