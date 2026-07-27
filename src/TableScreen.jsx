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
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { SUIT_SYM, SUIT_NAME, cid, cardPts, legalPlays, makeDeck, isTrump, trumpPower, trickWinner } from "./engine.js";
import { felt, Card, Badge, Modal, btnGold, btnPlain, btnGhost } from "./ui.jsx";
import { useTableStream } from "./useTableStream.js";
import { usePacedTrick } from "./usePacedTrick.js";
import { fanOverlap } from "./fan.js";
import { Felt, HandFan } from "./felt.jsx";
import { TableHeader } from "./header.jsx";
// The fallback matters for tables created before rules were table state: they
// are live in the store with no `rules` field, and a header with no rules line
// is a visibly broken header rather than a missing feature.
import { HOUSE_RULES } from "./rules.js";
import { idleMs, isBootable, AWAY_AFTER_MS } from "./table.js";
import * as api from "./api.js";

const SEATS = 5;

// Derived, never hand-written: a hardcoded list is a second source of truth for
// the rules and would quietly go stale if trump ever changed.
const TRUMP_ORDER = makeDeck().filter(isTrump).sort((a, b) => trumpPower(b) - trumpPower(a));

// Reserved height for the status + action block. Without it the felt reflows
// every time a button appears or disappears, and the whole play area jumps as
// the last card of a trick lands (#33). Solo has always reserved this space.
const ACTION_MIN_HEIGHT = 84;

// Show an idle hint well before the seat becomes bootable, so the table sees
// somebody drifting rather than being surprised by a Boot button.
const IDLE_HINT_MS = 45_000;

// How often the client tells the server it's still here. Presence must be
// driven from the browser, not from a server timer: a timer keeps running after
// the tab closes and vouches for someone who has already gone. Comfortably
// inside AWAY_AFTER_MS so a couple of missed pings — a backgrounded tab, a
// tunnel — don't hand the seat to the AI.
const PRESENCE_PING_MS = 20_000;

// Re-renders once a second so idle counters advance. Only mounted while a table
// is on screen.
function useTick(ms = 1000) {
  const [, bump] = useState(0);
  useEffect(() => {
    const t = setInterval(() => bump((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

// `lastSeen` is stamped with the SERVER's clock. Comparing it against the
// browser's Date.now() shows nonsense the moment the two disagree — and phones
// with a slow clock disagree by minutes, which would either hide idle players
// or offer to boot people who just sat down. `updatedAt` gives us a reading of
// the server clock on every update, so the difference is the skew, and idle
// times are computed in the server's frame.
function useServerNow(table) {
  const [skew, setSkew] = useState(0);
  // `serverAt` rides the presence frame and therefore arrives every heartbeat,
  // where updatedAt only moves when the table itself changes. On a quiet table
  // updatedAt goes stale and the skew derived from it drifts, which is half of
  // why idle counters used to run away.
  const stamp = table?.serverAt ?? table?.updatedAt;
  useEffect(() => {
    if (stamp) setSkew(Date.now() - stamp);
  }, [stamp]);
  return () => Date.now() - skew;
}

// Keeps the seconds visible past a minute. The previous version switched units
// at 60s — so the counter read "59s" and then "1m", which looks like it reset,
// and then sat on "1m" for the whole 60-119s range. That range straddles the
// point where a seat becomes removable, so the number never visibly approached
// the thing it was supposed to be counting towards.
function formatIdle(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

// Absolute seat -> screen position, with the viewer always at the bottom.

// Horizontal padding on the hand row, subtracted from the viewport to get the
// width the fan actually has to fit inside.
const HAND_PADDING = 12;

// Tracks viewport width so the fan re-tightens on rotation and resize. The
// table is position:fixed inset:0, so the viewport IS the container.
function useViewportWidth() {
  const [w, setW] = useState(() => (typeof window === "undefined" ? 375 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  return w;
}

// What the felt should draw right now, which is deliberately not what the
// server most recently said.
//
// Two differences, both about time. The trick shown is the paced frame rather
// than g.trick — the server resolves every AI seat inside one request, so its
// trick jumps by four cards at once and has usually been cleared again before
// the client sees it. And the card you just played is on the table before the
// server has confirmed it.
//
// Synthesising a state keeps Felt ignorant of both: it renders a game, and this
// decides which game that is. Masking `turn` while the reveal catches up also
// stops the active-seat glow racing ahead of the cards.
function displayState(g, frame, optimistic, caughtUp) {
  const trick = [
    ...frame.cards,
    ...(optimistic && !frame.cleared && !frame.cards.some((p) => cid(p.card) === cid(optimistic.card))
      ? [optimistic]
      : []),
  ];
  return { ...g, trick, turn: caughtUp ? g.turn : -1, pickTurn: caughtUp ? g.pickTurn : -1 };
}

/* ------------------------- Sharing the table link -------------------------- */

// MP-1.2/1.3. navigator.share is preferred on phones because it opens Messages
// directly, which is where this group actually coordinates; clipboard is the
// desktop fallback.
function useShareLink(tableId) {
  const [copied, setCopied] = useState(false);
  const url = api.tableUrl(tableId);
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
  return { url, share, copied };
}

function ShareRow({ tableId }) {
  const { url, share, copied } = useShareLink(tableId);
  return (
    <div style={{
      display: "flex", gap: 8, alignItems: "center",
      background: "#00000030", borderRadius: 8, padding: "8px 10px",
    }}>
      <code style={{
        flex: 1, fontSize: 13, color: felt.creamDim,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{url}</code>
      <button style={btnGhost} onClick={share}>{copied ? "Copied" : "Share"}</button>
    </div>
  );
}

/* ------------------------------- The lobby -------------------------------- */

function Lobby({ table, mySeat, onStart, busy, err }) {
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

      <ShareRow tableId={table.id} />

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


/* --------------------------------- Modals --------------------------------- */

// #34 — the table had no way to check what beats what. Derived from the engine,
// so it can't drift from the rules it documents.
function TrumpModal({ onClose }) {
  return (
    <Modal maxWidth={420} onClose={onClose}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 4 }}>
        Trump, high to low
      </div>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 12 }}>
        Every Queen, then every Jack, then the diamonds. Everything else is a
        fail suit.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 14 }}>
        {TRUMP_ORDER.map((c) => (
          <span key={cid(c)} style={{
            fontSize: 14, fontWeight: 700, padding: "3px 6px", borderRadius: 4,
            background: "#00000035",
            color: c.suit === "H" || c.suit === "D" ? felt.red : felt.cream,
          }}>{c.rank}{SUIT_SYM[c.suit]}</span>
        ))}
      </div>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 14 }}>
        Card points: A 11 · 10 10 · K 4 · Q 3 · J 2 · 9/8/7 nothing. 120 in the
        deck; the picker's team needs 61.
      </div>
      <button style={btnPlain} onClick={onClose}>Close</button>
    </Modal>
  );
}

// #34 — running scores, which previously existed nowhere on the table screen.
function ScoresModal({ table, onClose, onRename, busy }) {
  const mySeat = table.you;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(mySeat >= 0 ? table.seats[mySeat]?.name || "" : "");

  return (
    <Modal onClose={onClose}>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 2 }}>
        {table.handNum > 0 ? `After hand ${table.handNum}` : "Not started"}
      </div>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 10 }}>
        Scores
      </div>
      <table style={{ width: "100%", fontSize: 16, borderCollapse: "collapse", marginBottom: 14 }}>
        <tbody>
          {table.seats.map((s, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #ffffff18" }}>
              <td style={{ padding: "6px 0", fontWeight: s.isYou ? 800 : 500 }}>
                {s.name} {s.isYou && <Badge compact>You</Badge>}
              </td>
              <td style={{ textAlign: "right", color: felt.brass, fontWeight: 700 }}>
                {table.scores[i] >= 0 ? "+" : ""}{table.scores[i]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Changing your name lives here because this is the one screen that
          already lists everybody by name — it's where you notice yours is
          wrong. Server-side it goes through the same collision rule as
          joining. */}
      {mySeat >= 0 && (editing ? (
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && draft.trim() && onRename(draft)}
            maxLength={24}
            autoFocus
            style={{
              flex: 1, minWidth: 0, padding: "8px 10px", fontSize: 16, borderRadius: 8,
              border: `1px solid ${felt.brassDim}`, background: "#00000030", color: felt.cream,
            }}
          />
          <button style={btnGold} disabled={busy || !draft.trim()} onClick={() => onRename(draft)}>
            Save
          </button>
        </div>
      ) : (
        <button style={{ ...btnGhost, marginBottom: 14 }} onClick={() => setEditing(true)}>
          Change my name
        </button>
      ))}

      {/* Your own seat. Stepping away has existed as a route since COM-3 but
          had no control anywhere in the UI — so the only way a seat became
          AI-covered was by going quiet, which is the accidental path rather
          than the deliberate one. */}
      {isMe && (s.kind === "away" ? (
        <>
          <button style={{ ...btnGold, marginBottom: 8 }} disabled={busy} onClick={onBack}>
            Take my seat back
          </button>
          <div style={{ fontSize: 12, color: felt.creamDim, marginBottom: 14 }}>
            Your cards were never touched — the AI was only choosing plays.
            Control returns at your next decision.
          </div>
        </>
      ) : (
        <>
          <button style={{ ...btnPlain, marginBottom: 8 }} disabled={busy} onClick={onAway}>
            Step away
          </button>
          <div style={{ fontSize: 12, color: felt.creamDim, marginBottom: 14 }}>
            The AI plays your seat until you come back. The seat stays yours —
            nobody else can take it.
          </div>
        </>
      ))}

      <button style={btnPlain} onClick={onClose}>Close</button>
    </Modal>
  );
}

// #30 — with tricks now sweeping off the felt correctly, the last trick is gone
// the moment it ends. Solo has always let you look back at it; this restores
// that for the table, laid out by seat position the way the felt is.
function LastTrickModal({ table, mySeat, onClose }) {
  const lt = table.g?.lastTrick;
  if (!lt) return null;
  const winner = lt.winner;
  const leader = lt.trick[0]?.player;
  const pts = lt.trick.reduce((n, t) => n + cardPts(t.card), 0);

  return (
    <Modal maxWidth={420} onClose={onClose}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 10 }}>
        Last trick
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", marginBottom: 12 }}>
        {lt.trick.map((t) => (
          <div key={cid(t.card)} style={{ textAlign: "center", minWidth: 60 }}>
            <Card card={t.card} small />
            <div style={{
              fontSize: 12, marginTop: 4, whiteSpace: "nowrap",
              fontWeight: t.player === winner ? 800 : 500,
              color: t.player === winner ? felt.brass : felt.creamDim,
              borderBottom: t.player === leader ? `2px solid ${felt.brass}` : "2px solid transparent",
            }}>
              {t.player === mySeat ? "You" : table.seats[t.player]?.name}
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 14 }}>
        <span style={{ color: felt.brass, fontWeight: 700 }}>
          {winner === mySeat ? "You" : table.seats[winner]?.name}
        </span>{" "}
        took it for {pts} {pts === 1 ? "point" : "points"} · underline = led
      </div>
      <button style={btnPlain} onClick={onClose}>Close</button>
    </Modal>
  );
}

// #31 — the link was only reachable from the lobby, so once a hand was dealt
// there was no way to invite anyone, despite MP-2.3 supporting joining mid-hand.
function InviteModal({ table, onClose }) {
  return (
    <Modal maxWidth={420} onClose={onClose}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 4 }}>
        Invite
      </div>
      <div style={{ fontSize: 14, color: felt.creamDim, marginBottom: 12 }}>
        Anyone who joins now takes an AI seat at the start of the next hand — the
        hand in progress isn't disturbed.
      </div>
      <div style={{ marginBottom: 14 }}><ShareRow tableId={table.id} /></div>
      <button style={btnPlain} onClick={onClose}>Close</button>
    </Modal>
  );
}

// Tapping a seat. Today it holds presence and the boot control; it's also the
// natural home for a profile link and lifetime stats once players are more than
// a localStorage token.
function PlayerModal({ table, seat, serverNow, onBoot, onAway, onBack, onClose, busy, err }) {
  const s = table.seats[seat];
  if (!s) return null;
  const idle = idleMs(table, seat, serverNow());
  const bootable = isBootable(table, seat, serverNow());
  const isMe = seat === table.you;

  const kindLabel =
    s.kind === "ai" ? "Played by the house AI"
      : s.kind === "away" ? "Stepped away — the AI is covering this seat"
        : "Playing";

  return (
    <Modal onClose={onClose}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 24, fontWeight: 900, color: felt.brass, marginBottom: 2 }}>
        {s.name}
      </div>
      <div style={{ fontSize: 14, color: felt.creamDim, marginBottom: 10 }}>
        {kindLabel}{isMe ? " · this is you" : ""}
      </div>

      {s.kind !== "ai" && (
        <div style={{ fontSize: 14, color: idle > AWAY_AFTER_MS ? felt.red : felt.creamDim, marginBottom: 14 }}>
          {idle > IDLE_HINT_MS ? `Last seen ${formatIdle(idle)} ago` : "Here now"}
        </div>
      )}

      {/* The error has to live in here. It used to render in a bar between the
          felt and the actions — underneath this modal's overlay — so a refused
          boot ("they just checked back in") looked like a button that did
          nothing at all. */}
      {err && (
        <div style={{
          background: "#00000040", color: felt.red, fontSize: 13,
          padding: "8px 10px", borderRadius: 8, marginBottom: 12,
        }}>{err}</div>
      )}

      {!isMe && s.kind !== "ai" && (
        bootable ? (
          <>
            <button style={{ ...btnGold, marginBottom: 8 }} disabled={busy} onClick={() => onBoot(seat)}>
              {busy ? "Removing…" : `Remove ${s.name}`}
            </button>
            <div style={{ fontSize: 12, color: felt.creamDim, marginBottom: 14 }}>
              Frees the seat for someone else. Not a ban — they can rejoin with
              the table link and take any open seat.
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: felt.creamDim, marginBottom: 14 }}>
            You can free this seat once they've been away for a while.
          </div>
        )
      )}

      <button style={btnPlain} onClick={onClose}>Close</button>
    </Modal>
  );
}

/* --------------------------------- Table ---------------------------------- */

export default function TableScreen({ tableId, playerId, onRejoin }) {
  const { table, connected, error } = useTableStream(tableId, playerId);
  // Called before any early return — hooks can't be conditional, and the
  // paced cursor has to keep running while the rest of the screen decides
  // what to render.
  const frame = usePacedTrick(table?.g);
  const caughtUp = frame.caughtUp;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState([]);

  // Your own card, drawn on the felt the instant you tap it rather than after
  // the round trip. Playing a card was POST -> server -> stream -> render
  // before anything moved, so the card sat in your hand for the length of a
  // network hop and the tap felt broken. The server is still the authority —
  // this is only a stand-in until the real card comes back down the stream,
  // and an illegal play is rejected and the stand-in withdrawn.
  const [optimistic, setOptimistic] = useState(null);
  const viewportWidth = useViewportWidth();
  const [modal, setModal] = useState(null); // "trump" | "scores" | "lastTrick" | "invite"
  const [seatModal, setSeatModal] = useState(null);
  const serverNow = useServerNow(table);
  useTick(1000);

  // Proof of life. Ignores the response — the stream is authoritative for
  // state; this exists purely so the server has an inbound request to date the
  // seat by. Fires immediately on mount so a returning player is current at
  // once rather than up to a ping late.
  useEffect(() => {
    if (!tableId || !playerId) return;
    let stopped = false;
    const ping = () => {
      if (stopped) return;
      api.getState(tableId, playerId).catch(() => {});
    };
    ping();
    const t = setInterval(ping, PRESENCE_PING_MS);
    return () => { stopped = true; clearInterval(t); };
  }, [tableId, playerId]);

  // Retire the stand-in once the genuine card has been REVEALED (not merely
  // received): dropping it as soon as the server confirms would blink the card
  // out and back in while the paced cursor caught up to it.
  useEffect(() => {
    if (optimistic && frame.revealedIds?.has(cid(optimistic.card))) setOptimistic(null);
  }, [optimistic, frame.revealedIds]);

  // A new hand invalidates any stand-in still hanging around.
  useEffect(() => {
    setOptimistic(null);
  }, [table?.g?.handNum]);

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

  // No seat. Two very different situations that used to render the same
  // message: someone waiting for the next hand, and someone whose seat was
  // reclaimed. Telling a removed player "you'll be seated at the start of the
  // next hand" is simply false — they aren't in the queue, so nothing will
  // ever seat them, and the screen offered no way back.
  if (mySeat < 0) {
    const queued = (table.pendingJoins || []).some((p) => p.isYou);
    const seatsFree = table.seats.some((s) => s.kind === "ai");
    return (
      <Centered>
        <div style={{ fontFamily: "Georgia, serif", fontSize: 24, fontWeight: 900, color: felt.brass, marginBottom: 8 }}>
          {queued ? "You're in the queue" : "You're not at the table"}
        </div>
        <div style={{ fontSize: 14, color: felt.creamDim, marginBottom: 18, maxWidth: 320 }}>
          {queued
            ? "You'll be seated at the start of the next hand."
            : seatsFree
              ? "Your seat was given up or reclaimed. There's room — you can sit back down."
              : "Your seat was given up or reclaimed, and the table is full right now."}
        </div>
        {!queued && (
          <div style={{ display: "flex", gap: 10 }}>
            {onRejoin && (
              <button style={btnGold} onClick={onRejoin}>
                {seatsFree ? "Sit back down" : "Join when a seat opens"}
              </button>
            )}
          </div>
        )}
        {queued && table.g && (
          <div style={{ fontSize: 13, color: felt.creamDim }}>Hand {table.g.handNum} in progress…</div>
        )}
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

  // The optimistic card leaves your hand immediately; once the server confirms,
  // its own copy of your hand no longer contains it and this filter is a no-op.
  const myHand = (g.hands[mySeat] || []).filter(
    (c) => !(optimistic && cid(c) === cid(optimistic.card))
  );
  // Tightens for the picker's 8-card bury view and loosens again once two are
  // buried. A fixed overlap fits six and clips eight — see src/fan.js.
  const handOverlap = fanOverlap(myHand.length, viewportWidth - HAND_PADDING);
  // `caughtUp` gates every affordance: until the table has finished showing
  // what everyone else played, your cards aren't live. Otherwise you can play
  // into a trick that visually has two cards in it and watch your own card
  // appear before theirs.
  const iAmAway = table.seats[mySeat]?.kind === "away";
  const isMyTurn = g.phase === "playing" && g.turn === mySeat && caughtUp && !iAmAway;
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
    setOptimistic({ card, player: mySeat });
    act(async () => {
      try {
        await api.playCard(tableId, playerId, card);
      } catch (e) {
        // Rejected or unreachable — take the stand-in back off the table so the
        // card returns to your hand rather than being stranded on the felt.
        setOptimistic(null);
        throw e;
      }
    });
  };

  return (
    // Solo's shell, not a plain fixed inset. The rails and the 480px cap are
    // why solo's felt is 363px wide on a 375px phone where this screen's was
    // the full 375 — and since every seat position is a percentage of the
    // felt, that 12px was the entire difference between the two layouts
    // (73/206/7/272 against 75/216/8/284). Same component, same percentages,
    // different box. Sharing the felt was never going to line them up on its
    // own; the box had to converge too.
    <div style={{
      height: "100dvh", overflow: "hidden",
      background: `radial-gradient(ellipse at 50% 30%, ${felt.bg}, ${felt.bgDeep} 80%)`,
      color: felt.cream, fontFamily: "'Avenir Next', 'Segoe UI', system-ui, sans-serif",
      display: "flex", flexDirection: "column", maxWidth: 480, margin: "0 auto",
      borderLeft: `6px solid ${felt.rail}`, borderRight: `6px solid ${felt.rail}`,
    }}>
      {/* The solo game's header, from header.jsx. The table code takes the
          title slot because at a table the code IS the identity — it's what
          you read out to someone whose link didn't paste — where solo has
          nothing more specific to say than SHEEPSHEAD.

          Invite / Trump / Scores were three buttons in a row here. They move
          into the menu because that is where solo keeps Trump and Scores, and
          keeping them out here is what forced this header to be a second
          implementation: three buttons plus a table code do not fit beside a
          title at phone width, so it dropped the rules line to make room.

          The contract strip that used to sit under this row is gone entirely.
          It showed who picked, the called suit and Alone — all three of which
          the felt now draws as badges on the picker's own seat, which is
          better placed anyway: it says who, not just what. Hand number was the
          only thing left, and the Scores modal already opens on "After hand
          N". */}
      <TableHeader
        title={table.id}
        rules={table.rules || HOUSE_RULES}
        doubler={g.doubler || 1}
        status={
          // Kept mounted and merely faded, so a dropped connection can never
          // reflow the header — a header that changes height mid-hand shifts
          // the felt, and the cards, under it.
          <span style={{
            flexShrink: 0, fontSize: 11, color: felt.creamDim, whiteSpace: "nowrap",
            opacity: connected ? 0 : 1, transition: "opacity .3s",
          }}>
            reconnecting…
          </span>
        }
        menuItems={[
          { label: "Invite others", onSelect: () => setModal("invite") },
          { label: "Trump order", onSelect: () => setModal("trump") },
          { label: "Scores", onSelect: () => setModal("scores") },
        ]}
      />

      {/* The felt is the solo game's, rendered from src/felt.jsx. Everything
          multiplayer needs on top of it hangs off two seams the component
          already has: seatExtra for presence, and onSeatClick for the player
          card. What the table gains by sharing it — running scores and trick
          counts per seat, the dealer button, the trick-winner banner — it
          previously just didn't have. */}
      <Felt
        g={displayState(g, frame, optimistic, caughtUp)}
        names={table.seats.map((s) => s.name)}
        mySeat={mySeat}
        onSeatClick={(seat) => setSeatModal(seat)}
        seatExtra={(seat) => {
          const s = table.seats[seat];
          const idle = serverNow ? idleMs(table, seat, serverNow()) : 0;
          const showIdle = idle > IDLE_HINT_MS && s.kind !== "ai";
          return (
            <>
              <div style={{ fontSize: 10, color: felt.creamDim, whiteSpace: "nowrap" }}>
                {/* MP-2.2 which seats are people vs house AI, and COM-3.3 the
                    third case: a real player's seat the AI is covering while
                    they're away. */}
                {s.kind === "ai" ? "AI" : s.kind === "away" ? "away · AI" : "\u00b7"}
              </div>
              {showIdle && (
                <div style={{ fontSize: 10, color: idle > AWAY_AFTER_MS ? felt.red : felt.creamDim }}>
                  idle {formatIdle(idle)}
                </div>
              )}
            </>
          );
        }}
      />

      {/* COM-3.2. Deliberately a banner rather than something tucked in a
          modal: a player who has just come back needs to find this without
          hunting, and until they do, the AI is playing their cards. */}
      {iAmAway && (
        <div style={{
          flexShrink: 0, display: "flex", alignItems: "center", gap: 10,
          background: felt.brass, color: "#241C06",
          padding: "8px 12px", fontSize: 14, fontWeight: 700,
        }}>
          <span style={{ flex: 1, minWidth: 0 }}>The AI is playing your seat.</span>
          <button
            style={{ ...btnPlain, background: "#241C0622", color: "#241C06", border: "1px solid #241C0655", fontSize: 14, padding: "6px 12px" }}
            disabled={busy}
            onClick={() => act(() => api.takeSeatBack(tableId, playerId))}
          >
            {busy ? "…" : "Take it back"}
          </button>
        </div>
      )}

      {err && (
        <div style={{ background: "#00000040", color: felt.red, padding: "6px 12px", fontSize: 13 }}>
          {err}
        </div>
      )}

      {/* Decisions. The reserved height is the fix for #33: these rows appear
          and disappear as a hand progresses, and without a floor the felt above
          resized every time — most visibly as the last card of a trick landed
          and the deal button arrived. */}
      {/* Solo's padding and alignment, to the pixel. Carrying the 7px inside
          the status line instead left this block 89px tall against solo's 98,
          and since the felt is flex:1 it absorbed the difference \u2014 516px
          instead of 507. Seat tops are percentages of that height, so a 9px
          discrepancy down here was moving every seat on the table. */}
      <div style={{ flexShrink: 0, padding: "7px 12px", textAlign: "center", minHeight: ACTION_MIN_HEIGHT }}>
        {/* Where solo keeps it: above the actions, not floating inside the
            felt. Held blank until the reveal catches up, so it can't announce
            a turn before the cards that caused it have landed. */}
        <div style={{ fontSize: 16, marginBottom: 7, color: felt.creamDim, fontStyle: "italic" }}>
          {caughtUp ? statusLine(g, table, mySeat, isMyTurn) : "\u00a0"}
        </div>
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

      {/* Held back until the final trick has finished playing out — otherwise
          the deal button appears while the last card is still landing. */}
      {g.phase === "handEnd" && caughtUp && table.youAreHost && (
        <Actions>
          <button style={btnGold} disabled={busy} onClick={() => act(() => api.startHand(tableId, playerId))}>
            Deal next hand
          </button>
        </Actions>
      )}

      </div>

      {/* #30 — tricks now sweep off the felt correctly, so the previous trick is
          gone the instant it ends. Solo has always offered a look back. */}
      {/* Fixed height for the same reason as the action block: the Last Trick
          button only exists once a trick has finished, and without a floor the
          felt above shrank by 11px the first time it appeared (measured). */}
      <div style={{
        flexShrink: 0, display: "flex", alignItems: "center", gap: 8,
        padding: "0 10px 4px", minHeight: 30,
      }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: ".06em", color: felt.creamDim }}>
          YOUR HAND
        </div>
        {g.lastTrick && (
          <button style={{ ...btnGhost, marginLeft: "auto" }} onClick={() => setModal("lastTrick")}>
            Last Trick
          </button>
        )}
      </div>

      {/* Your hand */}
      <div style={{ borderTop: `2px solid ${felt.rail}`, padding: "8px 6px 12px" }}>
        {/* overflowX is a safety net, not the mechanism: the fan is sized to
            fit, and a scrollbar appearing here means the geometry is wrong. */}
        <div style={{ display: "flex", justifyContent: "center", flexWrap: "nowrap", overflowX: "auto" }}>
          {myHand.map((c, i) => (
            <div key={cid(c)} style={{ marginLeft: i === 0 ? 0 : -handOverlap }}>
              <Card
                card={c}
                onClick={() => onCardClick(c)}
                selected={selected.some((s) => cid(s) === cid(c))}
                dim={g.phase === "playing" && isMyTurn && !legal.includes(cid(c))}
              />
            </div>
          ))}
        </div>
      </div>

      {modal === "trump" && <TrumpModal onClose={() => setModal(null)} />}
      {modal === "scores" && (
        <ScoresModal
          table={table}
          busy={busy}
          onClose={() => setModal(null)}
          onRename={(n) => act(async () => {
            await api.setName(tableId, playerId, n);
            setModal(null);
          })}
        />
      )}
      {modal === "invite" && <InviteModal table={table} onClose={() => setModal(null)} />}
      {modal === "lastTrick" && (
        <LastTrickModal table={table} mySeat={mySeat} onClose={() => setModal(null)} />
      )}
      {seatModal !== null && (
        <PlayerModal
          table={table}
          seat={seatModal}
          serverNow={serverNow}
          busy={busy}
          err={err}
          onClose={() => setSeatModal(null)}
          onBoot={(seat) => act(async () => {
            await api.bootPlayer(tableId, playerId, seat);
            setSeatModal(null);
          })}
          onAway={() => act(async () => {
            await api.stepAway(tableId, playerId);
            setSeatModal(null);
          })}
          onBack={() => act(async () => {
            await api.takeSeatBack(tableId, playerId);
            setSeatModal(null);
          })}
        />
      )}
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

// Solo's button row carries no padding of its own — the block around it
// already supplies 7px/12px and reserves 84px. The 10px/12px this used to add
// pushed the content past that floor, so the block grew to 103px and the felt,
// being flex:1, shrank to 502 where solo's is 507. Padding here is padding the
// reserved height was already paying for.
function Actions({ children }) {
  return (
    <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
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
