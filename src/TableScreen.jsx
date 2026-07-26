/* ============================================================================
   The live multiplayer table — MP-1, MP-2, MP-3.

   Renders entirely from the server's redacted view. There is no local game
   state here and there must not be: `table.g` arrived as viewFor(g, mySeat),
   so other players' hands are literally absent rather than hidden by CSS. Any
   attempt to compute something from a hand that isn't yours will find `null`,
   which is the intended failure.

   Deliberately NOT sharing state with Sheepshead.jsx. That file is the solo
   game, still live on noschnitz.com and driving its own engine loop locally.
   Solo eventually becomes the 1-human + 4-AI case of this screen (MP-2.4), but
   converging them now would put a network round trip behind every card in a
   game that currently works offline — and destabilise the thing that's
   shipped while this half is still being built.

   Seat geometry: the server's seat indices are absolute (seat 0 is whoever
   created the table). Players expect to sit at the bottom of their own screen,
   so every seat is rotated by `mySeat` for display — see `rotate()`.
   ========================================================================= */
import React, { useState, useEffect, useCallback } from "react";
import { SUIT_SYM, SUIT_NAME, cid, legalPlays } from "./engine.js";
import { felt, Card, Badge, Modal, btnGold, btnPlain, btnGhost } from "./ui.jsx";
import { useTableStream } from "./useTableStream.js";
import * as api from "./api.js";

const SEATS = 5;

// Absolute seat -> screen position, with the viewer always at the bottom.
const rotate = (seat, mySeat) => (mySeat < 0 ? seat : (seat - mySeat + SEATS) % SEATS);

// Where each rotated position sits around the felt. Position 0 is the viewer
// (rendered as the hand at the bottom, not as an avatar).
const SEAT_POS = [
  null,
  { left: "6%", top: "46%" },
  { left: "26%", top: "8%" },
  { right: "26%", top: "8%" },
  { right: "6%", top: "46%" },
];

function Avatar({ seat, table, isTurn }) {
  const s = table.seats[seat];
  const g = table.g;
  const initial = (s.name || "?").trim()[0]?.toUpperCase() || "?";
  const isPicker = g && g.picker === seat;
  const isPartner = g && g.partner === seat;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
      <div style={{
        width: 46, height: 46, borderRadius: "50%", background: felt.chip,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "Georgia, serif", fontSize: 20, fontWeight: 800, color: felt.cream,
        border: `2px solid ${isTurn ? felt.brass : "#ffffff22"}`,
        boxShadow: isTurn ? `0 0 12px ${felt.brass}` : "none",
      }}>{initial}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: felt.cream, whiteSpace: "nowrap" }}>
        {s.name}
      </div>
      <div style={{ fontSize: 10, color: felt.creamDim, whiteSpace: "nowrap" }}>
        {/* MP-2.2 — which seats are people and which are the house AI. */}
        {s.kind === "ai" ? "AI" : "•"} {g ? `${g.handCounts?.[seat] ?? 0}🂠` : ""}
      </div>
      {isPicker && <Badge gold compact>Picker</Badge>}
      {isPartner && <Badge gold compact>Partner</Badge>}
    </div>
  );
}

/* ------------------------------- The lobby -------------------------------- */

function Lobby({ table, mySeat, onStart, busy, err }) {
  const [copied, setCopied] = useState(false);
  const url = api.tableUrl(table.id);

  // MP-1.2/1.3: the link is the whole invitation mechanism, so copying it has
  // to be one tap. navigator.share is preferred on phones (it opens Messages
  // directly, which is where this group actually coordinates).
  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: "Sheepshead", text: "Join my table", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* user dismissed the share sheet */ }
  };

  const humans = table.seats.filter((s) => s.kind === "human").length;

  return (
    <div style={{ padding: 20, color: felt.cream, maxWidth: 460, margin: "0 auto" }}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 26, fontWeight: 900, color: felt.brass }}>
        Your table
      </div>
      <div style={{ fontSize: 14, color: felt.creamDim, marginBottom: 14 }}>
        Send the link. Empty seats are played by the AI, so you can start whenever
        you like — nobody has to wait for a fifth.
      </div>

      <div style={{
        display: "flex", gap: 8, alignItems: "center", marginBottom: 6,
        background: "#00000030", borderRadius: 8, padding: "8px 10px",
      }}>
        <code style={{ flex: 1, fontSize: 13, color: felt.creamDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {url}
        </code>
        <button style={btnGhost} onClick={share}>{copied ? "Copied" : "Share"}</button>
      </div>

      <div style={{ marginTop: 18, marginBottom: 8, fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: felt.creamDim }}>
        At the table — {humans} {humans === 1 ? "person" : "people"}
      </div>
      {table.seats.map((s, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: 8, padding: "7px 0",
          borderBottom: "1px solid #ffffff18",
        }}>
          <span style={{ fontWeight: i === mySeat ? 800 : 500 }}>{s.name}</span>
          {i === mySeat && <Badge>You</Badge>}
          {s.kind === "ai" && <Badge>AI</Badge>}
          {i === table.hostSeat && <Badge gold>Host</Badge>}
        </div>
      ))}

      {/* MP-2.3 — queued players are visible so the table knows they're there. */}
      {table.pendingJoins?.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: felt.creamDim }}>
          {table.pendingJoins.map((p) => p.name).join(", ")} joining next hand
        </div>
      )}

      {err && <div style={{ color: felt.red, marginTop: 12, fontSize: 14 }}>{err}</div>}

      {table.youAreHost ? (
        <button style={{ ...btnGold, marginTop: 18, width: "100%" }} disabled={busy} onClick={onStart}>
          {busy ? "Dealing…" : "Deal the first hand"}
        </button>
      ) : (
        <div style={{ marginTop: 18, fontSize: 14, color: felt.creamDim }}>
          Waiting for {table.seats[table.hostSeat]?.name || "the host"} to deal…
        </div>
      )}
    </div>
  );
}

/* --------------------------------- Table ---------------------------------- */

export default function TableScreen({ tableId, playerId, playerName }) {
  const { table, connected, error } = useTableStream(tableId, playerId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState([]);

  // Any action can lose a compare-and-swap. When it does, the winning state is
  // already on its way down the stream, so surfacing the conflict as an error
  // would flash a scary message at something that self-heals.
  const act = useCallback(async (fn) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      if (e.code !== "conflict") setErr(e.message || "That didn't work.");
    } finally {
      setBusy(false);
    }
  }, []);

  if (error) {
    return <Centered>{error}</Centered>;
  }
  if (!table) {
    return <Centered>{connected ? "Loading the table…" : "Connecting…"}</Centered>;
  }

  const mySeat = table.you;
  const g = table.g;

  // A spectator or a queued joiner holds the link but has no seat yet.
  if (mySeat < 0) {
    return (
      <Centered>
        <div style={{ marginBottom: 8 }}>You're in the queue.</div>
        <div style={{ fontSize: 14, color: felt.creamDim }}>
          You'll be seated at the start of the next hand.
        </div>
      </Centered>
    );
  }

  if (!g) {
    return (
      <Lobby
        table={table}
        mySeat={mySeat}
        busy={busy}
        err={err}
        onStart={() => act(() => api.startHand(tableId, playerId))}
      />
    );
  }

  const myHand = g.hands[mySeat] || [];
  const isMyTurn = g.phase === "playing" && g.turn === mySeat;
  const legal = isMyTurn ? legalPlays(g, mySeat).map(cid) : [];

  const onCardClick = (card) => {
    if (g.phase === "bury") {
      // Two to bury, then the call.
      setSelected((cur) =>
        cur.some((c) => cid(c) === cid(card))
          ? cur.filter((c) => cid(c) !== cid(card))
          : cur.length < 2 ? [...cur, card] : cur
      );
      return;
    }
    if (!isMyTurn || !legal.includes(cid(card))) return;
    act(() => api.playCard(tableId, playerId, card));
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: felt.bg, color: felt.cream,
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* Contract strip */}
      <div style={{
        padding: "8px 12px", fontSize: 13, color: felt.creamDim,
        borderBottom: `2px solid ${felt.rail}`, display: "flex", gap: 10, alignItems: "center",
      }}>
        <span style={{ fontWeight: 700 }}>Hand {g.handNum}</span>
        {g.picker !== null && <span>{table.seats[g.picker].name} picked</span>}
        {g.calledSuit && (
          <span style={{ color: felt.brass, fontWeight: 700 }}>
            Called: {SUIT_SYM[g.calledSuit]} {SUIT_NAME[g.calledSuit]}
          </span>
        )}
        {g.alone && <Badge>Alone</Badge>}
        <span style={{ marginLeft: "auto", opacity: connected ? 0 : 1, transition: "opacity .3s" }}>
          reconnecting…
        </span>
      </div>

      {/* Felt with the other four seats and the current trick */}
      <div style={{ flex: 1, position: "relative" }}>
        {table.seats.map((_, seat) => {
          if (seat === mySeat) return null;
          const pos = SEAT_POS[rotate(seat, mySeat)];
          if (!pos) return null;
          return (
            <div key={seat} style={{ position: "absolute", ...pos }}>
              <Avatar seat={seat} table={table} isTurn={g.turn === seat} />
            </div>
          );
        })}

        <div style={{
          position: "absolute", inset: "34% 18% 22%",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6, flexWrap: "wrap",
        }}>
          {g.trick.map((t, i) => (
            <div key={i} style={{ textAlign: "center" }}>
              <Card card={t.card} small />
              <div style={{ fontSize: 10, color: felt.creamDim, marginTop: 2 }}>
                {table.seats[t.player].name}
              </div>
            </div>
          ))}
        </div>

        <div style={{
          position: "absolute", bottom: 8, left: 0, right: 0, textAlign: "center",
          fontStyle: "italic", color: felt.creamDim, fontSize: 15,
        }}>
          {statusLine(g, table, mySeat, isMyTurn)}
        </div>
      </div>

      {err && (
        <div style={{ background: "#00000040", color: felt.red, padding: "6px 12px", fontSize: 13 }}>
          {err}
        </div>
      )}

      {/* Decisions */}
      {g.phase === "picking" && g.pickTurn === mySeat && (
        <Actions>
          <button style={btnGold} disabled={busy} onClick={() => act(() => api.pick(tableId, playerId, "pick"))}>
            Pick
          </button>
          <button style={btnPlain} disabled={busy} onClick={() => act(() => api.pick(tableId, playerId, "pass"))}>
            Pass
          </button>
        </Actions>
      )}

      {g.phase === "bury" && g.picker === mySeat && (
        <BuryBar
          g={g}
          mySeat={mySeat}
          selected={selected}
          busy={busy}
          onConfirm={(calledSuit) =>
            act(async () => {
              await api.bury(tableId, playerId, selected, calledSuit);
              setSelected([]);
            })
          }
        />
      )}

      {g.phase === "handEnd" && table.youAreHost && (
        <Actions>
          <button style={btnGold} disabled={busy} onClick={() => act(() => api.startHand(tableId, playerId))}>
            Deal next hand
          </button>
        </Actions>
      )}

      {/* Your hand */}
      <div style={{ borderTop: `2px solid ${felt.rail}`, padding: "8px 6px 12px" }}>
        <div style={{ display: "flex", gap: 3, justifyContent: "center", flexWrap: "nowrap", overflowX: "auto" }}>
          {myHand.map((c) => (
            <Card
              key={cid(c)}
              card={c}
              onClick={() => onCardClick(c)}
              selected={selected.some((s) => cid(s) === cid(c))}
              dim={g.phase === "playing" && isMyTurn && !legal.includes(cid(c))}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function statusLine(g, table, mySeat, isMyTurn) {
  if (g.phase === "handEnd") {
    return g.result ? `${g.result.pickerWins ? "Pickers win" : "Defenders win"}${g.result.label ? ` — ${g.result.label}` : ""}` : "Hand over.";
  }
  if (g.phase === "picking") {
    return g.pickTurn === mySeat ? "Pick or pass?" : `${table.seats[g.pickTurn].name} is deciding…`;
  }
  if (g.phase === "bury") {
    return g.picker === mySeat ? "Bury two, then call an ace." : `${table.seats[g.picker].name} is burying…`;
  }
  if (isMyTurn) return "Your play.";
  return `${table.seats[g.turn]?.name || "Someone"}'s play…`;
}

function Actions({ children }) {
  return (
    <div style={{ display: "flex", gap: 10, justifyContent: "center", padding: "10px 12px" }}>
      {children}
    </div>
  );
}

function Centered({ children }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: felt.bg, color: felt.cream,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: 24, textAlign: "center",
    }}>
      {children}
    </div>
  );
}

// Bury two, then choose which ace to call. The callable set is recomputed here
// purely to render buttons — api/tables/[id]/bury.js recomputes it server-side
// and is the actual authority, so a tampered client just gets a 400.
function BuryBar({ g, mySeat, selected, busy, onConfirm }) {
  const hand = g.hands[mySeat] || [];
  const remaining = hand.filter((c) => !selected.some((s) => cid(s) === cid(c)));
  const ready = selected.length === 2;

  const opts = ready ? callable(remaining, selected) : [];

  return (
    <div style={{ padding: "10px 12px", textAlign: "center" }}>
      {!ready ? (
        <div style={{ color: felt.creamDim, fontSize: 14 }}>
          Select {2 - selected.length} more card{selected.length === 1 ? "" : "s"} to bury.
        </div>
      ) : opts.length === 0 ? (
        <button style={btnGold} disabled={busy} onClick={() => onConfirm(null)}>
          Go alone
        </button>
      ) : (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
          {opts.map((su) => (
            <button key={su} style={btnGold} disabled={busy} onClick={() => onConfirm(su)}>
              Call {SUIT_SYM[su]} {SUIT_NAME[su]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Mirrors api/tables/[id]/bury.js — a fail suit you hold, whose ace you neither
// hold nor just buried.
function callable(hand, buried) {
  const isTrumpCard = (c) => c.rank === "Q" || c.rank === "J" || c.suit === "D";
  const fails = { C: [], S: [], H: [] };
  hand.filter((c) => !isTrumpCard(c)).forEach((c) => fails[c.suit]?.push(c));
  return ["C", "S", "H"].filter(
    (su) =>
      fails[su].length > 0 &&
      !fails[su].some((c) => c.rank === "A") &&
      !buried.some((c) => c.suit === su && c.rank === "A" && !isTrumpCard(c))
  );
}
