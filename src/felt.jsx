/* ============================================================================
   The table itself — seat ring, played trick, and your hand.

   Presentational. It reads a game state and renders it; it never advances one.
   That split is what lets the same components serve both halves of the game:
   the solo driver hands them local state from its own engine loop, and the
   multiplayer driver hands them the server's redacted view. Neither of them
   has to know how the other gets its state, and neither has to reimplement the
   felt to show it.

   Two props carry everything that differs between the two:

     names    display name per seat. Solo passes its fixed cast; a table passes
              whoever actually sat down.
     mySeat   which seat is the viewer's. Solo is always 0; at a table you get
              whichever seat was free, and you still expect to be at the bottom
              of your own screen.

   `rules` is deliberately NOT here. The house-rules line and the doubler chip
   both live in the header, so that prop belongs to the header extraction — it
   would only be noise in this file.

   Everything else comes off the game state, which is the same shape on both
   sides. The one thing to be careful about: at a table, other players' hands
   arrive as null (see viewFor). Nothing in here reads them — seat counts come
   from what's been played, not from what people hold — and it should stay that
   way.
   ========================================================================= */
import React, { useState, useEffect, useRef } from "react";
import { SUIT_SYM, SUIT_NAME, cid, cardPts, trickWinner } from "./engine.js";
import { felt, scoreColor, Card, CARD_ROW_H, Badge } from "./ui.jsx";
import { fanOverlap, MAX_OVERLAP } from "./fan.js";

export const SEATS = 5;

// Absolute seat -> position on screen, with the viewer always at the bottom.
// Solo passes mySeat 0, which makes this the identity it has always been.
export const rotate = (seat, mySeat = 0) =>
  mySeat < 0 ? seat : (seat - mySeat + SEATS) % SEATS;

// Where each rotated position sits. Position 0 is the viewer, drawn as the hand
// along the bottom rather than as an avatar, so it has no entry here.
export const SEAT_POS = {
  1: { left: "2%", top: "46%" },
  2: { left: "20%", top: "4%" },
  3: { right: "20%", top: "4%" },
  4: { right: "2%", top: "46%" },
};

// A played card lands pulled in from its own player's seat, so you can see at a
// glance who played what. Rendering the trick as a neutral row instead loses
// that, and with it most of the readability of a hand.
export const TRICK_POS = {
  0: { left: "50%", top: "72%", transform: "translate(-50%,-50%)" },
  1: { left: "22%", top: "50%", transform: "translate(-50%,-50%)" },
  2: { left: "38%", top: "26%", transform: "translate(-50%,-50%)" },
  3: { left: "62%", top: "26%", transform: "translate(-50%,-50%)" },
  4: { left: "78%", top: "50%", transform: "translate(-50%,-50%)" },
};

export function DealerButton() {
  return (
    <span
      title="Dealer"
      aria-label="Dealer"
      style={{
        width: 18, height: 18, borderRadius: "50%", flexShrink: 0,
        background: felt.cream, color: "#2A2108",
        border: `1.5px solid ${felt.brassDim}`, boxShadow: "0 1px 3px rgba(0,0,0,.5)",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontFamily: "Georgia, serif", fontWeight: 900, fontSize: 11, lineHeight: 1,
        userSelect: "none",
      }}
    >D</span>
  );
}

// The called suit belongs to the picker — they chose it — so it rides on their
// badge stack rather than in a strip of its own. Hearts is the only callable
// red suit (diamonds are trump), and felt.red is tuned for cream card faces, so
// it gets the lighter red that reads on felt.
//
// Glyph and word together, with "Called" dropped — the badge only ever appears
// on the picker's seat, so what it refers to is already answered by where it
// is. The word earns the space the word "Called" gave up: ♠ and ♣ are the pair
// people misread at a glance, and at 9px on a dark felt they are two small
// black clusters. Naming the suit removes the ambiguity that actually costs
// something in a game where going for the wrong ace loses the hand.
function CalledChip({ suit }) {
  return (
    <Badge compact>
      <span style={{ color: suit === "H" ? felt.scoreDown : felt.cream, fontWeight: 900 }}>
        {SUIT_SYM[suit]}
      </span>{" "}
      {SUIT_NAME[suit]}
    </Badge>
  );
}

export function RoleBadges({ g, seat }) {
  if (g.picker === seat) {
    return (
      <>
        <Badge gold>Picker{g.alone ? " · Alone" : ""}</Badge>
        {g.calledSuit && <CalledChip suit={g.calledSuit} />}
      </>
    );
  }
  if (g.partnerRevealed && g.partner === seat) return <Badge gold>Partner</Badge>;
  return null;
}

function SeatAvatar({ g, seat, names, extra }) {
  const active =
    (g.phase === "playing" && g.turn === seat) ||
    (g.phase === "picking" && g.pickTurn === seat);
  const name = names[seat] ?? "";

  return (
    <>
      {/* Avatar and dealer button share a positioning context so the button can
          sit against the avatar's edge the way it sits by a player's elbow at a
          real table, without disturbing the column below it. */}
      <div style={{ position: "relative", width: 44, height: 44 }}>
        <div style={{
          width: 44, height: 44, borderRadius: "50%", background: felt.chip,
          border: `2px solid ${active ? felt.brass : "#ffffff2e"}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "Georgia, serif", fontWeight: 800, fontSize: 19,
          boxShadow: active ? `0 0 10px ${felt.brass}66` : "none",
          transition: "border .2s, box-shadow .2s",
        }}>
          {(name[0] || "?").toUpperCase()}
        </div>
        {g.dealer === seat && (
          <span style={{ position: "absolute", right: -7, bottom: -2 }}><DealerButton /></span>
        )}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700 }}>{name}</div>
      {/* Running score rather than cards remaining. Everyone still holding
          cards has the same number of them as you do, so that count told you
          nothing you couldn't read off your own hand; where each opponent
          stands in the match is the thing you actually want at a glance. */}
      <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: felt.creamDim }}>
          <span style={{ color: scoreColor(g.scores[seat]), fontWeight: 700 }}>
            {g.scores[seat] >= 0 ? "+" : ""}{g.scores[seat]}
          </span>
          {" · "}{g.trickCounts[seat]} {g.trickCounts[seat] === 1 ? "trick" : "tricks"}
        </span>
      </div>
      <RoleBadges g={g} seat={seat} />
      {/* Somewhere for a table to hang presence, idle counters and the like
          without this file having to know what any of that means. */}
      {extra}
    </>
  );
}

/**
 * The felt: four opponents around the edge, the trick in the middle, the blind
 * while nobody has picked.
 *
 * @param {object}   g          game state (local, or a table's redacted view)
 * @param {string[]} names      display name per seat
 * @param {number}   mySeat     the viewer's seat; drawn as the hand, not an avatar
 * @param {Function} seatExtra  optional (seat) => node, rendered under a seat
 * @param {Function} onSeatClick optional (seat) => void
 */
export function Felt({ g, names, mySeat = 0, seatExtra, onSeatClick }) {
  return (
    <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }}>
      {names.map((_, seat) => {
        const pos = SEAT_POS[rotate(seat, mySeat)];
        if (!pos) return null; // the viewer — drawn as the hand below
        return (
          <div
            key={seat}
            onClick={onSeatClick ? () => onSeatClick(seat) : undefined}
            style={{
              position: "absolute", ...pos, width: 84,
              display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
              cursor: onSeatClick ? "pointer" : "default",
              WebkitTapHighlightColor: "transparent", touchAction: "manipulation",
            }}
          >
            <SeatAvatar g={g} seat={seat} names={names} extra={seatExtra?.(seat)} />
          </div>
        );
      })}

      {g.trick.map((t) => (
        <div key={cid(t.card)} style={{ position: "absolute", ...TRICK_POS[rotate(t.player, mySeat)], zIndex: 2 }}>
          <Card card={t.card} small />
        </div>
      ))}

      {g.trick.length === SEATS && (
        <div style={{
          position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
          background: "#000000aa", padding: "4px 12px", borderRadius: 6,
          fontSize: 16, fontWeight: 700, color: felt.brass, zIndex: 3,
        }}>
          {names[trickWinner(g.trick)]} +{g.trick.reduce((s, t) => s + cardPts(t.card), 0)}
        </div>
      )}

      {g.phase === "picking" && g.passes < SEATS && (
        <div style={{
          position: "absolute", left: "50%", top: "44%", transform: "translate(-50%,-50%)",
          display: "flex", gap: 6,
        }}>
          <Card faceDown small /><Card faceDown small />
        </div>
      )}
    </div>
  );
}

/**
 * Your hand, fanned.
 *
 * Takes predicates rather than game state so the two drivers can decide what
 * "playable" means for themselves — locally computed legality in solo, the
 * server's answer at a table — without this file learning about either.
 *
 * @param {object[]} cards
 * @param {Function} isSelected  (card) => boolean
 * @param {Function} isDim       (card) => boolean
 * @param {Function} onCardClick (card) => void | undefined to make it inert
 */
// Measures the row the fan is actually in, rather than the viewport minus a
// guess at the padding. The guess was wrong for both screens and differently
// wrong for each: solo wraps the fan in 10px of padding inside 6px rails, the
// table in 6px and no rails, so a single constant could not describe both. On
// a 375px phone the real width is 343, not the 363 the viewport implied, and
// the fan overhung its row by 7px on each side.
function useRowWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(el.clientWidth);
    measure();
    // Covers rotation and resize, but also the case a viewport listener can't:
    // the row changing width because something else on the page did.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function HandFan({ cards, isSelected, isDim, onCardClick }) {
  const rowRef = useRef(null);
  const rowWidth = useRowWidth(rowRef);

  // Derived, not guessed. This used to be a flat 14px with a 0.9 scale above
  // six cards, which is what made solo's fan overflow — 7px at six cards and
  // 35px at eight. fan.js solves for the tightest overlap that actually fits
  // the width available; fantest covers every hand size at every width.
  //
  // Before the row has been measured there is nothing sensible to compute
  // against, so fall back to the tightest fan rather than the loosest: too
  // tight for one frame is invisible, too loose clips cards off the screen.
  const overlap = rowWidth > 0 ? fanOverlap(cards.length, rowWidth) : MAX_OVERLAP;

  return (
    // The fan holds its height even when empty. The table above is
    // `flex: 1 1 auto`, so when the last card of the hand is played this row
    // would otherwise collapse and hand the table 91px — every seat and every
    // card of the final trick jumping, right at the moment you're watching it
    // resolve.
    <div ref={rowRef} style={{
      display: "flex", justifyContent: "center", alignItems: "flex-start",
      paddingTop: 10, minHeight: CARD_ROW_H,
      // A safety net, not the mechanism: the fan is sized to fit, and a
      // scrollbar here means the geometry is wrong.
      flexWrap: "nowrap", overflowX: "auto",
    }}>
      {cards.map((c, i) => {
        const onClick = onCardClick?.(c);
        return (
          <div key={cid(c)} style={{ marginLeft: i === 0 ? 0 : -overlap, zIndex: i }}>
            <Card
              card={c}
              selected={isSelected?.(c)}
              dim={isDim?.(c)}
              onClick={onClick}
            />
          </div>
        );
      })}
    </div>
  );
}
