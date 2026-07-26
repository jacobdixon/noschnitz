/* ============================================================================
   Shared presentational pieces — the felt/brass table look.

   Lifted out of Sheepshead.jsx so the multiplayer table screen renders from
   the same vocabulary rather than a second copy that quietly drifts. (The
   `compact` Badge variant is exactly the kind of change that would otherwise
   have to be made twice and eventually only get made once.)

   Presentation only: nothing here knows about game state, turns, or the
   server. `isTrump` is the single engine import, and only to draw the trump
   pip on a card face.
   ========================================================================= */
import { SUIT_SYM, isTrump } from "./engine.js";

export const felt = {
  bg: "#123B2D",
  bgDeep: "#0C2B20",
  rail: "#4A2E18",
  cream: "#F6EFDD",
  creamDim: "#E7DCC2",
  brass: "#D2A93C",
  brassDim: "#9A7C2C",
  red: "#B3392F",
  black: "#28241E",
  chip: "#1B4D3B",
};

export function Card({ card, small, onClick, dim, selected, faceDown, scale = 1 }) {
  // Card box dimensions stay put (so the table/hand layout doesn't get
  // cramped); only the rank/suit glyphs inside get ~20% bigger for
  // legibility — clubs vs. spades were hard to tell apart at the old sizes.
  const w = Math.round((small ? 42 : 56) * scale);
  const h = Math.round((small ? 60 : 80) * scale);
  if (faceDown) {
    return (
      <div style={{
        width: w, height: h, borderRadius: 7, flexShrink: 0,
        background: `repeating-linear-gradient(45deg, #6E1F1B, #6E1F1B 4px, #591714 4px, #591714 8px)`,
        border: `2px solid ${felt.cream}`, boxShadow: "0 2px 4px rgba(0,0,0,.4)",
      }} />
    );
  }
  const red = card.suit === "H" || card.suit === "D";
  const trump = isTrump(card);
  return (
    <div onClick={onClick} style={{
      width: w, height: h, borderRadius: 7, flexShrink: 0, position: "relative",
      background: dim ? "#CFC7B2" : felt.cream,
      border: selected ? `2.5px solid ${felt.brass}` : "1.5px solid #B8AD92",
      boxShadow: selected ? `0 0 0 2px ${felt.brass}55, 0 -6px 10px rgba(0,0,0,.35)` : "0 2px 4px rgba(0,0,0,.35)",
      transform: selected ? "translateY(-10px)" : "none",
      transition: "transform .15s, box-shadow .15s",
      cursor: onClick ? "pointer" : "default",
      opacity: dim ? 0.55 : 1,
      display: "flex", flexDirection: "column", justifyContent: "space-between",
      padding: `${Math.round((small ? 3 : 4) * scale)}px ${Math.round((small ? 4 : 6) * scale)}px`,
      userSelect: "none", WebkitTapHighlightColor: "transparent",
    }}>
      <div style={{ fontSize: Math.round((small ? 16 : 19) * scale), fontWeight: 800, lineHeight: 1, color: red ? felt.red : felt.black, fontFamily: "Georgia, serif" }}>
        {card.rank}
        <span style={{ fontSize: Math.round((small ? 13 : 17) * scale) }}>{SUIT_SYM[card.suit]}</span>
      </div>
      <div style={{ alignSelf: "center", fontSize: Math.round((small ? 22 : 31) * scale), color: red ? felt.red : felt.black, lineHeight: 1 }}>
        {SUIT_SYM[card.suit]}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {trump && <div style={{ width: Math.round((small ? 6 : 8) * scale), height: Math.round((small ? 6 : 8) * scale), borderRadius: "50%", background: felt.brass, boxShadow: "0 0 3px " + felt.brass }} />}
      </div>
    </div>
  );
}

// `compact` is for the recap grid, where the badge sits in the name column of
// a six-column table: at full size it widens that column enough to push the
// last trick off-screen on a phone.
export function Badge({ children, gold, compact }) {
  return (
    <span style={{
      fontSize: compact ? 9 : 11, fontWeight: 700,
      letterSpacing: compact ? ".04em" : ".08em", textTransform: "uppercase",
      padding: compact ? "1px 4px" : "2px 6px", borderRadius: 4,
      background: gold ? felt.brass : "#ffffff22",
      color: gold ? "#2A2108" : felt.creamDim,
    }}>{children}</span>
  );
}

export function Modal({ children, onClose, maxWidth = 380 }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000a8", zIndex: 20,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: felt.bgDeep, border: `2px solid ${felt.rail}`, borderRadius: 12,
        padding: 18, width: "100%", maxWidth, color: felt.cream,
        boxShadow: "0 10px 40px rgba(0,0,0,.6)",
      }}>
        {children}
      </div>
    </div>
  );
}

export const btnGold = {
  background: felt.brass, color: "#241C06", border: "none", borderRadius: 8,
  padding: "9px 18px", fontSize: 17, fontWeight: 800, letterSpacing: ".03em",
  cursor: "pointer", boxShadow: "0 2px 0 #7d6420",
};
export const btnPlain = {
  background: "#ffffff14", color: felt.cream, border: "1px solid #ffffff30", borderRadius: 8,
  padding: "9px 18px", fontSize: 17, fontWeight: 700, cursor: "pointer",
};
export const btnGhost = {
  background: "transparent", color: felt.creamDim, border: `1px solid ${felt.brassDim}`,
  borderRadius: 6, padding: "4px 10px", fontSize: 13, fontWeight: 700, cursor: "pointer",
  letterSpacing: ".05em",
};
