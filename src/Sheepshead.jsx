import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  SUIT_SYM, SUIT_NAME, NAMES, isTrump, cid, sortHand, trickWinner, handStrength,
  aiBuryAndCall, aiChooseCard, legalPlays, freshHand, assignPartner, applyPlay,
  resolveTrick, gradeHandPlays,
} from "./engine.js";

import { felt, btnGold, btnPlain, btnGhost } from "./ui.jsx";
import { Felt, HandFan, RoleBadges, DealerButton } from "./felt.jsx";
import { TableHeader } from "./header.jsx";
import { HandEndModal, RecapModal, ScoresModal, LastTrickModal, TrumpModal } from "./modals.jsx";
import { HOUSE_RULES } from "./rules.js";
import { shareRecap } from "./shareRecap.js";

// The house rules moved to rules.js so a table can copy the same list onto the
// table object, where they have to be state rather than a constant. Solo reads
// the constant directly: one player, so agreement is free.

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

  /* ---------- derived ---------- */
  const legalNow = useMemo(() => (g.phase === "playing" && g.turn === 0 ? legalPlays(g, 0).map(cid) : []), [g]);
  // Best/worst play grading is only meaningful once a hand is fully resolved;
  // recompute once per hand (not on every render) since trickHistory is frozen by then.
  const playGrades = useMemo(
    () => (g.phase === "handEnd" ? gradeHandPlays(g) : { best: null, worst: null }),
    [g.phase, g.handNum]
  );
  // Seat 0 is "You", so anything that reads back a seat name needs the
  // second person or it comes out as "You takes the trick".
  const takesTheTrick = (i) => (i === 0 ? "You take the trick" : `${NAMES[i]} takes the trick`);

  // A lone picker is one person, so "Pickers win" is wrong on exactly the hands
  // where the win is most impressive.


  // Poker-style dealer button. Seats 1-4 wear it beside their avatar; seat 0
  // has no avatar on the table, so it sits in the YOUR HAND row instead.

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
      {/* Header lives in header.jsx alongside the felt, so a table renders
          the same chrome rather than a second copy. The menu is passed as data
          because that is where the two halves genuinely differ — a table adds
          Invite and, later, a profile. */}
      <TableHeader
        rules={HOUSE_RULES}
        doubler={g.doubler || 1}
        menuItems={[
          { label: "Trump order", onSelect: () => setShowHelp(true) },
          { label: "Scores", onSelect: () => setShowScores(true) },
          // Only when a host supplied a handler — the solo game keeps no
          // dependency on the networked half and must work with no server.
          // Labelled for what it does today: it starts a fresh table, leaving
          // the hand in progress behind. Once a table can be seeded with the
          // running score this becomes "Invite others" and the game carries
          // over.
          ...(onPlayWithFriends ? [{ label: "Play with friends", onSelect: onPlayWithFriends }] : []),
        ]}
      />

      {/* Table. The felt lives in felt.jsx so the multiplayer table renders
          from the same components rather than a second copy that drifts —
          which is exactly what happened over the last week. Solo passes its
          fixed cast and seat 0; a table passes real names and whichever seat
          you got. */}
      <Felt g={g} names={NAMES} mySeat={0} />

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
          {g.dealer === 0 && <DealerButton />}
          <RoleBadges g={g} seat={0} />
          {/* "Friends" used to live here — beside Last Trick rather than in the
              header, because the header couldn't fit a third button. The menu
              solves that properly, so it has moved there and this row is back
              to carrying one thing. */}
          <button onClick={() => setShowLastTrick(true)} style={{ ...btnGhost, marginLeft: "auto" }}>Last Trick</button>
        </div>
        {/* The fan holds its height even when empty. The table above is
            `flex: 1 1 auto`, so when the last card of the hand is played this
            row used to collapse and hand the table 91px — every seat and every
            card of the final trick jumped, right at the moment you're watching
            it resolve. Reserving the row keeps the layout exactly as it was
            with cards in front of you. It also settles the smaller 8px shift
            between the burying fan (8 cards at 0.9 scale) and normal play. */}
        <HandFan
          cards={g.hands[0]}
          isSelected={(c) => g.selected.some((x) => cid(x) === cid(c))}
          isDim={(c) => g.phase === "playing" && g.turn === 0 && !legalNow.includes(cid(c))}
          onCardClick={(c) => {
            if (g.phase === "bury") return () => toggleBury(c);
            if (g.phase === "playing" && g.turn === 0 && legalNow.includes(cid(c))) return () => humanPlay(c);
            return undefined;
          }}
        />
      </div>

      {g.phase === "handEnd" && g.result && !showRecap && (
        <HandEndModal
          g={g}
          names={NAMES}
          onNext={nextHand}
          onRecap={() => setShowRecap(true)}
        />
      )}

      {g.phase === "handEnd" && showRecap && (
        <RecapModal
          g={g}
          names={NAMES}
          grades={playGrades}
          captureRef={recapCaptureRef}
          onShare={() => shareRecap(recapCaptureRef.current, g.handNum)}
          onBack={() => setShowRecap(false)}
          onNext={nextHand}
        />
      )}

      {showScores && (
        <ScoresModal
          names={NAMES}
          scores={g.scores}
          handNum={g.handNum}
          mySeat={0}
          onClose={() => setShowScores(false)}
        />
      )}

      {showLastTrick && (
        <LastTrickModal
          lastTrick={g.lastTrick}
          names={NAMES}
          onClose={() => setShowLastTrick(false)}
        />
      )}

      {showHelp && <TrumpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}
