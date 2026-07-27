import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  SUIT_SYM, SUIT_NAME, NAMES, isTrump, cid, cardPts, sortHand, trickWinner, handStrength,
  aiBuryAndCall, aiChooseCard, legalPlays, freshHand, assignPartner, applyPlay,
  resolveTrick, gradeHandPlays,
} from "./engine.js";

import { felt, scoreColor, Card, CARD_ROW_H, Badge, Modal, btnGold, btnPlain, btnGhost } from "./ui.jsx";

// The house rules this table plays by, shown under the title for the whole
// game. A list rather than a sentence: the planned version of that line lets
// you change them, and each rule has to be addressable for that to work.
const HOUSE_RULES = ["Called Ace", "No Leasters", "Double on the Bump"];

// `onPlayWithFriends` is optional: when supplied, a header button offers the
// multiplayer table. Passed in as a prop rather than imported so this file
// keeps no dependency on the networked half — the solo game must go on working
// with no server at all.
export default function Sheepshead({ onPlayWithFriends }) {
  const [g, setG] = useState(() => freshHand(Math.floor(Math.random() * 5), [0, 0, 0, 0, 0], 1));
  const [showScores, setShowScores] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showLastTrick, setShowLastTrick] = useState(false);
  const [showRecap, setShowRecap] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const recapCaptureRef = useRef(null);

  /* ---------- engine loop ---------- */
  useEffect(() => {
    let t;
    if (g.phase === "picking") {
      if (g.passes === 5) {
        // Nobody picked, so this hand is thrown in and the next one pays
        // double. Stacks if it happens twice running.
        t = setTimeout(() => setG((s) => ({
          ...freshHand((s.dealer + 1) % 5, s.scores, s.handNum + 1, (s.doubler || 1) * 2),
          message: null,
        })), 1600);
      } else if (g.pickTurn !== 0) {
        t = setTimeout(() => setG((s) => {
          if (s.phase !== "picking" || s.pickTurn === 0 || s.passes === 5) return s;
          const idx = s.pickTurn;
          const wants = handStrength(s.hands[idx]) >= 10 || (s.passes === 4 && handStrength(s.hands[idx]) >= 8);
          if (!wants) {
            const passes = s.passes + 1;
            return { ...s, passes, pickTurn: (idx + 1) % 5, message: passes === 5 ? "Everyone passed — throwing it in." : null };
          }
          // AI picks: take blind, bury, call
          const eight = [...s.hands[idx], ...s.blind];
          const { buried, call, hand } = aiBuryAndCall(eight);
          const hands = s.hands.map((h, i) => (i === idx ? sortHand(hand) : h));
          let ns = { ...s, picker: idx, hands, buried, calledSuit: call, phase: "playing", trick: [], turn: s.leader, message: null };
          ns = assignPartner(ns);
          return ns;
        }), 750);
      }
    }
    if (g.phase === "playing") {
      if (g.trick.length === 5) {
        t = setTimeout(() => setG((s) => (s.trick.length === 5 ? resolveTrick(s) : s)), 2625);
      } else if (g.turn !== 0 && g.turn !== -1) {
        t = setTimeout(() => setG((s) => {
          if (s.phase !== "playing" || s.turn === 0 || s.turn === -1 || s.trick.length >= 5) return s;
          const card = aiChooseCard(s, s.turn);
          return applyPlay(s, s.turn, card);
        }), 800);
      }
    }
    return () => clearTimeout(t);
  }, [g.phase, g.pickTurn, g.passes, g.turn, g.trick.length, g.tricksDone]);

  /* ---------- human actions ---------- */
  const humanPick = (pick) => {
    setG((s) => {
      if (pick) {
        const hands = s.hands.map((h, i) => (i === 0 ? sortHand([...h, ...s.blind]) : h));
        return { ...s, picker: 0, hands, phase: "bury", selected: [], message: "Select two cards to bury." };
      }
      const passes = s.passes + 1;
      return { ...s, passes, pickTurn: (s.pickTurn + 1) % 5, message: passes === 5 ? "Everyone passed — throwing it in." : null };
    });
  };

  const toggleBury = (card) => {
    setG((s) => {
      const sel = s.selected.some((c) => cid(c) === cid(card))
        ? s.selected.filter((c) => cid(c) !== cid(card))
        : s.selected.length < 2 ? [...s.selected, card] : s.selected;
      return { ...s, selected: sel };
    });
  };

  const confirmBury = () => {
    setG((s) => {
      if (s.selected.length !== 2) return s;
      const hand = s.hands[0].filter((c) => !s.selected.some((x) => cid(x) === cid(c)));
      const hands = s.hands.map((h, i) => (i === 0 ? hand : h));
      const failsBy = { C: [], S: [], H: [] };
      hand.filter((c) => !isTrump(c)).forEach((c) => failsBy[c.suit].push(c));
      const opts = ["C", "S", "H"].filter(
        (su) =>
          failsBy[su].length > 0 &&
          !failsBy[su].some((c) => c.rank === "A") &&
          !s.selected.some((c) => c.suit === su && c.rank === "A")
      );
      return { ...s, hands, buried: s.selected, selected: [], phase: "call", callOptions: opts, message: opts.length ? "Call an ace — your partner holds it." : "No callable suit. You're going alone." };
    });
  };

  const callAce = (suit) => {
    setG((s) => {
      let ns = { ...s, calledSuit: suit, phase: "playing", trick: [], turn: s.leader, message: null };
      ns = assignPartner(ns);
      return ns;
    });
  };

  const humanPlay = (card) => {
    setG((s) => {
      if (s.phase !== "playing" || s.turn !== 0 || s.trick.length >= 5) return s;
      const legal = legalPlays(s, 0);
      if (!legal.some((c) => cid(c) === cid(card))) return s;
      return applyPlay(s, 0, card);
    });
  };

  const nextHand = () => {
    setShowRecap(false);
    setG((s) => freshHand((s.dealer + 1) % 5, s.scores, s.handNum + 1));
  };

  // Lazily load html2canvas from a CDN only when someone actually taps Share,
  // rather than bundling it for every visitor.
  function loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
      script.onload = () => resolve(window.html2canvas);
      script.onerror = () => reject(new Error("Couldn't load screenshot library"));
      document.head.appendChild(script);
    });
  }

  // Screenshots the recap grid and hands it to the OS share sheet (Messages,
  // Mail, etc.) so testers can send back hands they think the AI misplayed.
  // Falls back gracefully if file-sharing or navigator.share isn't available.
  async function handleShareRecap() {
    if (!recapCaptureRef.current) return;
    try {
      const html2canvas = await loadHtml2Canvas();
      const canvas = await html2canvas(recapCaptureRef.current, { backgroundColor: felt.bgDeep, scale: 2 });
      canvas.toBlob(async (blob) => {
        if (!blob) return;
        const fileName = `sheepshead-hand-${g.handNum}.png`;
        const file = new File([blob], fileName, { type: "image/png" });
        const shareText = `Sheepshead hand ${g.handNum} — take a look at this play.`;
        try {
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: `Sheepshead — Hand ${g.handNum}`, text: shareText });
          } else if (navigator.share) {
            await navigator.share({ title: `Sheepshead — Hand ${g.handNum}`, text: shareText });
          } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName;
            a.click();
            URL.revokeObjectURL(url);
          }
        } catch (shareErr) {
          // AbortError etc. when the user cancels the share sheet — not an error.
        }
      }, "image/png");
    } catch (err) {
      console.error("Recap share failed:", err);
    }
  }

  /* ---------- derived ---------- */
  const legalNow = useMemo(() => (g.phase === "playing" && g.turn === 0 ? legalPlays(g, 0).map(cid) : []), [g]);
  // Best/worst play grading is only meaningful once a hand is fully resolved;
  // recompute once per hand (not on every render) since trickHistory is frozen by then.
  const playGrades = useMemo(
    () => (g.phase === "handEnd" ? gradeHandPlays(g) : { best: null, worst: null }),
    [g.phase, g.handNum]
  );
  const seatPos = [null,
    { left: "2%", top: "46%" },
    { left: "20%", top: "4%" },
    { right: "20%", top: "4%" },
    { right: "2%", top: "46%" },
  ];
  const trickPos = {
    0: { left: "50%", top: "72%", transform: "translate(-50%,-50%)" },
    1: { left: "22%", top: "50%", transform: "translate(-50%,-50%)" },
    2: { left: "38%", top: "26%", transform: "translate(-50%,-50%)" },
    3: { left: "62%", top: "26%", transform: "translate(-50%,-50%)" },
    4: { left: "78%", top: "50%", transform: "translate(-50%,-50%)" },
  };
  // Seat 0 is "You", so anything that reads back a seat name needs the
  // second person or it comes out as "You takes the trick".
  const takesTheTrick = (i) => (i === 0 ? "You take the trick" : `${NAMES[i]} takes the trick`);

  // A lone picker is one person, so "Pickers win" is wrong on exactly the hands
  // where the win is most impressive.
  const outcomeHeadline = () => {
    if (!g.result.pickerWins) return "Defenders win";
    return g.alone || g.partner === null ? "Picker wins" : "Pickers win";
  };

  // The called suit belongs to the picker — they chose it — so it rides on their
  // badge stack rather than in a strip of its own. Hearts is the only callable
  // red suit (diamonds are trump), and `felt.red` is tuned for cream card faces,
  // so it gets the lighter red that reads on felt.
  const calledChip = () => (
    <Badge compact>
      Called{" "}
      <span style={{ color: g.calledSuit === "H" ? felt.scoreDown : felt.cream, fontWeight: 900 }}>
        {SUIT_SYM[g.calledSuit]}
      </span>
    </Badge>
  );

  const roleTag = (i) => {
    if (g.picker === i) return (
      <>
        <Badge gold>Picker{g.alone ? " · Alone" : ""}</Badge>
        {g.calledSuit && calledChip()}
      </>
    );
    if (g.partnerRevealed && g.partner === i) return <Badge gold>Partner</Badge>;
    return null;
  };

  // Poker-style dealer button. Seats 1-4 wear it beside their avatar; seat 0
  // has no avatar on the table, so it sits in the YOUR HAND row instead.
  const dealerButton = () => (
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

  const statusLine = () => {
    if (g.phase === "picking") {
      if (g.passes === 5) return "Everyone passed — redealing…";
      return g.pickTurn === 0 ? "Blind's yours if you want it." : `${NAMES[g.pickTurn]} is thinking…`;
    }
    if (g.phase === "bury") return `Bury two cards (${g.selected.length}/2)`;
    if (g.phase === "call") return g.message;
    if (g.phase === "playing") {
      if (g.trick.length === 5) return takesTheTrick(trickWinner(g.trick));
      return g.turn === 0 ? "Your play." : `${NAMES[g.turn]}'s play…`;
    }
    return "";
  };

  return (
    <div style={{
      height: "100dvh", overflow: "hidden",
      background: `radial-gradient(ellipse at 50% 30%, ${felt.bg}, ${felt.bgDeep} 80%)`,
      color: felt.cream, fontFamily: "'Avenir Next', 'Segoe UI', system-ui, sans-serif",
      display: "flex", flexDirection: "column", maxWidth: 480, margin: "0 auto",
      borderLeft: `6px solid ${felt.rail}`, borderRight: `6px solid ${felt.rail}`,
    }}>
      {/* Header */}
      <div style={{ flexShrink: 0, position: "relative", padding: "8px 12px", borderBottom: `2px solid ${felt.rail}` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 900, letterSpacing: ".14em", fontSize: 19, color: felt.brass }}>
            SHEEPSHEAD
          </div>
          <div style={{ fontSize: 8, opacity: 0.35, letterSpacing: ".02em", userSelect: "none" }}>
            v{__APP_VERSION__}
          </div>
          <button
            onClick={() => setShowMenu((v) => !v)}
            aria-label="Menu"
            aria-haspopup="menu"
            aria-expanded={showMenu}
            style={{ ...btnGhost, display: "flex", alignItems: "center", padding: "5px 9px" }}
          >
            <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M1 1h14M1 6h14M1 11h14" />
            </svg>
          </button>
        </div>

        {/* The house rules, above the rail and there for the whole game. Kept as
            data rather than one sentence because the next version of this line
            lets you change them, and a rule you can toggle has to be an
            addressable thing rather than a substring. Not a button yet — a
            control that does nothing when you press it reads as broken, so it
            stays text until it has somewhere to go. */}
        {/* Wraps rather than squeezes. The rules and the badge together need
            356px and a 375px phone gives 339, so something has to give — and
            it must not be the rules line, which is the permanent thing. The
            badge drops to a second row instead. That changes the header's
            height, which is only safe because a doubler is set when the hand is
            dealt, never mid-hand: the layout settles before a card is played. */}
        <div style={{ marginTop: 4, display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 4, columnGap: 8 }}>
          <div style={{
            flexShrink: 0, fontSize: 11, letterSpacing: ".04em",
            color: felt.creamDim, opacity: 0.75, userSelect: "none", whiteSpace: "nowrap",
          }}>
            {HOUSE_RULES.join(" · ")}
          </div>
          {/* The stake rides with the rules rather than on the table. It was
              briefly at the table's top centre, which collides: the seats sit
              at 4% of the table's height, so on a 667px-tall phone they start
              at y=14 while the badge reaches y=19, and there is no room to put
              it between the two top seats either — that gap is ~50px and the
              badge is ~95px. Up here it is fixed chrome, it cannot collide with
              anything the game draws, and it sits next to the rules that
              explain what doubling means. */}
          {(g.doubler || 1) > 1 && (
            <span style={{
              marginLeft: "auto", flexShrink: 0,
              color: "#2A2108", background: felt.brass,
              fontWeight: 800, fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase",
              padding: "2px 7px", borderRadius: 4, whiteSpace: "nowrap",
            }}>
              Doubler{g.doubler > 2 ? ` ×${g.doubler}` : ""}
            </span>
          )}
        </div>

        {showMenu && (
          <>
            {/* Catches the click that dismisses the menu. Sits under the menu
                but over everything else, so the next tap anywhere closes it
                instead of also hitting a card. */}
            <div onClick={() => setShowMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 15 }} />
            <div role="menu" style={{
              position: "absolute", right: 12, top: "calc(100% - 4px)", zIndex: 16,
              background: felt.bgDeep, border: `2px solid ${felt.rail}`, borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,.5)", overflow: "hidden", minWidth: 150,
            }}>
              {[
                ["Trump order", () => setShowHelp(true)],
                ["Scores", () => setShowScores(true)],
              ].map(([label, open], i) => (
                <button
                  key={label}
                  role="menuitem"
                  onClick={() => { setShowMenu(false); open(); }}
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

      {/* The contract strip is gone. Everything it carried now lives where the
          thing it describes already is: the dealer wears a button, the called
          suit rides on the picker's badge stack, and "picked"/"alone" were
          always duplicated by those same badges. That hands its ~28px back to
          the table, which is the part of the screen you actually look at. */}

      {/* Table */}
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} style={{ position: "absolute", ...seatPos[i], display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 84 }}>
            {/* Avatar and dealer button share a positioning context so the
                button can sit against the avatar's edge the way it sits by a
                player's elbow at a real table, without disturbing the column
                below it. */}
            <div style={{ position: "relative", width: 44, height: 44 }}>
              <div style={{
                width: 44, height: 44, borderRadius: "50%", background: felt.chip,
                border: `2px solid ${g.phase === "playing" && g.turn === i ? felt.brass : (g.phase === "picking" && g.pickTurn === i ? felt.brass : "#ffffff2e")}`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: "Georgia, serif", fontWeight: 800, fontSize: 19,
                boxShadow: (g.turn === i || g.pickTurn === i) ? `0 0 10px ${felt.brass}66` : "none",
                transition: "border .2s, box-shadow .2s",
              }}>
                {NAMES[i][0]}
              </div>
              {g.dealer === i && (
                <span style={{ position: "absolute", right: -7, bottom: -2 }}>{dealerButton()}</span>
              )}
            </div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{NAMES[i]}</div>
            {/* Running score rather than cards remaining. Everyone still
                holding cards has the same number of them as you do, so that
                count told you nothing you couldn't read off your own hand;
                where each opponent stands in the match is the thing you
                actually want at a glance. */}
            <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: felt.creamDim }}>
                <span style={{ color: scoreColor(g.scores[i]), fontWeight: 700 }}>
                  {g.scores[i] >= 0 ? "+" : ""}{g.scores[i]}
                </span>
                {" · "}{g.trickCounts[i]} {g.trickCounts[i] === 1 ? "trick" : "tricks"}
              </span>
            </div>
            {roleTag(i)}
          </div>
        ))}

        {/* trick cards */}
        {g.trick.map((t) => (
          <div key={cid(t.card)} style={{ position: "absolute", ...trickPos[t.player], zIndex: 2 }}>
            <Card card={t.card} small />
          </div>
        ))}
        {g.trick.length === 5 && (
          <div style={{
            position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
            background: "#000000aa", padding: "4px 12px", borderRadius: 6, fontSize: 16, fontWeight: 700, color: felt.brass, zIndex: 3,
          }}>
            {NAMES[trickWinner(g.trick)]} +{g.trick.reduce((s, t) => s + cardPts(t.card), 0)}
          </div>
        )}

        {/* blind marker during picking */}
        {g.phase === "picking" && g.passes < 5 && (
          <div style={{ position: "absolute", left: "50%", top: "44%", transform: "translate(-50%,-50%)", display: "flex", gap: 6 }}>
            <Card faceDown small /><Card faceDown small />
          </div>
        )}
      </div>

      {/* Status + actions */}
      <div style={{ flexShrink: 0, padding: "7px 12px", textAlign: "center", minHeight: 84 }}>
        <div style={{ fontSize: 16, marginBottom: 7, color: felt.creamDim, fontStyle: "italic" }}>{statusLine()}</div>

        {g.phase === "picking" && g.pickTurn === 0 && g.passes < 5 && (
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button style={btnGold} onClick={() => humanPick(true)}>Pick it up</button>
            <button style={btnPlain} onClick={() => humanPick(false)}>Pass</button>
          </div>
        )}

        {g.phase === "bury" && (
          <button style={{ ...btnGold, opacity: g.selected.length === 2 ? 1 : 0.45 }} onClick={confirmBury} disabled={g.selected.length !== 2}>
            Bury {g.selected.length}/2
          </button>
        )}

        {g.phase === "call" && (
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            {(g.callOptions || []).map((su) => (
              <button key={su} style={btnGold} onClick={() => callAce(su)}>
                Call <span style={{ color: su === "H" ? "#7A1E14" : "#1c1a14" }}>{SUIT_SYM[su]}</span> {SUIT_NAME[su]}
              </button>
            ))}
            {(!g.callOptions || g.callOptions.length === 0) && (
              <button style={btnGold} onClick={() => callAce(null)}>Go alone</button>
            )}
          </div>
        )}

        {g.tricksDone > 0 && g.phase === "playing" && (
          <div style={{ fontSize: 13, color: felt.creamDim, marginTop: 4 }}>
            Trick {g.tricksDone + 1} of 6 · You've taken {g.ptsTaken[0]} pts
          </div>
        )}
      </div>

      {/* Your hand */}
      <div style={{ flexShrink: 0, padding: "0 10px calc(14px + env(safe-area-inset-bottom))" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: ".06em" }}>YOUR HAND</div>
          {g.dealer === 0 && dealerButton()}
          {roleTag(0)}
          {/* Sits beside Last Trick rather than in the header: the header row
              already measures 429px of content against 363px of space at
              375px wide, so a third button there clips the title. This row
              has room to spare. */}
          {onPlayWithFriends && (
            <button
              onClick={onPlayWithFriends}
              style={{ ...btnGhost, marginLeft: "auto", borderColor: felt.brass, color: felt.brass }}
            >
              Friends
            </button>
          )}
          <button onClick={() => setShowLastTrick(true)} style={{ ...btnGhost, marginLeft: onPlayWithFriends ? 8 : "auto" }}>Last Trick</button>
        </div>
        {/* The fan holds its height even when empty. The table above is
            `flex: 1 1 auto`, so when the last card of the hand is played this
            row used to collapse and hand the table 91px — every seat and every
            card of the final trick jumped, right at the moment you're watching
            it resolve. Reserving the row keeps the layout exactly as it was
            with cards in front of you. It also settles the smaller 8px shift
            between the burying fan (8 cards at 0.9 scale) and normal play. */}
        <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: 10, minHeight: CARD_ROW_H }}>
          {(() => {
            // More than 6 cards only happens transiently while burying (holding
            // the blind before discarding 2) — shrink the fan a bit so the
            // leftmost card's rank doesn't get crowded off narrow phone widths.
            const fanScale = g.hands[0].length > 6 ? 0.9 : 1;
            const overlap = Math.round(14 * fanScale);
            return g.hands[0].map((c, i) => {
              const inBury = g.phase === "bury";
              const playable = g.phase === "playing" && g.turn === 0 && legalNow.includes(cid(c));
              const selected = g.selected.some((x) => cid(x) === cid(c));
              return (
                <div key={cid(c)} style={{ marginLeft: i === 0 ? 0 : -overlap, zIndex: i }}>
                  <Card
                    card={c}
                    scale={fanScale}
                    selected={selected}
                    dim={g.phase === "playing" && g.turn === 0 && !playable}
                    onClick={
                      inBury ? () => toggleBury(c)
                      : playable ? () => humanPlay(c)
                      : undefined
                    }
                  />
                </div>
              );
            });
          })()}
        </div>
      </div>

      {/* Hand end modal */}
      {g.phase === "handEnd" && g.result && !showRecap && (
        <Modal>
          <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 2 }}>Hand {g.handNum}</div>
          <div style={{ fontFamily: "Georgia, serif", fontSize: 24, fontWeight: 900, color: felt.brass, marginBottom: 4 }}>
            {outcomeHeadline()} {g.result.label && `— ${g.result.label}`}
          </div>
          <div style={{ fontSize: 16, marginBottom: 10, color: felt.creamDim }}>
            {g.result.pickerTeam.map((p) => NAMES[p]).join(" & ")} took {g.result.teamPts} points
            {g.result.buriedPts > 0 && ` (${g.result.buriedPts} buried)`} · defenders {g.result.defPts}
          </div>
          <table style={{ width: "100%", fontSize: 16, borderCollapse: "collapse", marginBottom: 14 }}>
            <thead>
              <tr style={{ fontSize: 11, color: felt.creamDim, textTransform: "uppercase", letterSpacing: ".04em" }}>
                <td style={{ padding: "0 0 4px" }}></td>
                <td style={{ textAlign: "right", padding: "0 0 4px" }}>Pts</td>
                <td style={{ textAlign: "right", padding: "0 0 4px" }}>Hand</td>
                <td style={{ textAlign: "right", padding: "0 0 4px" }}>Total</td>
              </tr>
            </thead>
            <tbody>
              {NAMES.map((n, i) => (
                <tr key={n} style={{ borderBottom: "1px solid #ffffff18" }}>
                  <td style={{ padding: "5px 0", fontWeight: i === 0 ? 800 : 500 }}>
                    {n}{" "}
                    {i === g.picker && <Badge gold>Picker</Badge>}{" "}
                    {i === g.partner && <Badge gold>Partner</Badge>}
                  </td>
                  <td style={{ textAlign: "right" }}>{g.ptsTaken[i]} pts</td>
                  <td style={{ textAlign: "right", color: felt.brass, fontWeight: 700, width: 50 }}>
                    {g.result.handDelta[i] >= 0 ? "+" : ""}{g.result.handDelta[i]}
                  </td>
                  <td style={{ textAlign: "right", color: felt.brass, fontWeight: 700, width: 60 }}>
                    {g.scores[i] >= 0 ? "+" : ""}{g.scores[i]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 10 }}>
            <button style={btnGold} onClick={nextHand}>Deal next hand</button>
            <button style={btnPlain} onClick={() => setShowRecap(true)}>Recap</button>
          </div>
        </Modal>
      )}

      {/* Hand recap modal */}
      {g.phase === "handEnd" && showRecap && (
        <Modal maxWidth={480} onClose={() => setShowRecap(false)}>
          {/* Only the Share button lives outside the capture now. Hand number
              and build moved inside it, because this screenshot is the format
              hands actually get reported in — and a reported hand is evidence
              about a specific AI build. Without the version stamped into the
              image, "the AI misplayed this" can't be matched to what the AI was
              at the time. */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 2 }}>
            <button
              onClick={handleShareRecap}
              aria-label="Share this recap"
              title="Share this recap"
              style={{ ...btnGhost, display: "flex", alignItems: "center", gap: 5, padding: "6px 10px" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 15V3M12 3l-4 4M12 3l4 4" />
                <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
              </svg>
              Share
            </button>
          </div>
          <div ref={recapCaptureRef} style={{ background: felt.bgDeep }}>
          <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 2 }}>
            Hand {g.handNum}
            <span style={{ opacity: 0.55 }}> · v{__APP_VERSION__}</span>
          </div>
          {/* The hand-end summary is repeated here, and sits inside the capture
              region on purpose: a recap gets shared to argue about a hand, and
              the trick grid alone doesn't say who won or by how much. The
              buried cards replace the old "(N buried)" count — they're the one
              part of the hand nobody at the table ever gets to see, and the
              recap is the only place they can be shown. */}
          <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 4 }}>
            {outcomeHeadline()} {g.result.label && `— ${g.result.label}`}
          </div>
          <div style={{ fontSize: 15, color: felt.creamDim, marginBottom: 8 }}>
            {g.result.pickerTeam.map((p) => NAMES[p]).join(" & ")} took {g.result.teamPts} points
            {" · "}defenders {g.result.defPts}
          </div>
          {/* Rank-and-suit glyphs, not card faces — the same shorthand the grid
              below uses, so the whole recap reads in one visual language and
              the buried pair doesn't outweigh the 30 cards that were played. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 13 }}>
            <span style={{ fontSize: 11, color: felt.creamDim, letterSpacing: ".04em", textTransform: "uppercase" }}>Buried</span>
            {g.buried.map((c) => (
              <span key={cid(c)} style={{ color: c.suit === "H" || c.suit === "D" ? felt.red : felt.cream, fontWeight: 700 }}>
                {c.rank}{SUIT_SYM[c.suit]}
              </span>
            ))}
          </div>
          <div style={{ overflowX: "auto", marginBottom: 14 }}>
            <table style={{ borderCollapse: "collapse", fontSize: 13, minWidth: "100%" }}>
              <thead>
                <tr>
                  {/* "TRICK" labels the row once, in the otherwise-empty name
                      column, so each heading is just its number. Repeating the
                      word six times cost width in the one place the grid is
                      tightest — at 375px every heading wrapped onto two lines. */}
                  <td style={{ padding: "0 6px 6px 0", color: felt.creamDim, fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em", whiteSpace: "nowrap" }}>
                    Trick
                  </td>
                  {[1, 2, 3, 4, 5, 6].map((t) => (
                    <td key={t} style={{ textAlign: "center", padding: "0 4px 6px", color: felt.creamDim, fontSize: 12, fontWeight: 700 }}>
                      {t}
                    </td>
                  ))}
                </tr>
              </thead>
              <tbody>
                {NAMES.map((n, p) => (
                  <tr key={n} style={{ borderTop: "1px solid #ffffff18" }}>
                    {/* Badges stack under the name rather than sitting beside
                        it: the grid already scrolls sideways on a phone, and a
                        wider name column eats the tricks you're trying to read. */}
                    <td style={{ padding: "6px 6px 6px 0", fontWeight: p === 0 ? 800 : 500, whiteSpace: "nowrap" }}>
                      <div>{n}</div>
                      {p === g.picker && (
                        <div style={{ marginTop: 3 }}><Badge gold compact>Picker</Badge></div>
                      )}
                      {p === g.picker && g.alone && (
                        <div style={{ marginTop: 3 }}><Badge compact>Alone</Badge></div>
                      )}
                      {p === g.partner && (
                        <div style={{ marginTop: 3 }}><Badge gold compact>Partner</Badge></div>
                      )}
                    </td>
                    {g.trickHistory.map((th, t) => {
                      const played = th.trick.find((x) => x.player === p);
                      if (!played) return <td key={t} />;
                      const { card } = played;
                      const isLeader = th.trick[0].player === p;
                      const isWinner = th.winner === p;
                      const red = card.suit === "H" || card.suit === "D";
                      const isBestPlay = playGrades.best && playGrades.best.trick === t && playGrades.best.player === p;
                      const isWorstPlay = playGrades.worst && playGrades.worst.trick === t && playGrades.worst.player === p;
                      return (
                        <td key={t} style={{ textAlign: "center", padding: "6px 4px" }}>
                          <span style={{
                            display: "inline-block",
                            color: red ? felt.red : felt.cream,
                            fontWeight: isWinner ? 800 : 500,
                            background: isWinner ? "#00000040" : "transparent",
                            borderRadius: 4,
                            padding: "2px 4px",
                            borderBottom: isLeader ? `2px solid ${felt.brass}` : "2px solid transparent",
                          }}>
                            {card.rank}{SUIT_SYM[card.suit]}
                            {isBestPlay && <span style={{ color: "#4FAE64", fontWeight: 900, marginLeft: 2 }}>!</span>}
                            {isWorstPlay && <span style={{ color: felt.red, fontWeight: 900, marginLeft: 2 }}>?</span>}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: felt.creamDim, marginBottom: 14 }}>
            <span style={{ borderBottom: `2px solid ${felt.brass}` }}>underline</span> = led the trick · shaded = won the trick
            <br />
            <span style={{ color: "#4FAE64", fontWeight: 900 }}>!</span> best play · <span style={{ color: felt.red, fontWeight: 900 }}>?</span> worst play
          </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button style={btnGold} onClick={nextHand}>Deal next hand</button>
            <button style={btnPlain} onClick={() => setShowRecap(false)}>Back</button>
          </div>
        </Modal>
      )}

      {/* Scores modal */}
      {showScores && (
        <Modal onClose={() => setShowScores(false)}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
            <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass }}>Score</div>
            <div style={{ fontSize: 13, color: felt.creamDim }}>Hand {g.handNum}</div>
          </div>
          {NAMES.map((n, i) => (
            <div key={n} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #ffffff18", fontSize: 17 }}>
              <span style={{ fontWeight: i === 0 ? 800 : 500 }}>{n}</span>
              <span style={{ color: felt.brass, fontWeight: 700 }}>{g.scores[i] >= 0 ? "+" : ""}{g.scores[i]}</span>
            </div>
          ))}
          <div style={{ marginTop: 12 }}>
            <button style={btnPlain} onClick={() => setShowScores(false)}>Close</button>
          </div>
        </Modal>
      )}

      {/* Last trick modal */}
      {showLastTrick && (
        <Modal maxWidth={420} onClose={() => setShowLastTrick(false)}>
          <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 10 }}>Last Trick</div>
          {g.lastTrick ? (
            <>
              <div style={{ position: "relative", height: 250, margin: "4px 0 10px" }}>
                {[0, 1, 2, 3, 4].map((i) => {
                  const t = g.lastTrick.trick.find((x) => x.player === i);
                  const isLeader = g.lastTrick.trick[0].player === i;
                  const isWinner = i === g.lastTrick.winner;
                  const pos = i === 0
                    ? { left: "50%", bottom: 0, transform: "translateX(-50%)" }
                    : seatPos[i];
                  return (
                    <div key={i} style={{ position: "absolute", ...pos, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, width: 74 }}>
                      <div style={{
                        width: 38, height: 38, borderRadius: "50%", background: felt.chip,
                        border: `2px solid ${isLeader ? felt.brass : "#ffffff2e"}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontFamily: "Georgia, serif", fontWeight: 800, fontSize: 16,
                        boxShadow: isWinner ? `0 0 10px ${felt.brass}aa` : "none",
                      }}>
                        {NAMES[i][0]}
                      </div>
                      <div style={{ fontSize: 11, fontWeight: isWinner ? 800 : 600, color: isWinner ? felt.brass : felt.cream, textAlign: "center" }}>
                        {NAMES[i]}
                      </div>
                      <div style={{ minHeight: 46 }}>{t && <Card card={t.card} small />}</div>
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: 11, color: felt.creamDim, textAlign: "center" }}>
                <span style={{ color: felt.brass, fontWeight: 700 }}>Gold ring</span> = led this trick · <span style={{ color: felt.brass, fontWeight: 700 }}>glow</span> = won it
              </div>
              <div style={{ fontSize: 13, color: felt.creamDim, marginTop: 6, textAlign: "center" }}>
                {NAMES[g.lastTrick.winner]} took {g.lastTrick.trick.reduce((s, t) => s + cardPts(t.card), 0)} pts
              </div>
            </>
          ) : (
            <div style={{ fontSize: 16, color: felt.creamDim }}>No trick played yet this hand.</div>
          )}
          <div style={{ marginTop: 12 }}>
            <button style={btnPlain} onClick={() => setShowLastTrick(false)}>Close</button>
          </div>
        </Modal>
      )}

      {/* Trump help modal */}
      {showHelp && (
        <Modal onClose={() => setShowHelp(false)}>
          <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 8 }}>Trump order</div>
          <div style={{ fontSize: 16, lineHeight: 1.7, color: felt.creamDim }}>
            <div style={{ color: felt.cream, fontWeight: 700 }}>Q♣ Q♠ Q♥ Q♦ · J♣ J♠ J♥ J♦ · A♦ 10♦ K♦ 9♦ 8♦ 7♦</div>
            <div style={{ marginTop: 8 }}>All queens, jacks, and diamonds are trump (marked with a gold dot). Fail suits rank A, 10, K, 9, 8, 7.</div>
            <div style={{ marginTop: 8 }}>Points: A=11, 10=10, K=4, Q=3, J=2. Picker's team needs 61 of 120.</div>
            <div style={{ marginTop: 8 }}>The player holding the called ace is the picker's secret partner and must play it when the suit is led.</div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button style={btnPlain} onClick={() => setShowHelp(false)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
