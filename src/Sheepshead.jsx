import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  pickBotNames, cid, sortHand, handStrength,
  aiBuryAndCall, aiChooseCard, legalPlays, freshHand, assignPartner, applyPlay, callOptions,
  resolveTrick, SUIT_NAME,
} from "./engine.js";

import { felt, btnGold, btnPlain, btnGhost } from "./ui.jsx";
import { Felt, HandFan, HandLabel } from "./felt.jsx";
import { TableHeader } from "./header.jsx";
import { HandEndModal, RecapModal, ScoresModal, LastTrickModal, TrumpModal } from "./modals.jsx";
import { HOUSE_RULES } from "./rules.js";
import { shareRecap } from "./shareRecap.js";
import { statusLine, progressLine } from "./status.js";
import { CallButtons } from "./decisions.jsx";
import { useHandGrade } from "./useHandGrade.js";
import { recordHand, installExportGlobal } from "./handLog.js";

// The house rules moved to rules.js so a table can copy the same list onto the
// table object, where they have to be state rather than a constant. Solo reads
// the constant directly: one player, so agreement is free.

// `onPlayWithFriends` is optional: when supplied, a header button offers the
// multiplayer table. Passed in as a prop rather than imported so this file
// keeps no dependency on the networked half — the solo game must go on working
// with no server at all.
export default function Sheepshead({ onPlayWithFriends }) {
  const [g, setG] = useState(() => freshHand(Math.floor(Math.random() * 5), [0, 0, 0, 0, 0], 1));
  // Picked once per session, not per hand — the score column tracks a name
  // across a whole sitting, so changing it mid-session would orphan history.
  const [names] = useState(() => pickBotNames());
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
          const { buried, call, callRank, callKind, underCard, hand } = aiBuryAndCall(eight);
          const hands = s.hands.map((h, i) => (i === idx ? sortHand(hand) : h));
          let ns = {
            ...s, picker: idx, hands, buried,
            calledSuit: call,
            calledRank: call === null ? null : callRank,
            calledUnder: callKind === "under",
            underCard: underCard ?? null,
            phase: "playing", trick: [], turn: s.leader, message: null,
          };
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
      // The rule lives in the engine now — it was written out here and again
      // on the table screen, which is two places for one rule.
      const opts = callOptions(hand, s.selected);
      return { ...s, hands, buried: s.selected, selected: [], phase: "call", callOptions: opts };
    });
  };

  // Takes the whole option, not a suit: the call is a (suit, rank) pair now,
  // because the picker who holds every fail ace calls a ten instead.
  const callAce = (opt) => {
    setG((s) => {
      // An under call is not finished at the call. The picker still has to say
      // which of their six cards stands in for the suit, so it gets its own
      // step — without it the picker would simply be exempt from their own call.
      const under = Boolean(opt && opt.kind === "under");
      let ns = {
        ...s,
        calledSuit: opt ? opt.suit : null,
        calledRank: opt ? opt.rank : null,
        calledUnder: under,
        underCard: null,
        phase: under ? "under" : "playing",
        trick: [], turn: s.leader, message: null,
      };
      if (!under) ns = assignPartner(ns);
      return ns;
    });
  };

  const designateUnder = (card) => {
    setG((s) => {
      if (s.phase !== "under") return s;
      // The card stays in hand — it is not spent, it is spoken for. It leaves
      // when the called suit is led, like any other card of that suit.
      return assignPartner({ ...s, underCard: card, phase: "playing" });
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
  // Only meaningful once a hand is fully resolved, and it now grades from
  // trick 1, which is too slow to sit on the render path — see useHandGrade.
  const playGrades = useHandGrade(g, g.phase === "handEnd");

  // Keep a local record of finished hands so human play can be compared
  // against the engine's offline — see handLog.js. Nothing leaves the browser;
  // export is a console call, not a feature.
  useEffect(() => { installExportGlobal(); }, []);
  useEffect(() => {
    if (g.phase === "handEnd") recordHand(g, __APP_VERSION__, 0);
  }, [g.phase, g.handNum]);

  // A lone picker is one person, so "Pickers win" is wrong on exactly the hands
  // where the win is most impressive.


  // Poker-style dealer button. Seats 1-4 wear it beside their avatar; seat 0
  // has no avatar on the table, so it sits in the YOUR HAND row instead.


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
      <Felt g={g} names={names} mySeat={0} />

      {/* Status + actions */}
      <div style={{ flexShrink: 0, padding: "7px 12px", textAlign: "center", minHeight: 84 }}>
        <div style={{ fontSize: 16, marginBottom: 7, color: felt.creamDim, fontStyle: "italic" }}>
          {statusLine({ g, names, mySeat: 0, isMyTurn: g.turn === 0, selected: g.selected.length, options: g.callOptions })}
        </div>

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
          <CallButtons options={g.callOptions} onCall={callAce} />
        )}

        {g.phase === "under" && (
          <div style={{ fontSize: 13, color: felt.creamDim }}>
            Tap a card — it plays as the lowest {SUIT_NAME[g.calledSuit]} and stays face down.
          </div>
        )}

        {progressLine({ g, mySeat: 0 }) && (
          <div style={{ fontSize: 13, color: felt.creamDim, marginTop: 4 }}>
            {progressLine({ g, mySeat: 0 })}
          </div>
        )}
      </div>

      {/* Your hand */}
      <div style={{ flexShrink: 0, padding: "0 10px calc(14px + env(safe-area-inset-bottom))" }}>
        <HandLabel g={g} seat={0} name={names[0]}>
          <button onClick={() => setShowLastTrick(true)} style={{ ...btnGhost, marginLeft: "auto" }}>Last Trick</button>
        </HandLabel>
        {/* The fan holds its height even when empty. The table above is
            `flex: 1 1 auto`, so when the last card of the hand is played this
            row used to collapse and hand the table 91px — every seat and every
            card of the final trick jumped, right at the moment you're watching
            it resolve. Reserving the row keeps the layout exactly as it was
            with cards in front of you. It also settles the smaller 8px shift
            between the burying fan (8 cards at 0.9 scale) and normal play. */}
        <HandFan
          dealKey={g.handNum}
          cards={g.hands[0]}
          isSelected={(c) => g.selected.some((x) => cid(x) === cid(c))}
          isDim={(c) => g.phase === "playing" && g.turn === 0 && !legalNow.includes(cid(c))}
          onCardClick={(c) => {
            if (g.phase === "bury") return () => toggleBury(c);
            if (g.phase === "under") return () => designateUnder(c);
            if (g.phase === "playing" && g.turn === 0 && legalNow.includes(cid(c))) return () => humanPlay(c);
            return undefined;
          }}
        />
      </div>

      {g.phase === "handEnd" && g.result && !showRecap && (
        <HandEndModal
          g={g}
          names={names}
          onNext={nextHand}
          onRecap={() => setShowRecap(true)}
        />
      )}

      {g.phase === "handEnd" && showRecap && (
        <RecapModal
          g={g}
          names={names}
          grades={playGrades}
          captureRef={recapCaptureRef}
          onShare={() => shareRecap(recapCaptureRef.current, g.handNum)}
          onBack={() => setShowRecap(false)}
          onNext={nextHand}
        />
      )}

      {showScores && (
        <ScoresModal
          names={names}
          scores={g.scores}
          handNum={g.handNum}
          mySeat={0}
          onClose={() => setShowScores(false)}
        />
      )}

      {showLastTrick && (
        <LastTrickModal
          lastTrick={g.lastTrick}
          names={names}
          onClose={() => setShowLastTrick(false)}
        />
      )}

      {showHelp && <TrumpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}
