import React, { useState, useEffect, useMemo } from "react";
import {
  SUIT_SYM, NAMES, isTrump, cid, cardPts, sortHand, trickWinner, handStrength,
  aiBuryAndCall, aiChooseCard, legalPlays, freshHand, assignPartner, applyPlay,
  resolveTrick,
} from "./engine.js";

/* ================================ UI ================================ */
const felt = {
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

function Card({ card, small, onClick, dim, selected, faceDown, scale = 1 }) {
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

function Badge({ children, gold }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase",
      padding: "2px 6px", borderRadius: 4,
      background: gold ? felt.brass : "#ffffff22",
      color: gold ? "#2A2108" : felt.creamDim,
    }}>{children}</span>
  );
}

export default function Sheepshead() {
  const [g, setG] = useState(() => freshHand(Math.floor(Math.random() * 5), [0, 0, 0, 0, 0], 1));
  const [showScores, setShowScores] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showLastTrick, setShowLastTrick] = useState(false);

  /* ---------- engine loop ---------- */
  useEffect(() => {
    let t;
    if (g.phase === "picking") {
      if (g.passes === 5) {
        t = setTimeout(() => setG((s) => ({ ...freshHand((s.dealer + 1) % 5, s.scores, s.handNum + 1), message: null })), 1600);
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

  const nextHand = () => setG((s) => freshHand((s.dealer + 1) % 5, s.scores, s.handNum + 1));

  /* ---------- derived ---------- */
  const legalNow = useMemo(() => (g.phase === "playing" && g.turn === 0 ? legalPlays(g, 0).map(cid) : []), [g]);
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
  const roleTag = (i) => {
    if (g.picker === i) return <Badge gold>Picker{g.alone ? " · Alone" : ""}</Badge>;
    if (g.partnerRevealed && g.partner === i) return <Badge gold>Partner</Badge>;
    return null;
  };

  const statusLine = () => {
    if (g.phase === "picking") {
      if (g.passes === 5) return "Everyone passed — redealing…";
      return g.pickTurn === 0 ? "Blind's yours if you want it." : `${NAMES[g.pickTurn]} is thinking…`;
    }
    if (g.phase === "bury") return `Bury two cards (${g.selected.length}/2)`;
    if (g.phase === "call") return g.message;
    if (g.phase === "playing") {
      if (g.trick.length === 5) return `${NAMES[trickWinner(g.trick)]} takes the trick`;
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
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: `2px solid ${felt.rail}` }}>
        <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 900, letterSpacing: ".14em", fontSize: 19, color: felt.brass }}>
          SHEEPSHEAD
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowHelp(true)} style={btnGhost}>Trump</button>
          <button onClick={() => setShowScores(true)} style={btnGhost}>Scores</button>
        </div>
      </div>

      {/* Contract strip */}
      <div style={{ flexShrink: 0, display: "flex", gap: 10, alignItems: "center", padding: "5px 12px", fontSize: 15, color: felt.creamDim, minHeight: 28 }}>
        <span>Hand {g.handNum}</span>
        <span>· Dealer: {NAMES[g.dealer]}</span>
        {g.picker !== null && <span>· {NAMES[g.picker]} picked</span>}
        {g.calledSuit && (
          <span style={{ color: felt.brass, fontWeight: 700 }}>
            · Called: A{SUIT_SYM[g.calledSuit]}
          </span>
        )}
        {g.picker !== null && g.alone && <span style={{ color: felt.brass }}>· Alone</span>}
        <span style={{ marginLeft: "auto", fontSize: 8, opacity: 0.35, letterSpacing: ".02em", userSelect: "none" }}>
          v{__APP_VERSION__}
        </span>
      </div>

      {/* Table */}
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} style={{ position: "absolute", ...seatPos[i], display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 84 }}>
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
            <div style={{ fontSize: 13, fontWeight: 700 }}>{NAMES[i]}</div>
            <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: felt.creamDim }}>{g.hands[i].length}🂠 · {g.trickCounts[i]} tricks</span>
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
                Call A<span style={{ color: su === "H" ? "#7A1E14" : "#1c1a14" }}>{SUIT_SYM[su]}</span>
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
          {roleTag(0)}
          <button onClick={() => setShowLastTrick(true)} style={{ ...btnGhost, marginLeft: "auto" }}>Last Trick</button>
        </div>
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 10 }}>
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
      {g.phase === "handEnd" && g.result && (
        <Modal>
          <div style={{ fontFamily: "Georgia, serif", fontSize: 24, fontWeight: 900, color: felt.brass, marginBottom: 4 }}>
            {g.result.pickerWins ? "Picker team wins" : "Defenders win"} {g.result.label && `— ${g.result.label}`}
          </div>
          <div style={{ fontSize: 16, marginBottom: 10, color: felt.creamDim }}>
            {g.result.pickerTeam.map((p) => NAMES[p]).join(" & ")} took {g.result.teamPts} points
            {g.result.buriedPts > 0 && ` (${g.result.buriedPts} buried)`} · defenders {g.result.defPts}
          </div>
          <table style={{ width: "100%", fontSize: 16, borderCollapse: "collapse", marginBottom: 14 }}>
            <tbody>
              {NAMES.map((n, i) => (
                <tr key={n} style={{ borderBottom: "1px solid #ffffff18" }}>
                  <td style={{ padding: "5px 0", fontWeight: i === 0 ? 800 : 500 }}>
                    {n}{" "}
                    {i === g.picker && <Badge gold>Picker</Badge>}{" "}
                    {i === g.partner && <Badge gold>Partner</Badge>}
                  </td>
                  <td style={{ textAlign: "right" }}>{g.ptsTaken[i]} pts</td>
                  <td style={{ textAlign: "right", color: felt.brass, fontWeight: 700, width: 60 }}>
                    {g.scores[i] >= 0 ? "+" : ""}{g.scores[i]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button style={btnGold} onClick={nextHand}>Deal next hand</button>
        </Modal>
      )}

      {/* Scores modal */}
      {showScores && (
        <Modal onClose={() => setShowScores(false)}>
          <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 10 }}>Score</div>
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
        <Modal onClose={() => setShowLastTrick(false)}>
          <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 10 }}>Last Trick</div>
          {g.lastTrick ? (
            <>
              {g.lastTrick.trick.map((t, i) => {
                const red = t.card.suit === "H" || t.card.suit === "D";
                const won = t.player === g.lastTrick.winner;
                return (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #ffffff18", fontSize: 17 }}>
                    <span style={{ fontWeight: i === 0 || won ? 800 : 500 }}>
                      {NAMES[t.player]}
                      {i === 0 && <span style={{ fontSize: 12, color: felt.creamDim, fontWeight: 500 }}> · led</span>}
                      {won && <span style={{ fontSize: 12, color: felt.brass, fontWeight: 700 }}> · won</span>}
                    </span>
                    <span style={{ color: red ? felt.red : felt.cream, fontWeight: 700 }}>
                      {t.card.rank}{SUIT_SYM[t.card.suit]}
                    </span>
                  </div>
                );
              })}
              <div style={{ fontSize: 13, color: felt.creamDim, marginTop: 8 }}>
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

function Modal({ children, onClose }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000a8", zIndex: 20,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: felt.bgDeep, border: `2px solid ${felt.rail}`, borderRadius: 12,
        padding: 18, width: "100%", maxWidth: 380, color: felt.cream,
        boxShadow: "0 10px 40px rgba(0,0,0,.6)",
      }}>
        {children}
      </div>
    </div>
  );
}

const btnGold = {
  background: felt.brass, color: "#241C06", border: "none", borderRadius: 8,
  padding: "9px 18px", fontSize: 17, fontWeight: 800, letterSpacing: ".03em",
  cursor: "pointer", boxShadow: "0 2px 0 #7d6420",
};
const btnPlain = {
  background: "#ffffff14", color: felt.cream, border: "1px solid #ffffff30", borderRadius: 8,
  padding: "9px 18px", fontSize: 17, fontWeight: 700, cursor: "pointer",
};
const btnGhost = {
  background: "transparent", color: felt.creamDim, border: `1px solid ${felt.brassDim}`,
  borderRadius: 6, padding: "4px 10px", fontSize: 13, fontWeight: 700, cursor: "pointer",
  letterSpacing: ".05em",
};
